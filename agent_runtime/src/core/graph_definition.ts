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
export const RECOMMENDATION_GRAPH: GraphDefinition = {
    name: "recommendation_pipeline",
    version: "2.0.0",
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
        // Node 2: Fetch full recommendation (recall+rerank+mix)
        // The recommendation service runs the full pipeline in one
        // /score call. This node honestly exposes the full result.
        // Output: cz_ranked, ez_ranked, mix_policy, decision_trace
        // ─────────────────────────────────────────────────────────
        {
            id: "fetch_recommendation",
            skill: "fetch_recommendation",
            inputFrom: {
                user_id: "extract_intent.user_id",
                city: "extract_intent.city",
                tags: "extract_intent.tags",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 3: Rerank — consumes ranked lists from graph input
        // Primary: uses cz_ranked/ez_ranked from fetch_recommendation
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
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 4: Mix policy — consumes from graph input
        // Primary: uses reco_mix_policy and reco_decision_trace
        // from fetch_recommendation
        // Output: policy, upstream_trace
        // ─────────────────────────────────────────────────────────
        {
            id: "mix_policy",
            skill: "mix_policy",
            inputFrom: {
                cz_ranked: "rerank.cz_ranked",
                ez_ranked: "rerank.ez_ranked",
                intent: "extract_intent.type",
                memory_confidence: "extract_intent.confidence",
                reco_mix_policy: "fetch_recommendation.mix_policy",
                reco_decision_trace: "fetch_recommendation.decision_trace",
            },
        },

        // ─────────────────────────────────────────────────────────
        // Node 5: Build final journey cards
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
