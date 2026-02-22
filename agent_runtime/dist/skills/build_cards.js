"use strict";
/**
 * BuildCards skill — calls the planner service via the gateway to
 * assemble final journey cards.
 *
 * Forwards the FULL accumulated decision_trace from the graph input
 * (not just extract_intent). This ensures the planner receives all
 * upstream traces from recommendation service stages.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBuildCardsSkill = createBuildCardsSkill;
const trace_manager_1 = require("../core/trace_manager");
const RULE_ID = "build_cards_v1";
const TOOL_NAME = "planner.compose";
function asObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value;
}
function normalizeStringList(values) {
    if (!Array.isArray(values))
        return [];
    return values.filter((v) => typeof v === "string");
}
function isValidInput(input) {
    const missing = [];
    if (typeof input.city !== "string" || !input.city.trim()) {
        missing.push("city");
    }
    if (!Array.isArray(input.cz_ranked)) {
        missing.push("cz_ranked");
    }
    if (!Array.isArray(input.ez_ranked)) {
        missing.push("ez_ranked");
    }
    if (!input.mix_policy || typeof input.mix_policy !== "object" || Array.isArray(input.mix_policy)) {
        missing.push("mix_policy");
    }
    return missing;
}
function buildFallback(reason, input, upstreamTrace, extra = {}) {
    const traceNode = {
        rule_id: RULE_ID,
        source: TOOL_NAME,
        fallback_used: true,
        fallback_reason: reason,
        ...extra,
    };
    const mergedDecisionTrace = (0, trace_manager_1.deepMergeTrace)(upstreamTrace, {
        build_cards: traceNode,
    });
    return {
        output: {
            ok: false,
            cards: [],
            mix_policy: input.mix_policy ?? {},
            decision_trace: mergedDecisionTrace,
            debug: {
                fallback_used: true,
                fallback_reason: reason,
            },
            input_echo: {},
            service: "planner",
            version: "v1",
            trace_id: null,
        },
        trace: traceNode,
    };
}
function createBuildCardsSkill(toolClient) {
    return {
        name: "build_cards",
        inputSchema: {
            description: "All data needed to compose journey cards",
            required: ["city", "user_id", "tags", "cz_ranked", "ez_ranked", "mix_policy"],
            optional: ["cz_seed", "ez_seed", "intent", "decision_trace"],
        },
        outputSchema: {
            description: "Final cards payload with decision trace",
            required: ["cards", "mix_policy", "decision_trace"],
        },
        async execute(input, _context) {
            const invalidFields = isValidInput(input);
            // Forward the full accumulated decision_trace from graph input,
            // falling back to the context's accumulated trace.
            const upstreamTrace = (input.decision_trace &&
                typeof input.decision_trace === "object" &&
                Object.keys(input.decision_trace).length > 0)
                ? input.decision_trace
                : _context.decision_trace;
            if (invalidFields.length > 0) {
                return buildFallback("invalid_input", input, upstreamTrace, {
                    invalid_fields: invalidFields,
                });
            }
            const plannerPayload = {
                data: {
                    city: input.city,
                    cz: normalizeStringList(input.cz_seed),
                    ez: normalizeStringList(input.ez_seed),
                    tags: normalizeStringList(input.tags),
                    user_id: input.user_id,
                    intent: input.intent ?? {},
                    cz_ranked: Array.isArray(input.cz_ranked) ? input.cz_ranked : [],
                    ez_ranked: Array.isArray(input.ez_ranked) ? input.ez_ranked : [],
                    mix_policy: input.mix_policy ?? {},
                    decision_trace: upstreamTrace,
                    meta: {
                        intent: input.intent ?? {},
                        decision_trace: upstreamTrace,
                    },
                },
            };
            let observation;
            try {
                observation = await toolClient.call({
                    tool: TOOL_NAME,
                    input: plannerPayload,
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return buildFallback("tool_error", input, upstreamTrace, {
                    error_message: message,
                });
            }
            if (!observation.ok) {
                return buildFallback("tool_error", input, upstreamTrace, {
                    error_code: observation.error?.code ?? "unknown",
                    error_message: observation.error?.message ?? "",
                });
            }
            const plannerResponse = asObject(observation.output);
            if (!plannerResponse) {
                return buildFallback("invalid_output", input, upstreamTrace, {
                    error_message: "planner_response_not_object",
                });
            }
            const plannerDecisionTrace = asObject(plannerResponse.decision_trace) ?? {};
            const mergedDecisionTrace = (0, trace_manager_1.deepMergeTrace)(upstreamTrace, plannerDecisionTrace);
            const output = {
                ok: plannerResponse.ok ?? true,
                cards: plannerResponse.cards ?? [],
                mix_policy: plannerResponse.mix_policy ?? input.mix_policy ?? {},
                decision_trace: mergedDecisionTrace,
                debug: plannerResponse.debug ?? {},
                input_echo: plannerResponse.input_echo ?? {},
                service: plannerResponse.service ?? "planner",
                version: plannerResponse.version ?? "v1",
                trace_id: plannerResponse.trace_id ?? observation.trace_id,
            };
            // Extract the planner-specific trace for the orchestrator
            const plannerNode = asObject(plannerDecisionTrace.planner);
            const trace = plannerNode ?? {
                rule_id: RULE_ID,
                source: TOOL_NAME,
                trace_id: observation.trace_id,
                latency_ms: observation.latency_ms,
                fallback_used: false,
            };
            return { output, trace };
        },
    };
}
//# sourceMappingURL=build_cards.js.map