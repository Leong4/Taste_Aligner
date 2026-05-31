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
 *   │  decide_tag_budget   │  → budget, hard/soft allocation
 *   └─────────┬────────────┘
 *             │
 *             ▼
 *   ┌─────────────────────┐
 *   │    tag_expand        │
 *   └─────────┬────────────┘
 *             │
 *             ▼
 *   ┌─────────────────────┐
 *   │   tag_normalize      │
 *   └─────────┬────────────┘
 *             │
 *             ▼
 *   ┌─────────────────────┐
 *   │    tes_builder       │  → tes_vector (512)
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
 *   │ build_cards   │  → cards (core output)
 *   └──────┬───────┘
 *          │
 *          ▼
 *   ┌────────────────────┐
 *   │ explain_from_trace  │  → explanation, bullets (LLM-generated)
 *   └────────────────────┘
 *
 * To add a new skill:
 *   1. Implement the Skill interface (see skills/ directory)
 *   2. Register it in the SkillRegistry
 *   3. Add a GraphNode here with appropriate inputFrom mappings
 */
import { GraphDefinition } from "./types";
/**
 * The default recommendation pipeline graph (v8.0).
 *
 * v13.0 changes from v12.0:
 *   - Added build_profile_vector node (Node 6) between memory_weight_adjust
 *     and vision_describe.  Single authoritative source for P4 dynamic
 *     weighting: computes final_weight = cosine * w_time * w_sent * w_context
 *     per memory and writes decision_trace.profile_vector_node.
 *   - explain_from_trace now reads profile_vector_node from the trace.
 *   - Graph version bumped to 13.0.0.
 *
 * v12.0 changes from v11.0:
 *   - Removed legacy memory_signal node from default /run main path.
 *   - mix_policy.memory_confidence now reads from memory_weight_adjust.
 *   - Graph version bumped to 12.0.0.
 *
 * v11.0 changes from v10.0:
 *   - Added vision_describe node between memory_weight_adjust and tes_builder.
 *     Reads image_url / image_base64 from root input (optional).
 *     Provides vision_features[] to tes_builder for multimodal TES enrichment.
 *     Falls back gracefully to vision_features=[] when no image is supplied.
 *   - tes_builder now receives vision_features from vision_describe.
 *   - Graph version bumped to 11.0.0.
 *
 * v10.0 changes from v9.0:
 *   - rerank node now receives tes_vector, tes_dim, tes_normalized,
 *     tes_fallback_used from tes_builder for TES-driven reranking
 *   - rerank skill upgraded to v2 with TES similarity fusion
 *
 * v9.0 changes from v8.0:
 *   - Added memory_weight_adjust node after tag_normalize
 *   - tes_builder.anchor_tags now reads from memory_weight_adjust
 *   - fetch_recommendation.memory_confidence now reads from memory_weight_adjust
 *   - memory_signal node retained for backward compatibility
 *
 * v8.0 changes from v7.0:
 *   - Added tes_builder node after memory_signal
 *   - tes_builder builds validated TES vector from anchor_tags
 *
 * v7.0 changes from v6.0:
 *   - Added memory_signal node after tag_normalize
 *   - fetch_recommendation now accepts memory_confidence
 *   - mix_policy memory_confidence now comes from memory_signal
 *
 * v6.0 changes from v5.0:
 *   - Added tag_normalize node after tag_expand
 *   - fetch_recommendation now consumes normalized_tags first
 *
 * v5.0 changes from v4.0:
 *   - Added tag_expand node after decide_tag_budget
 *   - fetch_recommendation now reads expanded tags first with intent fallback
 *
 * v4.0 changes from v3.0:
 *   - Added decide_tag_budget node after extract_intent
 *     (deterministic budget computation for future tag_expand)
 *
 * v3.0 changes from v2.0:
 *   - Added explain_from_trace node (LLM-backed) after build_cards
 *   - Orchestrator buildOutput scans all nodes for output fields
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