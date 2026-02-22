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

import {
    Skill,
    SkillResult,
    ExecutionContext,
    MemoryWeightAdjustInput,
    MemoryWeightAdjustOutput,
    MemoryWeightAdjustDecisionTrace,
    MemoryWeightedResult,
} from "../core/types";
import { ToolClient } from "../tools/toolClient";

const RULE_ID = "memory_weight_adjust_v1";
const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "memory.search";
const CONFIDENCE_FORMULA = "clamp01(0.7*top_score_avg + 0.3*coverage)";
const DEFAULT_TOP_K = 10;
const ANCHOR_TOP_N = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

function round6(value: number): number {
    return Number(value.toFixed(6));
}

function normalizeUserId(userId: unknown): string {
    if (typeof userId !== "string" || !userId.trim()) return "u001";
    return userId.trim();
}

function normalizeCity(city: unknown): string | undefined {
    if (typeof city !== "string") return undefined;
    const cleaned = city.trim().toLowerCase();
    return cleaned || undefined;
}

function normalizeTags(primary: unknown, fallback: unknown): string[] {
    const source = Array.isArray(primary) && primary.length > 0 ? primary : fallback;
    if (!Array.isArray(source)) return [];

    const seen = new Set<string>();
    for (const value of source) {
        if (typeof value !== "string") continue;
        const cleaned = value.trim().toLowerCase();
        if (cleaned) seen.add(cleaned);
    }

    return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

function normalizeTopK(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_TOP_K;
    const intValue = Math.trunc(parsed);
    if (intValue < 1) return 1;
    if (intValue > 50) return 50;
    return intValue;
}

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fallback builder
// ---------------------------------------------------------------------------

function buildInputSummary(
    city: string | undefined,
    tagsCount: number,
    topK: number,
    nowTsPresent: boolean,
): MemoryWeightAdjustDecisionTrace["input_summary"] {
    const summary: MemoryWeightAdjustDecisionTrace["input_summary"] = {
        user_id_present: true,
        tags_count: tagsCount,
        top_k: topK,
        now_ts_present: nowTsPresent,
    };
    if (city !== undefined) summary.city = city;
    return summary;
}

function buildFallback(
    reason: "no_tags" | "tool_error" | "invalid_output" | "empty_results",
    tagsCount: number,
    topK: number,
    userId: string,
    city: string | undefined,
    nowTsPresent: boolean,
    latencyMs?: number,
    errorMessage?: string,
): SkillResult<MemoryWeightAdjustOutput> {
    const trace: MemoryWeightAdjustDecisionTrace = {
        rule_id: RULE_ID,
        schema_version: SCHEMA_VERSION,
        tool: { name: TOOL_NAME },
        input_summary: buildInputSummary(city, tagsCount, topK, nowTsPresent),
        aggregation: {
            anchor_top_n: ANCHOR_TOP_N,
            confidence_formula: CONFIDENCE_FORMULA,
        },
        fallback_used: true,
        fallback_reason: reason,
    };
    if (errorMessage !== undefined) trace.error_message = errorMessage;
    if (latencyMs !== undefined) trace.latency_ms = latencyMs;

    const output: MemoryWeightAdjustOutput = {
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

function mapResult(raw: Record<string, unknown>): MemoryWeightedResult {
    const score = Number(raw.score ?? raw.final_score ?? 0);
    const result: MemoryWeightedResult = {
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
        result.normalized_tags = (raw.normalized_tags as unknown[])
            .filter((t): t is string => typeof t === "string").sort();
    }
    if (raw.sentiment != null) {
        result.sentiment = round6(Number(raw.sentiment) || 0);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------

export function createMemoryWeightAdjustSkill(
    toolClient: ToolClient,
): Skill<MemoryWeightAdjustInput, MemoryWeightAdjustOutput> {
    return {
        name: "memory_weight_adjust",

        inputSchema: {
            description: "Weighted memory search: calls memory.search, sorts/aggregates results deterministically",
            required: ["user_id"],
            optional: ["city", "tags", "intent_tags", "top_k", "now_ts"],
        },

        outputSchema: {
            description: "Weighted results, anchor IDs/tags, confidence, stats, and decision trace",
            required: ["weighted_results", "anchor_memory_ids", "anchor_tags", "memory_confidence", "stats", "decision_trace"],
        },

        async execute(
            input: MemoryWeightAdjustInput,
            context: ExecutionContext,
        ): Promise<SkillResult<MemoryWeightAdjustOutput>> {
            const userId = normalizeUserId(input.user_id);
            const city = normalizeCity(input.city);
            const tags = normalizeTags(input.tags, input.intent_tags);
            const topK = normalizeTopK(input.top_k);

            // Determine now_ts: use input.now_ts, fall back to context.request_ts, else omit
            const rawNowTs = typeof input.now_ts === "number" && Number.isFinite(input.now_ts)
                ? input.now_ts
                : (context.request_ts && Number.isFinite(context.request_ts) ? context.request_ts : undefined);
            const nowTsPresent = rawNowTs !== undefined;

            // Fallback: no tags
            if (tags.length === 0) {
                return buildFallback("no_tags", 0, topK, userId, city, nowTsPresent);
            }

            // Build tool payload
            const payload: Record<string, unknown> = {
                user_id: userId,
                query_tags: tags,
                top_k: topK,
            };
            if (city !== undefined) payload.city = city;
            if (rawNowTs !== undefined) payload.now_ts = rawNowTs;

            // Call tool
            const startedAt = Date.now();
            let observation: Awaited<ReturnType<ToolClient["call"]>>;
            try {
                observation = await toolClient.call({
                    tool: TOOL_NAME,
                    input: { data: payload },
                });
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                return buildFallback("tool_error", tags.length, topK, userId, city, nowTsPresent, Date.now() - startedAt, message);
            }

            const latencyMs = observation.latency_ms ?? (Date.now() - startedAt);

            if (!observation.ok) {
                return buildFallback(
                    "tool_error", tags.length, topK, userId, city, nowTsPresent,
                    latencyMs,
                    observation.error?.message ?? "gateway_call_failed",
                );
            }

            // Validate output shape
            const outputObj = asObject(observation.output);
            if (!outputObj) {
                return buildFallback("invalid_output", tags.length, topK, userId, city, nowTsPresent, latencyMs, "output_not_object");
            }

            const rawResults = outputObj.results;
            if (!Array.isArray(rawResults)) {
                return buildFallback("invalid_output", tags.length, topK, userId, city, nowTsPresent, latencyMs, "results_not_array");
            }

            if (rawResults.length === 0) {
                return buildFallback("empty_results", tags.length, topK, userId, city, nowTsPresent, latencyMs);
            }

            // Sort deterministically: score desc, then memory_id asc
            const validated: Array<Record<string, unknown>> = [];
            for (const item of rawResults) {
                const obj = asObject(item);
                if (!obj) continue;
                validated.push(obj);
            }

            validated.sort((a, b) => {
                const scoreA = Number(a.score ?? a.final_score ?? 0) || 0;
                const scoreB = Number(b.score ?? b.final_score ?? 0) || 0;
                if (scoreA !== scoreB) return scoreB - scoreA;
                return String(a.memory_id ?? "").localeCompare(String(b.memory_id ?? ""));
            });

            // Map to typed results
            const weightedResults = validated.map(mapResult);

            // Top N for anchors
            const topN = Math.min(ANCHOR_TOP_N, weightedResults.length);
            const topResults = weightedResults.slice(0, topN);

            const anchorMemoryIds = topResults.map(r => r.memory_id).filter(id => id.length > 0);

            // Anchor tags: sorted by (-count, tag lex asc)
            const tagCounts = new Map<string, number>();
            for (const r of topResults) {
                if (r.normalized_tags) {
                    for (const tag of r.normalized_tags) {
                        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
                    }
                }
            }
            const anchorTags = Array.from(tagCounts.entries())
                .sort((a, b) => {
                    if (a[1] !== b[1]) return b[1] - a[1]; // count desc
                    return a[0].localeCompare(b[0]); // tag lex asc
                })
                .map(([tag]) => tag);

            // Confidence: clamp01(0.7*top_score_avg + 0.3*coverage)
            const topScores = topResults.map(r => r.score);
            const topScoreAvg = topScores.reduce((s, v) => s + v, 0) / topN;
            const coverage = Math.min(1, anchorTags.length / Math.max(1, tags.length));
            const memoryConfidence = round6(clamp01(0.7 * topScoreAvg + 0.3 * coverage));

            // Build trace
            const trace: MemoryWeightAdjustDecisionTrace = {
                rule_id: RULE_ID,
                schema_version: SCHEMA_VERSION,
                tool: { name: TOOL_NAME },
                input_summary: buildInputSummary(city, tags.length, topK, nowTsPresent),
                aggregation: {
                    anchor_top_n: topN,
                    confidence_formula: CONFIDENCE_FORMULA,
                },
                fallback_used: false,
                latency_ms: latencyMs,
            };

            const output: MemoryWeightAdjustOutput = {
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
