# Skill Graph Architecture

## Overview

The Taste Aligner agent runtime uses a **SkillRegistry + Graph + Orchestrator** architecture to execute a deterministic recommendation pipeline. This replaces the previous ReAct loop + IntentAgent pattern with a structured, extensible, and fully traceable execution model.

**Key principles:**
- No multi-agent reasoning — purely deterministic skill execution
- Graph defines execution order — skills do not know about each other
- Decision trace is preserved and merged across all skills
- Existing Python services are unchanged — skills wrap gateway calls

---

## Architecture Diagram

```
                         POST /run { text }
                              │
                              ▼
                    ┌──────────────────┐
                    │   HTTP Server    │  (server.ts)
                    │   port 8787     │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │   Orchestrator   │  (core/orchestrator.ts)
                    │                  │
                    │  • Loads Graph   │
                    │  • Creates Ctx   │
                    │  • Runs nodes    │
                    │  • Merges trace  │
                    └────────┬─────────┘
                             │
           ┌─────────────────┼──────────────────┐
           │                 │                   │
           ▼                 ▼                   ▼
    ┌─────────────┐  ┌──────────────┐   ┌──────────────┐
    │ SkillRegistry│  │    Graph     │   │ ExecutionCtx │
    │              │  │  Definition  │   │              │
    │ • 5 skills   │  │  • 5 nodes   │   │ • input      │
    │ • get/list   │  │  • inputFrom │   │ • results    │
    │              │  │  • linear    │   │ • trace      │
    └──────────────┘  └──────────────┘   │ • errors     │
                                         └──────────────┘

    ═══════════════ Execution Graph ═══════════════

    ┌─────────────────┐
    │  extract_intent  │  (local, no HTTP)
    │  city/type/tags  │
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐     ┌─────────────────────┐
    │ recall_candidates │────▶│  recommendation.score│
    │  cz/ez lists     │     │  (gateway → :5005)   │
    └────────┬─────────┘     └─────────────────────┘
             │
             ▼
    ┌─────────┐
    │  rerank  │  (reads cached reco response)
    │  scored  │
    └────┬────┘
         │
         ▼
    ┌────────────┐
    │ mix_policy  │  (reads cached reco response)
    │ CZ:EZ ratio│
    └─────┬──────┘
          │
          ▼
    ┌──────────────┐     ┌─────────────────────┐
    │  build_cards  │────▶│  planner.compose     │
    │  final cards  │     │  (gateway → :5006)   │
    └──────────────┘     └─────────────────────┘
```

---

## Module Structure

```
agent_runtime/src/
├── core/                          # Orchestration engine
│   ├── types.ts                   # All TypeScript interfaces
│   ├── skill_registry.ts          # Skill registration + lookup
│   ├── execution_context.ts       # Shared context + path resolution
│   ├── trace_manager.ts           # Decision trace merge logic
│   ├── graph_definition.ts        # Graph DAG + validation
│   ├── orchestrator.ts            # Main execution engine
│   ├── bootstrap.ts               # Factory: wires registry + graph + orchestrator
│   └── index.ts                   # Barrel export
│
├── skills/                        # Skill implementations
│   ├── extract_intent.ts          # Rule-based intent extraction
│   ├── recall_candidates.ts       # Gateway call to recommendation.score
│   ├── rerank.ts                  # Extract rerank from cached response
│   ├── mix_policy.ts              # Extract mix policy from cached response
│   ├── build_cards.ts             # Gateway call to planner.compose
│   └── index.ts                   # Barrel export
│
├── agents/                        # (Legacy — preserved for reference)
│   └── intentAgent.ts
│
├── runtime/                       # (Legacy — preserved for reference)
│   ├── agent.ts
│   └── reactRuntime.ts
│
├── tools/
│   └── toolClient.ts              # Gateway HTTP client (shared)
│
├── types/
│   └── react.ts                   # Legacy types (Action, Observation, Thought)
│
├── index.ts                       # CLI entry point
└── server.ts                      # HTTP server entry point
```

---

## Skill Lifecycle

### 1. Definition

Every skill implements the `Skill` interface:

```typescript
interface Skill<TInput, TOutput> {
    name: string;
    inputSchema: SchemaDescriptor;
    outputSchema: SchemaDescriptor;
    execute(input: TInput, context: ExecutionContext): Promise<SkillResult<TOutput>>;
}

interface SkillResult<T> {
    output: T;       // Skill's output data
    trace: SkillTrace; // Decision trace fragment
}
```

### 2. Registration

Skills are registered at startup in `bootstrap.ts`:

```typescript
const registry = new SkillRegistry();
registry.register(extractIntentSkill);
registry.register(createRecallCandidatesSkill(toolClient));
registry.register(rerankSkill);
registry.register(mixPolicySkill);
registry.register(createBuildCardsSkill(toolClient));
```

Skills that need HTTP access (recall_candidates, build_cards) are created via factory functions that receive the shared `ToolClient`.

### 3. Graph Binding

Each skill is bound to a graph node with explicit input mappings:

```typescript
{
    id: "rerank",
    skill: "rerank",
    inputFrom: {
        recall_results: "recall_candidates.recall_results",
        user_id: "extract_intent.user_id",
        user_city: "extract_intent.city",
        user_tags: "extract_intent.tags",
    },
}
```

### 4. Execution

The Orchestrator iterates graph nodes sequentially:

1. Resolve inputs from `ExecutionContext` using `inputFrom` paths
2. Call `skill.execute(resolvedInput, context)`
3. Store `result.output` in `context.intermediate_results[nodeId]`
4. Merge `result.trace` into `context.decision_trace[skillName]`
5. Record timing

### 5. Error Handling

- If a skill throws, the Orchestrator records the error and returns immediately
- Early termination: if `extract_intent` produces no city, the pipeline stops before `recall_candidates`
- Non-fatal errors are collected in `context.errors`

---

## Data Flow

### Input → Output Path

```
{ text: "I want to travel to London for food." }
    │
    ▼
extract_intent
    → { city: "london", type: "food", tags: ["food"], cz_seed: [...], ... }
    │
    ▼
recall_candidates (HTTP → recommendation.score)
    → { recall_results: { cz_candidates: [...], ez_candidates: [...] },
        full_reco_response: { ... } }
    │
    ▼
rerank (reads cached full_reco_response)
    → { cz_ranked: [{score_CZ: 1.87, ...}], ez_ranked: [{score_EZ: 1.43, ...}] }
    │
    ▼
mix_policy (reads cached full_reco_response)
    → { policy: { ratio: "3:1", cz: 3, ez: 1, rule: "..." },
        upstream_trace: { recall: {...}, rerank: {...}, mix_policy: {...} } }
    │
    ▼
build_cards (HTTP → planner.compose)
    → { cards: [ { zone: "CZ", items: [...] }, { zone: "EZ", items: [...] } ],
        decision_trace: { recall: {...}, rerank: {...}, planner: {...} } }
```

### ExecutionContext Resolution

Input paths use dot notation to reference data from prior nodes:

| Path | Resolves To |
|------|-------------|
| `input.text` | Original user text |
| `extract_intent.city` | City from intent extraction |
| `recall_candidates.recall_results` | Recall output |
| `rerank.cz_ranked` | Ranked CZ list |
| `mix_policy.policy` | Mix policy decision |

---

## Decision Trace Structure

The final merged `decision_trace` contains one entry per skill:

```json
{
    "extract_intent": {
        "rule_id": "intent_v1_keywords",
        "city_detected": true,
        "city": "london",
        "type": "food",
        "cz_seed": ["ramen_shop", "izakaya"],
        "ez_seed": [],
        "tags": ["food"]
    },
    "recall_candidates": {
        "recall": {
            "rule_id": "recall_v1_city_strict",
            "rules_used": ["cz_city_match", "ez_city_excellence"],
            "candidate_counts": { "cz": 11, "ez": 18 },
            "cross_city_guard": { "rejected": 0 }
        },
        "source": "recommendation.score"
    },
    "rerank": {
        "rule_id": "rerank_v1_3",
        "top_items": [...],
        "weights": { "alpha": 1.0, "beta": 0.6, "gamma": 0.3 },
        "thresholds": { ... }
    },
    "mix_policy": {
        "ratio": { "label": "3:1", "cz": 3, "ez": 1 },
        "rule_id": "comfort_high_confidence",
        "confidence": 0.9,
        "components": { ... }
    },
    "build_cards": {
        "rule_id": "planner_compose_v1",
        "cards_count": 2,
        "selected_cz_ids": [...],
        "selected_ez_ids": [...]
    }
}
```

---

## How to Add a New Skill

### Step 1: Implement the Skill

Create a new file in `agent_runtime/src/skills/`:

```typescript
// skills/my_new_skill.ts
import { Skill, SkillResult, ExecutionContext } from "../core/types";

interface MyInput { /* ... */ }
interface MyOutput { /* ... */ }

export const myNewSkill: Skill<MyInput, MyOutput> = {
    name: "my_new_skill",
    inputSchema: {
        description: "Description of expected input",
        required: ["field1", "field2"],
    },
    outputSchema: {
        description: "Description of output",
        required: ["result"],
    },
    async execute(input: MyInput, context: ExecutionContext): Promise<SkillResult<MyOutput>> {
        // Your logic here
        const output: MyOutput = { /* ... */ };
        const trace = { rule_id: "my_rule_v1", /* ... */ };
        return { output, trace };
    },
};
```

### Step 2: Register in Bootstrap

```typescript
// core/bootstrap.ts
import { myNewSkill } from "../skills/my_new_skill";

registry.register(myNewSkill);
```

### Step 3: Add to Graph

```typescript
// core/graph_definition.ts — add a node
{
    id: "my_new_skill",
    skill: "my_new_skill",
    inputFrom: {
        field1: "extract_intent.city",
        field2: "rerank.cz_ranked",
    },
}
```

### Step 4: Export

Add to `skills/index.ts`:

```typescript
export { myNewSkill } from "./my_new_skill";
```

---

## How to Add an LLM-Based Skill

LLM-based skills follow the same pattern but call an LLM endpoint:

```typescript
export function createLlmSummarySkill(toolClient: ToolClient): Skill {
    return {
        name: "llm_summary",
        inputSchema: { description: "Cards to summarize", required: ["cards"] },
        outputSchema: { description: "Natural language summary", required: ["summary"] },
        async execute(input, context) {
            // Call an LLM service via gateway
            const observation = await toolClient.call({
                tool: "llm.summarize",
                input: { cards: input.cards, prompt: "Summarize these recommendations" },
            });

            if (!observation.ok) {
                throw new Error(`LLM call failed: ${observation.error?.message}`);
            }

            return {
                output: { summary: observation.output.text },
                trace: {
                    rule_id: "llm_summary_v1",
                    model: observation.output.model,
                    latency_ms: observation.latency_ms,
                },
            };
        },
    };
}
```

Then add it to the graph after `build_cards`. The deterministic pipeline remains unchanged — the LLM skill is an additive post-processing step.

---

## Backward Compatibility

The `/run` endpoint response maintains the same shape as before:

| Field | Old Source | New Source |
|-------|-----------|-----------|
| `ok` | `observation.ok` | `orchestrator.result.ok` |
| `city` | `state.city` | `result.city` |
| `type` | `state.type` | `result.type` |
| `tool` | `observation.tool` | `"planner.compose"` (if ok) |
| `observation` | Raw observation | Synthetic wrapper |
| `output` | `observation.output` | Cards + trace payload |

New fields added: `decision_trace`, `timing`, `errors`.

---

## Comparison: Old vs New Architecture

| Aspect | Old (ReAct + IntentAgent) | New (SkillRegistry + Graph) |
|--------|--------------------------|----------------------------|
| Flow control | ReAct loop with maxTurns | Linear graph traversal |
| Intent extraction | IntentAgent.think() | extract_intent skill |
| Tool dispatch | IntentAgent.act() → ToolClient | Graph node → skill.execute() |
| Trace management | Passed through state object | TraceManager merges per-skill |
| Error handling | ReAct loop retry | Fail-fast with error collection |
| Extensibility | Add new Agent class | Register skill + add graph node |
| LLM integration | Agent uses LLM to decide | Skill wraps LLM call |
| Observability | history array | timing + decision_trace + errors |
