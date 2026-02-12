/**
 * Graph definitions for the Taste Aligner orchestration pipeline.
 *
 * Each graph is a linear DAG of skill nodes. The Orchestrator executes
 * nodes in order, resolving each node's input from the shared
 * ExecutionContext using the `inputFrom` mapping.
 *
 * Data flow path:
 *
 *   input.text
 *       │
 *       ▼
 *   ┌─────────────────────┐
 *   │   extract_intent     │  → city, type, tags, seeds
 *   └─────────┬────────────┘
 *             │
 *             ▼
 *   ┌─────────────────────┐
 *   │ fetch_recommendation │  → cz_ranked, ez_ranked, mix_policy, decision_trace
 *   └─────────┬────────────┘
 *             │
 *             ▼
 *   ┌─────────┐
 *   │ rerank   │  → cz_ranked, ez_ranked (pass-through from service)
 *   └────┬────┘
 *        │
 *        ▼
 *   ┌────────────┐
 *   │ mix_policy  │  → policy, upstream_trace
 *   └─────┬──────┘
 *         │
 *         ▼
 *   ┌──────────────┐
 *   │ build_cards   │  → cards (final output)
 *   └──────────────┘
 *
 * To add a new skill:
 *   1. Implement the Skill interface (see skills/ directory)
 *   2. Register it in the SkillRegistry
 *   3. Add a GraphNode here with appropriate inputFrom mappings
 */
import { GraphDefinition } from "./types";
/**
 * The default recommendation pipeline graph (v2.0).
 *
 * v2.0 changes from v1.0:
 *   - recall_candidates renamed to fetch_recommendation (honest semantics)
 *   - rerank/mix_policy consume graph inputs, not raw context lookups
 *   - mix_policy receives reco_mix_policy and reco_decision_trace from
 *     the fetch_recommendation node
 */
export declare const RECOMMENDATION_GRAPH: GraphDefinition;
/**
 * Validate a graph definition for structural correctness.
 * Checks that:
 *   - All node IDs are unique
 *   - All inputFrom references point to either "input" or a prior node
 *   - No forward references exist (DAG property for linear graphs)
 */
export declare function validateGraph(graph: GraphDefinition): string[];
//# sourceMappingURL=graph_definition.d.ts.map