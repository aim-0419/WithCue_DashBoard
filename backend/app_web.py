from __future__ import annotations

import csv
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import cv2
from flask import Flask, Response, jsonify, render_template, request, send_file

try:
    import numpy as np
except Exception as error:  # pragma: no cover - exercised only on missing local deps
    np = None
    NUMPY_IMPORT_ERROR = error
else:
    NUMPY_IMPORT_ERROR = None

try:
    import pyrealsense2 as rs
except Exception as error:  # pragma: no cover - depends on local RealSense runtime
    rs = None
    REALSENSE_IMPORT_ERROR = error
else:
    REALSENSE_IMPORT_ERROR = None

app = Flask(__name__)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.logger.setLevel(logging.INFO)

# 로컬 저장 경로와 Firebase 동기화 스크립트 위치를 한곳에서 관리한다.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SYNC_SCRIPT = PROJECT_ROOT / "backend" / "scripts" / "sync-locations.mjs"
DESKTOP_DIR = Path.home() / "Desktop"
SAVE_ROOT = DESKTOP_DIR / "Data_Auto"
PARTICIPANTS_CSV = SAVE_ROOT / "participants.csv"
# 실제 학습용 촬영물은 여기 밑에 {부위}/{참여자ID}/{회차}/ 구조로 쌓인다.
DATASET_ROOT = SAVE_ROOT / "dataset"
SITE_CONFIG = {
    "aim": {"code": "A", "label": "AIM"},
}
PART_DIRS = {
    "목": DATASET_ROOT / "Neck",
    "허리": DATASET_ROOT / "Hip",
    "왼쪽 어깨": DATASET_ROOT / "L_Shoulder",
    "오른쪽 어깨": DATASET_ROOT / "R_Shoulder",
    "왼쪽 무릎": DATASET_ROOT / "L_Knee",
    "오른쪽 무릎": DATASET_ROOT / "R_Knee",
}
SORT_TARGETS = {
    "01": ("Neck", False),
    "011": ("Neck", True),
    "02": ("Hip", False),
    "021": ("Hip", True),
    "03": ("L_Shoulder", False),
    "031": ("L_Shoulder", True),
    "04": ("R_Shoulder", False),
    "041": ("R_Shoulder", True),
    "05": ("L_Knee", False),
    "051": ("L_Knee", True),
    "06": ("R_Knee", False),
    "061": ("R_Knee", True),
}
DEPTH_SIDECAR_SUFFIXES = (".depth.raw", ".depth.csv", ".depth.json")
SORT_SKIP_FILES = {"participants.csv"}
CSV_HEADERS = [
    "participant_id",
    "name",
    "birth_date",
    "age",
    "gender",
    "consent",
    "site_code",
    "registered_at",
    "updated_at",
]
PREVIEW_MAX_WIDTH = 960
PREVIEW_JPEG_QUALITY = 72
DEFAULT_ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}
REALSENSE_CAMERA_INDEX = -100
REALSENSE_STREAM_WIDTH = 640
REALSENSE_STREAM_HEIGHT = 480
REALSENSE_STREAM_FPS = 30
DEPTH_VALUE_BYTES = 2
CAMERA_SCAN_RANGE = range(2)
CAMERA_CHOICES = [
    {"index": 0, "label": "카메라 0"},
    {"index": 1, "label": "카메라 1"},
]
CAMERA_LIST_BACKENDS = [
    ("default", None),
    ("dshow", cv2.CAP_DSHOW),
    ("msmf", getattr(cv2, "CAP_MSMF", None)),
]
CAMERA_OPEN_BACKENDS = [
    ("dshow", cv2.CAP_DSHOW),
    ("msmf", getattr(cv2, "CAP_MSMF", None)),
    ("default", None),
]


def get_site_config(site_key: str | None) -> dict[str, str]:
    # 쿼리스트링이나 API payload의 site 값을 지점 코드/표시명으로 정규화한다.
    return SITE_CONFIG.get((site_key or "").lower(), SITE_CONFIG["aim"])


def normalize_gender(raw_gender: str) -> str:
    normalized = (raw_gender or "").strip().lower()
    if normalized in {"male", "남", "남성"}:
        return "남"
    if normalized in {"female", "여", "여성"}:
        return "여"
    return raw_gender.strip()


def get_camera_backend_name(backend_name: str) -> str:
    if backend_name == "default":
        return "default"
    if backend_name == "dshow":
        return "DirectShow"
    if backend_name == "msmf":
        return "MediaFoundation"
    return backend_name


def get_realsense_unavailable_reason() -> str | None:
    if rs is None:
        return f"pyrealsense2 import failed: {REALSENSE_IMPORT_ERROR}"
    if np is None:
        return f"numpy import failed: {NUMPY_IMPORT_ERROR}"
    return None


def get_realsense_info(device, info) -> str:
    try:
        if device.supports(info):
            return device.get_info(info)
    except Exception:
        return ""
    return ""


def get_realsense_device_choice() -> dict[str, int | str | bool] | None:
    unavailable_reason = get_realsense_unavailable_reason()
    if unavailable_reason:
        app.logger.info("RealSense unavailable: %s", unavailable_reason)
        return None

    try:
        devices = rs.context().query_devices()
    except Exception as error:
        app.logger.warning("failed to query RealSense devices: %s", error)
        return None

    if len(devices) == 0:
        return None

    device = devices[0]
    name = get_realsense_info(device, rs.camera_info.name) or "Intel RealSense"
    serial = get_realsense_info(device, rs.camera_info.serial_number)
    label = f"{name} RGB+Depth"
    if serial:
        label = f"{label} ({serial})"
    return {"index": REALSENSE_CAMERA_INDEX, "label": label, "depth": True}


def intrinsics_to_dict(intrinsics) -> dict[str, object] | None:
    if intrinsics is None:
        return None

    return {
        "width": int(intrinsics.width),
        "height": int(intrinsics.height),
        "ppx": float(intrinsics.ppx),
        "ppy": float(intrinsics.ppy),
        "fx": float(intrinsics.fx),
        "fy": float(intrinsics.fy),
        "model": str(intrinsics.model),
        "coeffs": [float(value) for value in intrinsics.coeffs],
    }


def get_windows_camera_names() -> list[str]:
    # 카메라 선택 UI에 실제 장치명을 보여주기 위해 Windows 장치 목록을 읽는다.
    if not shutil.which("powershell"):
        return []

    command = (
        "Get-CimInstance Win32_PnPEntity | "
        "Where-Object { $_.PNPClass -in @('Camera','Image') -and $_.Name } | "
        "Select-Object -ExpandProperty Name | "
        "ConvertTo-Json -Compress"
    )

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
    except Exception as error:
        app.logger.warning("failed to read camera device names: %s", error)
        return []

    raw_output = (result.stdout or "").strip()
    if not raw_output:
        return []

    try:
        import json

        parsed = json.loads(raw_output)
    except Exception as error:
        app.logger.warning("failed to parse camera device names: %s", error)
        return []

    if isinstance(parsed, str):
        return [parsed]
    if isinstance(parsed, list):
        return [str(item) for item in parsed if str(item).strip()]
    return []


def get_camera_choices() -> list[dict[str, int | str | bool]]:
    # 장치명과 인덱스를 같이 내려 프론트에서 사람이 읽기 쉬운 목록을 만든다.
    device_names = get_windows_camera_names()
    choices: list[dict[str, int | str | bool]] = []
    realsense_choice = get_realsense_device_choice()
    if realsense_choice:
        choices.append(realsense_choice)

    for idx, camera in enumerate(CAMERA_CHOICES):
        label = camera["label"]
        if idx < len(device_names):
            label = device_names[idx]
        choices.append({"index": camera["index"], "label": label})

    return choices


def split_recording_stem(file_name: str) -> tuple[str, str]:
    lower = file_name.lower()
    for suffix in DEPTH_SIDECAR_SUFFIXES:
        if lower.endswith(suffix):
            return file_name[: -len(suffix)], file_name[-len(suffix):]
    p = Path(file_name)
    return p.stem, p.suffix


def get_sort_target_dir(base_dir: Path, stem: str) -> Path:
    parts = [p for p in re.split(r"[-_]", stem) if p]
    if len(parts) < 2:
        return base_dir / "_unclassified"
    body_part_code = parts[1]
    target_info = SORT_TARGETS.get(body_part_code)
    if not target_info:
        return base_dir / "_unclassified"
    folder_name, is_wrong = target_info
    target = base_dir / folder_name
    return target / f"W_{folder_name}" if is_wrong else target


def sort_recording_group(base_dir: Path, output_path: Path) -> dict[str, str]:
    stem = output_path.stem
    target_dir = get_sort_target_dir(base_dir, stem)
    target_dir.mkdir(parents=True, exist_ok=True)

    candidates = [output_path] + [
        output_path.parent / f"{stem}{suf}" for suf in DEPTH_SIDECAR_SUFFIXES
    ]
    files = [f for f in candidates if f.exists() and f.is_file()]
    if not files:
        return {}

    result: dict[str, str] = {}
    for src in files:
        _, suffix = split_recording_stem(src.name)
        dst = target_dir / f"{stem}{suffix}"
        counter = 1
        while dst.exists():
            dst = target_dir / f"{stem}_{counter}{suffix}"
            counter += 1
        shutil.move(str(src), str(dst))
        result[src.name] = str(dst)
        app.logger.info("[sort] %s -> %s", src.name, dst)

    return result


def sync_locations_snapshot() -> None:
    # 로컬 CSV/영상 폴더 집계를 별도 Node 스크립트로 넘겨 Firestore locations를 갱신한다.
    node_binary = shutil.which("node")
    if not node_binary or not SYNC_SCRIPT.exists():
        app.logger.warning("locations sync skipped: node or sync script is unavailable")
        return

    try:
        subprocess.run(
            [node_binary, str(SYNC_SCRIPT)],
            cwd=str(PROJECT_ROOT),
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.CalledProcessError as error:
        stderr_output = (error.stderr or "").strip()
        stdout_output = (error.stdout or "").strip()
        app.logger.warning("locations sync failed: %s", stderr_output or stdout_output or error)
    except Exception as error:
        app.logger.warning("locations sync failed: %s", error)


def sync_locations_snapshot_async() -> None:
    # 등록/녹화 종료 응답 속도를 해치지 않도록 집계는 백그라운드에서 처리한다.
    threading.Thread(target=sync_locations_snapshot, daemon=True).start()


def get_allowed_origins() -> set[str]:
    configured_origins = {
        origin.strip().rstrip("/")
        for origin in os.environ.get("WITHCUE_ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    }
    return DEFAULT_ALLOWED_ORIGINS | configured_origins


def generate_mjpeg_stream():
    while True:
        image_bytes = camera_manager.get_jpeg_frame()
        if image_bytes is None:
            time.sleep(0.03)
            continue
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            b"Cache-Control: no-cache\r\n\r\n" + image_bytes + b"\r\n"
        )


class CameraManager:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.capture: cv2.VideoCapture | None = None
        self.camera_index: int | None = None
        self.frame = None
        self.running = False
        self.thread: threading.Thread | None = None
        self.recording = False
        self.writer: cv2.VideoWriter | None = None
        self.read_fail_count = 0
        self.source_type: str | None = None
        self.rs_pipeline = None
        self.rs_align = None
        self.rs_depth_scale = 0.001
        self.rs_depth_intrinsics = None
        self.rs_depth_width = REALSENSE_STREAM_WIDTH
        self.rs_depth_height = REALSENSE_STREAM_HEIGHT
        self.depth_file = None
        self.depth_index_file = None
        self.depth_index_writer: csv.DictWriter | None = None
        self.depth_raw_path: Path | None = None
        self.depth_index_path: Path | None = None
        self.depth_metadata_path: Path | None = None
        self.depth_metadata: dict[str, object] | None = None
        self.depth_frame_count = 0
        self.recording_output_path: Path | None = None
        self.last_recording: dict[str, object] | None = None

    def list_cameras(self) -> list[dict[str, int | str | bool]]:
        # 현장 장비 기준으로 짧은 인덱스 범위만 검사해 카메라 탐색 지연을 줄인다.
        cameras: list[dict[str, int | str | bool]] = []
        realsense_choice = get_realsense_device_choice()
        if realsense_choice:
            cameras.append(realsense_choice)

        seen_indexes: set[int] = set()
        for index in CAMERA_SCAN_RANGE:
            found_backend_name = None
            for backend_name, backend_flag in CAMERA_LIST_BACKENDS:
                if backend_flag is None:
                    capture = cv2.VideoCapture(index)
                else:
                    capture = cv2.VideoCapture(index, backend_flag)

                if capture.isOpened():
                    if index not in seen_indexes:
                        cameras.append({"index": index, "label": f"카메라 {index}"})
                        seen_indexes.add(index)
                    found_backend_name = get_camera_backend_name(backend_name)
                    capture.release()
                    break
                capture.release()
            if found_backend_name:
                app.logger.info("camera detected: index=%s backend=%s", index, found_backend_name)
                return cameras
            else:
                app.logger.info("camera not available: index=%s", index)

        if cameras:
            return cameras

        fallback_indexes = [0, 1, 2, 3]
        app.logger.warning("camera detection returned empty list; exposing fallback indexes: %s", fallback_indexes)
        return [
            {"index": index, "label": f"카메라 {index} (수동 시도)"}
            for index in fallback_indexes
        ]

    def open_camera(self, index: int) -> None:
        if index == REALSENSE_CAMERA_INDEX:
            self._open_realsense_camera()
            return
        self._open_opencv_camera(index)

    def _open_opencv_camera(self, index: int) -> None:
        with self.lock:
            if (
                self.camera_index == index
                and self.source_type == "opencv"
                and self.capture is not None
                and self.capture.isOpened()
            ):
                return

            capture = None
            warmed_frame = None
            selected_backend_name = None
            last_error_backend = None

            for backend_name, backend_flag in CAMERA_OPEN_BACKENDS:
                # Windows에서 잘 잡히는 backend를 우선순위대로 시도하고, 실제 프레임이 나와야 성공으로 본다.
                if backend_flag is None:
                    current_capture = cv2.VideoCapture(index)
                else:
                    current_capture = cv2.VideoCapture(index, backend_flag)

                if not current_capture.isOpened():
                    current_capture.release()
                    continue

                current_capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                current_capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                current_capture.set(cv2.CAP_PROP_FPS, 30)
                current_capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)

                for _ in range(30):
                    ok, frame = current_capture.read()
                    if ok and frame is not None:
                        warmed_frame = frame
                        break
                    time.sleep(0.03)

                if warmed_frame is not None:
                    capture = current_capture
                    selected_backend_name = get_camera_backend_name(backend_name)
                    break

                last_error_backend = get_camera_backend_name(backend_name)
                app.logger.warning(
                    "camera backend opened but produced no frames: index=%s backend=%s",
                    index,
                    last_error_backend,
                )
                current_capture.release()

            if capture is None or not capture.isOpened() or warmed_frame is None:
                if capture is not None:
                    capture.release()
                app.logger.warning("camera open failed: index=%s backend=%s", index, last_error_backend or "unknown")
                raise RuntimeError("선택한 카메라에서 프레임을 읽지 못했습니다.")

            self._close_locked()
            self.capture = capture
            self.camera_index = index
            self.frame = warmed_frame
            self.source_type = "opencv"
            self.running = True
            self.read_fail_count = 0
            app.logger.info("camera opened: index=%s backend=%s", index, selected_backend_name or "unknown")

            self.thread = threading.Thread(target=self._update_frames, daemon=True)
            self.thread.start()

    def _open_realsense_camera(self) -> None:
        unavailable_reason = get_realsense_unavailable_reason()
        if unavailable_reason:
            raise RuntimeError(
                "RealSense 카메라를 사용하려면 pyrealsense2와 numpy가 필요합니다. "
                f"상세: {unavailable_reason}"
            )

        with self.lock:
            if self.camera_index == REALSENSE_CAMERA_INDEX and self.source_type == "realsense" and self.rs_pipeline:
                return

            try:
                devices = rs.context().query_devices()
            except Exception as error:
                raise RuntimeError(f"RealSense 장치 목록을 읽지 못했습니다: {error}") from error

            if len(devices) == 0:
                raise RuntimeError("연결된 Intel RealSense 카메라를 찾지 못했습니다.")

            pipeline = rs.pipeline()
            config = rs.config()
            config.enable_stream(
                rs.stream.depth,
                REALSENSE_STREAM_WIDTH,
                REALSENSE_STREAM_HEIGHT,
                rs.format.z16,
                REALSENSE_STREAM_FPS,
            )
            config.enable_stream(
                rs.stream.color,
                REALSENSE_STREAM_WIDTH,
                REALSENSE_STREAM_HEIGHT,
                rs.format.bgr8,
                REALSENSE_STREAM_FPS,
            )

            warmed_frame = None
            depth_intrinsics = None
            depth_width = REALSENSE_STREAM_WIDTH
            depth_height = REALSENSE_STREAM_HEIGHT
            align = rs.align(rs.stream.color)

            try:
                profile = pipeline.start(config)
                depth_sensor = profile.get_device().first_depth_sensor()
                depth_scale = float(depth_sensor.get_depth_scale())

                for _ in range(30):
                    frames = pipeline.wait_for_frames(1000)
                    aligned_frames = align.process(frames)
                    depth_frame = aligned_frames.get_depth_frame()
                    color_frame = aligned_frames.get_color_frame()
                    if not depth_frame or not color_frame:
                        continue

                    warmed_frame = np.asanyarray(color_frame.get_data()).copy()
                    video_profile = depth_frame.profile.as_video_stream_profile()
                    depth_intrinsics = video_profile.intrinsics
                    depth_width = int(depth_frame.get_width())
                    depth_height = int(depth_frame.get_height())
                    break
            except Exception as error:
                try:
                    pipeline.stop()
                except Exception:
                    pass
                raise RuntimeError(f"RealSense 스트림을 열지 못했습니다: {error}") from error

            if warmed_frame is None:
                try:
                    pipeline.stop()
                except Exception:
                    pass
                raise RuntimeError("RealSense 카메라에서 컬러/깊이 프레임을 읽지 못했습니다.")

            self._close_locked()
            self.rs_pipeline = pipeline
            self.rs_align = align
            self.rs_depth_scale = depth_scale
            self.rs_depth_intrinsics = depth_intrinsics
            self.rs_depth_width = depth_width
            self.rs_depth_height = depth_height
            self.camera_index = REALSENSE_CAMERA_INDEX
            self.frame = warmed_frame
            self.source_type = "realsense"
            self.running = True
            self.read_fail_count = 0
            app.logger.info("RealSense camera opened: %sx%s@%s", depth_width, depth_height, REALSENSE_STREAM_FPS)

            self.thread = threading.Thread(target=self._update_frames, daemon=True)
            self.thread.start()

    def _close_locked(self) -> None:
        self.running = False
        self.recording = False
        if self.writer:
            self.writer.release()
            self.writer = None
        self._close_depth_recording_locked(finalized=False)
        if self.capture:
            self.capture.release()
            self.capture = None
        if self.rs_pipeline:
            try:
                self.rs_pipeline.stop()
            except Exception as error:
                app.logger.warning("failed to stop RealSense pipeline: %s", error)
            self.rs_pipeline = None
            self.rs_align = None
        self.camera_index = None
        self.source_type = None
        self.recording_output_path = None
        self.frame = None
        self.thread = None

    def close_camera(self) -> None:
        with self.lock:
            self._close_locked()

    def _handle_frame_read_failure(self) -> None:
        with self.lock:
            self.read_fail_count += 1
            count = self.read_fail_count
            camera_index = self.camera_index
        if count in {1, 10, 30, 60}:
            app.logger.warning("camera frame read failed: index=%s count=%s", camera_index, count)
        time.sleep(0.02)

    def _read_realsense_frame(self):
        if self.rs_pipeline is None or np is None:
            return None

        try:
            frames = self.rs_pipeline.wait_for_frames(1000)
            aligned_frames = self.rs_align.process(frames) if self.rs_align else frames
            depth_frame = aligned_frames.get_depth_frame()
            color_frame = aligned_frames.get_color_frame()
        except Exception:
            return None

        if not depth_frame or not color_frame:
            return None

        color_image = np.asanyarray(color_frame.get_data()).copy()
        depth_image = np.asanyarray(depth_frame.get_data()).copy()
        return color_image, depth_image, float(depth_frame.get_timestamp()), float(color_frame.get_timestamp())

    def _update_frames(self) -> None:
        # 프리뷰와 실제 녹화가 같은 캡처를 공유하도록 최신 프레임을 계속 메모리에 유지한다.
        while True:
            with self.lock:
                if not self.running:
                    break
                source_type = self.source_type
                capture = self.capture

            if source_type == "realsense":
                frame_data = self._read_realsense_frame()
                if frame_data is None:
                    self._handle_frame_read_failure()
                    continue

                frame, depth_image, depth_timestamp_ms, color_timestamp_ms = frame_data
                with self.lock:
                    self.read_fail_count = 0
                    self.frame = frame
                    if self.writer is not None:
                        self.writer.write(frame)
                    if self.recording:
                        self._write_depth_frame_locked(depth_image, depth_timestamp_ms, color_timestamp_ms)
                time.sleep(0.001)
                continue

            if capture is None:
                break

            ok, frame = capture.read()
            if not ok:
                self._handle_frame_read_failure()
                continue
            with self.lock:
                self.read_fail_count = 0
                self.frame = frame
                if self.writer is not None:
                    self.writer.write(frame)
            time.sleep(0.01)

    def get_jpeg_frame(self) -> bytes | None:
        # MJPEG 프리뷰용 전송은 크기와 품질을 조금 낮춰 브라우저 부담을 줄인다.
        with self.lock:
            if self.frame is None:
                return None
            frame = self.frame.copy()

        frame_height, frame_width = frame.shape[:2]
        if frame_width > PREVIEW_MAX_WIDTH:
            scale = PREVIEW_MAX_WIDTH / float(frame_width)
            preview_size = (PREVIEW_MAX_WIDTH, max(1, int(frame_height * scale)))
            frame = cv2.resize(frame, preview_size, interpolation=cv2.INTER_AREA)

        ok, buffer = cv2.imencode(
            ".jpg",
            frame,
            [int(cv2.IMWRITE_JPEG_QUALITY), PREVIEW_JPEG_QUALITY],
        )
        if not ok:
            return None
        return buffer.tobytes()

    def start_recording(self, output_path: Path) -> dict[str, object]:
        # 실제 저장 영상은 프리뷰와 별도로 mp4 파일로 기록된다.
        with self.lock:
            if self.recording:
                raise RuntimeError("이미 녹화 중입니다.")
            if self.source_type == "realsense":
                if self.rs_pipeline is None or self.frame is None:
                    raise RuntimeError("RealSense 카메라가 준비되지 않았습니다.")
                height, width = self.frame.shape[:2]
                fps_value = float(REALSENSE_STREAM_FPS)
            else:
                if self.capture is None or not self.capture.isOpened():
                    raise RuntimeError("카메라가 준비되지 않았습니다.")
                width = int(self.capture.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
                height = int(self.capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720
                fps = self.capture.get(cv2.CAP_PROP_FPS)
                fps_value = fps if fps and fps > 1 else 30.0

            output_path.parent.mkdir(parents=True, exist_ok=True)
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(str(output_path), fourcc, fps_value, (width, height))
            if not writer.isOpened():
                writer.release()
                raise RuntimeError("녹화 파일을 열지 못했습니다.")

            try:
                if self.source_type == "realsense":
                    self._open_depth_recording_locked(output_path)
            except Exception:
                writer.release()
                self._close_depth_recording_locked(finalized=False)
                raise

            self.writer = writer
            self.recording = True
            self.recording_output_path = output_path
            self.last_recording = None
            return self._build_recording_details_locked(output_path)

    def stop_recording(self) -> dict[str, object] | None:
        with self.lock:
            self.recording = False
            output_path = self.recording_output_path
            if self.writer:
                self.writer.release()
                self.writer = None
            self._close_depth_recording_locked(finalized=True)
            details = self._build_recording_details_locked(output_path) if output_path else None
            self.recording_output_path = None
            if details:
                self.last_recording = details
            return details

    def _open_depth_recording_locked(self, output_path: Path) -> None:
        self.depth_raw_path = output_path.with_suffix(".depth.raw")
        self.depth_index_path = output_path.with_suffix(".depth.csv")
        self.depth_metadata_path = output_path.with_suffix(".depth.json")
        self.depth_file = self.depth_raw_path.open("wb")
        self.depth_index_file = self.depth_index_path.open("w", newline="", encoding="utf-8")
        self.depth_index_writer = csv.DictWriter(
            self.depth_index_file,
            fieldnames=[
                "frame_number",
                "raw_offset_bytes",
                "width",
                "height",
                "depth_timestamp_ms",
                "color_timestamp_ms",
                "system_timestamp",
            ],
        )
        self.depth_index_writer.writeheader()
        self.depth_frame_count = 0
        self.depth_metadata = {
            "format_version": 1,
            "source": "Intel RealSense",
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "finalized": False,
            "color_file": output_path.name,
            "depth_raw_file": self.depth_raw_path.name,
            "depth_index_file": self.depth_index_path.name,
            "depth_value_type": "uint16",
            "depth_value_bytes": DEPTH_VALUE_BYTES,
            "depth_scale_to_meters": float(self.rs_depth_scale),
            "depth_shape": {
                "width": int(self.rs_depth_width),
                "height": int(self.rs_depth_height),
                "channels": 1,
            },
            "stream": {
                "width": REALSENSE_STREAM_WIDTH,
                "height": REALSENSE_STREAM_HEIGHT,
                "fps": REALSENSE_STREAM_FPS,
            },
            "intrinsics": intrinsics_to_dict(self.rs_depth_intrinsics),
            "depth_meters_formula": "meters = raw_uint16 * depth_scale_to_meters",
            "xyz_formula": "Z=meters; X=(pixel_x-ppx)*Z/fx; Y=(pixel_y-ppy)*Z/fy",
        }
        self._write_depth_metadata_locked()

    def _write_depth_frame_locked(
        self,
        depth_image,
        depth_timestamp_ms: float,
        color_timestamp_ms: float,
    ) -> None:
        if self.depth_file is None or self.depth_index_writer is None or np is None:
            return

        depth_u16 = depth_image.astype(np.uint16, copy=False)
        height, width = depth_u16.shape[:2]
        raw_offset = self.depth_file.tell()
        depth_u16.tofile(self.depth_file)
        self.depth_index_writer.writerow(
            {
                "frame_number": self.depth_frame_count,
                "raw_offset_bytes": raw_offset,
                "width": width,
                "height": height,
                "depth_timestamp_ms": f"{depth_timestamp_ms:.3f}",
                "color_timestamp_ms": f"{color_timestamp_ms:.3f}",
                "system_timestamp": datetime.now().isoformat(timespec="milliseconds"),
            }
        )
        self.depth_frame_count += 1

    def _write_depth_metadata_locked(self) -> None:
        if self.depth_metadata_path is None or self.depth_metadata is None:
            return
        with self.depth_metadata_path.open("w", encoding="utf-8") as file:
            json.dump(self.depth_metadata, file, ensure_ascii=False, indent=2)

    def _close_depth_recording_locked(self, finalized: bool) -> None:
        if (
            self.depth_file is None
            and self.depth_index_file is None
            and self.depth_metadata is None
        ):
            return

        if self.depth_file:
            self.depth_file.flush()
        if self.depth_index_file:
            self.depth_index_file.flush()
        if self.depth_metadata is not None:
            self.depth_metadata["finalized"] = finalized
            self.depth_metadata["ended_at"] = datetime.now().isoformat(timespec="seconds")
            self.depth_metadata["frame_count"] = int(self.depth_frame_count)
            self._write_depth_metadata_locked()
        if self.depth_file:
            self.depth_file.close()
        if self.depth_index_file:
            self.depth_index_file.close()

        self.depth_file = None
        self.depth_index_file = None
        self.depth_index_writer = None
        self.depth_metadata = None

    def _build_recording_details_locked(self, output_path: Path | None) -> dict[str, object] | None:
        if output_path is None:
            return None

        # 회차 폴더마다 파일명이 전부 "color.mp4"로 동일하므로, 다운로드 식별용으로는
        # bare 파일명이 아니라 SAVE_ROOT 기준 상대경로를 써야 회차끼리 안 섞인다.
        def relative_name(path: Path) -> str:
            return path.relative_to(SAVE_ROOT).as_posix()

        details: dict[str, object] = {
            "file_name": relative_name(output_path),
            "file_path": str(output_path),
            "mime_type": "video/mp4",
            "source_type": self.source_type or "",
            "size": output_path.stat().st_size if output_path.exists() else 0,
        }

        depth_raw_path = output_path.with_suffix(".depth.raw")
        depth_index_path = output_path.with_suffix(".depth.csv")
        depth_metadata_path = output_path.with_suffix(".depth.json")
        if depth_raw_path.exists():
            details.update(
                {
                    "depth": True,
                    "depth_frame_count": int(self.depth_frame_count),
                    "depth_raw_file_name": relative_name(depth_raw_path),
                    "depth_raw_file_path": str(depth_raw_path),
                    "depth_raw_size": depth_raw_path.stat().st_size,
                    "depth_index_file_name": relative_name(depth_index_path),
                    "depth_index_file_path": str(depth_index_path),
                    "depth_metadata_file_name": relative_name(depth_metadata_path),
                    "depth_metadata_file_path": str(depth_metadata_path),
                }
            )
        else:
            details["depth"] = False
            details["depth_frame_count"] = 0

        return details


camera_manager = CameraManager()


def ensure_storage() -> None:
    # 처음 실행하는 지점 PC에서도 폴더 구조와 participants.csv가 자동으로 준비되게 한다.
    SAVE_ROOT.mkdir(parents=True, exist_ok=True)
    for path in PART_DIRS.values():
        path.mkdir(parents=True, exist_ok=True)
    if not PARTICIPANTS_CSV.exists():
        with PARTICIPANTS_CSV.open("w", newline="", encoding="utf-8-sig") as file:
            writer = csv.DictWriter(file, fieldnames=CSV_HEADERS)
            writer.writeheader()


def sort_existing_files() -> None:
    # 서버 시작 시 루트에 남아 있는 미분류 mp4 파일을 부위 폴더로 정렬한다.
    for file_path in list(SAVE_ROOT.iterdir()):
        if not file_path.is_file():
            continue
        if file_path.name in SORT_SKIP_FILES:
            continue
        if file_path.suffix.lower() != ".mp4":
            continue
        try:
            moved = sort_recording_group(SAVE_ROOT, file_path)
            if moved:
                print(f"[sort] startup sorted {file_path.name} -> {list(moved.values())[0]}")
        except Exception as exc:
            print(f"[sort] startup sort failed for {file_path.name}: {exc}")


def load_participants() -> list[dict[str, str]]:
    ensure_storage()
    with PARTICIPANTS_CSV.open("r", newline="", encoding="utf-8-sig") as file:
        rows = list(csv.DictReader(file))
    normalized_rows: list[dict[str, str]] = []
    for row in rows:
        normalized_row = {header: row.get(header, "") for header in CSV_HEADERS}
        normalized_rows.append(normalized_row)
    return normalized_rows


def save_participants(rows: list[dict[str, str]]) -> None:
    with PARTICIPANTS_CSV.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=CSV_HEADERS)
        writer.writeheader()
        writer.writerows(rows)


def normalize_name(name: str) -> str:
    return " ".join(name.strip().split()).lower()


def find_participant(name: str, birth_date: str, gender: str) -> dict[str, str] | None:
    # 같은 참여자인지 판별할 때는 이름/생년월일/성별 조합을 사용한다.
    normalized_name = normalize_name(name)
    normalized_birth_date = birth_date.strip()
    normalized_gender = normalize_gender(gender)
    for row in load_participants():
        if normalize_name(row.get("name", "")) != normalized_name:
            continue
        if row.get("birth_date", "").strip() != normalized_birth_date:
            continue
        if normalize_gender(row.get("gender", "")) != normalized_gender:
            continue
        return row
    return None


def update_existing_participant(
    name: str,
    birth_date: str,
    gender: str,
    consent: str,
    site_code: str,
) -> dict[str, str] | None:
    rows = load_participants()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    participant = find_participant(name, birth_date, gender)
    if participant is None:
        return None

    for row in rows:
        if row.get("participant_id") != participant.get("participant_id"):
            continue
        row["birth_date"] = birth_date
        row["age"] = ""
        row["gender"] = normalize_gender(gender)
        row["consent"] = consent
        row["site_code"] = site_code
        row["updated_at"] = now
        save_participants(rows)
        return row
    return None


def get_or_create_participant(
    name: str,
    birth_date: str,
    gender: str,
    consent: str,
    site_code: str,
) -> tuple[str, bool]:
    # 참가자 등록 시 기존 ID를 재사용하거나 새 ID를 발급해 CSV와 영상 파일명을 연결한다.
    rows = load_participants()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    existing = find_participant(name, birth_date, gender)
    if existing is not None:
        for row in rows:
            if row.get("participant_id") != existing.get("participant_id"):
                continue
            row["birth_date"] = birth_date
            row["age"] = ""
            row["gender"] = normalize_gender(gender)
            row["consent"] = consent
            row["site_code"] = site_code
            row["updated_at"] = now
            save_participants(rows)
            return row["participant_id"], False

    next_id = 1
    if rows:
        next_id = max(int(row["participant_id"]) for row in rows if row["participant_id"].isdigit()) + 1
    participant_id = f"{next_id:02d}"
    rows.append(
        {
            "participant_id": participant_id,
            "name": name.strip(),
            "birth_date": birth_date,
            "age": "",
            "gender": normalize_gender(gender),
            "consent": consent,
            "site_code": site_code,
            "registered_at": now,
            "updated_at": now,
        }
    )
    save_participants(rows)
    return participant_id, True


def get_next_recording_path(participant_id: str, part_name: str) -> Path:
    # dataset/{부위}/{참여자ID}/{회차}/color.mp4 구조. 회차 폴더 하나 = 촬영 1회(rep) 전체 산출물.
    participant_dir = PART_DIRS[part_name] / participant_id
    participant_dir.mkdir(parents=True, exist_ok=True)

    highest_take = 0
    for entry in participant_dir.iterdir():
        if entry.is_dir() and entry.name.isdigit():
            highest_take = max(highest_take, int(entry.name))

    take_dir = participant_dir / f"{highest_take + 1:03d}"
    take_dir.mkdir(parents=True, exist_ok=True)
    result = take_dir / "color.mp4"
    app.logger.warning(f"[path] part_name={part_name!r} output_path={result}")
    return result


@app.after_request
def add_no_cache_headers(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    origin = request.headers.get("Origin", "").rstrip("/")
    if origin in get_allowed_origins():
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Vary"] = "Origin"
    return response


@app.get("/")
def index():
    ensure_storage()
    # React 로그인에서 넘긴 사용자 정보를 템플릿 초기 상태에 주입해 바로 촬영 단계로 진입시킨다.
    site_key = request.args.get("site", "aim")
    site_config = get_site_config(site_key)
    initial_state = {
        "siteKey": site_key,
        "siteCode": site_config["code"],
        "siteLabel": site_config["label"],
        "name": request.args.get("name", "").strip(),
        "birthDate": request.args.get("birthDate", "").strip(),
        "gender": normalize_gender(request.args.get("gender", "").strip()),
    }
    return render_template("index.html", initial_state=initial_state)


@app.get("/api/cameras")
def cameras():
    return jsonify({"cameras": get_camera_choices()})


@app.post("/api/check-participant")
def check_participant():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    birth_date = str(payload.get("birth_date", "")).strip()
    gender = str(payload.get("gender", "")).strip()
    site_key = str(payload.get("site_key", "aim")).strip()
    site_config = get_site_config(site_key)

    if not name:
        return jsonify({"error": "이름을 입력해 주세요."}), 400
    if not birth_date:
        return jsonify({"error": "생년월일을 입력해 주세요."}), 400
    if not gender:
        return jsonify({"error": "성별을 선택해 주세요."}), 400

    participant = find_participant(name, birth_date, gender)
    if not participant:
        return jsonify({"exists": False, "consented": False})

    updated = update_existing_participant(name, birth_date, gender, participant.get("consent", "agree"), site_config["code"]) or participant
    return jsonify(
        {
            "exists": True,
            "consented": updated.get("consent", "") == "agree",
            "participant_id": updated.get("participant_id", ""),
        }
    )


@app.post("/api/register")
def register():
    # 수집 페이지 진입 직후 자동으로 호출되어 로컬 참가자 CSV를 갱신한다.
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    birth_date = str(payload.get("birth_date", "")).strip()
    gender = str(payload.get("gender", "")).strip()
    consent = str(payload.get("consent", "")).strip()
    site_key = str(payload.get("site_key", "aim")).strip()
    site_config = get_site_config(site_key)

    if not name:
        return jsonify({"error": "이름을 입력해 주세요."}), 400
    if not birth_date:
        return jsonify({"error": "생년월일을 입력해 주세요."}), 400
    if not gender:
        return jsonify({"error": "성별을 선택해 주세요."}), 400
    if consent != "agree":
        return jsonify({"error": "동의해야 다음 단계로 이동할 수 있습니다."}), 400

    participant_id, created = get_or_create_participant(
        name,
        birth_date,
        gender,
        consent,
        site_config["code"],
    )
    return jsonify({"participant_id": participant_id, "created": created})


@app.post("/api/preview/start")
def preview_start():
    # 브라우저 프리뷰에 맞춰 서버 쪽 캡처도 같은 인덱스 카메라로 연다.
    payload = request.get_json(silent=True) or {}
    camera_index = payload.get("camera_index")
    if camera_index is None:
        return jsonify({"error": "camera_index가 없습니다."}), 400
    try:
        camera_manager.open_camera(int(camera_index))
    except Exception as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({"started": True})


@app.post("/api/record/start")
def record_start():
    payload = request.get_json(silent=True) or {}
    participant_id = str(payload.get("participant_id", "")).strip()
    part_name = str(payload.get("part_name", "")).strip()
    camera_index = payload.get("camera_index")
    app.logger.warning(f"[record_start] part_name={part_name!r} participant_id={participant_id!r}")

    if not participant_id:
        return jsonify({"error": "participant_id가 없습니다."}), 400
    if part_name not in PART_DIRS:
        app.logger.warning(f"[record_start] INVALID part_name={part_name!r}, PART_DIRS keys={list(PART_DIRS.keys())}")
        return jsonify({"error": "유효하지 않은 부위입니다."}), 400
    if camera_index is None:
        return jsonify({"error": "camera_index가 없습니다."}), 400

    try:
        camera_manager.open_camera(int(camera_index))
        output_path = get_next_recording_path(participant_id, part_name)
        app.logger.warning(f"[record_start] output_path={output_path}")
        recording = camera_manager.start_recording(output_path)
    except Exception as error:
        app.logger.warning(f"[record_start] error={error}")
        return jsonify({"error": str(error)}), 400
    return jsonify({"started": True, "recording": recording})


@app.post("/api/record/stop")
def record_stop():
    recording = camera_manager.stop_recording()
    camera_manager.close_camera()
    return jsonify({"stopped": True, "recording": recording or camera_manager.last_recording})


@app.get("/api/frame")
def frame():
    image_bytes = camera_manager.get_jpeg_frame()
    if image_bytes is None:
        return Response(status=204)
    return Response(image_bytes, mimetype="image/jpeg")


@app.get("/video_feed")
def video_feed():
    # MJPEG 프리뷰가 필요한 경우를 위해 스트림 엔드포인트를 유지한다.
    return Response(
        generate_mjpeg_stream(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/api/download")
def download_recording_file():
    # 회차 폴더마다 파일명이 같은 "color.mp4"라서, SAVE_ROOT 기준 상대경로로 정확히 지정받는다.
    raw_path = request.args.get("filename", "").strip()
    print(f"[download] requested: {raw_path!r}")
    if not raw_path:
        return jsonify({"error": "잘못된 경로입니다."}), 400

    relative_path = Path(raw_path)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        return jsonify({"error": "잘못된 경로입니다."}), 400

    candidate = (SAVE_ROOT / relative_path).resolve()
    try:
        candidate.relative_to(SAVE_ROOT.resolve())
    except ValueError:
        return jsonify({"error": "잘못된 경로입니다."}), 400

    if not candidate.is_file():
        print(f"[download] not found: {candidate}")
        return jsonify({"error": "파일을 찾을 수 없습니다."}), 404

    # 브라우저 다운로드함에서는 회차별로 구분되게 경로를 이어붙인 이름으로 저장한다.
    download_name = "_".join(relative_path.parts)
    return send_file(candidate, as_attachment=True, download_name=download_name)


if __name__ == "__main__":
    ensure_storage()
    sort_existing_files()
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
