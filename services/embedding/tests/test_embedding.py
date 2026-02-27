"""
Embedding Service Tests
=======================

Organised in three sections:

1. Contract tests   – verify the TES v2 response shape for *any* backend via
                      FastAPI TestClient.  These tests reset the backend
                      singleton between runs so they can exercise both
                      hash_v2 and (optionally) st_v1.

2. hash_v2 tests    – determinism and edge-case tests that do NOT require
                      sentence-transformers.

3. st_v1 tests      – backend-specific tests that are skipped automatically
                      when sentence-transformers is not installed.

Usage
-----
# Run all tests (skips st_v1 if sentence-transformers absent):
    pytest services/embedding/tests/

# Run only contract tests:
    pytest services/embedding/tests/ -k "contract"

# Run with st_v1:
    EMBEDDING_BACKEND=st_v1 pytest services/embedding/tests/
"""

import importlib
import importlib.util
import math
import os
from typing import Any, Dict

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Helper: reset the backend singleton and re-read env vars
# ---------------------------------------------------------------------------

def _reset_backend(backend_name: str) -> None:
    """Force the singleton to reinitialise with a new backend name."""
    os.environ["EMBEDDING_BACKEND"] = backend_name
    import services.embedding.backends as b
    b._instance = None


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_PAYLOAD: Dict[str, Any] = {
    "tags": ["ramen", "japanese", "casual"],
    "vision_features": ["outdoor", "night"],
    "sentiment": 0.5,
    "recency_days": 3.0,
    "location": "Tokyo",
}

MINIMAL_PAYLOAD: Dict[str, Any] = {
    "tags": ["coffee"],
}


@pytest.fixture(autouse=True)
def isolate_backend(monkeypatch):
    """Reset the backend singleton after each test."""
    yield
    import services.embedding.backends as b
    b._instance = None


# ---------------------------------------------------------------------------
# 1. Contract tests (work with any configured backend)
# ---------------------------------------------------------------------------

class TestTESv2Contract:
    """The response shape of POST /tes/build must be stable regardless of backend."""

    def _make_client(self, backend: str):
        _reset_backend(backend)
        from services.embedding.main import app
        from fastapi.testclient import TestClient
        return TestClient(app)

    @pytest.mark.parametrize("backend", ["hash_v2"])
    def test_returns_512_dim_vector(self, backend):
        client = self._make_client(backend)
        resp = client.post("/tes/build", json=SAMPLE_PAYLOAD)
        assert resp.status_code == 200, resp.text
        data = resp.json()

        assert data["dim"] == 512
        assert len(data["vector"]) == 512
        assert all(math.isfinite(v) for v in data["vector"])

    @pytest.mark.parametrize("backend", ["hash_v2"])
    def test_meta_fields_present(self, backend):
        client = self._make_client(backend)
        resp = client.post("/tes/build", json=SAMPLE_PAYLOAD)
        meta = resp.json()["meta"]

        assert meta["tes_version"] == "2.0"
        assert meta["backend"] == backend
        assert "model_id" in meta
        assert "device" in meta
        assert "warm" in meta
        assert "inputs_summary" in meta

    @pytest.mark.parametrize("backend", ["hash_v2"])
    def test_components_structure(self, backend):
        client = self._make_client(backend)
        resp = client.post("/tes/build", json=SAMPLE_PAYLOAD)
        comps = resp.json()["components"]

        assert comps["vision_dim"] == 128
        assert comps["tag_dim"] == 256
        assert comps["scalar_dim"] == 128

    @pytest.mark.parametrize("backend", ["hash_v2"])
    def test_normalized_true_when_requested(self, backend):
        payload = {**SAMPLE_PAYLOAD, "normalize": True}
        client = self._make_client(backend)
        resp = client.post("/tes/build", json=payload)
        data = resp.json()

        assert data["normalized"] is True
        norm = math.sqrt(sum(v * v for v in data["vector"]))
        assert abs(norm - 1.0) < 1e-3, f"Expected unit norm, got {norm}"

    @pytest.mark.parametrize("backend", ["hash_v2"])
    def test_normalized_false_when_not_requested(self, backend):
        payload = {**SAMPLE_PAYLOAD, "normalize": False}
        client = self._make_client(backend)
        resp = client.post("/tes/build", json=payload)
        data = resp.json()

        assert data["normalized"] is False

    def test_422_on_empty_payload(self):
        client = self._make_client("hash_v2")
        resp = client.post("/tes/build", json={})
        assert resp.status_code == 422

    def test_422_on_infinite_sentiment(self):
        # JSON does not support Infinity literals; send raw bytes so Python's
        # json.loads parses 1e999 as float('inf'), which our endpoint must reject.
        client = self._make_client("hash_v2")
        resp = client.post(
            "/tes/build",
            content=b'{"tags": ["x"], "sentiment": 1e999}',
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422

    def test_health_returns_backend_info(self):
        _reset_backend("hash_v2")
        from services.embedding.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert "backend" in data
        assert "warm" in data
        assert "device" in data


# ---------------------------------------------------------------------------
# 2. hash_v2 tests
# ---------------------------------------------------------------------------

class TestHashV2Backend:
    """Determinism and correctness tests for the hash_v2 backend."""

    def setup_method(self):
        _reset_backend("hash_v2")
        from services.embedding.embedding_core import build_tes_vector_v2
        self.build = build_tes_vector_v2

    def test_deterministic_same_input(self):
        kwargs = dict(
            vision_features=["outdoor", "night"],
            tags=["ramen", "casual"],
            sentiment=0.3,
            recency_days=7.0,
            location="Tokyo",
            normalize=True,
        )
        r1 = self.build(**kwargs)
        r2 = self.build(**kwargs)
        assert r1["vector"] == r2["vector"], "hash_v2 is not deterministic"

    def test_order_independent_tags(self):
        """Same tags in different order must produce the same vector."""
        base = dict(vision_features=[], sentiment=None, recency_days=None, location=None, normalize=True)
        r1 = self.build(tags=["ramen", "casual", "japanese"], **base)
        r2 = self.build(tags=["japanese", "ramen", "casual"], **base)
        assert r1["vector"] == r2["vector"]

    def test_minimal_payload(self):
        result = self.build(
            vision_features=None, tags=["coffee"], sentiment=None,
            recency_days=None, location=None, normalize=True
        )
        assert result["dim"] == 512
        assert len(result["vector"]) == 512
        assert result["meta"]["backend"] == "hash_v2"


# ---------------------------------------------------------------------------
# 3. st_v1 tests
# ---------------------------------------------------------------------------

st_v1_available = pytest.mark.skipif(
    importlib.util.find_spec("sentence_transformers") is None,
    reason="sentence-transformers not installed",
)


class TestSTBackend:
    """Tests for the st_v1 Sentence-Transformers backend."""

    @st_v1_available
    def test_encode_to_512_shape(self):
        from services.embedding.backends import STBackend
        backend = STBackend(
            model_id="sentence-transformers/all-MiniLM-L6-v2", device="cpu"
        )
        vec = backend.encode_to_512(
            tags=["ramen"], vision_features=["outdoor"],
            location="Tokyo", sentiment=0.5, recency_days=3.0,
        )
        assert vec.shape == (512,), f"Expected (512,), got {vec.shape}"
        assert vec.dtype == np.float32
        assert np.all(np.isfinite(vec))

    @st_v1_available
    def test_deterministic_within_process(self):
        from services.embedding.backends import STBackend
        backend = STBackend(
            model_id="sentence-transformers/all-MiniLM-L6-v2", device="cpu"
        )
        kwargs = dict(
            tags=["ramen", "casual"],
            vision_features=["outdoor"],
            location="Tokyo",
            sentiment=0.3,
            recency_days=5.0,
        )
        vec1 = backend.encode_to_512(**kwargs)
        vec2 = backend.encode_to_512(**kwargs)
        assert np.allclose(vec1, vec2, atol=1e-6), "st_v1 is not deterministic within process"

    @st_v1_available
    def test_projection_is_repeatable_across_instances(self):
        """Two separate STBackend instances must return identical vectors."""
        from services.embedding.backends import STBackend
        kwargs = dict(
            tags=["sushi"], vision_features=[], location=None,
            sentiment=0.0, recency_days=1.0,
        )
        b1 = STBackend("sentence-transformers/all-MiniLM-L6-v2", "cpu")
        b2 = STBackend("sentence-transformers/all-MiniLM-L6-v2", "cpu")
        v1 = b1.encode_to_512(**kwargs)
        v2 = b2.encode_to_512(**kwargs)
        assert np.allclose(v1, v2, atol=1e-6)

    @st_v1_available
    def test_build_text_order_independent(self):
        from services.embedding.backends import STBackend
        t1 = STBackend.build_text(["ramen", "casual"], ["outdoor"], "Tokyo", 0.5, 3.0)
        t2 = STBackend.build_text(["casual", "ramen"], ["outdoor"], "Tokyo", 0.5, 3.0)
        assert t1 == t2, "build_text is not order-independent"

    @st_v1_available
    def test_full_stack_st_v1_returns_512(self, monkeypatch):
        _reset_backend("st_v1")
        from services.embedding.embedding_core import build_tes_vector_v2
        result = build_tes_vector_v2(
            vision_features=["outdoor"],
            tags=["ramen"],
            sentiment=0.4,
            recency_days=2.0,
            location="Shibuya",
            normalize=True,
        )
        assert result["dim"] == 512
        assert len(result["vector"]) == 512
        assert result["normalized"] is True
        assert result["meta"]["backend"] == "st_v1"
        assert result["meta"]["tes_version"] == "2.0"
        assert result["meta"]["warm"] is True
        norm = math.sqrt(sum(v * v for v in result["vector"]))
        assert abs(norm - 1.0) < 1e-3


# ---------------------------------------------------------------------------
# 4. Projection tests (no model needed)
# ---------------------------------------------------------------------------

class TestProjection:
    # Use a seeded RNG with modest values to avoid float32 overflow warnings
    _rng = np.random.RandomState(42)

    def test_project_to_512_shape(self):
        from services.embedding.projection import project_to_512
        vec = self._rng.uniform(-0.5, 0.5, 384).astype(np.float32)
        out = project_to_512(vec)
        assert out.shape == (512,)
        assert out.dtype == np.float32

    def test_project_identity_for_512_input(self):
        from services.embedding.projection import project_to_512
        vec = self._rng.uniform(-0.5, 0.5, 512).astype(np.float32)
        out = project_to_512(vec)
        assert np.allclose(out, vec)

    def test_project_deterministic(self):
        from services.embedding.projection import project_to_512
        vec = self._rng.uniform(-0.5, 0.5, 384).astype(np.float32)
        assert np.allclose(project_to_512(vec), project_to_512(vec))

    def test_project_rejects_2d(self):
        from services.embedding.projection import project_to_512
        with pytest.raises(ValueError):
            project_to_512(np.zeros((4, 384), dtype=np.float32))
