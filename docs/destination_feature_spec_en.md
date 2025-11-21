# Destination Feature Schema — V1.0 (English)

This document defines the **Destination Feature Database (DFD)** of Taste Aligner V10.

DFD is the companion database to **P5 Memory** in the recommendation system:
- **P5 answers: “Who are you? What do you like?”**
- **DFD answers: “What is available in this city?”**

Only when both are present can the Matcher Agent compute CZ/EZ (Comfort Zone / Exploration Zone) and the Planner Agent generate Journey Cards.

This spec is organized as:
1. Definition & design goals of Destination Features
2. Single Destination Item Schema (field-level)
3. Storage & Indexing (DB + optional vector index)

---

# 1. What is a Destination Feature?

A **Destination Feature** is a structured representation of a recommendable item inside a city. It is how Taste Aligner encodes “city knowledge” in a machine-usable way.

You can think of it as:
> **City database of food / scenery / experiences + structured tags + style tags + description.**

In Taste Aligner, a single **Destination Item** may represent:
- A restaurant / cafe / dessert shop (`type = "food"`)
- A viewpoint / landmark / museum / park (`type = "scenery"`)
- An activity, such as onsen, hiking route, cycling tour (`type = "experience"`, extensible)

Each Destination Item contains multimodal features, for example:
- Tags (labels) → aligned with P5 Memory
- Style (atmosphere / aesthetics)
- Location (city, country, optional geo-coordinates)
- Popularity / rating
- Description text
- Cover images

It is the **second half** of what the recommendation engine needs to compute CZ/EZ.

---

## 1.1 Why do we need Destination Features?

Without DFD, the system:
- Only knows the user’s past experiences (P5)
- Does not know what options exist in the target city
- Cannot build a candidate list of places to recommend
- Cannot construct Journey Cards

With DFD, the system can:
- Enumerate candidate items within a city
- Attach structured tags and style to each item
- Compare user_embedding (from P5) with item_embedding (from DFD)
- Finally output CZ/EZ lists and Journey Cards

In other words:
> **P5 is the user’s “History”. DFD is the city’s “Options”.**

A recommender must consider **who you are** and **where you are** at the same time.

---

## 1.2 Role of Destination Features in the System

### Taste Analyzer Agent
- Uses the shared ontology to understand categories (food/scenery/etc.)

### Matcher Agent
- Uses DFD tags / style / location to construct the candidate set (`candidate_items`)
- Connects candidate items with P5 memories

### Recommendation Engine
- Compares **user_embedding (TES query)** with **item_embedding**
- Outputs CZ (Comfort Zone) and EZ (Exploration Zone) candidates

### Planner Agent
- Combines Destination Items into Journey Cards (itineraries + memory anchors)
- Requires: `display_name`, `image`, `reason`, `location`, `item_id`

DFD is therefore a critical component in the multi-agent system.

---

## 1.3 Design Principles

### Principle 1: Tag System aligned with P5
- `normalized_labels` must come from the **same Tag Ontology** as P5
- This ensures:
  - Preference patterns from P5 can be matched with destination tags
  - `recommendation.score` can compute similarity meaningfully

### Principle 2: Structured but Extensible
Destination Items must support:
- New tags
- New categories (e.g., coffee, historical, activity)
- New style embeddings or image embeddings in the future

### Principle 3: Unified Source Format
Regardless of data source:
- Manual input
- City scraping
- Third-party APIs

Everything must converge to the **same schema**.

### Principle 4: Explainable
Destination Items must be usable for:
- Planner Agent’s “reason for recommendation”
- Rich UI rendering
- Natural language explanation (“We recommend this because…”)

### Principle 5: Lightweight
- Keep structured fields concise
- Description texts should be moderate (not a full encyclopedia)
- Embeddings generated on demand or precomputed in a compact format

---

## 1.4 Three Components of a Destination Item

A complete Destination Item consists of three core parts:

### (1) Basic Info
- `item_id`
- `display_name`
- `type` (food / scenery / experience)
- `location` (city / country / lat / lng)
- `images` (cover photos)

### (2) Semantic Tags
- `raw_labels`
- `normalized_labels`
- `style_tags`

These are directly consumed by the recommendation engine.

### (3) Structured Attributes
- `popularity` (rating / popularity score)
- `price_level` (optional)
- `opening_hours` (optional)
- `description` (optional short introduction)
- `source` (data origin)

The next section will define the **Destination Item Schema** at field level.

---

# 2. Destination Item Schema (Field-level Definition)

This section defines the full field-level schema of a **single Destination Feature Item**.

A Destination Item represents:
- A restaurant, cafe, dessert shop (`type = "food"`)
- A viewpoint, landmark, museum, park (`type = "scenery"`)
- An activity such as onsen, hiking, cycling (`type = "experience"`, extensible)

The Destination Item is the **candidate pool** parallel to P5 Memory in the recommendation engine. Its tag, style, and structured fields must be fully compatible with P5.

---

## 2.1 Top-Level Structure

```ts
DestinationItem {
  item_id: string,                      // globally unique ID
  display_name: string,                 // display name
  type: "food" | "scenery" | "experience",

  images: string[] | null,              // 1–3 cover images (paths or URLs)

  raw_labels: string[],                 // raw labels from scraping / APIs
  normalized_labels: string[],          // standardized labels via ontology.normalize
  style_tags: string[] | null,          // optional style tags (cozy, minimal, etc.)

  popularity: number | null,            // rating or popularity (0–1 or 0–5)
  price_level: number | null,           // optional (1–5)
  opening_hours: string | null,         // optional (e.g. "10:00–20:00")
  description: string | null,           // optional short intro

  location: {
    city: string,
    country: string,
    lat: number | null,
    lng: number | null
  },

  item_embedding: number[] | null,      // optional precomputed item embedding

  source: string,                       // manual / scrape / api
  version: number                       // schema version
}
```

---

## 2.2 Field Descriptions

### (1) `item_id` — Destination ID
- Type: string (UUID)
- Usage:
  - Primary key in the DB
  - Stable identifier for Planner and UI

### (2) `display_name` — Name shown to the user
- Type: string
- Examples:
  - "Archer Café"
  - "Kiyomizu-dera Viewpoint"
- Used directly in Journey Cards and UI

### (3) `type` — Item category
- Values: `"food"`, `"scenery"`, `"experience"`
- Extensible to future categories (e.g., `"shopping"`, `"culture"`)

### (4) `images` — Cover image list
- Type: `string[] | null`
- 1–3 images recommended
- Used for UI rendering and Planner visuals

---

### Label & Ontology Fields

### (5) `raw_labels`
- Type: `string[]`
- Source: raw from scraping / APIs / manual input
- Example: `"ramen", "noodle", "汤", "spicy"`

### (6) `normalized_labels`
- Type: `string[]`
- Must come from the **same Tag Ontology** as P5
- Used for matching against P5 labels and TES

### (7) `style_tags`
- Type: `string[] | null`
- Example: `"cozy", "bright", "analog", "minimal"`
- Used as part of the style embedding in item_embedding

---

### Structured Attributes

### (8) `popularity`
- Type: `number | null`
- Range: 0–1 or 0–5 (to be standardized at implementation time)
- Source: manual input or external APIs
- Used as an auxiliary factor in recommendation ranking

### (9) `price_level`
- Type: `number | null`
- Range: 1–5
- Mainly meaningful for `type = "food"`

### (10) `opening_hours`
- Type: `string | null`
- Example: `"10:00–20:00"`
- Planner may use this for optional time ordering

### (11) `description`
- Type: `string | null`
- A short, human-readable description of the place
- Used by Planner / UI to enrich Journey Cards

---

### Location Fields

### (12) `location`
```ts
location: {
  city: string,
  country: string,
  lat: number | null,
  lng: number | null
}
```
- `city` and `country` are required
- `lat` / `lng` are optional (for future map-based features)

---

### Item Embedding

### (13) `item_embedding`
- Type: `number[] | null`
- If generated, it should be compatible with the TES design
- It could include:
  - Tag embedding (e.g., 384 dims)
  - Style embedding (e.g., 16 dims)
  - Optional location embedding

Usage:
- Directly compared to `user_embedding` in `recommendation.score`
- If null, the Recommendation Engine can compute an embedding on the fly

---

### Metadata Fields

### (14) `source`
- Type: string
- Examples: `"manual"`, `"scrape"`, `"api"`
- Used for data provenance and debugging

### (15) `version`
- Type: number (default 1)
- Used to support future schema evolution

---

## 2.3 ASCII Schema Overview

```text
DestinationItem
│
├── item_id: string
├── display_name: string
├── type: food | scenery | experience
│
├── images: string[] | null
│
├── raw_labels: string[]
├── normalized_labels: string[]
├── style_tags: string[] | null
│
├── popularity: number | null
├── price_level: number | null
├── opening_hours: string | null
├── description: string | null
│
├── location:
│     ├── city: string
│     ├── country: string
│     ├── lat: number | null
│     └── lng: number | null
│
├── item_embedding: number[] | null
│
├── source: string
└── version: number
```

---

# 3. Storage & Indexing Design

The DFD must support:
- **Fast queries** (by city, type, tags)
- **Lightweight yet extensible** structure
- **High compatibility with P5 Memory** (shared tag & style systems)
- **Easy consumption by Planner / Matcher / Recommendation Engine**

We use a similar approach as P5 Memory: a **relational database (SQLite/Postgres) + optional vector index (FAISS/Milvus)**. The vector index is only needed if `item_embedding` is heavily used.

---

## 3.1 Relational Database Schema

Recommended engines:
- Local dev: **SQLite** (lightweight, cross-platform)
- Future server deployment: **Postgres** (JSON + full-text capabilities)

Table name: `destination_items`

```sql
CREATE TABLE destination_items (
    item_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    type TEXT CHECK(type IN ('food', 'scenery', 'experience')),

    images JSON,

    raw_labels JSON,
    normalized_labels JSON,
    style_tags JSON,

    popularity REAL,
    price_level INTEGER,
    opening_hours TEXT,
    description TEXT,

    city TEXT NOT NULL,
    country TEXT NOT NULL,
    lat REAL,
    lng REAL,

    item_embedding BLOB,            -- optional: serialized vector

    source TEXT,
    version INTEGER DEFAULT 1
);
```

Notes:
- `images` is a JSON array
- `item_embedding` can be null (computed on the fly when needed)
- `lat` / `lng` can be null initially but are recommended for better geo features

---

## 3.2 Vector Index (Optional)

If you want faster item retrieval or expect a large destination set, you can build a vector index over `item_embedding`.

Differences from P5:
- `item_embedding` can be smaller than TES (e.g., only tags + style ≈ 400 dims)
- Or it can follow full TES dimensions (e.g., 930 dims) for maximum compatibility

Vector index entry:
```text
index_key = item_id
vector    = item_embedding (float32[n])
```

Recommended:
- M4 Pro: FAISS Flat or IVF-Flat
- Cloud: Milvus or similar

---

## 3.3 Query System

Matcher Agent and Planner Agent rely heavily on DFD. Common query patterns include:

### (1) Filter by city
```sql
SELECT * FROM destination_items WHERE city = 'London';
```

### (2) Filter by type
```sql
SELECT * FROM destination_items WHERE type = 'scenery';
```

### (3) Filter by normalized_labels
Using JSON text search or JSON operators:
```sql
SELECT * FROM destination_items
WHERE normalized_labels LIKE '%ramen%';
```

### (4) Sort by popularity
```sql
SELECT * FROM destination_items ORDER BY popularity DESC;
```

### (5) Vector similarity search (optional)
```python
index.search(query_vector, top_k)
```

The Recommendation Engine will combine:
- Tag similarity
- Style similarity
- Popularity weighting
- City match

Into a final ranking.

---

## 3.4 Write / Update / Delete Rules

DFD is relatively static compared to P5 Memory, so its rules can be simpler.

### (1) Add
- `item_id` must be unique
- `normalized_labels` must come from `ontology.normalize`
- `city` and `country` are required
- `images` may be null

Write flow:
```
Step 1: Validate payload
Step 2: INSERT into destination_items
Step 3: If item_embedding is provided → insert into vector index
```

### (2) Update
- Any structured field can be updated
- If `normalized_labels` or `style_tags` are changed → recompute item_embedding

Flow:
```
UPDATE destination_items
If item_embedding changed → update vector index
```

### (3) Delete
```
DELETE FROM destination_items WHERE item_id = ...
If vector index exists → delete corresponding embedding
```

---

## 3.5 Initialization Flow

On startup, the Destination Service must:
1. Load SQLite/Postgres
2. If vector index is enabled: load FAISS/Milvus
3. Build `item_id → index_position` mapping if necessary
4. Validate schema versions and basic field integrity

---

## 3.6 Index Design

Recommended DB indexes:
```sql
CREATE INDEX idx_city ON destination_items(city);
CREATE INDEX idx_type ON destination_items(type);
CREATE INDEX idx_popularity ON destination_items(popularity);
CREATE INDEX idx_country_city ON destination_items(country, city);
```

Purpose:
- Faster candidate set construction for Matcher
- Faster Journey Card building for Planner

---

## 3.7 Capacity Planning

Assume per city:
- 80–200 destination items
- Each item_embedding ≈ 400–930 dims (float32)

Rough storage:
- 200 items × 400 dims × 4 bytes ≈ **320 KB**
- 200 items × 930 dims × 4 bytes ≈ **744 KB**

For ~30 cities → **20–45 MB**

This is very light and easily handled by an M4 Pro.

---

## 3.8 Directory Layout

```text
/taste_destination/
    destination.db            # SQLite
    dest_index.faiss          # optional vector index
    id_map.json               # item_id → FAISS index position

/service/
    destination_service.py    # Destination API

/gateway/
    gateway.java              # Tool bridge
```

---

## 3.9 Summary

The Destination Feature storage and indexing design ensures:
- Efficient queries
- Lightweight structure
- Full compatibility with P5 tag & style systems
- Future model extensibility

This allows `recommendation.score` to quickly construct candidate sets and match them against the user’s taste profile (TES).

---

*End of Destination Feature Specification — English (destination_feature_spec_en)*

