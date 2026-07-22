#!/usr/bin/env python3
"""Vision must not fabricate neutral sentiment for clip_v1."""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.vision import main as vision_main  # noqa: E402


class StubBackend:
    def __init__(self, name: str, sentiment: float | None = None) -> None:
        self.name = name
        self.model_id = "stub/model"
        self.device = "cpu"
        self.warm = True
        self.sentiment = sentiment

    def describe(self, **_kwargs):
        result = {
            "tags": ["ramen"],
            "scores": [{"tag": "ramen", "score": 0.8}],
            "cues": ["ramen"],
            "vision_type": "food",
            "confidence": 0.8,
        }
        if self.sentiment is not None:
            result["sentiment"] = self.sentiment
        return result


def main() -> None:
    original = vision_main.get_backend
    client = TestClient(vision_main.app)
    try:
        vision_main.get_backend = lambda: StubBackend("clip_v1")
        clip = client.post(
            "/describe",
            json={"data": {"image_base64": "stub", "caption_text": "terrible"}},
        )
        assert clip.status_code == 200, clip.text
        assert clip.json()["sentiment"] is None, clip.json()
        assert clip.json()["sentiment_source"] is None, clip.json()

        vision_main.get_backend = lambda: StubBackend("cloud_v1", sentiment=0.15)
        cloud = client.post(
            "/describe",
            json={"data": {"image_base64": "stub", "caption_text": "terrible"}},
        )
        assert cloud.status_code == 200, cloud.text
        assert cloud.json()["sentiment"] == 0.15, cloud.json()
        assert cloud.json()["sentiment_source"] == "cloud_caption_v1", cloud.json()

        print("vision_sentiment_contract: PASS")
    finally:
        vision_main.get_backend = original


if __name__ == "__main__":
    main()
