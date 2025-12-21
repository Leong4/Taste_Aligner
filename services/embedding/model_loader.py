from typing import Any, Dict


class DummyEmbeddingModel:
    def __init__(self, name: str = "dummy-embedding-model"):
        self.name = name

    def encode(self, text: str) -> Dict[str, Any]:
        return {"text": text, "model": self.name}


def load_model() -> DummyEmbeddingModel:
    return DummyEmbeddingModel()

