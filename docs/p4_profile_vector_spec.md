# P4 Profile Vector Spec

## Goal

`build_profile_vector` is the Step 4 runtime-only unification node for P4 dynamic weighting.

Its job is:

- consume `memory_weight_adjust.weighted_results`
- recompute the authoritative per-memory dynamic weights
- produce a deterministic `profile_vector`
- write a single explain-facing trace product:
  - `decision_trace.profile_vector_node`

This node is the only runtime source that is allowed to summarize:

- time weighting
- sentiment weighting
- context weighting
- final per-memory weight used for P4 explanation

`explain_from_trace` must read only `decision_trace.profile_vector_node` and must not recompute `w_time` / `w_sent`.

## Why Runtime-Only, Not Persisted

`profile_vector` is not persisted to DB.

Reasons:

- avoid double weighting: memory records may already carry weighted search outputs, so persisting a derived profile creates implicit state drift
- avoid hidden state: the same request should be replayable from request input + memory search result only
- keep auditability: `profile_vector_node` can be reproduced exactly from `weighted_results` + `now_ts`
- keep contracts simple: memory storage remains raw memory-oriented, not request-context-derived

## Inputs

Source type:

- `BuildProfileVectorInput` in [agent_runtime/src/core/types.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/core/types.ts:707)

JSON shape:

```json
{
  "weighted_results": [
    {
      "memory_id": "m_001",
      "cosine": 0.82,
      "score": 0.816865,
      "w_time": 0.904837,
      "w_sent": 1.1,
      "w_context": 1.0,
      "timestamp": "2026-02-28T10:00:00Z",
      "sentiment": 0.5,
      "embedding": [0.0, 0.0]
    }
  ],
  "now_ts": 1772400000000
}
```

Notes:

- `weighted_results` is structurally treated as `MemoryUnit[]`
- `embedding` is optional
- if no embeddings are present, output `profile_vector` is a deterministic 512-dim zero vector
- `now_ts` should come from `input.request_ts`; skill falls back to `context.request_ts`

## Output

Source type:

- `BuildProfileVectorOutput` in [agent_runtime/src/core/types.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/core/types.ts:717)

JSON shape:

```json
{
  "profile_vector": [0.0, 0.0],
  "anchors": [
    {
      "memory_id": "m_001",
      "cosine": 0.82,
      "w_time": 0.904837,
      "w_sent": 1.1,
      "w_context": 1,
      "final_weight": 0.816865
    }
  ],
  "total_memories_considered": 1,
  "weights": {
    "per_memory": [],
    "summary": {
      "dominant_reason": "time",
      "time_bias": 0.904837,
      "sentiment_bias": 1.1,
      "context_bias": 1
    }
  },
  "decision_trace": {
    "profile_vector_node": {}
  }
}
```

## Weight ownership

Defined in [agent_runtime/src/skills/build_profile_vector.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/skills/build_profile_vector.ts:9).

`build_profile_vector` does not recompute memory weights. It consumes the
authoritative `score`, `w_time`, `w_sent`, and `w_context` emitted by
`memory.search` and passed through `memory_weight_adjust`:

```text
w_time       = pass-through
w_sent       = pass-through
w_context    = pass-through
final_weight = score
```

The Memory Service computes confidence-aware sentiment weighting as
`clamp(1 + 0.5 * sentiment * sentiment_confidence, 0.5, 1.5)` and returns
neutral weight when `sentiment_available=false`.

## Determinism Contract

Defined by [agent_runtime/src/skills/build_profile_vector.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/skills/build_profile_vector.ts:24).

Requirements:

- same `weighted_results` + same `now_ts` -> identical output
- no random values
- no network/tool calls
- no DB writes
- all floats rounded to 6 decimals
- anchors sorted by:
  - `final_weight` desc
  - `memory_id` asc
- `profile_vector` values rounded to 6 decimals
- trace must not include volatile fields like `latency_ms` or timestamps

## Explain Read Rule

`explain_from_trace` reads only the unified P4 trace product.

Evidence:

- [agent_runtime/src/skills/explain_from_trace.ts:185](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/skills/explain_from_trace.ts:185)

Contract:

- read `decision_trace.profile_vector_node`
- do not read raw `memory.search` weight fields for explanation
- do not recompute `w_time`
- do not recompute `w_sent`

## Minimal Trace Example

Field names below must match runtime exactly.

```json
{
  "profile_vector_node": {
    "rule_id": "profile_vector_v1",
    "schema_version": "1.0",
    "anchors": [
      {
        "memory_id": "m_001",
        "cosine": 0.82,
        "w_time": 0.904837,
        "w_sent": 1.1,
        "w_context": 1,
        "final_weight": 0.816865
      }
    ],
    "weights_summary": {
      "dominant_reason": "time",
      "time_bias": 0.904837,
      "sentiment_bias": 1.1,
      "context_bias": 1
    },
    "total_memories_considered": 1,
    "profile_vector_dim": 512,
    "has_embeddings": false,
    "fallback_used": false
  }
}
```

## Relevant Files

- [agent_runtime/src/skills/build_profile_vector.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/skills/build_profile_vector.ts)
- [agent_runtime/src/skills/explain_from_trace.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/skills/explain_from_trace.ts)
- [agent_runtime/src/core/types.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/core/types.ts)
- [agent_runtime/src/core/graph_definition.ts](/Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/agent_runtime/src/core/graph_definition.ts)
