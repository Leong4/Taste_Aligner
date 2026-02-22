# Skill Graph Architecture

## Overview

The Taste Aligner agent runtime uses a **SkillRegistry + Graph + Orchestrator** architecture to execute a deterministic recommendation pipeline. This replaces the previous ReAct loop + IntentAgent pattern with a structured, extensible, and fully traceable execution model.

**Key principles:**
- No multi-agent reasoning — deterministic skill execution + optional LLM post-processing
- Graph defines execution order — skills do not know about each other
- Decision trace is preserved and deep-merged across all skills (incoming wins)
- LLM integration via pluggable adapter — mock for dev, API adapters for production
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
    │ • 6 skills   │  │  • 6 nodes   │   │ • input      │
    │ • get/list   │  │  • inputFrom │   │ • results    │
    │              │  │  • linear    │   │ • trace      │
    └──────────────┘  └──────────────┘   │ • errors     │
                                         └──────────────┘

    ═══════════════ Execution Graph (v3.0) ═══════════════

    ┌─────────────────┐
    │  extract_intent  │  (local, no HTTP)
    │  city/type/tags  │
    └────────┬─────────┘
             │
             ▼
    ┌────────────────────┐     ┌─────────────────────┐
    │ fetch_recommendation│────▶│  recommendation.score│
    │  cz/ez ranked      │     │  (gateway → :5005)   │
    └────────┬───────────┘     └─────────────────────┘
             │
             ▼
    ┌─────────┐
    │  rerank  │  (graph input from fetch_recommendation)
    │  scored  │
    └────┬────┘
         │
         ▼
    ┌────────────┐
    │ mix_policy  │  (graph input from fetch_recommendation)
    │ CZ:EZ ratio│
    └─────┬──────┘
          │
          ▼
    ┌──────────────┐     ┌─────────────────────┐
    │  build_cards  │────▶│  planner.compose     │
    │  final cards  │     │  (gateway → :5006)   │
    └──────┬───────┘     └─────────────────────┘
           │
           ▼
    ┌────────────────────┐     ┌──────────────────┐
    │ explain_from_trace  │────▶│  LLMAdapter      │
    │  explanation + tips │     │  (mock / API)    │
    └────────────────────┘     └──────────────────┘
```

---

## Module Structure

```
agent_runtime/src/
├── core/                          # Orchestration engine
│   ├── types.ts                   # All TypeScript interfaces
│   ├── skill_registry.ts          # Skill registration + lookup
│   ├── execution_context.ts       # Shared context + path resolution
│   ├── trace_manager.ts           # Decision trace deep merge logic
│   ├── graph_definition.ts        # Graph DAG + validation
│   ├── orchestrator.ts            # Main execution engine
│   ├── bootstrap.ts               # Factory: wires registry + graph + orchestrator
│   └── index.ts                   # Barrel export
│
├── llm/                           # LLM adapter abstraction
│   ├── llm_adapter.ts             # Interface: LLMAdapter, LLMCallTrace, etc.
│   ├── mock_adapter.ts            # MockLLMAdapter (deterministic, no network)
│   └── index.ts                   # Factory: createLLMAdapterFromEnv()
│
├── skills/                        # Skill implementations
│   ├── extract_intent.ts          # Rule-based intent extraction
│   ├── fetch_recommendation.ts    # Gateway call to recommendation.score
│   ├── rerank.ts                  # Rerank via graph input (+ fallback)
│   ├── mix_policy.ts              # Mix policy via graph input (+ fallback)
│   ├── build_cards.ts             # Gateway call to planner.compose
│   ├── explain_from_trace.ts      # LLM-backed explanation generation
│   └── index.ts                   # Barrel export
│
├── tools/
│   └── toolClient.ts              # Gateway HTTP client (shared)
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
const llmAdapter = createLLMAdapterFromEnv();

// Deterministic skills
registry.register(extractIntentSkill);
registry.register(createFetchRecommendationSkill(toolClient));
registry.register(rerankSkill);
registry.register(mixPolicySkill);
registry.register(createBuildCardsSkill(toolClient));

// LLM-backed skills
registry.register(createExplainFromTraceSkill(llmAdapter));
```

Skills that need HTTP access are created via factory functions that receive the shared `ToolClient`. LLM-backed skills receive an `LLMAdapter` instance.

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
    │
    ▼
explain_from_trace (LLM → MockAdapter / API)
    → { explanation: "Based on your preferences, we selected...",
        bullets: ["City matched", "Comfort-zone ranked", "Exploration added"],
        meta: { locale: "en", style: "concise" } }
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
    },
    "explain_from_trace": {
        "schema_version": "explain_v1",
        "inputs_used": ["intent", "recall", "rerank", "mix_policy", "planner"],
        "locale": "en",
        "style": "concise",
        "fallback_used": false,
        "llm_call": {
            "provider": "mock",
            "model_name": "mock-v1",
            "temperature": 0.3,
            "prompt_version": "explain_v1",
            "latency_ms": 1,
            "fallback_used": false
        }
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

## LLM Adapter Abstraction

### Why an Adapter?

LLM-backed skills (like `explain_from_trace`) need to call language models for structured text generation. The `LLMAdapter` interface decouples skills from specific API providers:

- **Development/testing:** `MockLLMAdapter` returns deterministic canned responses — no API keys, no network, fully reproducible.
- **Production:** Swap in an `OpenAIAdapter` or `AnthropicAdapter` by setting `LLM_PROVIDER=openai` — zero changes to skill code or graph wiring.

### Interface

```typescript
interface LLMAdapter {
    readonly modelInfo: LLMModelInfo;
    generateStructuredJSON<T>(input: LLMGenerateInput): Promise<LLMGenerateOutput<T>>;
}
```

Every call returns:
- `data: T` — parsed structured response
- `callTrace: LLMCallTrace` — model, temperature, prompt_version, latency, usage (for decision_trace)

### MockLLMAdapter

The default adapter. Returns canned explanations based on `LLM_MOCK_MODE`:

| Mode | Behavior |
|------|----------|
| `short` (default) | Concise explanation, 3 bullets |
| `long` | Detailed explanation, 6 bullets |
| `error` | Throws to test fallback handling |

### How to Add an API Adapter

Create `agent_runtime/src/llm/openai_adapter.ts`:

```typescript
import { LLMAdapter, LLMGenerateInput, LLMGenerateOutput, LLMModelInfo } from "./llm_adapter";

export class OpenAIAdapter implements LLMAdapter {
    readonly modelInfo: LLMModelInfo = {
        provider: "openai",
        model_name: "gpt-4o",
        version: "2024-08-06",
    };

    async generateStructuredJSON<T>(input: LLMGenerateInput): Promise<LLMGenerateOutput<T>> {
        // Call OpenAI API with structured output schema
        // Return parsed data + callTrace
    }
}
```

Then add a case in `createLLMAdapterFromEnv()`:

```typescript
case "openai":
    return new OpenAIAdapter(process.env.OPENAI_API_KEY!);
```

No changes needed in skills, graph, or orchestrator.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `mock` | Adapter to use (`mock`, future: `openai`, `anthropic`) |
| `LLM_MOCK_MODE` | `short` | Mock response mode (`short`, `long`, `error`) |
| `EXPLAIN_LOCALE` | `en` | Default locale for explanations (`en`, `zh`) |
| `EXPLAIN_STYLE` | `concise` | Default style (`concise`, `detailed`) |

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

New fields added: `decision_trace`, `timing`, `errors`, `explanation`, `bullets`.

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
