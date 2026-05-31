"use strict";
/**
 * memory_weight_adjust skill
 *
 * Calls memory.search via gateway, then deterministically sorts/aggregates
 * results into weighted_results, anchor_memory_ids, anchor_tags, and
 * memory_confidence.
 *
 * Determinism strategy:
 *   - input tags: deduped + sorted lexicographically
 *   - results sorted by (score desc, memory_id asc)
 *   - anchor_tags sorted by (-count desc, tag lex asc)
 *   - no Date.now() used in decisions (only for latency measurement)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMemoryWeightAdjustSkill = createMemoryWeightAdjustSkill;
const RULE_ID = "memory_weight_adjust_v1";
const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "memory.search";
const EMBEDDING_TOOL_NAME = "embedding.tes_build";
const CONFIDENCE_FORMULA = "clamp01(0.7*top_score_avg + 0.3*coverage)";
const DEFAULT_TOP_K = 10;
const ANCHOR_TOP_N = 3;
const QUERY_EMBEDDING_DIM = 512;
const NORM_LOWER = 0.99;
const NORM_UPPER = 1.01;
const DEFAULT_MEMORY_POOL = "all";
const PROFILE_SEED_TOP_K = 50;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
function round6(value) {
    return Number(value.toFixed(6));
}
function normalizeUserId(userId) {
    if (typeof userId !== "string" || !userId.trim())
        return "u001";
    return userId.trim();
}
function normalizeCity(city) {
    if (typeof city !== "string")
        return undefined;
    const cleaned = city.trim().toLowerCase();
    return cleaned || undefined;
}
function normalizeTags(primary, fallback) {
    const source = Array.isArray(primary) && primary.length > 0 ? primary : fallback;
    if (!Array.isArray(source))
        return [];
    const seen = new Set();
    for (const value of source) {
        if (typeof value !== "string")
            continue;
        const cleaned = value.trim().toLowerCase();
        if (cleaned)
            seen.add(cleaned);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
}
function resolveMemoryPool(queryType) {
    if (typeof queryType !== "string")
        return DEFAULT_MEMORY_POOL;
    const cleaned = queryType.trim().toLowerCase();
    if (cleaned === "food")
        return "food";
    if (cleaned === "scenery" || cleaned === "culture")
        return "scenery";
    return "all";
}
function normalizeTopK(value) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed))
        return DEFAULT_TOP_K;
    const intValue = Math.trunc(parsed);
    if (intValue < 1)
        return 1;
    if (intValue > 50)
        return 50;
    return intValue;
}
function resolveNowTsIso(value, context) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(Math.trunc(value)).toISOString();
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed)
            return undefined;
        const numeric = Number(trimmed);
        if (Number.isFinite(numeric)) {
            return new Date(Math.trunc(numeric)).toISOString();
        }
        return trimmed;
    }
    if (typeof context.request_ts === "number" && Number.isFinite(context.request_ts)) {
        return new Date(Math.trunc(context.request_ts)).toISOString();
    }
    return undefined;
}
function asObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
function computeNorm(vector) {
    let sum = 0;
    for (const value of vector) {
        sum += value * value;
    }
    return Math.sqrt(sum);
}
async function buildQueryEmbedding(toolClient, tags) {
    let observation;
    try {
        observation = await toolClient.call({
            tool: EMBEDDING_TOOL_NAME,
            input: {
                tags,
                normalize: true,
            },
        });
    }
    catch {
        return { fallbackReason: "query_embedding_tool_error" };
    }
    if (!observation.ok) {
        return { fallbackReason: "query_embedding_tool_error" };
    }
    const payload = asObject(observation.output);
    if (!payload) {
        return { fallbackReason: "query_embedding_invalid_output" };
    }
    const vectorRaw = payload.vector;
    const dimRaw = Number(payload.dim);
    const normalizedRaw = payload.normalized;
    if (!Array.isArray(vectorRaw) || !Number.isFinite(dimRaw) || typeof normalizedRaw !== "boolean") {
        return { fallbackReason: "query_embedding_invalid_output" };
    }
    const vector = vectorRaw;
    const finite = vector.every((v) => typeof v === "number" && Number.isFinite(v));
    if (!finite) {
        return { fallbackReason: "query_embedding_invalid_vector" };
    }
    const numericVector = vector;
    const dimActual = numericVector.length;
    const norm = computeNorm(numericVector);
    const validVector = dimRaw === QUERY_EMBEDDING_DIM &&
        dimActual === QUERY_EMBEDDING_DIM &&
        normalizedRaw === true &&
        norm >= NORM_LOWER &&
        norm <= NORM_UPPER;
    if (!validVector) {
        return { fallbackReason: "query_embedding_invalid_vector" };
    }
    return { vector: numericVector };
}
function applyQueryEmbeddingTraceFields(trace, queryEmbeddingUsed, queryTagsCount, memorySearchMode, queryEmbeddingFallbackReason) {
    trace.query_embedding_used = queryEmbeddingUsed;
    trace.query_tags_count = queryTagsCount;
    trace.memory_search_mode = memorySearchMode;
    if (queryEmbeddingUsed) {
        trace.query_embedding_dim = QUERY_EMBEDDING_DIM;
    }
    if (!queryEmbeddingUsed && queryEmbeddingFallbackReason !== undefined) {
        trace.query_embedding_fallback_reason = queryEmbeddingFallbackReason;
        if (trace.fallback_reason === undefined) {
            trace.fallback_reason = queryEmbeddingFallbackReason;
        }
    }
}
function applyMemoryPoolTraceFields(trace, memoryPool) {
    trace.memory_pool = memoryPool;
    trace.pool_filter_applied = memoryPool !== "all";
}
// ---------------------------------------------------------------------------
// Fallback builder
// ---------------------------------------------------------------------------
function buildInputSummary(city, tagsCount, topK, nowTsPresent, memoryPool) {
    const summary = {
        user_id_present: true,
        tags_count: tagsCount,
        top_k: topK,
        now_ts_present: nowTsPresent,
        memory_pool: memoryPool,
    };
    if (city !== undefined)
        summary.city = city;
    return summary;
}
function buildFallback(reason, tagsCount, topK, userId, city, nowTsPresent, memoryPool, latencyMs, errorMessage) {
    const trace = {
        rule_id: RULE_ID,
        schema_version: SCHEMA_VERSION,
        tool: { name: TOOL_NAME },
        input_summary: buildInputSummary(city, tagsCount, topK, nowTsPresent, memoryPool),
        aggregation: {
            anchor_top_n: ANCHOR_TOP_N,
            confidence_formula: CONFIDENCE_FORMULA,
        },
        fallback_used: true,
        fallback_reason: reason,
    };
    applyMemoryPoolTraceFields(trace, memoryPool);
    if (errorMessage !== undefined)
        trace.error_message = errorMessage;
    if (latencyMs !== undefined)
        trace.latency_ms = latencyMs;
    const output = {
        weighted_results: [],
        anchor_memory_ids: [],
        anchor_tags: [],
        memory_confidence: 0,
        stats: {
            input_tags_count: tagsCount,
            results_count: 0,
            anchor_count: 0,
            anchor_tags_count: 0,
        },
        decision_trace: { memory_weight_adjust: trace },
    };
    return { output, trace };
}
// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------
function mapResult(raw) {
    const score = Number(raw.score ?? raw.final_score ?? 0);
    const result = {
        memory_id: String(raw.memory_id ?? ""),
        score: round6(Number.isFinite(score) ? score : 0),
    };
    result.cosine = round6(Number(raw.cosine ?? 0) || 0);
    result.w_time = round6(Number(raw.w_time ?? 0) || 0);
    result.w_sent = round6(Number(raw.w_sent ?? 0) || 0);
    result.w_context = round6(Number(raw.w_context ?? 0) || 0);
    result.city_boost = round6(Number(raw.city_boost ?? 0) || 0);
    result.tag_boost = round6(Number(raw.tag_boost ?? 0) || 0);
    if (typeof raw.timestamp === "string" || typeof raw.timestamp === "number") {
        result.timestamp = raw.timestamp;
    }
    if (typeof raw.city === "string") {
        result.city = raw.city;
    }
    if (Array.isArray(raw.normalized_tags)) {
        result.normalized_tags = raw.normalized_tags
            .filter((t) => typeof t === "string").sort();
    }
    if (raw.sentiment != null) {
        result.sentiment = round6(Number(raw.sentiment) || 0);
    }
    return result;
}
// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------
function createMemoryWeightAdjustSkill(toolClient) {
    return {
        name: "memory_weight_adjust",
        inputSchema: {
            description: "Weighted memory search: calls memory.search, sorts/aggregates results deterministically",
            required: ["user_id"],
            optional: ["city", "tags", "intent_tags", "top_k", "now_ts", "query_type"],
        },
        outputSchema: {
            description: "Weighted results, anchor IDs/tags, confidence, stats, and decision trace",
            required: ["weighted_results", "anchor_memory_ids", "anchor_tags", "memory_confidence", "stats", "decision_trace"],
        },
        async execute(input, context) {
            const userId = normalizeUserId(input.user_id);
            const city = normalizeCity(input.city);
            let tags = normalizeTags(input.tags, input.intent_tags);
            const topK = normalizeTopK(input.top_k);
            const generalQuery = (typeof input.query_type === "string" && input.query_type.trim().toLowerCase() === "general")
                || (tags.length === 1 && tags[0] === "general");
            const memoryPool = generalQuery ? "all" : resolveMemoryPool(input.query_type);
            // Determine now_ts: use input.now_ts, fall back to context.request_ts, else omit
            const resolvedNowTs = resolveNowTsIso(input.now_ts, context);
            const nowTsPresent = resolvedNowTs !== undefined;
            // Fallback: no tags
            if (tags.length === 0) {
                const fallback = buildFallback("no_tags", 0, topK, userId, city, nowTsPresent, memoryPool);
                applyQueryEmbeddingTraceFields(fallback.trace, false, 0, "tags_only_fallback");
                return fallback;
            }
            if (generalQuery) {
                const profileSeedPayload = {
                    user_id: userId,
                    query_tags: ["general"],
                    top_k: PROFILE_SEED_TOP_K,
                    memory_pool: "all",
                };
                if (city !== undefined)
                    profileSeedPayload.city = city;
                if (resolvedNowTs !== undefined)
                    profileSeedPayload.now_ts = resolvedNowTs;
                try {
                    const profileSeedObservation = await toolClient.call({
                        tool: TOOL_NAME,
                        input: { data: profileSeedPayload },
                    });
                    const profileSeedOutput = profileSeedObservation.ok
                        ? asObject(profileSeedObservation.output)
                        : null;
                    const profileSeedResults = profileSeedOutput?.results;
                    if (Array.isArray(profileSeedResults)) {
                        const profileTags = [];
                        for (const result of profileSeedResults) {
                            const resultObj = asObject(result);
                            if (resultObj && Array.isArray(resultObj.normalized_tags)) {
                                profileTags.push(...resultObj.normalized_tags);
                            }
                        }
                        const normalizedProfileTags = normalizeTags(profileTags, []);
                        if (normalizedProfileTags.length > 0) {
                            tags = normalizedProfileTags;
                        }
                    }
                }
                catch {
                    // Continue with the deterministic "general" tag fallback.
                }
            }
            // Build query embedding (TES v2) in the same vector space as memory embeddings.
            const queryEmbeddingResult = await buildQueryEmbedding(toolClient, tags);
            const queryEmbedding = queryEmbeddingResult.vector;
            const queryEmbeddingUsed = Array.isArray(queryEmbedding) && queryEmbedding.length === QUERY_EMBEDDING_DIM;
            const memorySearchMode = queryEmbeddingUsed
                ? "embedding_plus_tags"
                : "tags_only_fallback";
            // Build tool payload
            const payload = {
                user_id: userId,
                query_tags: tags,
                top_k: topK,
                memory_pool: memoryPool,
            };
            if (queryEmbeddingUsed) {
                payload.query_embedding = queryEmbedding;
            }
            if (city !== undefined)
                payload.city = city;
            if (resolvedNowTs !== undefined)
                payload.now_ts = resolvedNowTs;
            // Call tool
            const startedAt = Date.now();
            let observation;
            try {
                observation = await toolClient.call({
                    tool: TOOL_NAME,
                    input: { data: payload },
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const fallback = buildFallback("tool_error", tags.length, topK, userId, city, nowTsPresent, memoryPool, Date.now() - startedAt, message);
                applyQueryEmbeddingTraceFields(fallback.trace, queryEmbeddingUsed, tags.length, memorySearchMode, queryEmbeddingResult.fallbackReason);
                return fallback;
            }
            const latencyMs = observation.latency_ms ?? (Date.now() - startedAt);
            if (!observation.ok) {
                const fallback = buildFallback("tool_error", tags.length, topK, userId, city, nowTsPresent, memoryPool, latencyMs, observation.error?.message ?? "gateway_call_failed");
                applyQueryEmbeddingTraceFields(fallback.trace, queryEmbeddingUsed, tags.length, memorySearchMode, queryEmbeddingResult.fallbackReason);
                return fallback;
            }
            // Validate output shape
            const outputObj = asObject(observation.output);
            if (!outputObj) {
                const fallback = buildFallback("invalid_output", tags.length, topK, userId, city, nowTsPresent, memoryPool, latencyMs, "output_not_object");
                applyQueryEmbeddingTraceFields(fallback.trace, queryEmbeddingUsed, tags.length, memorySearchMode, queryEmbeddingResult.fallbackReason);
                return fallback;
            }
            const initialRawResults = outputObj.results;
            if (!Array.isArray(initialRawResults)) {
                const fallback = buildFallback("invalid_output", tags.length, topK, userId, city, nowTsPresent, memoryPool, latencyMs, "results_not_array");
                applyQueryEmbeddingTraceFields(fallback.trace, queryEmbeddingUsed, tags.length, memorySearchMode, queryEmbeddingResult.fallbackReason);
                return fallback;
            }
            let rawResults = initialRawResults;
            if (rawResults.length === 0 && memoryPool !== "all") {
                try {
                    const retryObservation = await toolClient.call({
                        tool: TOOL_NAME,
                        input: {
                            data: {
                                ...payload,
                                memory_pool: "all",
                            },
                        },
                    });
                    const retryOutputObj = retryObservation.ok
                        ? asObject(retryObservation.output)
                        : null;
                    if (retryOutputObj && Array.isArray(retryOutputObj.results)) {
                        rawResults = retryOutputObj.results;
                    }
                }
                catch {
                    // Preserve the original empty-result fallback.
                }
            }
            if (rawResults.length === 0) {
                const fallback = buildFallback("empty_results", tags.length, topK, userId, city, nowTsPresent, memoryPool, latencyMs);
                applyQueryEmbeddingTraceFields(fallback.trace, queryEmbeddingUsed, tags.length, memorySearchMode, queryEmbeddingResult.fallbackReason);
                return fallback;
            }
            // Sort deterministically: score desc, then memory_id asc
            const validated = [];
            for (const item of rawResults) {
                const obj = asObject(item);
                if (!obj)
                    continue;
                validated.push(obj);
            }
            validated.sort((a, b) => {
                const scoreA = Number(a.score ?? a.final_score ?? 0) || 0;
                const scoreB = Number(b.score ?? b.final_score ?? 0) || 0;
                if (scoreA !== scoreB)
                    return scoreB - scoreA;
                return String(a.memory_id ?? "").localeCompare(String(b.memory_id ?? ""));
            });
            // Map to typed results
            const weightedResults = validated.map(mapResult);
            // Top N for anchors
            const topN = Math.min(ANCHOR_TOP_N, weightedResults.length);
            const topResults = weightedResults.slice(0, topN);
            const anchorMemoryIds = topResults.map(r => r.memory_id).filter(id => id.length > 0);
            // Anchor tags: sorted by (-count, tag lex asc)
            const tagCounts = new Map();
            for (const r of topResults) {
                if (r.normalized_tags) {
                    for (const tag of r.normalized_tags) {
                        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
                    }
                }
            }
            const anchorTags = Array.from(tagCounts.entries())
                .sort((a, b) => {
                if (a[1] !== b[1])
                    return b[1] - a[1]; // count desc
                return a[0].localeCompare(b[0]); // tag lex asc
            })
                .map(([tag]) => tag);
            // Confidence: clamp01(0.7*top_score_avg + 0.3*coverage)
            const topScores = topResults.map(r => r.score);
            const topScoreAvg = topScores.reduce((s, v) => s + v, 0) / topN;
            const coverage = Math.min(1, anchorTags.length / Math.max(1, tags.length));
            const memoryConfidence = round6(clamp01(0.7 * topScoreAvg + 0.3 * coverage));
            // Build trace
            const trace = {
                rule_id: RULE_ID,
                schema_version: SCHEMA_VERSION,
                tool: { name: TOOL_NAME },
                input_summary: buildInputSummary(city, tags.length, topK, nowTsPresent, memoryPool),
                aggregation: {
                    anchor_top_n: topN,
                    confidence_formula: CONFIDENCE_FORMULA,
                },
                fallback_used: false,
                latency_ms: latencyMs,
            };
            applyMemoryPoolTraceFields(trace, memoryPool);
            applyQueryEmbeddingTraceFields(trace, queryEmbeddingUsed, tags.length, memorySearchMode, queryEmbeddingResult.fallbackReason);
            const output = {
                weighted_results: weightedResults,
                anchor_memory_ids: anchorMemoryIds,
                anchor_tags: anchorTags,
                memory_confidence: memoryConfidence,
                stats: {
                    input_tags_count: tags.length,
                    results_count: weightedResults.length,
                    anchor_count: anchorMemoryIds.length,
                    anchor_tags_count: anchorTags.length,
                },
                decision_trace: { memory_weight_adjust: trace },
            };
            return { output, trace };
        },
    };
}
//# sourceMappingURL=memory_weight_adjust.js.map