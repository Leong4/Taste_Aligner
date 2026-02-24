/**
 * Rerank skill (v2) — TES-driven rerank with deterministic fallback.
 *
 * When a valid user TES vector is available from tes_builder:
 *   1. For each candidate item (up to TES_MAX_CALLS budget), build an
 *      item TES vector via embedding.tes_build using item tags.
 *   2. Compute cosine similarity between user and item TES vectors.
 *   3. Fuse: fused_score = base_score + TES_SIM_WEIGHT * tes_similarity.
 *   4. Sort deterministically: fused_score desc, base_score desc, id asc.
 *
 * Fallback: if user TES vector is missing/invalid, degrade to pass-through
 * of cz_ranked/ez_ranked from upstream (v1 behavior). Never throws.
 *
 * Determinism:
 *   - Tag signatures are sorted for cache key computation.
 *   - Stable sort with triple tie-breaker (fused desc, base desc, id asc).
 *   - No Date.now() in decision logic (only for latency measurement).
 */

import {
    Skill,
    SkillResult,
    ExecutionContext,
    RerankInput,
    RerankOutput,
    RerankTesDecisionTrace,
} from "../core/types";
import { ToolClient } from "../tools/toolClient";

const RULE_ID = "rerank_v2_tes";
const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "embedding.tes_build";
const TES_SIM_WEIGHT = 0.25;
const TES_MAX_CALLS = 20;
const TES_DIM = 512;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function round6(value: number): number {
    return Number(value.toFixed(6));
}

/** Extract a sortable string ID from a candidate item. */
function itemId(item: Record<string, unknown>): string {
    if (typeof item.id === "string") return item.id;
    if (typeof item.item_id === "string") return item.item_id;
    if (typeof item.name === "string") return item.name;
    return "";
}

/** Extract base score from a candidate. */
function baseScore(item: Record<string, unknown>): number {
    const s = Number(item.score ?? item.excellence ?? item.base_score ?? 0);
    return Number.isFinite(s) ? s : 0;
}

/** Extract tags from a candidate item. */
function itemTags(item: Record<string, unknown>): string[] {
    const candidates = [item.tags, item.normalized_tags, item.category_tags];
    for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0) {
            return c
                .filter((t): t is string => typeof t === "string")
                .map((t) => t.trim().toLowerCase())
                .filter((t) => t.length > 0)
                .sort((a, b) => a.localeCompare(b));
        }
    }
    return [];
}

/** Build a deterministic cache key from sorted tags. */
function tagCacheKey(tags: string[]): string {
    return tags.join("|");
}

/** Validate a TES vector: must be number[], correct dim, finite, ~unit norm. */
function isValidTesVector(vec: unknown, dim: number): vec is number[] {
    if (!Array.isArray(vec) || vec.length !== dim) return false;
    let sumSq = 0;
    for (const v of vec) {
        if (typeof v !== "number" || !Number.isFinite(v)) return false;
        sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq);
    return norm >= 0.99 && norm <= 1.01;
}

/** Cosine similarity of two normalized vectors (dot product). Guard NaN. */
function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
    }
    return Number.isFinite(dot) ? dot : 0;
}

// ---------------------------------------------------------------------------
// Internal item representation for sorting
// ---------------------------------------------------------------------------

interface ScoredItem {
    original: unknown;
    id: string;
    base_score: number;
    tes_sim: number;
    fused_score: number;
}

function sortScored(items: ScoredItem[]): ScoredItem[] {
    return [...items].sort((a, b) => {
        if (a.fused_score !== b.fused_score) return b.fused_score - a.fused_score;
        if (a.base_score !== b.base_score) return b.base_score - a.base_score;
        return a.id.localeCompare(b.id);
    });
}

// ---------------------------------------------------------------------------
// TES call with cache
// ---------------------------------------------------------------------------

interface TesCallStats {
    used_calls: number;
    cache_hits: number;
    invalid_vectors: number;
    tool_errors: number;
}

async function buildItemTes(
    toolClient: ToolClient,
    tags: string[],
    cache: Map<string, number[] | null>,
    stats: TesCallStats,
    budgetRemaining: number,
): Promise<number[] | null> {
    if (tags.length === 0) {
        stats.invalid_vectors++;
        return null;
    }

    const key = tagCacheKey(tags);
    if (cache.has(key)) {
        stats.cache_hits++;
        return cache.get(key) ?? null;
    }

    if (budgetRemaining <= 0) {
        // Budget exhausted — treat as no vector
        return null;
    }

    stats.used_calls++;
    let observation: Awaited<ReturnType<ToolClient["call"]>>;
    try {
        observation = await toolClient.call({
            tool: TOOL_NAME,
            input: {
                tags,
                normalize: true,
            },
        });
    } catch {
        stats.tool_errors++;
        cache.set(key, null);
        return null;
    }

    if (!observation.ok) {
        stats.tool_errors++;
        cache.set(key, null);
        return null;
    }

    const payload = asObject(observation.output);
    if (!payload) {
        stats.invalid_vectors++;
        cache.set(key, null);
        return null;
    }

    const vec = payload.vector;
    if (!isValidTesVector(vec, TES_DIM)) {
        stats.invalid_vectors++;
        cache.set(key, null);
        return null;
    }

    cache.set(key, vec);
    return vec;
}

// ---------------------------------------------------------------------------
// Score a list of candidates with TES
// ---------------------------------------------------------------------------

async function scoreList(
    items: unknown[],
    userTes: number[],
    toolClient: ToolClient,
    cache: Map<string, number[] | null>,
    stats: TesCallStats,
    budgetRemaining: { value: number },
): Promise<ScoredItem[]> {
    const scored: ScoredItem[] = [];

    for (const raw of items) {
        const obj = asObject(raw);
        if (!obj) {
            scored.push({
                original: raw,
                id: "",
                base_score: 0,
                tes_sim: 0,
                fused_score: 0,
            });
            continue;
        }

        const id = itemId(obj);
        const bs = baseScore(obj);
        const tags = itemTags(obj);

        const itemVec = await buildItemTes(
            toolClient, tags, cache, stats, budgetRemaining.value,
        );
        if (itemVec !== null) {
            // Only decrement budget if a real call was made (not cache hit).
            // We check used_calls change — but actually the stats tracking already
            // handles this. We need to track budget decrement via used_calls.
            budgetRemaining.value = TES_MAX_CALLS - stats.used_calls;
        }

        const sim = itemVec ? round6(cosineSimilarity(userTes, itemVec)) : 0;
        const fused = round6(bs + TES_SIM_WEIGHT * sim);

        scored.push({
            original: raw,
            id,
            base_score: bs,
            tes_sim: sim,
            fused_score: fused,
        });
    }

    return sortScored(scored);
}

// ---------------------------------------------------------------------------
// Fallback (v1 behavior): pass-through with context lookup
// ---------------------------------------------------------------------------

function v1Fallback(
    input: RerankInput,
    context: ExecutionContext,
): { cz: unknown[]; ez: unknown[]; inputFallbackUsed: boolean; missingFields: string[] } {
    let cz = input.cz_ranked;
    let ez = input.ez_ranked;
    let inputFallbackUsed = false;
    const missingFields: string[] = [];

    if (!Array.isArray(cz) || cz.length === 0) missingFields.push("cz_ranked");
    if (!Array.isArray(ez) || ez.length === 0) missingFields.push("ez_ranked");

    if (missingFields.length > 0) {
        for (const nodeOutput of Object.values(context.intermediate_results)) {
            const obj = nodeOutput as Record<string, unknown> | undefined;
            if (!obj || !obj.cz_ranked) continue;
            if (missingFields.includes("cz_ranked") && Array.isArray(obj.cz_ranked)) {
                cz = obj.cz_ranked;
            }
            if (missingFields.includes("ez_ranked") && Array.isArray(obj.ez_ranked)) {
                ez = obj.ez_ranked;
            }
            inputFallbackUsed = true;
            break;
        }
    }

    return {
        cz: cz ?? [],
        ez: ez ?? [],
        inputFallbackUsed,
        missingFields,
    };
}

// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------

export function createRerankSkill(
    toolClient: ToolClient,
): Skill<RerankInput, RerankOutput> {
    return {
        name: "rerank",

        inputSchema: {
            description: "Ranked CZ/EZ lists, user context, and optional TES vector",
            required: ["cz_ranked", "ez_ranked", "user_id", "user_city", "user_tags"],
            optional: ["tes_vector", "tes_dim", "tes_normalized", "tes_fallback_used"],
        },

        outputSchema: {
            description: "Reranked CZ and EZ lists with TES-fused scores",
            required: ["cz_ranked", "ez_ranked"],
        },

        async execute(
            input: RerankInput,
            context: ExecutionContext,
        ): Promise<SkillResult<RerankOutput>> {
            const startedAt = Date.now();

            // Resolve candidates (v1 fallback for input fields)
            const { cz, ez, inputFallbackUsed, missingFields } = v1Fallback(input, context);

            const czArr = Array.isArray(cz) ? cz : [];
            const ezArr = Array.isArray(ez) ? ez : [];
            const czCount = czArr.length;
            const ezCount = ezArr.length;

            // Check user TES vector validity
            const userTes = input.tes_vector;
            const userTesDim = typeof input.tes_dim === "number" ? input.tes_dim : 0;
            const userTesNormalized = input.tes_normalized === true;
            const tesFallbackUpstream = input.tes_fallback_used === true;
            const tesBackend = typeof input.tes_backend === "string" ? input.tes_backend : undefined;
            const userTesValid = !tesFallbackUpstream
                && isValidTesVector(userTes, TES_DIM)
                && userTesDim === TES_DIM
                && userTesNormalized;

            // Extract upstream rerank trace
            let upstreamRerankTrace: Record<string, unknown> = {};
            for (const nodeOutput of Object.values(context.intermediate_results)) {
                const obj = nodeOutput as Record<string, unknown> | undefined;
                const dt = obj?.decision_trace as Record<string, unknown> | undefined;
                if (dt?.rerank) {
                    upstreamRerankTrace = dt.rerank as Record<string, unknown>;
                    break;
                }
            }

            // Determine if TES path is viable
            if (!userTesValid) {
                // Fallback: no TES
                const trace: RerankTesDecisionTrace = {
                    rule_id: RULE_ID,
                    schema_version: SCHEMA_VERSION,
                    tes_used: false,
                    tes_budget: { max_calls: TES_MAX_CALLS, used_calls: 0, cache_hits: 0 },
                    weights: { tes_sim_weight: TES_SIM_WEIGHT },
                    stats: {
                        cz_items: czCount,
                        ez_items: ezCount,
                        tes_scored_items: 0,
                        invalid_vectors: 0,
                        tool_errors: 0,
                    },
                    input_summary: {
                        user_tes_dim: userTesDim,
                        user_tes_valid: false,
                        cz_count: czCount,
                        ez_count: ezCount,
                    },
                    fallback_used: true,
                    fallback_reason: "no_user_tes",
                    latency_ms: Date.now() - startedAt,
                };
                if (tesBackend !== undefined) {
                    trace.tes_backend = tesBackend;
                }

                const merged = { ...upstreamRerankTrace, ...trace };
                if (inputFallbackUsed) {
                    (merged as Record<string, unknown>).input_fallback_used = true;
                    (merged as Record<string, unknown>).missing_fields = missingFields;
                }

                return {
                    output: { cz_ranked: czArr, ez_ranked: ezArr },
                    trace: merged,
                };
            }

            if (czCount + ezCount === 0) {
                const trace: RerankTesDecisionTrace = {
                    rule_id: RULE_ID,
                    schema_version: SCHEMA_VERSION,
                    tes_used: false,
                    tes_budget: { max_calls: TES_MAX_CALLS, used_calls: 0, cache_hits: 0 },
                    weights: { tes_sim_weight: TES_SIM_WEIGHT },
                    stats: {
                        cz_items: 0,
                        ez_items: 0,
                        tes_scored_items: 0,
                        invalid_vectors: 0,
                        tool_errors: 0,
                    },
                    input_summary: {
                        user_tes_dim: TES_DIM,
                        user_tes_valid: true,
                        cz_count: 0,
                        ez_count: 0,
                    },
                    fallback_used: true,
                    fallback_reason: "no_candidates",
                    latency_ms: Date.now() - startedAt,
                };
                if (tesBackend !== undefined) {
                    trace.tes_backend = tesBackend;
                }

                return {
                    output: { cz_ranked: [], ez_ranked: [] },
                    trace: { ...upstreamRerankTrace, ...trace },
                };
            }

            // TES-driven rerank
            const cache = new Map<string, number[] | null>();
            const stats: TesCallStats = {
                used_calls: 0,
                cache_hits: 0,
                invalid_vectors: 0,
                tool_errors: 0,
            };
            const budgetRemaining = { value: TES_MAX_CALLS };

            const scoredCz = await scoreList(
                czArr, userTes as number[], toolClient, cache, stats, budgetRemaining,
            );
            const scoredEz = await scoreList(
                ezArr, userTes as number[], toolClient, cache, stats, budgetRemaining,
            );

            const tesScoredItems = scoredCz.filter((s) => s.tes_sim !== 0).length
                + scoredEz.filter((s) => s.tes_sim !== 0).length;

            const trace: RerankTesDecisionTrace = {
                rule_id: RULE_ID,
                schema_version: SCHEMA_VERSION,
                tes_used: true,
                tes_budget: {
                    max_calls: TES_MAX_CALLS,
                    used_calls: stats.used_calls,
                    cache_hits: stats.cache_hits,
                },
                weights: { tes_sim_weight: TES_SIM_WEIGHT },
                stats: {
                    cz_items: czCount,
                    ez_items: ezCount,
                    tes_scored_items: tesScoredItems,
                    invalid_vectors: stats.invalid_vectors,
                    tool_errors: stats.tool_errors,
                },
                input_summary: {
                    user_tes_dim: TES_DIM,
                    user_tes_valid: true,
                    cz_count: czCount,
                    ez_count: ezCount,
                },
                fallback_used: false,
                latency_ms: Date.now() - startedAt,
            };
            if (tesBackend !== undefined) {
                trace.tes_backend = tesBackend;
            }

            const merged = { ...upstreamRerankTrace, ...trace };
            if (inputFallbackUsed) {
                (merged as Record<string, unknown>).input_fallback_used = true;
                (merged as Record<string, unknown>).missing_fields = missingFields;
            }

            return {
                output: {
                    cz_ranked: scoredCz.map((s) => s.original),
                    ez_ranked: scoredEz.map((s) => s.original),
                },
                trace: merged,
            };
        },
    };
}

/**
 * Legacy export for backward compatibility with tests that use rerankSkill
 * without a ToolClient. Creates a no-op toolClient that always fails,
 * ensuring fallback path is taken.
 */
export const rerankSkill: Skill<RerankInput, RerankOutput> = createRerankSkill(
    {
        call: async () => ({
            ok: false,
            tool: "noop",
            trace_id: "noop",
            latency_ms: 0,
            error: { code: "no_client", message: "no ToolClient provided" },
        }),
    } as unknown as ToolClient,
);
