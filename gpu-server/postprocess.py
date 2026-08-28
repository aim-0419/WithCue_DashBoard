"""GPU 서버에서 배치로 도는 후처리: 얼굴 블러 + 앞뒤 불필요 구간 트리밍.

촬영 PC는 원본만 저장하고, 어느 정도 모이면 SSH로 이 서버에 배치 전송한 뒤
run_batch.py가 이 모듈을 호출해 처리한다.

- 앞: 녹화 시작 직후 촬영자가 자리를 잡는 시간을 고정 타이머로 컷.
- 뒤: 동작이 끝나고 정지 상태가 이어지는 구간을 프레임 차분 기반 움직임 감지로 컷.
- RealSense 경로는 color와 depth(raw+index+metadata)가 프레임 단위로 1:1 대응하므로
  같은 [start_frame, end_frame) 구간을 depth 쪽에도 동일하게 적용해 동기화를 유지한다.
"""

from __future__ import annotations

import csv
import json
import logging
from pathlib import Path

import cv2
import numpy as np

logger = logging.getLogger(__name__)

FRONT_TRIM_SECONDS = 1.0
BACK_TRIM_BUFFER_SECONDS = 0.5
MOTION_PIXEL_DIFF_THRESHOLD = 25
MOTION_PIXEL_RATIO_THRESHOLD = 0.01
MOTION_SCAN_WIDTH = 320
MIN_KEEP_FRAMES = 15

FACE_CASCADE_FILES = [
    "haarcascade_frontalface_default.xml",
    "haarcascade_profileface.xml",
]


def _load_face_cascades() -> list[cv2.CascadeClassifier]:
    cascades: list[cv2.CascadeClassifier] = []
    base_dir = getattr(getattr(cv2, "data", None), "haarcascades", "")
    for file_name in FACE_CASCADE_FILES:
        if not base_dir:
            break
        path = Path(base_dir) / file_name
        if not path.exists():
            continue
        classifier = cv2.CascadeClassifier(str(path))
        if not classifier.empty():
            cascades.append(classifier)
    if not cascades:
        logger.warning("[postprocess] no face cascades loaded; blur step will be a no-op")
    return cascades


_FACE_CASCADES = _load_face_cascades()


def blur_faces(frame: np.ndarray) -> np.ndarray:
    if not _FACE_CASCADES:
        return frame

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    for cascade in _FACE_CASCADES:
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
        for (x, y, w, h) in faces:
            roi = frame[y : y + h, x : x + w]
            if roi.size == 0:
                continue
            ksize = max(15, (min(w, h) // 3) | 1)
            frame[y : y + h, x : x + w] = cv2.GaussianBlur(roi, (ksize, ksize), 0)
    return frame


def _detect_motion_flags(video_path: Path) -> tuple[list[bool], float, int]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        return [], 0.0, 0

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    motion_flags: list[bool] = []
    prev_gray = None
    frame_count = 0

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frame_count += 1

        scale = MOTION_SCAN_WIDTH / frame.shape[1]
        small = cv2.resize(frame, (MOTION_SCAN_WIDTH, max(1, int(frame.shape[0] * scale))))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        if prev_gray is None:
            motion_flags.append(False)
        else:
            diff = cv2.absdiff(gray, prev_gray)
            changed = int(np.count_nonzero(diff > MOTION_PIXEL_DIFF_THRESHOLD))
            motion_flags.append((changed / diff.size) > MOTION_PIXEL_RATIO_THRESHOLD)
        prev_gray = gray

    capture.release()
    return motion_flags, fps, frame_count


def _compute_trim_bounds(video_path: Path) -> tuple[int, int] | None:
    motion_flags, fps, frame_count = _detect_motion_flags(video_path)
    if frame_count == 0 or fps <= 0:
        return None

    front_cut = int(round(FRONT_TRIM_SECONDS * fps))
    back_buffer = int(round(BACK_TRIM_BUFFER_SECONDS * fps))

    last_motion_index = None
    for index, is_motion in enumerate(motion_flags):
        if is_motion:
            last_motion_index = index

    end_frame = frame_count if last_motion_index is None else min(frame_count, last_motion_index + 1 + back_buffer)
    start_frame = min(front_cut, max(0, end_frame - MIN_KEEP_FRAMES))

    if end_frame - start_frame < MIN_KEEP_FRAMES:
        logger.warning("[postprocess] trim skipped, clip too short: %s", video_path.name)
        return None

    return start_frame, end_frame


def _rewrite_video(video_path: Path, start_frame: int, end_frame: int) -> int:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        return 0

    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0

    temp_path = video_path.with_suffix(".processing.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(temp_path), fourcc, fps, (width, height))

    kept = 0
    index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if start_frame <= index < end_frame:
            writer.write(blur_faces(frame))
            kept += 1
        index += 1

    capture.release()
    writer.release()

    if kept == 0:
        temp_path.unlink(missing_ok=True)
        return 0

    temp_path.replace(video_path)
    return kept


def _rewrite_depth_sidecars(
    depth_raw_path: Path,
    depth_index_path: Path,
    depth_metadata_path: Path,
    start_frame: int,
    end_frame: int,
) -> int:
    if not depth_raw_path.exists() or not depth_index_path.exists():
        return 0

    with depth_index_path.open("r", newline="", encoding="utf-8") as file:
        rows = list(csv.DictReader(file))

    kept_rows = [row for row in rows if start_frame <= int(row["frame_number"]) < end_frame]
    if not kept_rows:
        return 0

    metadata = None
    frame_size_bytes = None
    if depth_metadata_path.exists():
        metadata = json.loads(depth_metadata_path.read_text(encoding="utf-8"))
        shape = metadata.get("depth_shape", {})
        value_bytes = int(metadata.get("depth_value_bytes", 2))
        frame_size_bytes = int(shape.get("width", 0)) * int(shape.get("height", 0)) * value_bytes

    temp_raw_path = depth_raw_path.with_suffix(".processing.raw")
    new_rows = []
    with depth_raw_path.open("rb") as source, temp_raw_path.open("wb") as dest:
        new_offset = 0
        for new_index, row in enumerate(kept_rows):
            offset = int(row["raw_offset_bytes"])
            size = frame_size_bytes or (int(row["width"]) * int(row["height"]) * 2)
            source.seek(offset)
            chunk = source.read(size)
            dest.write(chunk)
            new_row = dict(row)
            new_row["frame_number"] = new_index
            new_row["raw_offset_bytes"] = new_offset
            new_rows.append(new_row)
            new_offset += len(chunk)

    temp_raw_path.replace(depth_raw_path)

    with depth_index_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(new_rows)

    if metadata is not None:
        metadata["frame_count"] = len(new_rows)
        depth_metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    return len(new_rows)


def process_recording(details: dict) -> dict:
    """batch runner에서 파일 하나당 호출. 실패해도 원본은 그대로 두고 details를 반환한다."""
    file_path = details.get("file_path")
    if not file_path:
        return details

    video_path = Path(file_path)
    if not video_path.exists():
        return details

    try:
        bounds = _compute_trim_bounds(video_path)
        start_frame, end_frame = bounds if bounds else (0, 10**9)

        kept = _rewrite_video(video_path, start_frame, end_frame)
        if kept == 0:
            return details

        if bounds and details.get("depth"):
            new_frame_count = _rewrite_depth_sidecars(
                Path(details["depth_raw_file_path"]),
                Path(details["depth_index_file_path"]),
                Path(details["depth_metadata_file_path"]),
                start_frame,
                end_frame,
            )
            if new_frame_count:
                details["depth_frame_count"] = new_frame_count
                details["depth_raw_size"] = Path(details["depth_raw_file_path"]).stat().st_size

        details["size"] = video_path.stat().st_size
        details["processed"] = True
    except Exception as error:  # noqa: BLE001 - 파일 하나 실패가 배치 전체를 막으면 안 됨
        logger.warning("[postprocess] failed for %s: %s", video_path.name, error)

    return details
