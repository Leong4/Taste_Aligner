/**
 * TagExpand skill — expands seed tags with LLM-generated hard/soft candidates,
 * then applies deterministic filtering, deduplication, thresholding, and limits.
 */

import {
    Skill,
    SkillResult,
    ExecutionContext,
    TagExpandInput,
    TagExpandOutput,
    TagExpandLLMOutput,
    TagExpansionCandidate,
} from "../core/types";
import { LLMAdapter, LLMCallTrace } from "../llm/llm_adapter";

const PROMPT_VERSION = "v1";

const SYSTEM_PROMPT =
    "You expand recommendation tags. Return JSON only with keys " +
    "\"hard_expansions\" and \"soft_expansions\". Each item must be " +
    "{\"tag\": string, \"confidence\": number}. No extra text.";

const OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        hard_expansions: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    tag: { type: "string" },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["tag", "confidence"],
            },
        },
        soft_expansions: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    tag: { type: "string" },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["tag", "confidence"],
            },
        },
    },
    required: ["hard_expansions", "soft_expansions"],
};

function normalizeTag(tag: string): string {
    return tag.trim().replace(/\s+/g, " ");
}

function canonicalTag(tag: string): string {
    return normalizeTag(tag).toLowerCase();
}

function isValidTag(tag: string): boolean {
    if (!tag) return false;
    if (tag.length > 24) return false;
    if (!/^[\p{L}\p{N}][\p{L}\p{N}\s_'-]*$/u.test(tag)) return false;
    const words = tag.split(" ").filter(Boolean);
    if (words.length > 3) return false;
    return true;
}

function sortCandidates(candidates: Array<{ tag: string; canonical: string; confidence: number }>) {
    candidates.sort((a, b) => {
        if (b.confidence !== a.confidence) {
            return b.confidence - a.confidence;
        }
        return a.canonical.localeCompare(b.canonical);
    });
}

function normalizeSeedTags(seedTags: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const seed of seedTags) {
        if (typeof seed !== "string") continue;
        const tag = normalizeTag(seed);
        if (!tag) continue;
        const key = canonicalTag(tag);
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(tag);
    }
    return normalized;
}

function buildUserPrompt(input: TagExpandInput): string {
    const seedTags = input.intent.tags ?? [];
    const intentType = input.intent.type ?? "unknown";
    const budget = input.tag_budget;

    return [
        `User text: "${input.user_text}"`,
        `Intent type: ${intentType}`,
        `Seed tags: ${JSON.stringify(seedTags)}`,
        `Expansion budget: ${budget.budget}`,
        `hard_expand_limit: ${budget.hard_expand_limit}`,
        `soft_expand_limit: ${budget.soft_expand_limit}`,
        `min_confidence_hard: ${budget.thresholds.min_confidence_hard}`,
        `min_confidence_soft: ${budget.thresholds.min_confidence_soft}`,
        "Generate short tags only (1-3 words, no sentences).",
        "Return JSON only with this shape:",
        "{\"hard_expansions\":[{\"tag\":\"...\",\"confidence\":0.9}],\"soft_expansions\":[{\"tag\":\"...\",\"confidence\":0.7}]}",
    ].join("\n");
}

export function createTagExpandSkill(
    adapter: LLMAdapter
): Skill<TagExpandInput, TagExpandOutput> {
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

        async execute(
            input: TagExpandInput,
            _context: ExecutionContext
        ): Promise<SkillResult<TagExpandOutput>> {
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

            let llmData: TagExpandLLMOutput = { hard_expansions: [], soft_expansions: [] };
            let callTrace: LLMCallTrace | null = null;
            let adapterError: string | null = null;
            let hardFallbackUsed = false;
            let fallbackReason = "";
            let adapterFallbackUsed = false;
            let adapterFallbackReason = "";

            const buildFallbackResult = (
                reason: string,
                dropStats: { by_confidence: number; by_budget: number; by_duplicate: number; by_invalid: number }
            ): SkillResult<TagExpandOutput> => {
                const output: TagExpandOutput = {
                    tags_seed: seedTags,
                    tags_added: [],
                    tags_dropped: [],
                    tags_final: seedTags,
                };

                const trace: Record<string, unknown> = {
                    rule_id: "tag_expand_v1",
                    schema_version: "1.0",
                    provider: adapter.modelInfo.provider,
                    model_name: adapter.modelInfo.model_name,
                    prompt_version: PROMPT_VERSION,
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
                    const llmCallEntry: Record<string, unknown> = {
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
                const result = await adapter.generateStructuredJSON<TagExpandLLMOutput>({
                    systemPrompt: SYSTEM_PROMPT,
                    userPrompt: buildUserPrompt(input),
                    schema: OUTPUT_SCHEMA,
                    temperature: 0,
                    promptVersion: PROMPT_VERSION,
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
            } catch (err: unknown) {
                hardFallbackUsed = true;
                fallbackReason = "adapter_error";
                adapterError = err instanceof Error ? err.message : String(err);
                callTrace = {
                    model: adapter.modelInfo,
                    temperature: 0,
                    prompt_version: PROMPT_VERSION,
                    latency_ms: 0,
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    fallback_used: true,
                    fallback_reason: "adapter_error",
                };
            }

            if (!hardFallbackUsed) {
                const isObject = llmData !== null && typeof llmData === "object";
                const hasExpectedShape =
                    isObject &&
                    Object.prototype.hasOwnProperty.call(llmData, "hard_expansions") &&
                    Object.prototype.hasOwnProperty.call(llmData, "soft_expansions") &&
                    Array.isArray((llmData as unknown as Record<string, unknown>).hard_expansions) &&
                    Array.isArray((llmData as unknown as Record<string, unknown>).soft_expansions);
                if (!hasExpectedShape) {
                    hardFallbackUsed = true;
                    fallbackReason = "invalid_output";
                }
            }

            if (hardFallbackUsed) {
                return buildFallbackResult(
                    fallbackReason || "invalid_output",
                    { by_confidence: 0, by_budget: 0, by_duplicate: 0, by_invalid: 0 }
                );
            }

            const rawHard = llmData.hard_expansions;
            const rawSoft = llmData.soft_expansions;

            const dropStats = {
                by_confidence: 0,
                by_budget: 0,
                by_duplicate: 0,
                by_invalid: 0,
            };
            const droppedDetailed: Array<{
                tag: string;
                kind: "hard" | "soft";
                confidence: number;
                reason: string;
            }> = [];

            const prepareCandidates = (
                candidates: TagExpansionCandidate[],
                minConfidence: number,
                kind: "hard" | "soft"
            ): Array<{ tag: string; canonical: string; confidence: number }> => {
                const prepared: Array<{ tag: string; canonical: string; confidence: number }> = [];

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

            const keepUniqueWithLimit = (
                prepared: Array<{ tag: string; canonical: string; confidence: number }>,
                limit: number,
                seen: Set<string>,
                kind: "hard" | "soft"
            ): string[] => {
                const kept: string[] = [];
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

            const tagsAdded = [...hardTags, ...softTags];
            if (tagsAdded.length === 0) {
                return buildFallbackResult("all_filtered", dropStats);
            }

            const tagsFinal = [...seedTags, ...tagsAdded];

            const output: TagExpandOutput = {
                tags_seed: seedTags,
                tags_added: tagsAdded,
                tags_dropped: droppedDetailed,
                tags_final: tagsFinal,
            };

            const trace: Record<string, unknown> = {
                rule_id: "tag_expand_v1",
                schema_version: "1.0",
                provider: adapter.modelInfo.provider,
                model_name: adapter.modelInfo.model_name,
                prompt_version: PROMPT_VERSION,
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
                const llmCallEntry: Record<string, unknown> = {
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
