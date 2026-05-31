#!/usr/bin/env python3
"""
Contract test for memory image asset split:
  - original is preserved
  - preview / thumb / vision_input are generated
  - /files variant routing works (thumb|preview|original)

Run from repo root:
  python3 tests/service_tests/memory_asset_split_contract.py
"""

import base64
import io
import os
import shutil
import sys
import uuid
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.memory import main as memory_main  # noqa: E402
from services.memory import db as memory_db  # noqa: E402


def _to_data_url(img_bytes: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(img_bytes).decode('ascii')}"


def _make_jpeg(width: int, height: int, color: tuple[int, int, int]) -> bytes:
    img = Image.new("RGB", (width, height), color=color)
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()


def _make_png(width: int, height: int, color: tuple[int, int, int]) -> bytes:
    img = Image.new("RGB", (width, height), color=color)
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def main() -> None:
    suffix = uuid.uuid4().hex[:10]
    memory_dir = Path(memory_main.__file__).resolve().parent
    test_upload_root = memory_dir / f"uploads_asset_test_{suffix}"
    test_db_path = memory_dir / f"memory_asset_test_{suffix}.db"

    original_upload_root = memory_main.UPLOAD_ROOT
    original_db_path = memory_db.DB_PATH

    test_upload_root.mkdir(parents=True, exist_ok=True)
    memory_main.UPLOAD_ROOT = test_upload_root
    memory_db.DB_PATH = test_db_path

    try:
        memory_db.init_database()

        memory_id = f"asset_split_{suffix}"
        user_id = "asset_split_user"
        original_bytes = _make_jpeg(2200, 1400, (220, 130, 70))
        vision_input_bytes = _make_png(900, 600, (70, 120, 220))

        memory_record = {
            "memory_id": memory_id,
            "user_id": user_id,
            "timestamp": "2026-03-09T00:00:00Z",
            "city": "tokyo",
            "raw_tags": ["ramen"],
            "normalized_tags": ["ramen"],
            "sentiment": 0.3,
            "embedding": [1.0] + [0.0] * 511,
            "source": "upload",
            "image_base64": _to_data_url(original_bytes, "image/jpeg"),
            "image_vision_input_base64": _to_data_url(vision_input_bytes, "image/png"),
            "caption_text": "asset split test",
            "vision_type": "food",
        }

        memory_main._save_image_assets(memory_record)

        required_path_keys = [
            "image_original_path",
            "image_preview_path",
            "image_thumbnail_path",
            "image_vision_input_path",
        ]
        for key in required_path_keys:
            assert key in memory_record and memory_record[key], f"{key} must be set"
            resolved = memory_main._resolve_upload_path(memory_record[key])
            assert resolved is not None and resolved.exists(), f"{key} file must exist"

        original_abs = memory_main._resolve_upload_path(memory_record["image_original_path"])
        preview_abs = memory_main._resolve_upload_path(memory_record["image_preview_path"])
        thumb_abs = memory_main._resolve_upload_path(memory_record["image_thumbnail_path"])
        vision_abs = memory_main._resolve_upload_path(memory_record["image_vision_input_path"])

        assert original_abs is not None
        assert preview_abs is not None
        assert thumb_abs is not None
        assert vision_abs is not None

        # original must remain untouched bytes
        assert original_abs.read_bytes() == original_bytes, "original bytes must be preserved"

        with Image.open(preview_abs) as img:
            assert img.width <= memory_main.PREVIEW_MAX_WIDTH, "preview width must be capped"
        with Image.open(thumb_abs) as img:
            assert img.width <= memory_main.THUMB_MAX_WIDTH, "thumb width must be capped"
        with Image.open(vision_abs) as img:
            assert img.width <= memory_main.VISION_INPUT_MAX_WIDTH, "vision_input width must be capped"

        assert vision_abs.stat().st_size < original_abs.stat().st_size, (
            "vision_input should be smaller than original for model ingestion"
        )

        write_resp = memory_db.write_memory(memory_record)
        assert write_resp["ok"] is True

        client = TestClient(memory_main.app)
        thumb_resp = client.get(f"/files/{memory_id}?variant=thumb")
        preview_resp = client.get(f"/files/{memory_id}?variant=preview")
        original_resp = client.get(f"/files/{memory_id}?variant=original")

        assert thumb_resp.status_code == 200, "thumb variant should be served"
        assert preview_resp.status_code == 200, "preview variant should be served"
        assert original_resp.status_code == 200, "original variant should be served"
        assert original_resp.content == original_bytes, "original variant must return preserved original bytes"
        assert thumb_resp.headers.get("content-type", "").startswith("image/")
        assert preview_resp.headers.get("content-type", "").startswith("image/")
        assert original_resp.headers.get("content-type", "").startswith("image/")

        print("memory_asset_split_contract: PASS")
    finally:
        memory_main.UPLOAD_ROOT = original_upload_root
        memory_db.DB_PATH = original_db_path
        if test_db_path.exists():
            test_db_path.unlink()
        if test_upload_root.exists():
            shutil.rmtree(test_upload_root, ignore_errors=True)


if __name__ == "__main__":
    main()

