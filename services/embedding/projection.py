"""
Deterministic Random Projection to 512 dimensions.

Uses a fixed-seed (1337) random Gaussian matrix to project an embedding of
any dimension to exactly 512 dims.  The matrix is column-normalised so that
each output dimension receives unit-scale contributions, improving numeric
stability after L2 normalisation.

Cache behaviour:
    * In-memory dict keyed by input_dim – avoids re-computation within a run.
    * On-disk npy file under services/embedding/artifacts/ – ensures identical
      output across separate processes.
"""

import os
import numpy as np

TARGET_DIM: int = 512
PROJ_SEED: int = 1337
ARTIFACTS_DIR: str = os.path.join(os.path.dirname(__file__), "artifacts")

_cache: dict = {}  # input_dim -> np.ndarray(input_dim, 512, float32)


def get_projection_matrix(input_dim: int) -> np.ndarray:
    """
    Return a (input_dim, 512) float32 projection matrix.

    Matrix is generated once with a fixed seed, column-normalised, cached in
    memory, and persisted to ARTIFACTS_DIR/proj_{input_dim}_512.npy.
    """
    if input_dim in _cache:
        return _cache[input_dim]

    npy_path = os.path.join(ARTIFACTS_DIR, f"proj_{input_dim}_{TARGET_DIM}.npy")

    if os.path.exists(npy_path):
        mat = np.load(npy_path).astype(np.float32)
    else:
        rng = np.random.RandomState(PROJ_SEED)
        mat = rng.randn(input_dim, TARGET_DIM).astype(np.float32)
        # Column-normalise: each output dimension has unit L2 scale
        col_norms = np.linalg.norm(mat, axis=0, keepdims=True)
        col_norms = np.where(col_norms < 1e-10, 1.0, col_norms)
        mat = (mat / col_norms).astype(np.float32)
        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        np.save(npy_path, mat)

    _cache[input_dim] = mat
    return mat


def project_to_512(vec: np.ndarray) -> np.ndarray:
    """
    Project a 1-D embedding vector to exactly 512 dimensions.

    Args:
        vec: 1-D numpy array of any length d (float32 or float64).

    Returns:
        1-D float32 numpy array of length 512.

    Raises:
        ValueError: if vec is not 1-D.
    """
    if vec.ndim != 1:
        raise ValueError(f"Expected 1-D vector, got shape {vec.shape}")

    d = vec.shape[0]
    if d == TARGET_DIM:
        return vec.astype(np.float32)

    proj = get_projection_matrix(d)                          # (d, 512)
    # errstate: float32 BLAS matmul can raise FP exception flags (overflow,
    # divide-by-zero in subnormal arithmetic) that don't affect the result.
    # We check finiteness explicitly in the callers.
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        return (vec.astype(np.float32) @ proj)              # (512,)
