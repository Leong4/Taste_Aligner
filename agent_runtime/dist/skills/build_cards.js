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
            // Forward the full accumulated decision_trace from graph input,
            // falling back to the context's accumulated trace.
            const upstreamTrace = (input.decision_trace &&
                typeof input.decision_trace === "object" &&
                Object.keys(input.decision_trace).length > 0)
                ? input.decision_trace
                : _context.decision_trace;
            const plannerPayload = {
                city: input.city,
                cz: input.cz_seed ?? [],
                ez: input.ez_seed ?? [],
                tags: input.tags ?? [],
                user_id: input.user_id,
                intent: input.intent ?? {},
                meta: {
                    intent: input.intent ?? {},
                    decision_trace: upstreamTrace,
                },
            };
            const observation = await toolClient.call({
                tool: "planner.compose",
                input: plannerPayload,
            });
            if (!observation.ok) {
                throw new Error(`[build_cards] Gateway call to planner.compose failed: ` +
                    `${observation.error?.code ?? "unknown"} — ${observation.error?.message ?? ""}`);
            }
            const plannerResponse = observation.output;
            const output = {
                ok: plannerResponse.ok ?? true,
                cards: plannerResponse.cards ?? [],
                mix_policy: plannerResponse.mix_policy ?? input.mix_policy ?? {},
                decision_trace: plannerResponse.decision_trace ?? {},
                debug: plannerResponse.debug ?? {},
                input_echo: plannerResponse.input_echo ?? {},
                service: plannerResponse.service ?? "planner",
                version: plannerResponse.version ?? "v1",
                trace_id: plannerResponse.trace_id ?? observation.trace_id,
            };
            // Extract the planner-specific trace for the orchestrator
            const plannerTrace = plannerResponse.decision_trace;
            const trace = plannerTrace?.planner ?? {
                rule_id: "planner_compose_v1",
                source: "planner.compose",
                trace_id: observation.trace_id,
                latency_ms: observation.latency_ms,
            };
            return { output, trace };
        },
    };
}
//# sourceMappingURL=build_cards.js.map