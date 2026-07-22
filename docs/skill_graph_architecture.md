# Skill Graph Architecture

## Overview

Taste Aligner executes recommendations through a `SkillRegistry`, a versioned
linear graph, and an `Orchestrator`. The production graph is
`recommendation_pipeline` v14.0.0. Every node has explicit `inputFrom`
dependencies, and each skill contributes structured evidence to the final
decision trace.

The default path is deterministic except for the skills that explicitly use an
LLM adapter (`tag_expand` and `explain_from_trace`) or external services. The
legacy `memory_signal` skill remains registered for compatibility, but it is not
part of the v14 graph.

## Production graph (v14)

```text
POST /run
   |
   v
extract_intent
   |
   v
decide_tag_budget -> tag_expand -> tag_normalize
                                      |
                                      v
                              memory_weight_adjust
                                      |
                                      v
                              build_profile_vector
                                      |
                                      v
                               vision_describe
                                      |
                                      v
                             caption_sentiment
                                      |
                                      v
                                 tes_builder
                                      |
                                      v
                                persist_memory
                                      |
                                      v
                           fetch_recommendation
                                      |
                                      v
                                   rerank
                                      |
                                      v
                                 mix_policy
                                      |
                                      v
                                build_cards
                                      |
                                      v
                            explain_from_trace
```

The exact node definitions and bindings live in
`agent_runtime/src/core/graph_definition.ts`.

## Node responsibilities

| # | Node | Responsibility |
|---:|---|---|
| 1 | `extract_intent` | Extract city, type, input tags, and CZ/EZ seeds. |
| 2 | `decide_tag_budget` | Compute deterministic hard/soft expansion limits. |
| 3 | `tag_expand` | Expand seed tags within the allocated budget. |
| 4 | `tag_normalize` | Map expanded tags to the shared ontology. |
| 5 | `memory_weight_adjust` | Search memory and expose authoritative `score`, `w_time`, `w_sent`, and `w_context` values plus anchors and confidence. |
| 6 | `build_profile_vector` | Consume upstream weights, select anchors, and construct the profile vector. It does not recompute time or sentiment weights. |
| 7 | `vision_describe` | Produce optional semantic vision features. |
| 8 | `caption_sentiment` | Analyse the user's caption independently of the vision backend and return signed sentiment, confidence, availability, and provenance. Missing evidence is unavailable rather than fabricated neutral. |
| 9 | `tes_builder` | Build a 512-dimensional TES vector from tags and vision features. The `/tes/build` contract is semantic-only: `tags`, `vision_features`, and `normalize`. |
| 10 | `persist_memory` | For upload requests, synchronously persist the TES vector and metadata with a stable `memory_id`, bounded transient retries, and confirmed success/failure status. |
| 11 | `fetch_recommendation` | Fetch the service's CZ/EZ candidates and upstream mix trace. |
| 12 | `rerank` | Fuse each zone's canonical score (`score_CZ` or `score_EZ`) with TES similarity. It records per-item base, TES, and fused scores and has a 20-call hard budget. |
| 13 | `mix_policy` | Choose the CZ/EZ mixing policy from reranked candidates and upstream evidence. |
| 14 | `build_cards` | Ask the planner to compose final journey cards. |
| 15 | `explain_from_trace` | Generate a user-facing explanation from bounded trace evidence. Its serialized trace context is hard-capped at 8 KiB of UTF-8 data. |

## Runtime components

```text
agent_runtime/src/
|- core/
|  |- graph_definition.ts    # v14 graph and validation
|  |- orchestrator.ts        # node execution and early termination
|  |- execution_context.ts   # input and intermediate-result resolution
|  |- skill_registry.ts      # registered skill lookup
|  |- trace_manager.ts       # trace merge behavior
|  |- bootstrap.ts           # production wiring
|  `- types.ts               # shared contracts
|- skills/                   # node implementations
|- llm/                      # mock/provider adapter abstraction
`- tools/toolClient.ts       # gateway client
```

`bootstrap.ts` registers the default graph's skills and also registers
`memory_signal` as a legacy, non-default compatibility entry.

## Skill lifecycle

Each skill implements the same contract:

```typescript
interface Skill<TInput, TOutput> {
    name: string;
    inputSchema: SchemaDescriptor;
    outputSchema: SchemaDescriptor;
    execute(
        input: TInput,
        context: ExecutionContext,
    ): Promise<SkillResult<TOutput>>;
}
```

For every node the orchestrator:

1. Resolves each `inputFrom` path from the root input or an earlier node.
2. Calls the registered skill.
3. Stores the output under the node id.
4. Merges the skill trace into the accumulated decision trace.
5. Records timing or terminates with a structured error.

Graph validation rejects duplicate node ids, missing dependencies, and forward
references.

## Important data contracts

### Memory weighting

`memory.search` is the authoritative source for the time, signed-sentiment, and
context factors. `memory_weight_adjust` validates and passes them downstream;
`build_profile_vector` consumes the resulting `score` as `final_weight`. This
avoids applying sentiment or recency twice.

Caption sentiment is stored on `[-1, 1]` together with
`sentiment_available`, `sentiment_confidence`, and `sentiment_source`. Its
weight is confidence-aware:

```text
w_sent = clamp(1 + 0.5 * sentiment * confidence, 0.5, 1.5)
```

Unavailable sentiment always yields `w_sent=1.0`; it is not described as a
measured neutral opinion.

### Confirmed upload persistence

`tes_builder` has no persistence side effect. `persist_memory` owns the write
and accepts success only after Memory Service returns 2xx with a `memory_id`.
Network errors, 408, 429, and 5xx responses receive bounded retries with the
same stable id; other 4xx responses fail immediately. Memory Service treats a
repeat of the same `memory_id` by the same user as an idempotent replay.

The final state is one of `skipped`, `persisted`, or `failed`. Only
`persisted` sets `memory_persisted=true` and receives the green UI state.

### TES input and reranking

`tes_builder` sends only semantic content to `/tes/build`:

```json
{
  "tags": ["seafood", "market"],
  "vision_features": ["harbour", "grilled fish"],
  "normalize": true
}
```

Sentiment, recency, and location are not TES embedding inputs. The reranker
uses `score_CZ` for CZ items and `score_EZ` for EZ items, falling back to generic
score fields only when the canonical zone field is absent. When no item TES
vector is valid, it preserves the upstream order and reports
`tes_used=false` with `fallback_reason=no_item_tes`.

### Explanation limits

`explain_from_trace` selects only the trace evidence needed for the prompt. The
serialized context is measured in UTF-8 bytes and cannot exceed 8 KiB, even for
large multibyte strings. The default token budget comes from the shared runtime
limit and can be overridden through the supported environment setting.

## Adding a skill

1. Implement the `Skill` interface in `agent_runtime/src/skills/`.
2. Export it from `skills/index.ts`.
3. Register it in `core/bootstrap.ts`.
4. Add a node with explicit backward-only `inputFrom` mappings in
   `core/graph_definition.ts`.
5. Add contract tests for graph wiring, fallback behavior, and decision trace.

Do not add new production behavior through `memory_signal`; extend
`memory_weight_adjust` or add a new graph node instead.

## Compatibility

The `/run` endpoint keeps the established response envelope (`ok`, `city`,
`type`, `tool`, `observation`, and `output`) and adds graph-native fields such as
`decision_trace`, timing, errors, explanations, and bullets. Old ReAct-related
code and the registered `memory_signal` skill are compatibility surfaces, not
the production recommendation path.
