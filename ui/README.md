# Taste Aligner UI — MVP

Minimal Vite + React + TypeScript demo for the Taste_Aligner pipeline.
Three pages: **Import** (upload photo → memory), **Explore** (query → recommendations + anchors), **Library** (memory grid).

---

## Why Vite React (not Next.js)

Next.js App Router adds SSR, server components, and build complexity that aren't needed for a local demo.
Vite gives a simpler, faster DX with a built-in proxy that handles CORS without touching backend configs.
Setup time: < 5 minutes.

---

## System Endpoints Used

| Service | Port | Used by |
|---------|------|---------|
| agent_runtime | 8787 | `POST /run` — full pipeline, Import + Explore pages |
| memory | 5001 | `POST /search`, `GET /read/{id}` — Library + memory_id polling |

All requests go through the Vite dev-server proxy (`/api/agent` → 8787, `/api/memory` → 5001).
No CORS configuration required on the backend.

**Actual API contracts (read from source):**

`POST :8787/run` body:
```json
{ "text": "...", "user_id": "ui_demo_user", "image_base64": "data:image/jpeg;base64,..." }
```
Response top-level fields used:
- `ok`, `city`, `type`, `explanation`, `bullets`
- `output.cards[]` — each card: `{ zone, items: [{ item_id, name, city, type, score_breakdown, scores }] }`
- `decision_trace.vision_describe` — `{ used, type, cues[], backend }`
- `decision_trace.tes_builder` — `{ memory_persisted, memory_write_status }`
- `decision_trace.profile_vector_node` — `{ anchors: [{ memory_id, final_weight, w_time, w_sent, cosine }] }`
- `decision_trace.tag_normalize.normalized_tags[]`

`POST :5001/search` body:
```json
{ "data": { "user_id": "...", "query_tags": ["ramen"], "city": "tokyo", "top_k": 20, "now_ts": "ISO" } }
```
Returns `{ results: [{ memory_id, score, sim, w_time, w_sent, w_city, timestamp, city, normalized_tags }] }`

`GET :5001/read/{memory_id}` returns full memory object with `{ memory_id, user_id, timestamp, city, raw_tags, normalized_tags, taxonomy, sentiment, source, embedding }`.

---

## 1. Start the Backend

```bash
# From repo root — starts all services (memory, embedding, recommendation, planner, gateway, agent_runtime, vision)
./scripts/dev_up.sh

# With real LLM (optional — needs LLM_API_KEY in .env.local):
./scripts/dev_up.sh --with-llm
```

Wait until you see `ALL UP` and all health checks pass.

Check status anytime:
```bash
./scripts/dev_status.sh
```

---

## 2. Start the Frontend

```bash
cd ui
npm install
npm run dev
```

Open http://localhost:3000

---

## 3. End-to-End Verification

### Step A: Upload a food photo

1. Go to **Import** tab
2. Drag & drop a food photo (jpg/png/webp)
3. Click **Upload**
4. You should see:
   - `Vision type: food`
   - `Memory write: queued`
   - `Memory ID: mem_...` (polled from `/search` within 5 s)

### Step B: Upload a scenery photo

Repeat with a scenery photo. Note the second `Memory ID`.

### Step C: Query and verify anchors

1. Go to **Explore** tab
2. Query: `I want ramen in tokyo`
3. Click **Run**
4. In the **Memory Anchors** table, check that the `memory_id` values from Steps A and B appear — this confirms the uploaded memories influenced the recommendation.

### Step D: Check Library

1. Go to **Library** tab
2. Click **Refresh** if needed
3. Your uploaded memories should appear as tiles
4. Click a tile to see full detail: `memory_id`, `taxonomy`, `raw_tags`, `normalized_tags`

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Cannot reach agent_runtime" | Run `./scripts/dev_up.sh` first |
| "Cannot reach memory service" | Same — memory runs on port 5001 |
| Vision type is "unknown" | Normal with `rule_v0` backend — tags still processed |
| Memory ID not found after upload | Increase poll timeout in `api.ts:pollForNewMemory` (default 6 s) or check `logs/memory.log` |
| Anchors table is empty | Upload photos first, then query — new memories need time to propagate |
| Cards zones both empty | Check `decision_trace.extract_intent.city` — if city wasn't detected the pipeline may abort early |

---

## File Structure

```
ui/
  package.json
  vite.config.ts          # proxy /api/agent -> :8787, /api/memory -> :5001
  tsconfig.json
  index.html
  README.md
  src/
    main.tsx
    App.tsx               # tab navigation (Import / Explore / Library)
    App.css               # all styles — no external CSS framework
    types.ts              # RunResponse, Card, Anchor, SearchResult, MemoryDetail
    api.ts                # runPipeline(), searchMemory(), readMemory(), pollForNewMemory()
    pages/
      ImportPage.tsx      # upload photo -> /run -> poll memory_id
      ExplorePage.tsx     # text query -> /run -> cards + anchors + explanation
      LibraryPage.tsx     # /search -> grid -> click -> /read detail modal
    components/
      AnchorTable.tsx     # memory_id / final_weight / w_time / w_sent / cosine
      MemoryModal.tsx     # full memory detail modal
```
