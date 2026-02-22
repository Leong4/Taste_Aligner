"use strict";
/**
 * memory_signal skill (A phase)
 *
 * Aggregates memory service search results into deterministic signal features:
 *   - anchor_tags
 *   - memory_confidence
 *
 * Determinism strategy:
 *   - input tags are normalized + deduped + sorted
 *   - results are sorted by (score desc, memory_id asc)
 *   - anchor tags are deduped + sorted
 *   - now_ts is fixed from input.now_ts or context.request_ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMemorySignalSkill = createMemorySignalSkill;
const RULE_ID = "memory_signal_v1";
const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "memory.search";
const CONFIDENCE_FORMULA = "clamp01(0.7*top_score_avg + 0.3*coverage)";
function clamp01(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return value;
}
function round6(value) {
    return Number(value.toFixed(6));
}
function asObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value;
}
function normalizeUserId(userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        return "u001";
    }
    return userId.trim();
}
function normalizeCity(city) {
    if (typeof city !== "string") {
        return null;
    }
    const cleaned = city.trim().toLowerCase();
    return cleaned || null;
}
function normalizeTags(primary, fallback) {
    const source = Array.isArray(primary) && primary.length > 0 ? primary : fallback;
    if (!Array.isArray(source)) {
        return [];
    }
    const seen = new Set();
    for (const value of source) {
        if (typeof value !== "string") {
            continue;
        }
        const cleaned = value.trim().toLowerCase();
        if (!cleaned) {
            continue;
        }
        seen.add(cleaned);
    }
    const out = Array.from(seen);
    out.sort((a, b) => a.localeCompare(b));
    return out;
}
function normalizeTopK(value) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return 10;
    }
    const intValue = Math.trunc(parsed);
    if (intValue < 1) {
        return 1;
    }
    if (intValue > 50) {
        return 50;
    }
    return intValue;
}
function normalizeNowTs(inputNowTs, ctxNowTs) {
    const candidate = typeof inputNowTs === "number" && Number.isFinite(inputNowTs)
        ? Math.trunc(inputNowTs)
        : ctxNowTs;
    return Number.isFinite(candidate) ? candidate : 0;
}
function resolveMethod(mode, hasQueryEmbedding) {
    if (mode === "embedding") {
        return "embedding";
    }
    if (mode === "tag_fallback") {
        return "tag_fallback";
    }
    return hasQueryEmbedding ? "embedding" : "tag_fallback";
}
function toIsoTs(nowTs) {
    try {
        return new Date(nowTs).toISOString();
    }
    catch {
        return new Date(0).toISOString();
    }
}
function sortResultsDeterministically(results) {
    const withSort = [...results];
    withSort.sort((a, b) => {
        const scoreA = Number(a.score ?? a.cosine ?? 0);
        const scoreB = Number(b.score ?? b.cosine ?? 0);
        if (scoreA !== scoreB) {
            return scoreB - scoreA;
        }
        const idA = String(a.memory_id ?? "");
        const idB = String(b.memory_id ?? "");
        return idA.localeCompare(idB);
    });
    return withSort;
}
function simplifyResult(result) {
    const normalizedTags = normalizeTags(result.normalized_tags, []);
    const score = Number(result.score ?? result.cosine ?? 0);
    return {
        memory_id: String(result.memory_id ?? ""),
        score: round6(Number.isFinite(score) ? score : 0),
        cosine: round6(Number(result.cosine ?? 0) || 0),
        w_time: round6(Number(result.w_time ?? 0) || 0),
        w_sent: round6(Number(result.w_sent ?? 0) || 0),
        w_context: round6(Number(result.w_context ?? 0) || 0),
        city_boost: round6(Number(result.city_boost ?? 0) || 0),
        tag_boost: round6(Number(result.tag_boost ?? 0) || 0),
        city: typeof result.city === "string" ? result.city : "",
        timestamp: typeof result.timestamp === "string" ? result.timestamp : "",
        sentiment: round6(Number(result.sentiment ?? 0) || 0),
        normalized_tags: normalizedTags,
    };
}
function buildFallbackTrace(method, userId, city, tags, topK, nowTs, latencyMs, fallbackReason, errorMessage) {
    return {
        rule_id: RULE_ID,
        schema_version: SCHEMA_VERSION,
        method,
        input_summary: {
            user_id: userId,
            city,
            tags_count: tags.length,
            tags_sample: tags.slice(0, 5),
            top_k: topK,
            now_ts: nowTs,
        },
        stats: {
            total_loaded: null,
            total_scored: null,
            returned: 0,
            top_n_used: 0,
        },
        aggregation: {
            confidence_formula: CONFIDENCE_FORMULA,
            top_n_used: 0,
            confidence_components: {
                top_score_avg: 0,
                coverage: 0,
            },
        },
        weights: {
            lambda_time: null,
            alpha_sent: null,
        },
        fallback_used: true,
        fallback_reason: fallbackReason,
        error_message: errorMessage,
        latency_ms: latencyMs,
    };
}
function buildFallbackResult(method, userId, city, tags, topK, nowTs, latencyMs, fallbackReason, errorMessage) {
    const traceNode = buildFallbackTrace(method, userId, city, tags, topK, nowTs, latencyMs, fallbackReason, errorMessage);
    const output = {
        anchor_memory_ids: [],
        anchor_tags: [],
        memory_confidence: 0,
        memory_results: [],
        decision_trace: {
            memory_signal: traceNode,
        },
    };
    return { output, trace: traceNode };
}
function validateAndNormalizeResults(rawResults) {
    if (!Array.isArray(rawResults)) {
        return null;
    }
    const normalized = [];
    for (const item of rawResults) {
        const obj = asObject(item);
        if (!obj) {
            return null;
        }
        if (typeof obj.memory_id !== "string" || !obj.memory_id.trim()) {
            return null;
        }
        const memoryId = obj.memory_id.trim();
        const normalizedTags = normalizeTags(obj.normalized_tags, []);
        const rawScore = Number(obj.score ?? obj.cosine ?? 0);
        const score = Number.isFinite(rawScore) ? rawScore : 0;
        const rawCosine = Number(obj.cosine ?? obj.score ?? 0);
        const cosine = Number.isFinite(rawCosine) ? rawCosine : 0;
        normalized.push({
            ...obj,
            memory_id: memoryId,
            normalized_tags: normalizedTags,
            score,
            cosine,
        });
    }
    return normalized;
}
function createMemorySignalSkill(toolClient) {
    return {
        name: "memory_signal",
        inputSchema: {
            description: "Aggregate memory search results into anchor_tags + memory_confidence",
            required: ["user_id", "city"],
            optional: ["tags", "intent_tags", "top_k", "now_ts", "mode", "query_embedding"],
        },
        outputSchema: {
            description: "Deterministic memory signal output and trace",
            required: ["anchor_memory_ids", "anchor_tags", "memory_confidence", "decision_trace"],
            optional: ["memory_results"],
        },
        async execute(input, context) {
            const userId = normalizeUserId(input.user_id);
            const city = normalizeCity(input.city);
            const tags = normalizeTags(input.tags, input.intent_tags);
            const topK = normalizeTopK(input.top_k);
            const nowTs = normalizeNowTs(input.now_ts, context.request_ts);
            const hasQueryEmbedding = Array.isArray(input.query_embedding) && input.query_embedding.length > 0;
            const method = resolveMethod(input.mode, hasQueryEmbedding);
            if (tags.length === 0) {
                return buildFallbackResult("none", userId, city, tags, topK, nowTs, 0, "no_tags", "");
            }
            const startedAt = Date.now();
            let observation;
            try {
                observation = await toolClient.call({
                    tool: TOOL_NAME,
                    input: {
                        data: {
                            user_id: userId,
                            query_tags: tags,
                            city,
                            top_k: topK,
                            now_ts: toIsoTs(nowTs),
                        },
                    },
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return buildFallbackResult(method, userId, city, tags, topK, nowTs, Date.now() - startedAt, "tool_error", message);
            }
            if (!observation.ok) {
                return buildFallbackResult(method, userId, city, tags, topK, nowTs, observation.latency_ms ?? (Date.now() - startedAt), "tool_error", observation.error?.message ?? "gateway_call_failed");
            }
            const payload = asObject(observation.output);
            const normalizedResults = validateAndNormalizeResults(payload?.results);
            if (!normalizedResults) {
                return buildFallbackResult(method, userId, city, tags, topK, nowTs, observation.latency_ms ?? (Date.now() - startedAt), "invalid_output", "results_invalid");
            }
            const sortedResults = sortResultsDeterministically(normalizedResults);
            const payloadMethod = payload?.method === "embedding" || payload?.method === "tag_fallback"
                ? payload.method
                : method;
            if (sortedResults.length === 0) {
                return buildFallbackResult(method, userId, city, tags, topK, nowTs, observation.latency_ms ?? (Date.now() - startedAt), "empty_results", "");
            }
            const topN = Math.min(3, sortedResults.length);
            const topResults = sortedResults.slice(0, topN);
            const anchorMemoryIds = topResults
                .map((item) => String(item.memory_id ?? ""))
                .filter((id) => id.length > 0);
            const anchorTagSet = new Set();
            for (const item of topResults) {
                const itemTags = normalizeTags(item.normalized_tags, []);
                for (const tag of itemTags) {
                    anchorTagSet.add(tag);
                }
            }
            const anchorTags = Array.from(anchorTagSet).sort((a, b) => a.localeCompare(b));
            const scoreList = topResults.map((item) => {
                const candidate = Number(item.score ?? item.cosine ?? 0);
                return Number.isFinite(candidate) ? candidate : 0;
            });
            const topScoreAvgRaw = scoreList.reduce((sum, score) => sum + score, 0) / topN;
            const topScoreAvg = round6(topScoreAvgRaw);
            const coverageRaw = anchorTags.length / Math.max(1, tags.length);
            const coverage = round6(Math.min(1, coverageRaw));
            const memoryConfidence = round6(clamp01((0.7 * topScoreAvgRaw) + (0.3 * coverage)));
            const statsObj = asObject(payload?.stats);
            const totalLoaded = Number(statsObj?.total_loaded);
            const totalScored = Number(statsObj?.total_scored);
            const weightsObj = asObject(payload?.weights);
            const lambdaTimeRaw = Number(weightsObj?.lambda_time);
            const alphaSentRaw = Number(weightsObj?.alpha_sent);
            const traceNode = {
                rule_id: RULE_ID,
                schema_version: SCHEMA_VERSION,
                method: payloadMethod,
                input_summary: {
                    user_id: userId,
                    city,
                    tags_count: tags.length,
                    tags_sample: tags.slice(0, 5),
                    top_k: topK,
                    now_ts: nowTs,
                },
                stats: {
                    total_loaded: Number.isFinite(totalLoaded) ? totalLoaded : null,
                    total_scored: Number.isFinite(totalScored) ? totalScored : null,
                    returned: sortedResults.length,
                    top_n_used: topN,
                },
                aggregation: {
                    confidence_formula: CONFIDENCE_FORMULA,
                    top_n_used: topN,
                    confidence_components: {
                        top_score_avg: topScoreAvg,
                        coverage,
                    },
                },
                weights: {
                    lambda_time: Number.isFinite(lambdaTimeRaw) ? lambdaTimeRaw : null,
                    alpha_sent: Number.isFinite(alphaSentRaw) ? alphaSentRaw : null,
                },
                fallback_used: false,
                latency_ms: observation.latency_ms ?? (Date.now() - startedAt),
            };
            const memoryResults = sortedResults.slice(0, topK).map((item) => simplifyResult(item));
            const output = {
                anchor_memory_ids: anchorMemoryIds,
                anchor_tags: anchorTags,
                memory_confidence: memoryConfidence,
                memory_results: memoryResults,
                decision_trace: {
                    memory_signal: traceNode,
                },
            };
            return {
                output,
                trace: traceNode,
            };
        },
    };
}
//# sourceMappingURL=memory_signal.js.map