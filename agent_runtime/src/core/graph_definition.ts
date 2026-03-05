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
export const RECOMMENDATION_GRAPH: GraphDefinition = {
    name: "recommendation_pipeline",
    version: "13.0.0",
    nodes: [
        // ─────────────────────────────────────────────────────────
        // Node 1: Extract intent from raw user text
        // Output: city, type, tags, cz_seed, ez_seed, user_id
        // May signal terminal=true if no city detected.
        // ─────────────────────────────────────────────────────────
        {
            id: "extract_intent",
            skill: "extract_intent",
            inputFrom: {
                text: "input.text",
                user_id: "input.user_id",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 2: Compute tag expansion budget
        // Deterministic budget based on seeds, soft hints, type,
        // and text length. Feeds future tag_expand skill.
        // Output: budget, hard_expand_limit, soft_expand_limit,
        //         + pass-through tags, cz_seed, ez_seed
        // ─────────────────────────────────────────────────────────
        {
            id: "decide_tag_budget",
            skill: "decide_tag_budget",
            inputFrom: {
                tags: "extract_intent.tags",
                cz_seed: "extract_intent.cz_seed",
                ez_seed: "extract_intent.ez_seed",
                type: "extract_intent.type",
                raw_text: "extract_intent.raw_text",
                confidence: "extract_intent.confidence",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 3: Expand tags with LLM + deterministic post-filtering
        // Output: seed_tags, hard_tags, soft_tags, tags_final
        // ─────────────────────────────────────────────────────────
        {
            id: "tag_expand",
            skill: "tag_expand",
            inputFrom: {
                user_text: "input.text",
                intent: "extract_intent",
                tag_budget: "decide_tag_budget",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 4: Normalize expanded tags to ontology standard tags
        // Output: normalized_tags + mapping + dropped + decision_trace
        // ─────────────────────────────────────────────────────────
        {
            id: "tag_normalize",
            skill: "tag_normalize",
            inputFrom: {
                tags_final: "tag_expand.tags_final",
                intent: "extract_intent",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 5: Weighted memory aggregation
        // Calls memory.search, deterministically sorts/aggregates
        // into weighted_results, anchor_tags, memory_confidence.
        // Output: weighted_results, anchor_memory_ids, anchor_tags,
        //         memory_confidence, stats, decision_trace
        // ─────────────────────────────────────────────────────────
        {
            id: "memory_weight_adjust",
            skill: "memory_weight_adjust",
            inputFrom: {
                user_id: "extract_intent.user_id",
                city: "extract_intent.city",
                tags: "tag_normalize.normalized_tags",
                intent_tags: "tag_expand.tags_final",
                now_ts: "input.request_ts",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 6: Build profile vector — P4 dynamic weighting unification
        // Single authoritative source for time/sentiment weighting in the
        // pipeline.  Reads weighted_results from memory_weight_adjust and
        // computes final_weight = cosine * w_time * w_sent * w_context for
        // each memory.  Profile vector is a weighted average of embeddings
        // (512-dim zero vector when no raw embeddings are available).
        // Writes decision_trace.profile_vector_node for explain_from_trace.
        // Output: profile_vector, anchors, total_memories_considered, weights,
        //         decision_trace
        // ─────────────────────────────────────────────────────────
        {
            id: "build_profile_vector",
            skill: "build_profile_vector",
            inputFrom: {
                weighted_results: "memory_weight_adjust.weighted_results",
                now_ts: "input.request_ts",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 7: Vision describe — optional multimodal signal
        // Reads image_url / image_base64 from root input (optional).
        // Returns vision_features[] for TES enrichment.
        // Falls back gracefully to [] when no image is provided.
        // ─────────────────────────────────────────────────────────
        {
            id: "vision_describe",
            skill: "vision_describe",
            inputFrom: {
                image_url: "input.image_url",
                image_base64: "input.image_base64",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 8: Build TES vector from anchor_tags + vision_features
        // Now reads from memory_weight_adjust instead of memory_signal.
        // vision_features wired from vision_describe for multimodal enrichment.
        // Output: tes_vector, normalized, backend, tes_version
        // ─────────────────────────────────────────────────────────
        {
            id: "tes_builder",
            skill: "tes_builder",
            inputFrom: {
                anchor_tags: "memory_weight_adjust.anchor_tags",
                normalized_tags: "tag_normalize.normalized_tags",
                vision_features: "vision_describe.vision_features",
                request_ts: "input.request_ts",
                user_city: "extract_intent.city",
                decision_trace: "memory_weight_adjust.decision_trace",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 8: Fetch full recommendation (recall+rerank+mix)
        // memory_confidence now comes from memory_weight_adjust.
        // Output: cz_ranked, ez_ranked, mix_policy, decision_trace
        // ─────────────────────────────────────────────────────────
        {
            id: "fetch_recommendation",
            skill: "fetch_recommendation",
            inputFrom: {
                user_id: "extract_intent.user_id",
                city: "extract_intent.city",
                tags: "tag_normalize.normalized_tags",
                intent_tags: "tag_expand.tags_final",
                memory_confidence: "memory_weight_adjust.memory_confidence",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 9: Rerank — TES-driven rerank with fallback
        // Receives user TES vector from tes_builder for similarity
        // fusion with per-item TES vectors.
        // Output: cz_ranked, ez_ranked
        // ─────────────────────────────────────────────────────────
        {
            id: "rerank",
            skill: "rerank",
            inputFrom: {
                cz_ranked: "fetch_recommendation.cz_ranked",
                ez_ranked: "fetch_recommendation.ez_ranked",
                user_id: "extract_intent.user_id",
                user_city: "extract_intent.city",
                user_tags: "extract_intent.tags",
                tes_vector: "tes_builder.tes_vector",
                tes_dim: "tes_builder.tes_dim",
                tes_normalized: "tes_builder.normalized",
                tes_fallback_used: "tes_builder.fallback_used",
                tes_backend: "tes_builder.backend",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 10: Mix policy — consumes from graph input
        // Primary: uses reco_mix_policy and reco_decision_trace
        // from fetch_recommendation
        // memory_confidence reads from memory_weight_adjust (single source).
        // Output: policy, upstream_trace
        // ─────────────────────────────────────────────────────────
        {
            id: "mix_policy",
            skill: "mix_policy",
            inputFrom: {
                cz_ranked: "rerank.cz_ranked",
                ez_ranked: "rerank.ez_ranked",
                intent: "extract_intent.type",
                memory_confidence: "memory_weight_adjust.memory_confidence",
                reco_mix_policy: "fetch_recommendation.mix_policy",
                reco_decision_trace: "fetch_recommendation.decision_trace",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 11: Build final journey cards
        // Calls planner.compose via gateway.
        // Output: cards + decision_trace
        // ─────────────────────────────────────────────────────────
        {
            id: "build_cards",
            skill: "build_cards",
            inputFrom: {
                city: "extract_intent.city",
                user_id: "extract_intent.user_id",
                tags: "extract_intent.tags",
                cz_seed: "extract_intent.cz_seed",
                ez_seed: "extract_intent.ez_seed",
                intent: "extract_intent.intent_object",
                cz_ranked: "rerank.cz_ranked",
                ez_ranked: "rerank.ez_ranked",
                mix_policy: "mix_policy.policy",
                decision_trace: "mix_policy.upstream_trace",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 12: Explain from trace (LLM-backed)
        // Generates a human-readable explanation of the recommendation
        // decision. Uses the accumulated decision_trace as input.
        // Output: explanation, bullets, meta
        // ─────────────────────────────────────────────────────────
        {
            id: "explain_from_trace",
            skill: "explain_from_trace",
            inputFrom: {
                decision_trace: "build_cards.decision_trace",
                user_text: "input.text",
            },
        },
    ],
};

/**
 * Validate a graph definition for structural correctness.
 * Checks that:
 *   - All node IDs are unique
 *   - All inputFrom references point to either "input" or a prior node
 *   - No forward references exist (DAG property for linear graphs)
 */
export function validateGraph(graph: GraphDefinition): string[] {
    const errors: string[] = [];
    const seen = new Set<string>(["input"]);

    for (const node of graph.nodes) {
        if (seen.has(node.id) && node.id !== "input") {
            errors.push(`Duplicate node ID: "${node.id}"`);
        }

        for (const [field, path] of Object.entries(node.inputFrom)) {
            const root = path.split(".")[0]!;
            if (!seen.has(root)) {
                errors.push(
                    `Node "${node.id}" field "${field}" references ` +
                    `"${root}" which has not been defined yet`
                );
            }
        }

        seen.add(node.id);
    }

    return errors;
}
