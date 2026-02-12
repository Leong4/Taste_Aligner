"use strict";
/**
 * RecallCandidates skill — calls the recommendation service's /score
 * endpoint via the gateway to get recall results.
 *
 * In the current architecture, the recommendation service runs the
 * full pipeline (recall → rerank → mix_policy) in a single /score
 * call. This skill wraps that call and extracts the recall-stage
 * output for downstream nodes.
 *
 * IMPORTANT: This skill calls the gateway exactly as ToolClient did
 * before. It does NOT rewrite any recall logic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRecallCandidatesSkill = createRecallCandidatesSkill;
/**
 * Factory: create a recall_candidates skill bound to a ToolClient.
 *
 * We use a factory so the skill can reference the shared ToolClient
 * configured with the gateway URL and timeout.
 */
function createRecallCandidatesSkill(toolClient) {
    return {
        name: "recall_candidates",
        inputSchema: {
            description: "User context for candidate recall",
            required: ["user_id", "city", "tags"],
            optional: ["intent", "memory_confidence"],
        },
        outputSchema: {
            description: "Recall results with CZ and EZ candidate lists",
            required: ["recall_results", "full_reco_response"],
        },
        async execute(input, _context) {
            // Call recommendation.score via gateway — this returns the FULL
            // recommendation response including recall, rerank, mix_policy
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
                throw new Error(`[recall_candidates] Gateway call failed: ` +
                    `${observation.error?.code ?? "unknown"} — ${observation.error?.message ?? ""}`);
            }
            const recoResponse = observation.output;
            // Extract recall-specific data for downstream nodes
            const output = {
                recall_results: {
                    cz_candidates: recoResponse.cz_ranked ?? [],
                    ez_candidates: recoResponse.ez_ranked ?? [],
                },
                // Pass through the full response so rerank/mix_policy can
                // use pre-computed results instead of re-calling the service
                full_reco_response: recoResponse,
            };
            // Extract recall trace from the recommendation response
            const recoTrace = recoResponse.decision_trace;
            const trace = {
                recall: recoTrace?.recall ?? {},
                source: "recommendation.score",
                trace_id: observation.trace_id,
                latency_ms: observation.latency_ms,
            };
            return { output, trace };
        },
    };
}
//# sourceMappingURL=recall_candidates.js.map