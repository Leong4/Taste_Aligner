"use strict";
/**
 * TagExpand skill — expands seed tags with LLM-generated hard/soft candidates,
 * then applies deterministic filtering, deduplication, thresholding, and limits.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTagExpandSkill = createTagExpandSkill;
const tag_expand_v1_1 = require("../llm/prompts/tag_expand_v1");
/** Hard cap on total tags added — from prompt module; env cannot override this. */
const MAX_GENERATED_TAGS = tag_expand_v1_1.LIMITS.max_tags;
/**
 * Token budget guard: if usage.total_tokens exceeds this threshold the skill
 * falls back deterministically with reason "token_budget_exceeded".
 * Configurable via TAG_EXPAND_MAX_TOTAL_TOKENS env var (default from LIMITS).
 */
const TAG_EXPAND_MAX_TOTAL_TOKENS = parseInt(process.env.TAG_EXPAND_MAX_TOTAL_TOKENS ?? String(tag_expand_v1_1.LIMITS.max_total_tokens), 10);
function normalizeTag(tag) {
    return tag.trim().replace(/\s+/g, " ");
}
function canonicalTag(tag) {
    return normalizeTag(tag).toLowerCase();
}
function isValidTag(tag) {
    if (!tag)
        return false;
    if (tag.length > 24)
        return false;
    if (!/^[\p{L}\p{N}][\p{L}\p{N}\s_'-]*$/u.test(tag))
        return false;
    const words = tag.split(" ").filter(Boolean);
    if (words.length > 3)
        return false;
    return true;
}
function sortCandidates(candidates) {
    candidates.sort((a, b) => {
        if (b.confidence !== a.confidence) {
            return b.confidence - a.confidence;
        }
        return a.canonical.localeCompare(b.canonical);
    });
}
function normalizeSeedTags(seedTags) {
    const seen = new Set();
    const normalized = [];
    for (const seed of seedTags) {
        if (typeof seed !== "string")
            continue;
        const tag = normalizeTag(seed);
        if (!tag)
            continue;
        const key = canonicalTag(tag);
        if (seen.has(key))
            continue;
        seen.add(key);
        normalized.push(tag);
    }
    return normalized;
}
function createTagExpandSkill(adapter) {
    return {
        name: "tag_expand",
        inputSchema: {
            description: "User text + extracted intent + tag budget for LLM-assisted tag expansion",
            required: ["user_text", "intent", "tag_budget"],
        },
        outputSchema: {
            description: "Final deterministic tags after LLM expansion and filtering",
            required: ["tags_seed", "tags_added", "tags_dropped", "tags_final"],
        },
        async execute(input, _context) {
            const seedTags = normalizeSeedTags(input.intent.tags ?? []);
            const baseSeen = new Set(seedTags.map(canonicalTag));
            const limits = {
                hard_expand_limit: Math.max(0, input.tag_budget.hard_expand_limit ?? 0),
                soft_expand_limit: Math.max(0, input.tag_budget.soft_expand_limit ?? 0),
            };
            const thresholds = {
                min_confidence_soft: input.tag_budget.thresholds.min_confidence_soft,
                min_confidence_hard: input.tag_budget.thresholds.min_confidence_hard,
            };
            let llmData = { hard_expansions: [], soft_expansions: [] };
            let callTrace = null;
            let adapterError = null;
            let hardFallbackUsed = false;
            let fallbackReason = "";
            let adapterFallbackUsed = false;
            let adapterFallbackReason = "";
            const buildFallbackResult = (reason, dropStats) => {
                const output = {
                    tags_seed: seedTags,
                    tags_added: [],
                    tags_dropped: [],
                    tags_final: seedTags,
                };
                const trace = {
                    rule_id: "tag_expand_v1",
                    schema_version: "1.0",
                    provider: adapter.modelInfo.provider,
                    model_name: adapter.modelInfo.model_name,
                    prompt_version: tag_expand_v1_1.PROMPT_VERSION,
                    limits,
                    thresholds,
                    raw_counts: {
                        hard_generated: Array.isArray(llmData.hard_expansions) ? llmData.hard_expansions.length : 0,
                        soft_generated: Array.isArray(llmData.soft_expansions) ? llmData.soft_expansions.length : 0,
                    },
                    kept_counts: {
                        hard_kept: 0,
                        soft_kept: 0,
                    },
                    drop_stats: dropStats,
                    fallback_used: true,
                    fallback_reason: reason,
                    error_message: reason === "adapter_error" ? (adapterError ?? "") : "",
                };
                if (callTrace) {
                    const llmCallEntry = {
                        provider: callTrace.model.provider,
                        model_name: callTrace.model.model_name,
                        model_version: callTrace.model.version,
                        temperature: callTrace.temperature,
                        prompt_version: callTrace.prompt_version,
                        usage: callTrace.usage,
                        fallback_used: callTrace.fallback_used,
                    };
                    const llmFallbackReason = callTrace.fallback_reason ?? (reason || "adapter_error");
                    if (llmFallbackReason !== undefined && llmFallbackReason !== "") {
                        llmCallEntry.fallback_reason = llmFallbackReason;
                    }
                    trace.llm_call = llmCallEntry;
                }
                return { output, trace };
            };
            try {
                const result = await adapter.generateStructuredJSON({
                    systemPrompt: tag_expand_v1_1.SYSTEM_PROMPT,
                    userPrompt: (0, tag_expand_v1_1.buildUserPrompt)(input),
                    schema: tag_expand_v1_1.OUTPUT_JSON_SCHEMA,
                    temperature: tag_expand_v1_1.LIMITS.temperature,
                    promptVersion: tag_expand_v1_1.PROMPT_VERSION,
                    traceContext: {
                        seed_tags: seedTags,
                        intent_type: input.intent.type ?? "unknown",
                        limits,
                        thresholds,
                    },
                });
                llmData = result.data ?? llmData;
                callTrace = result.callTrace;
                if (callTrace.fallback_used || adapter.fallbackReason) {
                    adapterFallbackUsed = true;
                    adapterFallbackReason =
                        callTrace.fallback_reason ?? adapter.fallbackReason ?? "adapter_error";
                }
                // Token budget guard: abort if the call consumed too many tokens.
                if (!hardFallbackUsed && callTrace.usage.total_tokens > TAG_EXPAND_MAX_TOTAL_TOKENS) {
                    hardFallbackUsed = true;
                    fallbackReason = "token_budget_exceeded";
                }
            }
            catch (err) {
                hardFallbackUsed = true;
                fallbackReason = "adapter_error";
                adapterError = err instanceof Error ? err.message : String(err);
                callTrace = {
                    model: adapter.modelInfo,
                    temperature: tag_expand_v1_1.LIMITS.temperature,
                    prompt_version: tag_expand_v1_1.PROMPT_VERSION,
                    latency_ms: 0,
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    fallback_used: true,
                    fallback_reason: "adapter_error",
                };
            }
            if (!hardFallbackUsed) {
                const isObject = llmData !== null && typeof llmData === "object";
                const hasExpectedShape = isObject &&
                    Object.prototype.hasOwnProperty.call(llmData, "hard_expansions") &&
                    Object.prototype.hasOwnProperty.call(llmData, "soft_expansions") &&
                    Array.isArray(llmData.hard_expansions) &&
                    Array.isArray(llmData.soft_expansions);
                if (!hasExpectedShape) {
                    hardFallbackUsed = true;
                    fallbackReason = "invalid_output";
                }
            }
            if (hardFallbackUsed) {
                return buildFallbackResult(fallbackReason || "invalid_output", { by_confidence: 0, by_budget: 0, by_duplicate: 0, by_invalid: 0 });
            }
            const rawHard = llmData.hard_expansions;
            const rawSoft = llmData.soft_expansions;
            const dropStats = {
                by_confidence: 0,
                by_budget: 0,
                by_duplicate: 0,
                by_invalid: 0,
            };
            const droppedDetailed = [];
            const prepareCandidates = (candidates, minConfidence, kind) => {
                const prepared = [];
                for (const candidate of candidates) {
                    const rawTag = typeof candidate?.tag === "string" ? candidate.tag : "";
                    const tag = normalizeTag(rawTag);
                    const confidence = Number(candidate?.confidence);
                    if (!isValidTag(tag) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
                        dropStats.by_invalid += 1;
                        droppedDetailed.push({
                            tag,
                            kind,
                            confidence: Number.isFinite(confidence) ? confidence : -1,
                            reason: "invalid",
                        });
                        continue;
                    }
                    if (confidence < minConfidence) {
                        dropStats.by_confidence += 1;
                        droppedDetailed.push({
                            tag,
                            kind,
                            confidence,
                            reason: "confidence",
                        });
                        continue;
                    }
                    prepared.push({ tag, canonical: canonicalTag(tag), confidence });
                }
                sortCandidates(prepared);
                return prepared;
            };
            const keepUniqueWithLimit = (prepared, limit, seen, kind) => {
                const kept = [];
                for (const candidate of prepared) {
                    if (seen.has(candidate.canonical)) {
                        dropStats.by_duplicate += 1;
                        droppedDetailed.push({
                            tag: candidate.tag,
                            kind,
                            confidence: candidate.confidence,
                            reason: "duplicate",
                        });
                        continue;
                    }
                    seen.add(candidate.canonical);
                    kept.push(candidate.tag);
                }
                if (kept.length > limit) {
                    dropStats.by_budget += kept.length - limit;
                    for (const dropped of kept.slice(limit)) {
                        const candidate = prepared.find((p) => p.tag === dropped);
                        droppedDetailed.push({
                            tag: dropped,
                            kind,
                            confidence: candidate?.confidence ?? 0,
                            reason: "budget",
                        });
                    }
                }
                return kept.slice(0, limit);
            };
            if (rawHard.length === 0 && rawSoft.length === 0 && seedTags.length === 0) {
                return buildFallbackResult("empty_generation", dropStats);
            }
            const hardPrepared = prepareCandidates(rawHard, thresholds.min_confidence_hard, "hard");
            const softPrepared = prepareCandidates(rawSoft, thresholds.min_confidence_soft, "soft");
            const seenHard = new Set(baseSeen);
            const hardTags = keepUniqueWithLimit(hardPrepared, limits.hard_expand_limit, seenHard, "hard");
            const seenSoft = new Set(baseSeen);
            for (const hard of hardTags) {
                seenSoft.add(canonicalTag(hard));
            }
            const softTags = keepUniqueWithLimit(softPrepared, limits.soft_expand_limit, seenSoft, "soft");
            // Hard cap: deterministic slice — hard tags take priority over soft.
            const tagsAdded = [...hardTags, ...softTags].slice(0, MAX_GENERATED_TAGS);
            if (tagsAdded.length === 0) {
                return buildFallbackResult("all_filtered", dropStats);
            }
            const tagsFinal = [...seedTags, ...tagsAdded];
            const output = {
                tags_seed: seedTags,
                tags_added: tagsAdded,
                tags_dropped: droppedDetailed,
                tags_final: tagsFinal,
            };
            const trace = {
                rule_id: "tag_expand_v1",
                schema_version: "1.0",
                provider: adapter.modelInfo.provider,
                model_name: adapter.modelInfo.model_name,
                prompt_version: tag_expand_v1_1.PROMPT_VERSION,
                limits,
                thresholds,
                raw_counts: {
                    hard_generated: rawHard.length,
                    soft_generated: rawSoft.length,
                },
                kept_counts: {
                    hard_kept: hardTags.length,
                    soft_kept: softTags.length,
                },
                drop_stats: dropStats,
                fallback_used: adapterFallbackUsed,
                fallback_reason: adapterFallbackReason,
                error_message: "",
            };
            if (callTrace) {
                const llmCallEntry = {
                    provider: callTrace.model.provider,
                    model_name: callTrace.model.model_name,
                    model_version: callTrace.model.version,
                    temperature: callTrace.temperature,
                    prompt_version: callTrace.prompt_version,
                    usage: callTrace.usage,
                    fallback_used: callTrace.fallback_used,
                };
                const llmFallbackReason = callTrace.fallback_reason ?? (adapterFallbackUsed ? (adapterFallbackReason || "adapter_error") : undefined);
                if (llmFallbackReason !== undefined && llmFallbackReason !== "") {
                    llmCallEntry.fallback_reason = llmFallbackReason;
                }
                trace.llm_call = llmCallEntry;
            }
            return { output, trace };
        },
    };
}
//# sourceMappingURL=tag_expand.js.map