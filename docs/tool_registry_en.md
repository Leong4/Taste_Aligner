# Tool Registry (Taste Aligner V10)

This document defines the **official tool API specifications** used by all Agents, Gateway, and microservices in the Taste Aligner architecture.\
It serves as the **single source of truth** for all tool input/output formats.

All tools must strictly follow these definitions to ensure cross-language consistency (Node.js, Python, Java) and stable Agentic workflows.

---

# **Tool 1: memory.search**

**Purpose:** Retrieve the most similar memory units from the multimodal memory store (P5 + TES).\
Used to activate "memory anchors" for recommendations and explanations.

**Called by (Agents):**

- Taste Analyzer Agent
- Matcher Agent
- Planner Agent

**Implemented by (Service):**

- Memory Service (Python / Node)

### **Input**

```
{
  "query_vector": number[],
  "top_k": number,
  "filters": {
      "type": "food" | "scenery" | null,
      "location": string | null
  }
}
```

### **Output**

```
{
  "results": [
    {
      "memory_id": string,
      "score": number,
      "type": "food" | "scenery",
      "tags": string[],
      "sentiment": number,
      "location": {
         "city": string,
         "country": string
      },
      "timestamp": string,
      "image": string
    }
  ]
}
```

### **Error Format**

```
{
  "error": true,
  "message": string,
  "code": string
}
```

### **Degradation**

- Use cached results if vector DB unavailable.
- Return empty results safely.
- Dimensional mismatch handled by Gateway.

---

# **Tool 2: vision.describe**

**Purpose:** Extract raw labels, style tags, and visual features from an image.\
First step of building a P5 memory unit and TES embedding.

**Called by (Agents):**

- Intent Agent
- Taste Analyzer Agent
- Planner Agent

**Implemented by (Service):**

- Vision Service (Python)

### **Input**

```
{
  "image_path": string,
  "require_style": boolean,
  "require_food_check": boolean
}
```

### **Output**

```
{
  "labels": string[],
  "confidence": number[],
  "style_tags": string[] | null,
  "type": "food" | "scenery",
  "raw_description": string,
  "embedding": number[] | null
}
```

### **Error Format**

```
{
  "error": true,
  "message": string,
  "code": string
}
```

### **Degradation**

- Fallback to local CLIP/LLaVA if cloud vision fails.
- Skip style analysis if model not available.
- Default type if ambiguous.

---

# **Tool 3: ontology.normalize**

**Purpose:** Normalize raw labels into the unified **Tag Ontology Dictionary** used across the entire system.

**Called by:**

- Taste Analyzer Agent
- Embedding Service
- Recommendation Engine

**Implemented by:**

- Ontology Service (Node / Python)

### **Input**

```
{
  "raw_labels": string[],
  "language": string | null,
  "context": "food" | "scenery" | null
}
```

### **Output**

```
{
  "normalized_labels": string[],
  "ignored_labels": string[],
  "confidence_map": {
      "<label>": number
  }
}
```

### **Error Format**

```
{
  "error": true,
  "message": string,
  "code": string
}
```

### **Degradation**

- Basic heuristics if ontology dictionary fails.
- Default to English mapping.
- Return empty normalized\_labels if no valid raw labels.

---

# **Tool 4: embedding.generate**

**Purpose:** Generate the unified **Taste Embedding Space (TES)** vector using all multimodal signals.

**Called by:**

- Taste Analyzer Agent
- Memory Service
- Recommendation Engine

**Implemented by:**

- Embedding Service (Python)

### **Input**

```
{
  "visual_embedding": number[] | null,
  "labels": string[],
  "sentiment": number | null,
  "timestamp": string | null,
  "location": {
      "city": string | null,
      "country": string | null
  },
  "mode": "memory" | "query"
}
```

### **Output**

```
{
  "embedding": number[],
  "components": {
     "visual": number[],
     "tags": number[],
     "style": number[],          // NEW: 16-dim style embedding
     "sentiment": number[],
     "recency": number[],
     "location": number[]
  }
}
```

### **Error Format**

```
{
  "error": true,
  "message": string,
  "code": string
}
```

### **Degradation**

- Missing components replaced with padded vectors.
- Use cached embeddings if service unavailable.


Taste Embedding Space consists of the following components:

| Component | Dim | Description |
|----------|-----|-------------|
| visual (vision_embedding) | 512 | Image representation from vision.describe |
| tags (tag_embedding) | 384 | Semantic tag embedding (pooled) |
| style (style_embedding) | 16 | Visual aesthetic/style embedding |
| sentiment (sentiment_scalar) | 1 | User emotional preference score |
| recency (recency_scalar) | 1 | Time-based decay value |
| location (location_embedding) | 16 | City/Country learned embedding |
| **Total TES Dimension** | **930** | Final concatenated vector |

---

# **Tool 5: recommendation.score**

**Purpose:** Calculate Comfort Zone (CZ) and Exploration Zone (EZ) scores for candidate items. Defines the core decision logic of Taste Aligner.

**Called by:**

- Matcher Agent
- Planner Agent

**Implemented by:**

- Recommendation Engine

### **Input**

```
{
  "user_embedding": number[],
  "candidate_items": [
    {
      "item_id": string,
      "type": "food" | "scenery",
      "tags": string[],
      "popularity": number | null,
      "location": {
          "city": string | null,
          "country": string | null
      }
    }
  ],
  "mode": "food" | "scenery" | "mixed"
}
```

### **Output**

```
{
  "comfort_zone": [
    {
      "item_id": string,
      "score_cz": number,
      "reason": string
    }
  ],
  "exploration_zone": [
    {
      "item_id": string,
      "score_ez": number,
      "reason": string
    }
  ],
  "debug": {
      "cz_weight": number,
      "ez_weight": number,
      "tag_overlap": any,
      "distance": any
  }
}
```

### **Error Format**

```
{
  "error": true,
  "message": string,
  "code": string
}
```

### **Degradation**

- Fallback to tag-similarity if embeddings missing.
- Default sort by popularity if scoring fails.

---

# **Tool 6: planner.compose**

**Purpose:** Combine CZ/EZ results with user memory anchors and destination metadata to produce the final "Personalized Journey Card" structure.

**Called by:**

- Planner Agent

**Implemented by:**

- Planner Service (Node)

### **Input**

```
{
  "comfort_zone": [
    {
      "item_id": string,
      "score_cz": number,
      "reason": string
    }
  ],
  "exploration_zone": [
    {
      "item_id": string,
      "score_ez": number,
      "reason": string
    }
  ],
  "memory_anchors": {
      "<item_id>": {
         "memory_id": string,
         "image": string,
         "source": string
      }
  },
  "destination": {
      "city": string,
      "country": string
  }
}
```

### **Output**

```
{
  "title": string,
  "subtitle": string,
  "sections": [
    {
      "section_type": "comfort_zone" | "exploration_zone",
      "items": [
        {
          "item_id": string,
          "display_name": string,
          "reason":

```
