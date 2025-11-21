# Taste Embedding Space (TES) Specification — V1.0 (English Version)

This document defines the complete **Taste Embedding Space (TES)** structure for Taste Aligner V10.\
TES is the unified vector representation used across all Agents, microservices, and the recommendation engine.

This file will be referenced by:

- Embedding Service (embedding.generate)
- Memory Service (P5 multimodal memory)
- Recommendation Engine (CZ/EZ scoring)
- Gateway Schema Validation
- Agent Runtime (query embedding construction)

---

# **1. Purpose of TES**

TES serves as the core latent space that represents:

- User taste preferences (Taste Profile)
- Multimodal memory units (P5 Memory)
- Query → candidate similarity computation

TES must be:

- **Fixed-dimensional**
- **Composable** from any subset of inputs
- **Interpretable and debuggable**
- **Multimodal** (image + tags + style + sentiment + time + location)

---

# **2. TES Components**

TES is constructed by concatenating six components, representing visual, semantic, stylistic, emotional, temporal, and geographic preferences.

| Component                          | Dim     | Description                                                 |
| ---------------------------------- | ------- | ----------------------------------------------------------- |
| **visual (vision\_embedding)**     | **512** | Visual features extracted from vision.describe              |
| **tags (tag\_embedding)**          | **384** | Semantic tag embedding (pooled over multiple tags)          |
| **style (style\_embedding)**       | **16**  | Visual aesthetic/style embedding (cozy, analog, warm, etc.) |
| **sentiment (sentiment\_scalar)**  | **1**   | User liking score in range [-1, 1]                          |
| **recency (recency\_scalar)**      | **1**   | Time-based freshness decay value                            |
| **location (location\_embedding)** | **16**  | City/country embedding                                      |
| **Total TES Dimension**            | **930** | Concatenation of all components                             |

---

# **3. Detailed Component Description**

## **3.1 Visual Embedding — 512 dim**

Source: vision.describe → CLIP / SigLip / OpenCLIP

Captures:

- objects and scene structure
- texture, shape, overall composition
- primary driver of similarity

---

## **3.2 Tag Embedding — 384 dim**

Source: ontology.normalize → normalized labels

Method:

- embed each tag
- apply mean/max pooling

Advantages:

- lightweight
- compatible with evolving ontologies

---

## **3.3 Style Embedding — 16 dim**

Source: vision.describe → style\_tags

Represents visual aesthetics:

- color tone (warm/cold)
- atmosphere (cozy/minimal/elegant)
- artistic style (analog/digital)
- lighting, saturation

Purpose:

- better personalization
- distinguish items with same category but different mood

---

## **3.4 Sentiment Scalar — 1 dim**

Range: [-1, 1]

Represents:

- how much the user likes this memory/item
- lightweight and effective for ranking

---

## **3.5 Recency Scalar — 1 dim**

Example decay formula:

```
recency = exp(- days / 90)
```

Purpose:

- weigh recent memories stronger
- avoid old data dominating the profile

---

## **3.6 Location Embedding — 16 dim**

Represents geographic preference patterns.

Future use cases:

- cross-city preference transfer
- global recommendation tuning

---

# **4. Final TES Structure (930 dimensions)**

```
[ visual (512) ]
       ⊕
[ tags (384) ]
       ⊕
[ style (16) ]
       ⊕
[ sentiment (1) ]
       ⊕
[ recency (1) ]
       ⊕
[ location (16) ]
--------------------------------------------
             = 930 dim
```

---

# **5. Integration Points**

TES will be used by:

### **5.1 Embedding Service**

- Input: multimodal components
- Output: fixed 930-dim vector

### **5.2 Memory Service (P5 Memory)**

- Every memory unit stores a TES vector
- Used for similarity-based retrieval

### **5.3 Recommendation Engine**

- Computes similarity between user embedding and candidate embeddings

### **5.4 Gateway Schema Validation**

- Ensures consistent vector dimensions

### **5.5 Agent Runtime**

- Builds user query embedding for matching

---

# **6. Future Upgrades (TES V2.0 Roadmap)**

Potential extensions:

- Sentiment embedding (8–16 dim)
- Larger style embedding (32 dim)
- Hierarchical location embedding (district/region)
- Topic/interest embeddings (art / cafe / nature / photography)



---

**End of TES Specification — V1.0 (English)**

