"use strict";
/**
 * FetchRecommendation skill — calls recommendation.score via gateway ToolClient.
 *
 * This skill is responsible for:
 *   1) building a stable request payload from graph inputs
 *   2) extracting ranked results + service decision_trace
 *   3) returning deterministic fallback output on any tool/output failure
 *
 * It does NOT perform rerank or mix-policy computation itself.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFetchRecommendationSkill = createFetchRecommendationSkill;
const RULE_ID = "fetch_recommendation_v1";
const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "recommendation.score";
const DEFAULT_MEMORY_POOL = "all";
function normalizeCity(city) {
    if (typeof city !== "string") {
        return "";
    }
    return city.trim().toLowerCase();
}
function normalizeUserId(userId) {
    if (typeof userId === "string" && userId.trim()) {
        return { value: userId.trim(), usedDefault: false };
    }
    return { value: "u001", usedDefault: true };
}
function normalizeTags(primary, fallback) {
    const source = Array.isArray(primary) && primary.length > 0 ? primary : fallback;
    if (!Array.isArray(source)) {
        return [];
    }
    const normalized = new Set();
    for (const value of source) {
        if (typeof value !== "string") {
            continue;
        }
        const cleaned = value.trim().toLowerCase();
        if (!cleaned) {
            continue;
        }
        normalized.add(cleaned);
    }
    const out = Array.from(normalized);
    out.sort((a, b) => a.localeCompare(b));
    return out;
}
function normalizeMemoryPool(value) {
    if (typeof value !== "string")
        return DEFAULT_MEMORY_POOL;
    const cleaned = value.trim().toLowerCase();
    if (cleaned === "food")
        return "food";
    if (cleaned === "scenery" || cleaned === "culture")
        return "scenery";
    if (cleaned === "all" || cleaned === "mixed" || cleaned === "unknown")
        return "all";
    return DEFAULT_MEMORY_POOL;
}
function emptyOutput() {
    return {
        cz_ranked: [],
        ez_ranked: [],
        mix_policy: null,
        decision_trace: {},
        reco_mix_policy: null,
        reco_decision_trace: {},
    };
}
function buildNodeTrace(requestSummary, latencyMs, rawCounts, fallbackUsed, fallbackReason, errorMessage, userIdDefaulted) {
    const trace = {
        rule_id: RULE_ID,
        schema_version: SCHEMA_VERSION,
        tool: TOOL_NAME,
        provider: "gateway",
        mode: "unknown",
        request_summary: requestSummary,
        latency_ms: latencyMs,
        raw_counts: rawCounts,
        fallback_used: fallbackUsed,
        fallback_reason: fallbackReason,
        error_message: errorMessage,
    };
    if (userIdDefaulted) {
        trace.reasons = ["user_id_defaulted_to_u001"];
    }
    return trace;
}
function buildFallback(reason, requestSummary, latencyMs, errorMessage, userIdDefaulted) {
    const nodeTrace = buildNodeTrace(requestSummary, latencyMs, { cz: 0, ez: 0 }, true, reason, reason === "tool_error" ? errorMessage : "", userIdDefaulted);
    return {
        output: emptyOutput(),
        trace: nodeTrace,
    };
}
function asObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value;
}
function createFetchRecommendationSkill(toolClient) {
    return {
        name: "fetch_recommendation",
        inputSchema: {
            description: "User context for recommendation scoring",
            required: ["city"],
            optional: ["user_id", "tags", "intent_tags", "intent", "meta", "controls", "memory_confidence", "memory_pool", "anchor_tags"],
        },
        outputSchema: {
            description: "Ranked CZ/EZ items + recommendation service decision trace",
            required: ["cz_ranked", "ez_ranked", "mix_policy", "decision_trace"],
            optional: ["reco_mix_policy", "reco_decision_trace"],
        },
        async execute(input, _context) {
            const city = normalizeCity(input.city);
            const userIdInfo = normalizeUserId(input.user_id);
            const tags = normalizeTags(input.tags, input.intent_tags);
            const memoryPool = normalizeMemoryPool(input.memory_pool);
            const anchorTags = normalizeTags(input.anchor_tags, []);
            const requestSummary = {
                city,
                user_id: userIdInfo.value,
                user_id_defaulted: userIdInfo.usedDefault,
                tags_count: tags.length,
                intent_present: input.intent !== undefined && input.intent !== null,
                memory_pool: memoryPool,
            };
            if (!city) {
                return buildFallback("invalid_output", requestSummary, 0, "missing_city", userIdInfo.usedDefault);
            }
            const startedAt = Date.now();
            let observation;
            try {
                observation = await toolClient.call({
                    tool: TOOL_NAME,
                    input: {
                        data: {
                            user_id: userIdInfo.value,
                            city,
                            tags,
                            intent: input.intent ?? "balanced",
                            memory_confidence: input.memory_confidence ?? 0.6,
                            memory_pool: memoryPool,
                            anchor_tags: anchorTags,
                        },
                    },
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return buildFallback("tool_error", requestSummary, Date.now() - startedAt, message, userIdInfo.usedDefault);
            }
            if (!observation.ok) {
                return buildFallback("tool_error", requestSummary, observation.latency_ms ?? (Date.now() - startedAt), observation.error?.message ?? "gateway_call_failed", userIdInfo.usedDefault);
            }
            const payload = asObject(observation.output);
            if (!payload) {
                return buildFallback("invalid_output", requestSummary, observation.latency_ms ?? (Date.now() - startedAt), "response_not_object", userIdInfo.usedDefault);
            }
            const czRanked = payload.cz_ranked;
            const ezRanked = payload.ez_ranked;
            if (!Array.isArray(czRanked) || !Array.isArray(ezRanked)) {
                return buildFallback("invalid_output", requestSummary, observation.latency_ms ?? (Date.now() - startedAt), "missing_ranked_lists", userIdInfo.usedDefault);
            }
            if (czRanked.length === 0 && ezRanked.length === 0) {
                return buildFallback("empty_result", requestSummary, observation.latency_ms ?? (Date.now() - startedAt), "both_ranked_lists_empty", userIdInfo.usedDefault);
            }
            const mixPolicy = asObject(payload.mix_policy);
            const recoDecisionTrace = asObject(payload.decision_trace) ?? {};
            const output = {
                cz_ranked: czRanked,
                ez_ranked: ezRanked,
                mix_policy: mixPolicy,
                decision_trace: recoDecisionTrace,
                reco_mix_policy: mixPolicy,
                reco_decision_trace: recoDecisionTrace,
            };
            const nodeTrace = buildNodeTrace(requestSummary, observation.latency_ms ?? (Date.now() - startedAt), { cz: czRanked.length, ez: ezRanked.length }, false, "", "", userIdInfo.usedDefault);
            return { output, trace: nodeTrace };
        },
    };
}
//# sourceMappingURL=fetch_recommendation.js.map