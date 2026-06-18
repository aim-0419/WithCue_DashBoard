from __future__ import annotations

import argparse
import re
import shutil
import sys
import time
from pathlib import Path


BODY_PART_TARGETS = {
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

PENDING_SUFFIXES = {".crdownload", ".part", ".tmp"}
DEPTH_SIDECAR_SUFFIXES = (".depth.raw", ".depth.csv", ".depth.json")
SKIP_ROOT_FILES = {"participants.csv"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Watch Data_Auto and sort recordings by the body-part code in the file name."
    )
    parser.add_argument(
        "--watch-dir",
        default=str(Path.home() / "Desktop" / "Data_Auto"),
        help="Data_Auto directory to watch.",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=1.0,
        help="Directory scan interval in seconds.",
    )
    parser.add_argument(
        "--settle-seconds",
        type=float,
        default=2.0,
        help="Seconds to wait while checking that files are no longer changing.",
    )
    return parser.parse_args()


def ensure_base_structure(base_dir: Path) -> None:
    base_dir.mkdir(parents=True, exist_ok=True)

    body_part_folders = {folder_name for folder_name, _ in BODY_PART_TARGETS.values()}
    for folder_name in body_part_folders:
        body_part_dir = base_dir / folder_name
        body_part_dir.mkdir(parents=True, exist_ok=True)
        (body_part_dir / f"W_{folder_name}").mkdir(parents=True, exist_ok=True)

    (base_dir / "_unclassified").mkdir(parents=True, exist_ok=True)


def is_pending_file(file_path: Path) -> bool:
    return file_path.suffix.lower() in PENDING_SUFFIXES


def are_files_stable(file_paths: list[Path], settle_seconds: float) -> bool:
    try:
        first_sizes = {file_path: file_path.stat().st_size for file_path in file_paths}
    except FileNotFoundError:
        return False

    time.sleep(settle_seconds)

    try:
        return all(file_path.stat().st_size == first_sizes[file_path] for file_path in file_paths)
    except FileNotFoundError:
        return False


def split_recording_name(file_path: Path) -> tuple[str, str]:
    file_name = file_path.name
    lower_name = file_name.lower()

    for suffix in DEPTH_SIDECAR_SUFFIXES:
        if lower_name.endswith(suffix):
            return file_name[: -len(suffix)], file_name[-len(suffix) :]

    return file_path.stem, file_path.suffix


def get_recording_group_key(file_path: Path) -> str:
    group_key, _ = split_recording_name(file_path)
    return group_key


def resolve_target_directory(base_dir: Path, file_name: str) -> Path:
    stem = Path(file_name).stem
    parts = [part for part in re.split(r"[-_]", stem) if part]
    if len(parts) < 3:
        return base_dir / "_unclassified"

    body_part_code = parts[1]
    target_info = BODY_PART_TARGETS.get(body_part_code)
    if target_info is None:
        return base_dir / "_unclassified"

    target_folder, is_wrong_posture = target_info
    target_dir = base_dir / target_folder

    if is_wrong_posture:
        return target_dir / f"W_{target_folder}"

    return target_dir


def resolve_group_target_paths(file_paths: list[Path], target_dir: Path, group_key: str) -> list[tuple[Path, Path]]:
    split_names = [(file_path, split_recording_name(file_path)[1]) for file_path in file_paths]
    candidate_key = group_key
    index = 1

    while any((target_dir / f"{candidate_key}{suffix}").exists() for _, suffix in split_names):
        candidate_key = f"{group_key}_{index}"
        index += 1

    return [
        (file_path, target_dir / f"{candidate_key}{suffix}")
        for file_path, suffix in split_names
    ]


def move_files_to_target(file_paths: list[Path], target_dir: Path, group_key: str) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    target_paths = resolve_group_target_paths(file_paths, target_dir, group_key)

    for source_path, target_path in target_paths:
        shutil.move(str(source_path), str(target_path))
        print(f"[moved] {source_path.name} -> {target_path}")

    if len(target_paths) > 1:
        print(f"[group moved] {group_key} ({len(target_paths)} files)")


def scan_and_sort(base_dir: Path, settle_seconds: float) -> None:
    groups: dict[str, list[Path]] = {}
    for file_path in base_dir.iterdir():
        if not file_path.is_file():
            continue

        if file_path.name in SKIP_ROOT_FILES:
            continue

        if is_pending_file(file_path):
            continue

        groups.setdefault(get_recording_group_key(file_path), []).append(file_path)

    for group_key, file_paths in groups.items():
        if not are_files_stable(file_paths, settle_seconds):
            continue

        target_dir = resolve_target_directory(base_dir, f"{group_key}.mp4")
        move_files_to_target(file_paths, target_dir, group_key)


def main() -> int:
    args = parse_args()
    watch_dir = Path(args.watch_dir).expanduser().resolve()

    ensure_base_structure(watch_dir)

    print(f"[watching] {watch_dir}")
    print("[info] Press Ctrl+C to stop.")

    try:
        while True:
            scan_and_sort(watch_dir, args.settle_seconds)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[stopped] User interrupted.")
        return 0
    except Exception as exc:  # pragma: no cover
        print(f"[error] Auto-sort failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
