"use strict";
/**
 * FetchRecommendation skill — calls the recommendation service's /score
 * endpoint via the gateway.
 *
 * The recommendation service runs the full pipeline (recall → rerank →
 * mix_policy) in a single /score call. This skill honestly exposes
 * the full response shape so downstream nodes consume correct semantics:
 *
 *   - cz_ranked:   already-scored CZ items (not raw recall candidates)
 *   - ez_ranked:   already-scored EZ items
 *   - mix_policy:  the computed CZ:EZ ratio
 *   - recall_summary: counts/rules from the recall stage
 *   - decision_trace: { recall, rerank, mix_policy } from the service
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFetchRecommendationSkill = createFetchRecommendationSkill;
function createFetchRecommendationSkill(toolClient) {
    return {
        name: "fetch_recommendation",
        inputSchema: {
            description: "User context for recommendation scoring",
            required: ["user_id", "city", "tags"],
            optional: ["intent", "memory_confidence"],
        },
        outputSchema: {
            description: "Full recommendation result: ranked lists, mix policy, traces",
            required: ["cz_ranked", "ez_ranked", "mix_policy", "decision_trace"],
        },
        async execute(input, _context) {
            const observation = await toolClient.call({
                tool: "recommendation.score",
                input: {
                    data: {
                        user_id: input.user_id,
                        city: input.city,
                        tags: input.tags,
                        intent: input.intent ?? "balanced",
                        memory_confidence: input.memory_confidence ?? 0.6,
                    },
                },
            });
            if (!observation.ok) {
                throw new Error(`[fetch_recommendation] Gateway call failed: ` +
                    `${observation.error?.code ?? "unknown"} — ${observation.error?.message ?? ""}`);
            }
            const reco = observation.output;
            // Expose the actual semantics of what the service returns
            const output = {
                cz_ranked: reco.cz_ranked ?? [],
                ez_ranked: reco.ez_ranked ?? [],
                mix_policy: reco.mix_policy ?? {},
                recall_summary: reco.recall ?? {},
                decision_trace: reco.decision_trace ?? {},
                debug: reco.debug ?? {},
                trace_id: reco.trace_id ?? observation.trace_id,
                version: reco.version,
            };
            // The skill-level trace for the orchestrator's decision_trace
            const recoTrace = reco.decision_trace;
            const trace = {
                source: "recommendation.score",
                trace_id: observation.trace_id,
                latency_ms: observation.latency_ms,
                recall: recoTrace?.recall ?? {},
            };
            return { output, trace };
        },
    };
}
//# sourceMappingURL=fetch_recommendation.js.map