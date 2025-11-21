# P5 Multimodal Memory Schema — V1.0 (English, Part 1–3)

This document defines the **P5 Multimodal Memory Unit** used in Taste Aligner V10.\
It covers **Part 1–3** of the full English specification, for Codex and backend implementation.

Contents in this part:

1. Definition & Design Goals of P5
2. Single P5 Memory Unit Schema
3. Storage & Indexing Design

---

## 1. What is P5? (Definition & Purpose)

**P5 = Personalized Multimodal Preference Profile.**

In Taste Aligner, P5 is the core structure used to store a user’s **real-world experiences** and **long-term preferences**. Each P5 memory unit corresponds to one concrete experience, for example:

- A restaurant or cafe the user actually visited
- A scenery spot or view the user photographed
- The user’s subjective feeling about that experience
- The time and place where it happened
- The learned multimodal embedding (TES vector) derived from it

So a single P5 memory is not just a log record; it is a **full piece of evidence** about the user’s taste, including:

> image → labels → style → sentiment → time → location → TES (930-dim vector)

In other words:

> **P5 Memory = The atomic unit of user preference learning.**

TES is the mathematical space; P5 is its concrete, real-world carrier.

---

### 1.1 Why does P5 exist?

Taste Aligner aims to provide **personalized journey recommendations**.

Traditional recommenders often:

- Only look at ratings (too shallow)
- Only use tags (too coarse)
- Ignore visual style / aesthetics
- Ignore emotional intensity
- Ignore temporal dynamics (no decay over time)

P5 fixes all of these weaknesses:

| Dimension | What P5 captures                                    |
| --------- | --------------------------------------------------- |
| Visual    | The actual image embedding from user uploads        |
| Semantic  | Cleaned, unified tags from the ontology             |
| Style     | The atmosphere / aesthetics the user prefers        |
| Emotion   | How much the user liked that experience             |
| Time      | Recency – newer memories weigh more                 |
| Location  | Geographic preference patterns                      |
| TES       | Full multimodal taste vector derived from all above |

P5 is the reason Taste Aligner can **remember who you are** in a stable, interpretable way.

---

### 1.2 Who uses P5?

#### (1) Memory Service

- Writes P5 records
- Reads P5 records
- Runs similarity search (memory.search)

#### (2) Recommendation Engine

- Learns comfort zone vs exploration zone
- Uses P5 items as item embeddings during scoring

#### (3) Taste Analyzer Agent

- Reads P5 to extract strong preference signals
- Builds the user’s Taste Profile (TES query vector)

#### (4) Planner Agent

- Uses P5 as **memory anchors** when composing Journey Cards
- Turns dry recommendations into personal stories

---

### 1.3 Design Principles

**Principle 1 — Each memory must be information-complete.**\
Every P5 item should contain:

- Image path or image reference
- Normalized labels
- Style tags (or null if none)
- Sentiment score
- Timestamp
- Location
- TES vector (930-dim)

**Principle 2 — Extensible.**\
P5 must support future extensions, such as:

- TES V2.0 (extra emotional/style/topic embeddings)
- Text/dialogue memories
- Video embeddings
- Social/contextual embeddings

**Principle 3 — Stable.**\
Field names should not change casually, ensuring:

- Vector store indices remain valid
- Gateway schemas do not break
- All Agents can rely on a consistent structure

**Principle 4 — Explainable.**\
Each memory unit should be explorable by Planner and UI, and usable as:

- Recommendation reason
- Personal memory anchor
- Evidence of preference patterns

---

## 2. Single P5 Memory Unit Schema

This section defines the canonical schema for **one P5 memory unit**.\
All backends (Memory Service, Embedding Service, Recommendation Engine) must treat this as the ground truth.

A P5 memory unit represents **one real user experience**.

---

### 2.1 Top-Level Structure

```ts
P5_Memory_Unit {
  memory_id: string,
  user_id: string,
  type: "food" | "scenery",

  raw_image: string | null,
  image_embedding: number[] | null,

  raw_labels: string[],
  normalized_labels: string[],
  style_tags: string[] | null,

  sentiment: number,              // [-1, 1]
  timestamp: string,              // ISO-8601

  location: {
    city: string | null,
    country: string | null
  },

  tes_embedding: number[],        // 930-dim TES vector

  source: string,                 // e.g. "user_upload" | "import"
  notes: string | null,           // user notes, e.g. "birthday ramen in Osaka"

  version: number                 // schema version, default 1
}
```

---

### 2.2 Field-by-field Description

**(1) memory\_id**

- Type: string (UUID)
- Purpose: unique identifier for one memory
- Used as primary key in DB and vector index

**(2) user\_id**

- Type: string
- Purpose: separate different users’ memory spaces
- Single-user prototype can use a fixed value like `"user_1"`

**(3) type**

- Type: `"food" | "scenery"`
- Purpose: steer recommendation mode and CZ/EZ weighting
- Source: mainly from vision.describe + ontology.normalize

---

#### Visual-related fields

**(4) raw\_image**

- Type: string | null (path or URI)
- Purpose:
  - display in Journey Card
  - allow re-embedding in the future

**(5) image\_embedding**

- Type: number[] | null (e.g. 512-dim CLIP)
- Purpose:
  - fallback for re-generating TES
  - debugging / analysis

TES is the final representation; `image_embedding` is an optional helper.

---

#### Label & Ontology fields

**(6) raw\_labels**

- Type: string[]
- Source: vision.describe

**(7) normalized\_labels**

- Type: string[]
- Source: ontology.normalize
- Purpose: stable tag space for tag embedding & recommendation

**(8) style\_tags**

- Type: string[] | null
- Source: vision.describe
- Purpose: build the 16-dim style\_embedding in TES

---

#### Sentiment / Time / Location

**(9) sentiment**

- Type: number (range [-1, 1])
- Purpose: maps directly to sentiment\_scalar in TES

**(10) timestamp**

- Type: string (ISO-8601)
- Purpose: used to compute recency\_scalar in TES

**(11) location**

```ts
location: {
  city: string | null,
  country: string | null
}
```

- Purpose: used to build the 16-dim location\_embedding

---

#### TES-related fields

**(12) tes\_embedding**

- Type: number[] (fixed length 930)
- Source: embedding.generate
- Uses:
  - main vector for memory.search (similarity search)
  - item embedding in recommendation.score

By definition:

> TES = visual(512) + tags(384) + style(16) + sentiment(1) + recency(1) + location(16)

---

#### Metadata fields

**(13) source**

- Type: string
- Examples: `"user_upload"`, `"manual"`, `"import"`, `"scraped"`
- Purpose: management, debugging, audits

**(14) notes**

- Type: string | null
- Example: `"Ramen I had on my birthday in Osaka"`
- Purpose: for human-readable stories in Planner / UI

**(15) version**

- Type: number (default 1)
- Purpose: support future schema / TES upgrades (e.g. V2.0)

---

### 2.3 ASCII Schema Overview

```text
P5_Memory_Unit
│
├── memory_id: string
├── user_id: string
├── type: "food" | "scenery"
│
├── raw_image: string | null
├── image_embedding: number[] | null
│
├── raw_labels: string[]
├── normalized_labels: string[]
├── style_tags: string[] | null
│
├── sentiment: number
├── timestamp: string
├── location:
│     ├── city: string | null
│     └── country: string | null
│
├── tes_embedding: number[930]
│
├── source: string
├── notes: string | null
└── version: number
```

---

## 3. Storage & Indexing Design

P5 Memory must support:

- **High-performance similarity search**
- **Flexible structured queries** (filter by time, location, type, etc.)
- **Scalability** (more users, more memories)
- **Maintainability** (easy to inspect, debug, and upgrade)

To achieve this, we use a **two-layer storage design**:

> **Relational DB (SQLite/Postgres) + Vector Index (FAISS/Milvus)**

- The relational DB stores all **non-vector** structured fields.
- The vector index stores the 930-dim `tes_embedding`.

---

### 3.1 Relational Database Schema

Recommended engines:

- Prototype / local: **SQLite**
- Future multi-user deployment: **Postgres**

Table name: `p5_memory`

Example schema:

```sql
CREATE TABLE p5_memory (
    memory_id TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL,
    type      TEXT CHECK(type IN ('food', 'scenery')),

    raw_image       TEXT,
    image_embedding BLOB,         -- optional: serialized 512-dim embedding

    raw_labels        JSON,
    normalized_labels JSON,
    style_tags        JSON,

    sentiment REAL,
    timestamp TEXT,

    city    TEXT,
    country TEXT,

    source  TEXT,
    notes   TEXT,
    version INTEGER DEFAULT 1
);
```

Why relational DB?

- Easy filtering (`WHERE city='Osaka'`)
- Easy sorting (`ORDER BY timestamp DESC`)
- SQLite/Postgres are stable and easy to deploy
- Schema evolution is manageable

---

### 3.2 Vector Index Structure

The 930-dim `tes_embedding` is stored in a dedicated vector index.

Recommended:

- **FAISS** for local / prototype on M4 Pro
- **Milvus** or similar for future cloud setups

Index key & vector:

```text
index_key = memory_id
vector    = tes_embedding (float32[930])
```

Index type:

- Small-scale: Flat (exact search)
- Larger-scale: IVF+Flat or similar

Example (FAISS):

```python
d = 930
index = faiss.IndexFlatIP(d)   # inner-product similarity
index.add(vectors)             # vectors aligned with memory_id order
```

---

### 3.3 Hybrid Query Flow (Vector + Structured)

When searching memories, the system uses both layers:

1. **Vector recall (first stage)**
   ```
   TES_query → vector index → top_k memory_id
   ```
2. **Structured filtering (second stage)**
   ```
   SELECT * FROM p5_memory
   WHERE memory_id IN (...) AND city='Tokyo';
   ```

Memory Service combines the results and returns a clean list to Agents.

---

### 3.4 Write Flow (New Memory)

For a new P5 memory:

```text
user uploads image / context
        ↓
vision.describe
        ↓
ontology.normalize
        ↓
embedding.generate → TES(930)
        ↓
Memory Service:
  1) INSERT into p5_memory
  2) INSERT into vector index
```

Both steps must succeed; otherwise the write must be rolled back.

---

### 3.5 Update & Delete (High-level)

- **Light updates** (notes, source, raw\_image) → DB only

- **Heavy updates** (sentiment, timestamp, label changes) →

  - recompute TES
  - update DB + vector index together

- **Delete** must remove:

  - DB row from `p5_memory`
  - corresponding vector from the index

(Details of write/update/delete rules are fully specified in Part 4.)

---

### **3.6 Indexes & Capacity Planning**

Recommended DB indexes:

```sql
CREATE INDEX idx_user_id   ON p5_memory(user_id);
CREATE INDEX idx_type      ON p5_memory(type);
CREATE INDEX idx_timestamp ON p5_memory(timestamp);
CREATE INDEX idx_city      ON p5_memory(city);
```

Purpose of indexes:

- Faster filtering by user, city, type
- Essential for Planner and Analyzer Agent queries
- Prevents full-table scans as memory count grows

### Capacity Planning

A TES vector has **930 float32 values**:

```
930 dims × 4 bytes = 3720 bytes ≈ 3.7 KB per memory
```

Storage usage:

- **1,000 memories → \~3.7 MB**
- **10,000 memories → \~37 MB**
- **100,000 memories → \~370 MB**

Completely manageable on an M4 Pro.

---

### **3.7 Storage Constraints & Performance Notes**

### Relational DB constraints

- JSON fields must be validated (SQLite has no native JSON type → store as TEXT)
- Large `image_embedding` blobs should be optional
- `timestamp` should be stored in ISO 8601 for fast lexical sorting

### Vector index constraints

- FAISS Flat index cannot delete by id → must maintain an **id-to-position map**
- Milvus highly recommended for scalable deletion & insertion
- Use float32 always (float16 harms similarity precision)

### Performance expectations

- Flat search: O(n × d) — with n=10k, d=930 → still fast on Metal GPU / CPU
- IVF search: O(log n) — recommended for >50k memories

---

### **3.8 Recommended Directory & File Layout**

```
/taste_memory/
    p5_memory.db            # SQLite
    vector_index.faiss      # FAISS index
    id_map.json             # memory_id → vector position

/services/
    memory_service.py       # Memory APIs
    embedding_service.py    # TES generator
    ontology_service.py
    vision_service.py

/gateway/
    gateway.java            # Schema enforcement + routing
```

This layout makes the system portable and easy to deploy on macOS / Linux.

---

### **3.9 Initialization & Migration Rules**

### Initialization

On system startup, Memory Service must:

1. Load SQLite database
2. Load FAISS index
3. Load id\_map.json → reconstruct memory\_id → position mapping
4. Validate vector dimensions
5. Log initialization summary

### Migration Rules

When schema version increases (e.g., TES V2.0):

- Old records retain `version=1`
- New records get `version=2`
- Memory Service auto-pads old TES vectors upon read
- Optional background job upgrades old vectors in batches

---

# **4. Rules for Write / Update / Delete**

P5 Memory is the taste database of Taste Aligner. All operations must guarantee:

- **Atomicity** — either all operations succeed or none do
- **Consistency** — relational DB and vector index must stay in sync
- **Isolation** — concurrent operations must not conflict
- **Durability** — data must survive crashes

These rules ensure P5 remains stable and reliable.

---

## **4.1 Write Rules**

Write operations must follow this strict sequence:

```
Step 1: Obtain TES(930) from embedding.generate
Step 2: INSERT into p5_memory (relational DB)
Step 3: INSERT tes_embedding into vector index
Step 4: Return success
```

### **4.1.1 Two-Phase Commit (2PC)**

```
DB_ok AND Vector_ok → SUCCESS
Else → rollback all writes
```

- If DB insert fails → abort
- If vector insert fails → rollback DB row

### **4.1.2 Required Field Validation**

Gateway must validate:

- memory\_id
- user\_id
- timestamp
- tes\_embedding (length = 930)

Invalid payload → Gateway rejects request.

---

## **4.2 Update Rules**

Updates come in two categories:

### **4.2.1 Light Updates (No TES Recalculation)**

TES stays unchanged, vector index not touched.

- Update notes
- Update source
- Update raw\_image

Only DB update is required.

### **4.2.2 Heavy Updates (TES Recalculation Required)**

Triggers a new TES vector:

- sentiment changed
- label ontology updated
- recency recalculation (timestamp changed)
- visual embedding recalculated

Process:

```
embedding.generate → new TES
↓
UPDATE p5_memory
↓
UPDATE vector index
```

If TES recalculation fails → keep old TES.

---

## **4.3 Delete Rules**

Deleting a P5 memory must delete **both**:

- DB row
- vector index entry

```
DELETE FROM p5_memory WHERE memory_id=...
vector_index.remove(memory_id)
```

### Hard Delete

Immediate removal from both layers.

### Soft Delete

- `source = "deleted"`
- `tes_embedding = zero vector`
- Keep record for audit/recovery

---

## **4.4 Concurrency Rules**

- DB writes for same memory\_id must use **row locks**
- Vector index updates must use **exclusive locks** to prevent inconsistent reads

---

## **4.5 Versioning**

Every P5 record contains a `version` field:

- Current version = **1** (TES V1.0)
- Future TES V2.0 will set version = 2

Backward compatibility:

- When reading version 1 records, missing dimensions are padded

---

## **4.6 Failure Recovery**

- DB write fails → abort, no vector write
- Vector write fails → rollback DB row
- TES recalculation fails → keep old TES

Errors must be logged with tag `[MEMORY_WRITE_FAIL]`.

---

# **5. Lifecycle Flow of P5 Memory**

This section describes how P5 flows through the entire Taste Aligner system — from user input to final recommendation.

---

## **5.1 Full Lifecycle Overview**

```
User uploads image / text
        ↓
Intent Agent
        ↓
Taste Analyzer Agent
        1) vision.describe
        2) ontology.normalize
        3) embedding.generate → TES(930)
        ↓
Memory Service: write P5 record
        ↓
Matcher Agent: memory.search (similarity recall)
        ↓
Recommendation.score (CZ/EZ scoring)
        ↓
Planner Agent: generate Journey Card (with memory anchors)
```

P5 drives the entire system: experience → memory → representation → recommendation → new experience.

---

## **5.2 Role of P5 in Each Agent**

### Intent Agent

- Does not use P5 directly
- Identifies task type and destination

### Taste Analyzer Agent

- Reads P5 to construct Taste Profile (TES query)

### Matcher Agent

- Uses memory.search to retrieve **Memory Anchors**
- Memory Anchors boost personalization

### Planner Agent

- Attaches Memory Anchors to Journey Cards
- Converts recommendations into personal narratives

---

## **5.3 System-Level Data Flow**

```
[Raw Image / Tags / Sentiment]
            ↓
  vision.describe + ontology + embedding
            ↓
          [TES]
            ↓
       Write into P5
            ↓
    memory.search (similarity)
            ↓
 recommendation.score (decision)
            ↓
    planner.compose (Journey Card)
```

P5 is the bridge between real-world experiences and the model’s computational representation.

---

## **5.4 Summary**

P5 enables a complete feedback loop:

- User experience forms a memory
- Memory becomes a vector (TES)
- TES affects recommendations
- Recommendations influence future experiences

Taste Aligner becomes more personalized as the loop strengthens.

---


# **6. Memory Service API Specification**

This section defines the **official Memory Service API**, used by Agents and Gateway.\
All routes must:

- Use JSON
- Match the P5 schema exactly
- Return consistent `{status, data, error}` format

---

## **6.1 API Overview**

| Function  | Method | Path             | Description                        |
| --------- | ------ | ---------------- | ---------------------------------- |
| Add P5    | POST   | `/memory/add`    | Insert new memory                  |
| Get P5    | GET    | `/memory/get`    | Fetch P5 by memory\_id             |
| Search P5 | POST   | `/memory/search` | Vector recall + structured filter  |
| Update P5 | POST   | `/memory/update` | Update sentiment/notes/etc.        |
| Delete P5 | POST   | `/memory/delete` | Delete DB row + vector index entry |

All responses use:

```
{ "status": "success" | "error", "data": {...}, "error": {...} }
```

---

## **6.2 **``** — Add New Memory**

### Method: `POST`

### Path: `/memory/add`

### Request Body

```json
{
  "memory_id": "string",
  "user_id": "string",
  "type": "food" | "scenery",

  "raw_image": "string | null",
  "image_embedding": [number] | null,
  "raw_labels": [string],
  "normalized_labels": [string],
  "style_tags": [string] | null,

  "sentiment": number,
  "timestamp": "string",
  "location": {
      "city": "string | null",
      "country": "string | null"
  },

  "tes_embedding": [number],
  "source": "string",
  "notes": "string | null",
  "version": number
}
```

### Response

```json
{
  "status": "success",
  "data": { "memory_id": "string" }
}
```

### Errors

- `MEMORY_WRITE_FAIL`
- `VECTOR_WRITE_FAIL`
- `BAD_SCHEMA`

---

## **6.3 **``** — Fetch Memory**

### Method: `GET`

### Path: `/memory/get?memory_id=...`

### Response

```json
{
  "status": "success",
  "data": { /* full P5_Memory_Unit */ }
}
```

### Errors

- `MEMORY_NOT_FOUND`

---

## **6.4 **``** — Vector Search**

### Method: `POST`

### Path: `/memory/search`

### Request

```json
{
  "query_vector": [number],
  "top_k": number,
  "filters": {
      "type": "food" | "scenery" | null,
      "city": "string | null"
  }
}
```

### Response

```json
{
  "status": "success",
  "data": [
    {
      "memory_id": "string",
      "score": number,
      "type": "food" | "scenery",
      "normalized_labels": ["string"],
      "sentiment": number,
      "location": { "city": "string", "country": "string" },
      "timestamp": "string",
      "raw_image": "string"
    }
  ]
}
```

### Errors

- `VECTOR_SEARCH_FAIL`
- `EMPTY_QUERY`

---

## **6.5 **``** — Update Memory**

### Method: `POST`

### Path: `/memory/update`

### Request

```json
{
  "memory_id": "string",
  "fields": {
      "sentiment": number | null,
      "notes": "string | null",
      "raw_image": "string | null",
      "timestamp": "string | null"
  }
}
```

### Update Logic

- Editing **sentiment** → recompute TES and update vector index
- Editing **notes/raw\_image** → DB only
- Editing **timestamp** → recency recalculation → TES update

### Response

```json
{
  "status": "success",
  "data": { "memory_id": "string" }
}
```

### Errors

- `MEMORY_UPDATE_FAIL`
- `TES_RECALC_FAIL`

---

## **6.6 **``** — Delete Memory**

### Method: `POST`

### Path: `/memory/delete`

### Request

```json
{
  "memory_id": "string",
  "mode": "hard" | "soft"
}
```

### Response

```json
{
  "status": "success",
  "data": { "deleted": true }
}
```

### Errors

- `MEMORY_DELETE_FAIL`
- `VECTOR_DELETE_FAIL`

---

# **7. Gateway ↔ Memory Service Interaction Protocol**

This protocol defines how the **Gateway (Java)** communicates with the **Memory Service (Python/Node)**.\
It ensures correctness, stability, and consistent tool invocation for ReAct agents.

---

## **7.1 Transport Rules**

- HTTP/1.1 or HTTP/2
- JSON as payload
- POST for all write/update/delete
- GET for read-only operations

---

## **7.2 Required Headers**

Every request from Gateway must include:

```
X-Trace-Id: <trace_id>
X-Service-Caller: gateway
Content-Type: application/json
```

Memory Service must echo back the same `X-Trace-Id`.

---

## **7.3 Schema Validation**

Gateway must validate:

- Required fields
- Field types
- TES vector length = 930
- Mode correctness
- No extra fields allowed

If validation fails:

```json
{ "error": true, "code": "BAD_SCHEMA", "message": "..." }
```

---

## **7.4 Gateway → Memory Request Format**

All requests must wrap payload in a unified envelope:

```
{
  "payload": { ... },
  "trace_id": "string",
  "tool": "memory.add"  // for logging only
}
```

Memory Service only reads `payload`.

---

## **7.5 Memory → Gateway Response Format**

```
{
  "status": "success" | "error",
  "data": { ... },
  "error": { "code": "string", "message": "string" },
  "trace_id": "string"
}
```

Gateway converts this into ReAct **Observation**.

---

## **7.6 Error Code Mapping**

| Memory Error         | Gateway Output       | ReAct Effect             |
| -------------------- | -------------------- | ------------------------ |
| MEMORY\_NOT\_FOUND   | MEMORY\_NOT\_FOUND   | Observation.error = true |
| BAD\_SCHEMA          | BAD\_SCHEMA          | Observation.error = true |
| VECTOR\_SEARCH\_FAIL | VECTOR\_SEARCH\_FAIL | Observation.error = true |
| TES\_RECALC\_FAIL    | TES\_RECALC\_FAIL    | Observation.error = true |
| MEMORY\_WRITE\_FAIL  | INTERNAL\_ERROR      | Observation.error = true |

---

## **7.7 Timeout / Retry / Circuit Breaker**

- Timeout: 1.5s per call
- Retry: 1 time
- Circuit breaker after 5 consecutive failures (10-second block)

---

## **7.8 Logging & Observability**

Gateway logs:

```
[GATEWAY] tool=memory.add | trace=<id> | latency=<ms> | status=<...>
```

Memory Service logs:

```
[SERVICE] name=memory | trace=<id> | route=<path> | latency=<ms>
```

---

## **7.9 Security Rules**

- Gateway must sanitize all JSON inputs
- Users cannot overwrite protected fields (e.g., version)
- Memory Service must not call external networks

---

## **7.10 Summary**

This protocol ensures:

- Unified tool调用 chain
- Schema consistency
- Stable errors and observability
- Reliable Gateway ↔ Service communication

---


