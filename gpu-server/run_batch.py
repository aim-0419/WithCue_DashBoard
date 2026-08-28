"""GPU 서버용 배치 실행기.

촬영 PC들에서 SSH(scp/rsync)로 넘어온 영상 폴더를 통째로 가리켜서 실행한다.
이미 처리된 파일은 <파일명>.processed 마커로 건너뛰므로, 같은 폴더에 배치가
누적돼도(먼저 온 배치 + 나중에 온 배치) 다시 처리하지 않는다.

사용:
    python run_batch.py /path/to/batch_root
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

import postprocess

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

DEPTH_SUFFIXES = {
    "raw": ".depth.raw",
    "index": ".depth.csv",
    "metadata": ".depth.json",
}


def build_details(video_path: Path) -> dict:
    stem = video_path.name[: -len(video_path.suffix)]
    depth_raw = video_path.with_name(f"{stem}{DEPTH_SUFFIXES['raw']}")
    depth_index = video_path.with_name(f"{stem}{DEPTH_SUFFIXES['index']}")
    depth_metadata = video_path.with_name(f"{stem}{DEPTH_SUFFIXES['metadata']}")

    has_depth = depth_raw.exists() and depth_index.exists()
    return {
        "file_path": str(video_path),
        "depth": has_depth,
        "depth_raw_file_path": str(depth_raw) if has_depth else "",
        "depth_index_file_path": str(depth_index) if has_depth else "",
        "depth_metadata_file_path": str(depth_metadata) if has_depth else "",
    }


def marker_path(video_path: Path) -> Path:
    return video_path.with_name(video_path.name + ".processed")


def find_pending_videos(root: Path) -> list[Path]:
    return [path for path in sorted(root.rglob("*.mp4")) if not marker_path(path).exists()]


def run(root: Path) -> None:
    pending = find_pending_videos(root)
    if not pending:
        logger.info("처리할 새 영상이 없음: %s", root)
        return

    logger.info("영상 %d개 처리 시작", len(pending))
    done = 0
    failed = 0

    for video_path in pending:
        details = build_details(video_path)
        result = postprocess.process_recording(details)

        if result.get("processed"):
            marker_path(video_path).write_text(datetime.now().isoformat(timespec="seconds"), encoding="utf-8")
            done += 1
            logger.info("완료: %s", video_path.name)
        else:
            failed += 1
            logger.warning("실패 또는 스킵(마커 없이 남음, 다음 실행 때 재시도): %s", video_path.name)

    logger.info("배치 종료: 완료 %d개, 실패/스킵 %d개", done, failed)


def main() -> int:
    parser = argparse.ArgumentParser(description="촬영 배치 후처리(얼굴 블러 + 앞뒤 트리밍) 실행")
    parser.add_argument("root", type=Path, help="전송받은 영상 폴더 루트 경로")
    args = parser.parse_args()

    if not args.root.exists():
        logger.error("경로를 찾을 수 없음: %s", args.root)
        return 1

    run(args.root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
