"use strict";
/**
 * MixPolicy skill — extracts the CZ:EZ ratio decision.
 *
 * Primary path: reads mix_policy and decision_trace from GRAPH INPUT
 * (resolved from the fetch_recommendation node's output).
 *
 * Fallback path: if graph input is missing, scans context for any
 * node that produced mix_policy data.
 *
 * Also assembles the upstream_trace bundle for the build_cards node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mixPolicySkill = void 0;
exports.mixPolicySkill = {
    name: "mix_policy",
    inputSchema: {
        description: "Mix policy data, ranked lists, intent, and confidence",
        required: ["cz_ranked", "ez_ranked", "intent", "memory_confidence"],
        optional: ["reco_mix_policy", "reco_decision_trace"],
    },
    outputSchema: {
        description: "Mix policy with ratio, rule, confidence, and upstream trace bundle",
        required: ["policy", "upstream_trace"],
    },
    async execute(input, context) {
        let mixPolicy = input.reco_mix_policy;
        let recoTrace = input.reco_decision_trace;
        let fallback_used = false;
        const missing_fields = [];
        // Check if graph input provided the required fields
        if (!mixPolicy || typeof mixPolicy !== "object" || Object.keys(mixPolicy).length === 0) {
            missing_fields.push("reco_mix_policy");
        }
        if (!recoTrace || typeof recoTrace !== "object") {
            missing_fields.push("reco_decision_trace");
        }
        // Fallback: scan context for a node that produced mix_policy
        if (missing_fields.length > 0) {
            for (const nodeOutput of Object.values(context.intermediate_results)) {
                const obj = nodeOutput;
                if (!obj)
                    continue;
                if (missing_fields.includes("reco_mix_policy") && obj.mix_policy &&
                    typeof obj.mix_policy === "object") {
                    mixPolicy = obj.mix_policy;
                }
                if (missing_fields.includes("reco_decision_trace") && obj.decision_trace &&
                    typeof obj.decision_trace === "object") {
                    recoTrace = obj.decision_trace;
                }
                if (mixPolicy && recoTrace) {
                    fallback_used = true;
                    break;
                }
            }
        }
        mixPolicy = mixPolicy ?? {};
        recoTrace = recoTrace ?? {};
        // Build the upstream trace bundle for build_cards
        const upstreamTrace = {};
        if (recoTrace.recall)
            upstreamTrace["recall"] = recoTrace.recall;
        if (recoTrace.rerank)
            upstreamTrace["rerank"] = recoTrace.rerank;
        if (recoTrace.mix_policy)
            upstreamTrace["mix_policy"] = recoTrace.mix_policy;
        const output = {
            policy: mixPolicy,
            upstream_trace: upstreamTrace,
        };
        // The mix_policy trace for the orchestrator
        const trace = {
            ...(recoTrace.mix_policy ?? {}),
            memory_confidence_source: "memory_weight_adjust",
            memory_confidence: input.memory_confidence,
        };
        if (fallback_used) {
            trace.fallback_used = true;
            trace.missing_fields = missing_fields;
        }
        return { output, trace };
    },
};
//# sourceMappingURL=mix_policy.js.map