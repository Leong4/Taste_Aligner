# Vision Pipeline Fix Report

## 1 Removed rule_v0

### What was removed
- Removed `rule_v0` backend implementation from [services/vision/backends.py](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/vision/backends.py).
- Removed legacy rule-based module [services/vision/vision_core.py](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/vision/vision_core.py).
- Removed `dev_up` default/fallback path to `rule_v0` in [scripts/dev_up.sh](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh).

### Enforcement
- `get_backend()` now allows only `clip_v1` (plus reserved `cloud_v1` not implemented).
- `vision_describe` skill rejects non-`clip_v1` payloads as `invalid_output`.

## 2 CLIP Backend Integration

### Backend
- [services/vision/backends.py](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/vision/backends.py)
  - CLIP-only backend (`ClipV1Backend`) kept as primary path.
  - Added required zero-shot labels: `food`, `dish`, `restaurant`, `seafood`, `beach`, `seaside`, `coast`, `landscape`, `architecture`, `cityscape`, `mountain`, `nature`.
  - Added robust image decoding for both:
    - raw base64
    - data URL (`data:image/...;base64,...`)

### Type classification
- Vision type now computed from CLIP score pools:
  - `food`
  - `scenery`
  - `other`
- `unknown` is no longer produced in normal CLIP inference; it is reserved for failure/fallback paths.

## 3 Vision Output Schema

### Vision service output (`/describe`)
- [services/vision/main.py](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/vision/main.py)
- Response now includes:
  - `vision_type`
  - `type` (compat alias)
  - `cues`
  - `tags`
  - `confidence`
  - `raw.scores`

### Agent skill output (`vision_describe`)
- [agent_runtime/src/skills/vision_describe.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/skills/vision_describe.ts)
- Skill now outputs:
  - `vision_features`
  - `vision_type`
  - `cues`
  - `tags`
  - `confidence`
- Decision trace now includes:
  - `vision_type`
  - `cues_count`
  - `confidence`
  - `cues`
  - `tags`

## 4 Vision → Memory Data Flow

### Wiring
- [agent_runtime/src/core/graph_definition.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/core/graph_definition.ts)
  - `vision_describe` now receives `caption_text` from `input.caption`.
  - `tes_builder` now receives:
    - `vision_features`
    - `vision_tags` (from `vision_describe.tags`)
    - `vision_type`

### Tes builder ingestion
- [agent_runtime/src/skills/tes_builder.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/skills/tes_builder.ts)
  - Added `vision_tags` input support.
  - For upload memory write, if anchor/normalized tags are empty, it now falls back to vision semantic tags.
  - Memory write payload includes `vision_type`, `raw_tags`, `normalized_tags` on main upload path.

## 5 Tag Generation Logic

### New tag composition (CLIP-first)
- Implemented in [services/vision/backends.py](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/vision/backends.py):
  1. CLIP top label scores (`raw.scores`)
  2. `cues` from top-scoring CLIP labels
  3. `caption_text` phrase extraction
  4. simple noun token extraction from caption
  5. deterministic dedupe and cap (`tags` capped to 1–5)

### Confidence
- Added deterministic `confidence` in [0,1] based on top CLIP score and separation from runner-up.

## 6 Memory Write Fix

### invalid_data_url / 422 mitigation
- [agent_runtime/src/skills/tes_builder.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/skills/tes_builder.ts)
  - Added `normalizeDataUrl()` to ensure payloads are always legal data URLs.
  - `image_base64` (original) and `image_vision_input_base64` are normalized before `memory.write`.
  - Prevents malformed raw base64 payloads from triggering `invalid_data_url` in memory service.

### memory.write response behavior
- Memory service returns `memory_id` on successful write and treats a same-user repeat as an idempotent replay.
- Graph v14 moved the write into `persist_memory`, which waits for acknowledgement and reports `persisted` or `failed`; `tes_builder` no longer has a persistence side effect.

## 7 Startup Commands

### Script update
- [scripts/dev_up.sh](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/scripts/dev_up.sh)
  - Default vision backend changed to `clip_v1`.
  - Non-clip backend now hard-fails.

### Recommended startup sequence
```bash
./scripts/dev_down.sh
ollama serve &
./scripts/dev_up.sh --with-llm --with-vision
```

### Notes
- `--with-llm` enables real LLM path (requires `LLM_API_KEY` / provider config).
- `--with-vision` starts CLIP vision service on `:5002`.

## 8 Validation Steps

### Automated checks run
```bash
node tests/agent_runtime_core_tests/test_vision_describe.js
node tests/agent_runtime_core_tests/test_memory_write_integration.js
node tests/agent_runtime_core_tests/run.js
python3 -m py_compile services/vision/backends.py services/vision/main.py services/memory/main.py
```

### Result summary
- `test_vision_describe`: PASS
- `test_memory_write_integration`: PASS
- `agent_runtime_core_tests/run.js`: PASS
- Python syntax check: PASS

### UI validation steps
1. Start services with `./scripts/dev_up.sh --with-llm --with-vision`.
2. Import a food image from UI Import page.
3. Confirm in response and modal:
   - `vision_type = food`
   - `tags` non-empty (1–5)
4. Import a scenery image.
5. Confirm:
   - `vision_type = scenery` or `other` (but not generic unknown on success)
   - `tags` non-empty
6. Open Library + MemoryModal and verify `vision_type`, `raw_tags`, `normalized_tags`, `sentiment` are visible.
