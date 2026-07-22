# Local Development Guide

One-command workflows for starting, stopping, checking status, and verifying
the Taste_Aligner service stack on a developer machine.

---

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| `python3 ≥ 3.11` | All Python services | `brew install python` |
| `pip` deps | Service dependencies | `pip install -r services/embedding/requirements.txt` (and per-service) |
| `mvn ≥ 3.8` | Java gateway | `brew install maven` |
| `node ≥ 18 + npm` | Agent runtime | `brew install node` |
| `curl` | Health probes | pre-installed on macOS |
| `nc` (netcat) | agent_runtime TCP probe | pre-installed on macOS |

> **Virtual environment (recommended):**
> ```bash
> python3 -m venv .venv && source .venv/bin/activate
> pip install -r services/embedding/requirements.txt
> # Repeat for each service that has a requirements.txt
> ```

### Core test runtime (agent_runtime/src)

`tests/agent_runtime_core_tests/*.js` now load **`agent_runtime/src/*` directly**
via `ts-node` (no fallback to `dist`).

Run once:
```bash
cd agent_runtime
npm install
npm i -D ts-node
```

If `ts-node` is missing, core tests exit non-zero with an explicit install hint.

---

## Default vs Core mode

### Default startup (all services)
`./scripts/dev_up.sh` now starts core + vision + ontology by default.

### Core services (`--core`)
Use `./scripts/dev_up.sh --core` for the minimal `/run` stack:

| Service | Port | Notes |
|---------|------|-------|
| memory | 5001 | SQLite-backed taste memory |
| embedding | 5004 | Sentence-Transformers (st_v1), 512-dim TES vectors |
| recommendation | 5005 | Two-stage recall+rerank over seeded SQLite DB |
| planner | 5006 | Trip card composer |
| gateway | 8080 | Java HTTP proxy / tool router |
| agent_runtime | 8787 | Node.js orchestrator; `POST /run` entry point |

### Additional services (included by default, can be disabled via `--core`)

| Service | Port | Flag | Pipeline |
|---------|------|------|----------|
| vision | 5002 | on by default; also `--with-vision` | **Wired** — `vision_describe` node reads `image_url`/`image_base64` from `/run` input and enriches TES (gateway `services.vision` also points to `http://localhost:5002`) |
| ontology | 5003 | on by default; also `--with-ontology` | Standalone (not yet in `/run` pipeline) |

---

## One-command workflows

### Start (default: all services)
```bash
./scripts/dev_up.sh
```
Starts core + vision + ontology, waits for health checks, then runs `dev_verify`.

### Start (core only)
```bash
./scripts/dev_up.sh --core
```
Starts only memory/embedding/recommendation/planner/gateway/agent_runtime.

### Start (core + optional)
```bash
./scripts/dev_up.sh --all               # same as default (idempotent)
./scripts/dev_up.sh --core --with-vision       # core + vision only
./scripts/dev_up.sh --core --with-ontology     # core + ontology only
```
When vision is started it is **wired into `/run`**: passing `image_url` or
`image_base64` triggers the `vision_describe` graph node and enriches TES.
`dev_up.sh` defaults to `VISION_BACKEND=rule_v0` (offline, no open_clip dependency).

### Start without auto-verify
```bash
./scripts/dev_up.sh --no-verify
```

### Custom log directory
```bash
./scripts/dev_up.sh --logs-dir /tmp/ta-logs
```

---

### Stop
```bash
./scripts/dev_down.sh
```
Reads `logs/pids.env`, sends SIGTERM (then SIGKILL if needed) to each process
and its children.

If the PID file is missing (e.g. services were started manually), falls back to
port-based detection and only kills processes whose binary matches the expected
service type.

---

### Status
```bash
./scripts/dev_status.sh
```
Prints a table with service name, port, PID, HTTP health status, and for the
embedding service the current backend and warm state.

Example output:
```
SERVICE              PORT   PID      STATUS     DETAIL
────────────────────────────────────────────────────────────────────────
memory               5001   91234    UP
embedding            5004   91235    UP         backend=st_v1  warm=True
recommendation       5005   91236    UP
planner              5006   91237    UP
gateway              8080   91238    UP
agent_runtime        8787   91239    UP         (tcp only)
vision               5002   91240    UP         backend=rule_v0  warm=True
ontology             5003   91241    UP
────────────────────────────────────────────────────────────────────────
  All services healthy
```

---

### Verify
```bash
./scripts/dev_verify.sh
```
Runs verification stages in sequence:
1. `verify_run_e2e.sh` – port checks, all gateway tools, `/run` decision trace
2. `verify_st_v1_e2e.sh` – embedding st_v1 path, determinism, `/run` trace evidence
3. Quick smoke: `POST gateway /tool/recommendation.score` → HTTP 200 + valid JSON
4. Quick smoke: `POST agent_runtime /run` → HTTP 200 + `ok=true`
5. Vision smoke _(auto-run when vision is up, non-blocking optional check)_:
   - `POST gateway /tool/vision.describe` with base64 PNG → HTTP 200 + `tags` array
   - `POST agent_runtime /run` with `image_base64` → `decision_trace.vision_describe.used=true`

Exits **0** when all core checks pass. Optional vision/ontology smoke failures are
reported as warnings and do not fail the command.

---

### LLM integration smoke (OpenAI-compatible)

Verifies that the LLM-backed skills (`tag_expand`, `explain_from_trace`) are using
a real provider and not falling back to mock.  The test **skips** (exit 0) if
`LLM_API_KEY` is not set, so it is safe to run in offline CI.

> **Default behavior:** `dev_up.sh` starts agent_runtime with the **mock** LLM
> adapter even if `LLM_API_KEY` is set in your shell or `.env.local`.  Pass
> `--with-llm` to opt in to the real LLM adapter.

**Prerequisites:**
- agent_runtime must be running with real LLM enabled (`--with-llm`)

**Setup — example for OpenAI `gpt-4o-mini`:**
```bash
export LLM_PROVIDER=openai_compat
export LLM_MODEL=gpt-4o-mini
export LLM_API_KEY=sk-...          # your OpenAI key
# export LLM_BASE_URL=...          # optional; omit to use OpenAI default
```

**Start the stack with real LLM enabled:**
```bash
./scripts/dev_up.sh --with-llm             # starts all services + enables real LLM
./scripts/dev_up.sh --with-llm --no-verify # skip auto-verify if you want faster startup
```

Without `--with-llm` the LLM env vars are unset from the agent_runtime process
environment, so the adapter always falls back to mock regardless of what is in
your shell.

**Run the smoke:**
```bash
node tests/integration/agent_llm_openai_compat_smoke.js
```

**With a different base URL (e.g. Qwen or local proxy):**
```bash
export LLM_PROVIDER=openai_compat
export LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export LLM_MODEL=qwen-plus
export LLM_API_KEY=sk-...
./scripts/dev_up.sh --with-llm --no-verify
node tests/integration/agent_llm_openai_compat_smoke.js
```

The smoke checks:
- HTTP 200 + valid JSON from `/run`
- No `NaN`/`Infinity` tokens in the response
- `decision_trace.tag_expand.llm_call.provider === "openai_compat"` and `fallback_used=false`
- `decision_trace.explain_from_trace.llm_call.provider === "openai_compat"` and `fallback_used=false`
- `tag_expand.llm_call.usage.total_tokens` does not exceed `TAG_EXPAND_MAX_TOTAL_TOKENS` (default 800)
- Determinism gate: two sequential `/run` calls with identical payload produce identical normalized traces

---

## Quick curl samples

```bash
# Check embedding backend
curl -s http://localhost:5004/health | python3 -m json.tool

# Build a TES vector (st_v1 path)
curl -s -X POST http://localhost:5004/tes/build \
  -H 'Content-Type: application/json' \
  -d '{"tags":["ramen","casual"],"vision_features":["outdoor"],"normalize":true}' \
  | python3 -m json.tool

# Score recommendations via gateway
curl -s -X POST http://localhost:8080/tool/recommendation.score \
  -H 'Content-Type: application/json' \
  -d '{"data":{"user_id":"u001","city":"tokyo","tags":["ramen"],"intent":"casual","memory_confidence":0.5}}' \
  | python3 -m json.tool

# Full /run pipeline (text only)
curl -s -X POST http://localhost:8787/run \
  -H 'Content-Type: application/json' \
  -d '{"text":"I want ramen in Tokyo for dinner","user_id":"u001"}' \
  | python3 -m json.tool

# Full /run pipeline with vision (enabled by default; disable via --core)
# Pass image_url OR image_base64; the vision_describe node fires automatically.
curl -s -X POST http://localhost:8787/run \
  -H 'Content-Type: application/json' \
  -d '{"text":"ramen in Tokyo","user_id":"u001","image_url":"https://example.com/dish.jpg"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); vd=d.get('decision_trace',{}).get('vision_describe',{}); print('used:', vd.get('used'), '| tags:', vd.get('tags_count'), '| backend:', vd.get('backend'))"

# Test vision.describe gateway directly
curl -s -X POST http://localhost:8080/tool/vision.describe \
  -H 'Content-Type: application/json' \
  -d '{"data":{"image_base64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","top_k":10}}' \
  | python3 -m json.tool
```

---

## Common failure cases

### Port already in use
```
[dev_up] ERROR: Port 5004 is occupied by an unexpected process (PID=12345).
                Stop it first or run:  ./scripts/dev_down.sh
```
**Fix:** Run `./scripts/dev_down.sh` to stop previously started services, or
manually kill the process with `kill 12345`.

---

### Embedding cold start (model download)
```
[dev_up]   attempt 12/60
```
On first run the `all-MiniLM-L6-v2` model (~90 MB) is downloaded from
Hugging Face.  This can take 1–3 minutes depending on network speed.
The script allows up to 3 minutes before timing out.

**Fix:** Let it finish.  Subsequent starts are fast (model is cached in
`~/.cache/huggingface/`).

---

### Embedding backend is hash_v2 instead of st_v1
```
[dev_up] ERROR: Embedding backend='hash_v2', expected 'st_v1'.
```
The embedding process may have started with the wrong environment variable.

**Fix:**
1. Check `logs/embedding.log` for errors.
2. Ensure `EMBEDDING_BACKEND` is not set to `hash_v2` in your shell:
   ```bash
   unset EMBEDDING_BACKEND
   ./scripts/dev_down.sh && ./scripts/dev_up.sh
   ```

---

### Missing Python venv / import errors
```
ModuleNotFoundError: No module named 'sentence_transformers'
```
**Fix:** Activate your virtual environment and install dependencies:
```bash
source .venv/bin/activate
pip install -r services/embedding/requirements.txt
```

---

### Gateway fails to start (Maven not found)
```
[dev_up] Required tool not in PATH: mvn
```
**Fix:** Install Maven: `brew install maven`

---

### Recommendation DB not seeded
The script auto-seeds on first run.  If seeding fails:
```bash
python3 scripts/seed_reco_db.py
```

---

### Vision service requires open_clip_torch (clip_v1 backend)
```
RuntimeError: VISION_BACKEND=clip_v1 requires open_clip_torch.
```
clip_v1 pulls PyTorch and CLIP (~2 GB on first install).

**Fix (option A):** Install the dependency:
```bash
pip install open_clip_torch
```
**Fix (option B):** Use the lightweight keyword backend (also the default in `dev_up.sh`):
```bash
VISION_BACKEND=rule_v0 python3 -m uvicorn services.vision.main:app --port 5002
```

---

### Vision node falls back silently (no_image)
If `/run` returns `decision_trace.vision_describe.fallback_reason="no_image"`, the
request was sent without `image_url` or `image_base64`.  This is expected for
text-only requests — the node skips the gateway call and returns an empty
`vision_features` list.

---

### Agent runtime npm errors
If `agent_runtime/node_modules` is absent the script auto-runs `npm install`.
If that fails:
```bash
cd agent_runtime && npm install && cd ..
./scripts/dev_up.sh
```

---

## Log files

All logs are written to `./logs/` (or `--logs-dir`):

| File | Service |
|------|---------|
| `memory.log` | memory (5001) |
| `embedding.log` | embedding (5004) |
| `recommendation.log` | recommendation (5005) |
| `planner.log` | planner (5006) |
| `gateway.log` | gateway (8080) |
| `agent_runtime.log` | agent_runtime (8787) |
| `vision.log` | vision (5002, default unless `--core`) |
| `ontology.log` | ontology (5003, default unless `--core`) |
| `pids.env` | PID registry (bash key=value) |
