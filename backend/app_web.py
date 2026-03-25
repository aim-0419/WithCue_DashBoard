from __future__ import annotations

import csv
import logging
import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import cv2
from flask import Flask, Response, jsonify, render_template, request

app = Flask(__name__)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.logger.setLevel(logging.INFO)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SYNC_SCRIPT = PROJECT_ROOT / "backend" / "scripts" / "sync-locations.mjs"
DESKTOP_DIR = Path.home() / "Desktop"
SAVE_ROOT = DESKTOP_DIR / "Data_Auto"
PARTICIPANTS_CSV = SAVE_ROOT / "participants.csv"
SITE_CONFIG = {
    "aim": {"code": "A", "label": "AIM"},
    "hyocheon": {"code": "H", "label": "효천점"},
    "jangdeok": {"code": "J", "label": "장덕점"},
}
PART_DIRS = {
    "목": SAVE_ROOT / "Neck",
    "허리": SAVE_ROOT / "Hip",
    "왼쪽 어깨": SAVE_ROOT / "L_Shoulder",
    "오른쪽 어깨": SAVE_ROOT / "R_Shoulder",
    "왼쪽 무릎": SAVE_ROOT / "L_Knee",
    "오른쪽 무릎": SAVE_ROOT / "R_Knee",
}
PART_CODES = {
    "목": "01",
    "허리": "02",
    "왼쪽 어깨": "03",
    "오른쪽 어깨": "04",
    "왼쪽 무릎": "05",
    "오른쪽 무릎": "06",
}
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


def get_windows_camera_names() -> list[str]:
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


def get_camera_choices() -> list[dict[str, int | str]]:
    device_names = get_windows_camera_names()
    choices: list[dict[str, int | str]] = []

    for idx, camera in enumerate(CAMERA_CHOICES):
        label = camera["label"]
        if idx < len(device_names):
            label = device_names[idx]
        choices.append({"index": camera["index"], "label": label})

    return choices


def sync_locations_snapshot() -> None:
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
    threading.Thread(target=sync_locations_snapshot, daemon=True).start()


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

    def list_cameras(self) -> list[dict[str, int | str]]:
        cameras: list[dict[str, int | str]] = []
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
        with self.lock:
            if self.camera_index == index and self.capture is not None and self.capture.isOpened():
                return
            previous_capture = self.capture
            previous_index = self.camera_index
            previous_frame = self.frame
            previous_writer = self.writer
            previous_running = self.running
            previous_thread = self.thread
            capture = None
            selected_backend_name = None
            last_error_backend = None

            for backend_name, backend_flag in CAMERA_OPEN_BACKENDS:
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

                warmed_frame = None
                for _ in range(30):
                    ok, frame = current_capture.read()
                    if ok and frame is not None:
                        warmed_frame = frame
                        break
                    time.sleep(0.03)

                if warmed_frame is not None:
                    capture = current_capture
                    selected_backend_name = get_camera_backend_name(backend_name)
                    self.frame = warmed_frame
                    break

                last_error_backend = get_camera_backend_name(backend_name)
                app.logger.warning(
                    "camera backend opened but produced no frames: index=%s backend=%s",
                    index,
                    last_error_backend,
                )
                current_capture.release()

            if capture is None or not capture.isOpened():
                if capture is not None:
                    capture.release()
                self.capture = previous_capture
                self.camera_index = previous_index
                self.frame = previous_frame
                self.writer = previous_writer
                self.running = previous_running
                self.thread = previous_thread
                app.logger.warning("camera open failed: index=%s backend=%s", index, last_error_backend or "unknown")
                raise RuntimeError("선택한 카메라에서 프레임을 읽지 못했습니다.")

            self._close_locked()
            self.capture = capture
            self.camera_index = index
            self.running = True
            self.read_fail_count = 0
            app.logger.info("camera opened: index=%s backend=%s", index, selected_backend_name or "unknown")

            self.thread = threading.Thread(target=self._update_frames, daemon=True)
            self.thread.start()

    def _close_locked(self) -> None:
        self.running = False
        if self.writer:
            self.writer.release()
            self.writer = None
        if self.capture:
            self.capture.release()
            self.capture = None
        self.camera_index = None
        self.frame = None

    def close_camera(self) -> None:
        with self.lock:
            self._close_locked()

    def _update_frames(self) -> None:
        while True:
            with self.lock:
                if not self.running or self.capture is None:
                    break
                capture = self.capture
                writer = self.writer
            ok, frame = capture.read()
            if not ok:
                self.read_fail_count += 1
                if self.read_fail_count in {1, 10, 30, 60}:
                    app.logger.warning(
                        "camera frame read failed: index=%s count=%s",
                        self.camera_index,
                        self.read_fail_count,
                    )
                time.sleep(0.02)
                continue
            with self.lock:
                self.read_fail_count = 0
                self.frame = frame
                if writer is not None:
                    writer.write(frame)
            time.sleep(0.01)

    def get_jpeg_frame(self) -> bytes | None:
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

    def start_recording(self, output_path: Path) -> None:
        with self.lock:
            if self.capture is None or not self.capture.isOpened():
                raise RuntimeError("카메라가 준비되지 않았습니다.")
            if self.recording:
                raise RuntimeError("이미 녹화 중입니다.")
            width = int(self.capture.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
            height = int(self.capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720
            fps = self.capture.get(cv2.CAP_PROP_FPS)
            fps_value = fps if fps and fps > 1 else 30.0
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(str(output_path), fourcc, fps_value, (width, height))
            if not writer.isOpened():
                writer.release()
                raise RuntimeError("녹화 파일을 열지 못했습니다.")
            self.writer = writer
            self.recording = True

    def stop_recording(self) -> None:
        with self.lock:
            self.recording = False
            if self.writer:
                self.writer.release()
                self.writer = None


camera_manager = CameraManager()


def ensure_storage() -> None:
    SAVE_ROOT.mkdir(parents=True, exist_ok=True)
    for path in PART_DIRS.values():
        path.mkdir(parents=True, exist_ok=True)
    if not PARTICIPANTS_CSV.exists():
        with PARTICIPANTS_CSV.open("w", newline="", encoding="utf-8-sig") as file:
            writer = csv.DictWriter(file, fieldnames=CSV_HEADERS)
            writer.writeheader()


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


def get_next_recording_path(participant_id: str, part_name: str, site_code: str) -> Path:
    part_dir = PART_DIRS[part_name]
    part_code = PART_CODES[part_name]
    highest_take = 0
    for file_path in part_dir.glob(f"{site_code}_{participant_id}_{part_code}_*.mp4"):
        stem_parts = file_path.stem.split("_")
        if len(stem_parts) != 4:
            continue
        if stem_parts[3].isdigit():
            highest_take = max(highest_take, int(stem_parts[3]))
    next_take = f"{highest_take + 1:03d}"
    return part_dir / f"{site_code}_{participant_id}_{part_code}_{next_take}.mp4"


@app.after_request
def add_no_cache_headers(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.get("/")
def index():
    ensure_storage()
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
    sync_locations_snapshot_async()
    return jsonify({"participant_id": participant_id, "created": created})


@app.post("/api/preview/start")
def preview_start():
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
    site_key = str(payload.get("site_key", "aim")).strip()
    site_config = get_site_config(site_key)

    if not participant_id:
        return jsonify({"error": "participant_id가 없습니다."}), 400
    if part_name not in PART_DIRS:
        return jsonify({"error": "유효하지 않은 부위입니다."}), 400
    if camera_index is None:
        return jsonify({"error": "camera_index가 없습니다."}), 400

    try:
        camera_manager.open_camera(int(camera_index))
        output_path = get_next_recording_path(participant_id, part_name, site_config["code"])
        camera_manager.start_recording(output_path)
    except Exception as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({"started": True})


@app.post("/api/record/stop")
def record_stop():
    camera_manager.stop_recording()
    camera_manager.close_camera()
    sync_locations_snapshot_async()
    return jsonify({"stopped": True})


@app.get("/api/frame")
def frame():
    image_bytes = camera_manager.get_jpeg_frame()
    if image_bytes is None:
        return Response(status=204)
    return Response(image_bytes, mimetype="image/jpeg")


@app.get("/video_feed")
def video_feed():
    return Response(
        generate_mjpeg_stream(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


if __name__ == "__main__":
    ensure_storage()
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
