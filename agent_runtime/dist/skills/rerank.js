"use strict";
/**
 * Rerank skill — extracts CZ/EZ ranked results from the upstream
 * fetch_recommendation node.
 *
 * Primary path: reads cz_ranked/ez_ranked from GRAPH INPUT (resolved
 * by the orchestrator from inputFrom mappings).
 *
 * Fallback path: if graph input fields are missing, reads from the
 * fetch_recommendation node's decision_trace via context. When
 * fallback is used, trace metadata records it for observability.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rerankSkill = void 0;
exports.rerankSkill = {
    name: "rerank",
    inputSchema: {
        description: "Ranked CZ/EZ lists and user context",
        required: ["cz_ranked", "ez_ranked", "user_id", "user_city", "user_tags"],
    },
    outputSchema: {
        description: "Ranked CZ and EZ lists with scores and components",
        required: ["cz_ranked", "ez_ranked"],
    },
    async execute(input, context) {
        let cz_ranked = input.cz_ranked;
        let ez_ranked = input.ez_ranked;
        let fallback_used = false;
        const missing_fields = [];
        // Check if graph input provided the required fields
        if (!Array.isArray(cz_ranked) || cz_ranked.length === 0) {
            missing_fields.push("cz_ranked");
        }
        if (!Array.isArray(ez_ranked) || ez_ranked.length === 0) {
            missing_fields.push("ez_ranked");
        }
        // Fallback: find the fetch_recommendation node output in context
        if (missing_fields.length > 0) {
            for (const nodeOutput of Object.values(context.intermediate_results)) {
                const obj = nodeOutput;
                if (!obj || !obj.cz_ranked)
                    continue;
                if (missing_fields.includes("cz_ranked") && Array.isArray(obj.cz_ranked)) {
                    cz_ranked = obj.cz_ranked;
                }
                if (missing_fields.includes("ez_ranked") && Array.isArray(obj.ez_ranked)) {
                    ez_ranked = obj.ez_ranked;
                }
                fallback_used = true;
                break;
            }
        }
        const output = {
            cz_ranked: cz_ranked ?? [],
            ez_ranked: ez_ranked ?? [],
        };
        // Extract rerank trace from the upstream decision_trace
        let rerank_trace = {};
        for (const nodeOutput of Object.values(context.intermediate_results)) {
            const obj = nodeOutput;
            const dt = obj?.decision_trace;
            if (dt?.rerank) {
                rerank_trace = dt.rerank;
                break;
            }
        }
        const trace = { ...rerank_trace };
        if (fallback_used) {
            trace.fallback_used = true;
            trace.missing_fields = missing_fields;
        }
        return { output, trace };
    },
};
//# sourceMappingURL=rerank.js.map