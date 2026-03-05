/**
 * ExplainFromTrace skill — generates a human-readable explanation of
 * the recommendation decision by summarizing the accumulated
 * decision_trace via an LLM adapter.
 *
 * This is the first LLM-backed skill in the pipeline. It runs AFTER
 * build_cards and does not alter any recommendation data — it only
 * produces an additive explanation layer.
 *
 * The skill:
 *   1. Compacts the decision_trace into a concise prompt (no raw arrays)
 *   2. Calls the LLM adapter for structured JSON output
 *   3. Returns explanation + bullets + full call trace for auditing
 *   4. On adapter failure, returns a graceful fallback (never throws)
 */

import {
    Skill,
    SkillResult,
    ExecutionContext,
    ExplainFromTraceInput,
    ExplainFromTraceOutput,
} from "../core/types";
import { LLMAdapter, LLMCallTrace } from "../llm/llm_adapter";
import {
    PROMPT_VERSION,
    SYSTEM_PROMPT,
    buildUserPrompt as buildExplainUserPrompt,
    OUTPUT_JSON_SCHEMA,
    LIMITS,
} from "../llm/prompts/explain_from_trace_v1";

// ---------------------------------------------------------------------------
// Deterministic inputs_used order — matches compactTrace output keys
// ---------------------------------------------------------------------------

// "profile" maps to compact.profile (from decision_trace.profile_vector_node).
// Explain reads ONLY the unified profile_vector_node — no raw memory weights
// must be re-read or recomputed from other trace keys.
const INPUT_ORDER = ["intent", "recall", "rerank", "mix_policy", "profile", "planner"] as const;

// ---------------------------------------------------------------------------
// Compaction limits
// ---------------------------------------------------------------------------

const MAX_CARDS = 6;
const MAX_ITEMS_PER_CARD = 3;
const MAX_TAGS_PER_ITEM = 5;
const MAX_COMPACT_JSON_BYTES = 8 * 1024; // 8 KB

/**
 * Token budget guard: if usage.total_tokens exceeds this threshold the skill
 * falls back deterministically with reason "token_budget_exceeded".
 * Configurable via EXPLAIN_MAX_TOTAL_TOKENS env var (default from LIMITS).
 */
const EXPLAIN_MAX_TOTAL_TOKENS = parseInt(
    process.env.EXPLAIN_MAX_TOTAL_TOKENS ?? String(LIMITS.max_total_tokens),
    10
);

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

interface ExplainLLMOutput {
    explanation: string;
    bullets: string[];
    disclaimer?: string;
}

function isValidOutput(data: unknown): data is ExplainLLMOutput {
    if (!data || typeof data !== "object") return false;
    const d = data as Record<string, unknown>;
    if (typeof d.explanation !== "string" || d.explanation.trim().length === 0) return false;
    if (!Array.isArray(d.bullets)) return false;
    if (d.bullets.length < 3 || d.bullets.length > 5) return false;
    if (!d.bullets.every((b) => typeof b === "string" && b.trim().length > 0)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Local fallback output — deterministic, no LLM required
// ---------------------------------------------------------------------------

function buildLocalFallback(compact: Record<string, unknown>): { explanation: string; bullets: string[] } {
    const intent = compact.intent as Record<string, unknown> | undefined;
    const city = typeof intent?.city === "string" ? intent.city : "your city";
    const type = typeof intent?.type === "string" ? intent.type : "food";

    return {
        explanation: `Based on your preferences, we selected ${type} options in ${city} matching your taste profile.`,
        bullets: [
            "Location matched from your input",
            "Candidates ranked by affinity score",
            "Mix policy applied for variety",
        ],
    };
}

// ---------------------------------------------------------------------------
// Trace compaction — extract salient fields for the prompt
// ---------------------------------------------------------------------------

function capArray<T>(arr: T[], max: number): T[] {
    return arr.length <= max ? arr : arr.slice(0, max);
}

function capItemFields(item: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
        if (Array.isArray(v)) {
            out[k] = capArray(v as unknown[], MAX_TAGS_PER_ITEM);
        } else if (typeof v === "string" && v.length > 120) {
            // Drop long text fields silently
        } else {
            out[k] = v;
        }
    }
    return out;
}

function compactTrace(trace: Record<string, unknown>): Record<string, unknown> {
    const compact: Record<string, unknown> = {};

    // extract_intent summary
    const intent = trace.extract_intent;
    if (intent && typeof intent === "object") {
        const ei = intent as Record<string, unknown>;
        compact.intent = {
            city: ei.city,
            type: ei.type,
            tags: Array.isArray(ei.tags) ? capArray(ei.tags as unknown[], MAX_TAGS_PER_ITEM) : ei.tags,
            confidence: ei.confidence,
        };
    }

    // fetch_recommendation / recall summary
    for (const key of ["fetch_recommendation", "recall", "recall_candidates"]) {
        const node = trace[key];
        if (node && typeof node === "object") {
            const n = node as Record<string, unknown>;
            compact.recall = {
                rule_id: n.rule_id,
                candidate_counts: n.candidate_counts,
                rules_used: n.rules_used,
            };
            break;
        }
    }

    // rerank summary — only top item ids and weights
    const rerank = trace.rerank;
    if (rerank && typeof rerank === "object") {
        const r = rerank as Record<string, unknown>;
        const topItems = r.top_items;
        let topIds: unknown[] = [];
        if (Array.isArray(topItems)) {
            topIds = capArray(topItems as unknown[], MAX_ITEMS_PER_CARD)
                .map((item) => {
                    if (typeof item === "object" && item !== null) {
                        const it = item as Record<string, unknown>;
                        return { id: it.id, score: it.score ?? it.score_CZ ?? it.score_EZ };
                    }
                    return item;
                });
        }
        compact.rerank = {
            rule_id: r.rule_id,
            weights: r.weights,
            top_items_preview: topIds,
        };
    }

    // mix_policy summary
    const mix = trace.mix_policy;
    if (mix && typeof mix === "object") {
        const m = mix as Record<string, unknown>;
        compact.mix_policy = {
            rule_id: m.rule_id,
            ratio: m.ratio,
            confidence: m.confidence,
        };
    }

    // profile_vector_node summary — P4 dynamic weighting unification.
    // explain_from_trace reads ONLY this unified structure; raw memory.search
    // weighting fields must NOT be re-read from other trace keys here.
    const pvn = trace.profile_vector_node;
    if (pvn && typeof pvn === "object" && !Array.isArray(pvn)) {
        const p = pvn as Record<string, unknown>;
        compact.profile = {
            anchors_count: Array.isArray(p.anchors) ? (p.anchors as unknown[]).length : 0,
            weights_summary: p.weights_summary,
            total_memories_considered: p.total_memories_considered,
        };
    }

    // planner / build_cards summary — cap cards and items per card
    for (const key of ["planner", "build_cards"]) {
        const node = trace[key];
        if (node && typeof node === "object") {
            const n = node as Record<string, unknown>;
            const plannerCompact: Record<string, unknown> = {
                rule_id: n.rule_id,
                cards_count: n.cards_count,
            };
            // Capture all ez_fill variants the planner may emit
            if (n.ez_fill_triggered !== undefined) plannerCompact.ez_fill_triggered = n.ez_fill_triggered;
            if (n.ez_fill_reason !== undefined) plannerCompact.ez_fill_reason = n.ez_fill_reason;
            if (n.ez_fill_source !== undefined) plannerCompact.ez_fill_source = n.ez_fill_source;
            if (n.ez_fill !== undefined) plannerCompact.ez_fill = n.ez_fill;

            // Cap cards array
            if (Array.isArray(n.cards)) {
                plannerCompact.cards = capArray(n.cards as unknown[], MAX_CARDS).map((card) => {
                    if (card && typeof card === "object") {
                        const c = card as Record<string, unknown>;
                        const cappedCard: Record<string, unknown> = {};
                        for (const [k, v] of Object.entries(c)) {
                            if (Array.isArray(v)) {
                                // Cap items per card, then cap tags per item
                                cappedCard[k] = capArray(v as unknown[], MAX_ITEMS_PER_CARD).map((item) => {
                                    if (item && typeof item === "object") {
                                        return capItemFields(item as Record<string, unknown>);
                                    }
                                    return item;
                                });
                            } else if (typeof v === "string" && v.length > 120) {
                                // Drop long text fields
                            } else {
                                cappedCard[k] = v;
                            }
                        }
                        return cappedCard;
                    }
                    return card;
                });
            }

            compact.planner = plannerCompact;
            break;
        }
    }

    // 8 KB hard cap — deterministically remove largest fields first
    const enforceByteLimit = (obj: Record<string, unknown>): Record<string, unknown> => {
        if (JSON.stringify(obj).length <= MAX_COMPACT_JSON_BYTES) return obj;
        // Priority order to drop: planner.cards first, then rerank.top_items_preview, then recall
        const result = { ...obj };
        const planner = result.planner as Record<string, unknown> | undefined;
        if (planner && planner.cards !== undefined) {
            const { cards: _cards, ...plannerWithout } = planner;
            result.planner = plannerWithout;
            if (JSON.stringify(result).length <= MAX_COMPACT_JSON_BYTES) return result;
        }
        const rerank = result.rerank as Record<string, unknown> | undefined;
        if (rerank && rerank.top_items_preview !== undefined) {
            const { top_items_preview: _tip, ...rerankWithout } = rerank;
            result.rerank = rerankWithout;
            if (JSON.stringify(result).length <= MAX_COMPACT_JSON_BYTES) return result;
        }
        if (result.recall !== undefined) {
            const { recall: _recall, ...withoutRecall } = result;
            if (JSON.stringify(withoutRecall).length <= MAX_COMPACT_JSON_BYTES) return withoutRecall;
        }
        return result;
    };

    return enforceByteLimit(compact);
}

// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------

export function createExplainFromTraceSkill(
    adapter: LLMAdapter
): Skill<ExplainFromTraceInput, ExplainFromTraceOutput> {
    return {
        name: "explain_from_trace",

        inputSchema: {
            description: "Decision trace + optional user text for explanation generation",
            required: ["decision_trace"],
            optional: ["user_text", "locale", "style"],
        },

        outputSchema: {
            description: "Human-readable explanation with bullet points",
            required: ["explanation", "bullets", "meta"],
        },

        async execute(
            input: ExplainFromTraceInput,
            _context: ExecutionContext
        ): Promise<SkillResult<ExplainFromTraceOutput>> {
            const locale = input.locale ?? (process.env.EXPLAIN_LOCALE as "en" | "zh" | undefined) ?? "en";
            const style = input.style ?? (process.env.EXPLAIN_STYLE as "concise" | "detailed" | undefined) ?? "concise";

            // Use graph-provided decision_trace, fall back to context
            const traceSource =
                input.decision_trace &&
                typeof input.decision_trace === "object" &&
                Object.keys(input.decision_trace).length > 0
                    ? input.decision_trace
                    : _context.decision_trace;

            const compact = compactTrace(traceSource);
            const userPrompt = buildExplainUserPrompt(compact, locale, style, input.user_text);

            let explanation: string;
            let bullets: string[];
            let callTrace: LLMCallTrace | null = null;
            let fallbackUsed = false;
            let fallbackReason = "";

            try {
                const result = await adapter.generateStructuredJSON<ExplainLLMOutput>({
                    systemPrompt: SYSTEM_PROMPT,
                    userPrompt,
                    schema: OUTPUT_JSON_SCHEMA,
                    temperature: LIMITS.temperature,
                    promptVersion: PROMPT_VERSION,
                    traceContext: compact,
                });

                callTrace = result.callTrace;

                // Token budget guardrail
                if (callTrace.usage.total_tokens > EXPLAIN_MAX_TOTAL_TOKENS) {
                    fallbackUsed = true;
                    fallbackReason = "token_budget_exceeded";
                    const local = buildLocalFallback(compact);
                    explanation = local.explanation;
                    bullets = local.bullets;
                } else if (!isValidOutput(result.data)) {
                    // Output schema validation
                    fallbackUsed = true;
                    fallbackReason = "invalid_output";
                    explanation = "Explanation unavailable.";
                    bullets = [];
                } else {
                    explanation = result.data.explanation;
                    bullets = result.data.bullets;
                    if (callTrace.fallback_used || adapter.fallbackReason) {
                        fallbackUsed = true;
                        fallbackReason = callTrace.fallback_reason ?? adapter.fallbackReason ?? "adapter_error";
                    }
                }
            } catch (err: unknown) {
                // Graceful fallback — never throw from this skill
                fallbackUsed = true;
                fallbackReason = "adapter_error";
                explanation = "Explanation unavailable.";
                bullets = [];
                const adapterError = err instanceof Error ? err.message : String(err);

                callTrace = {
                    model: adapter.modelInfo,
                    temperature: LIMITS.temperature,
                    prompt_version: PROMPT_VERSION,
                    latency_ms: 0,
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    fallback_used: true,
                    fallback_reason: "adapter_error",
                };

                console.warn(
                    `[explain_from_trace] Adapter error, returning fallback: ${adapterError}`
                );
            }

            const output: ExplainFromTraceOutput = {
                explanation,
                bullets,
                meta: { locale, style },
            };

            const trace: Record<string, unknown> = {
                schema_version: PROMPT_VERSION,
                inputs_used: INPUT_ORDER.filter((k) => compact[k] != null),
                locale,
                style,
                fallback_used: fallbackUsed,
            };
            if (fallbackUsed) {
                trace.fallback_reason = fallbackReason || "adapter_error";
            }

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
                const llmFallbackReason = callTrace.fallback_reason ?? (fallbackUsed ? (fallbackReason || "adapter_error") : undefined);
                if (llmFallbackReason !== undefined) {
                    llmCallEntry.fallback_reason = llmFallbackReason;
                }
                trace.llm_call = llmCallEntry;
            }

            if (fallbackUsed && (fallbackReason || "adapter_error") === "adapter_error") {
                trace.error = "adapter_error";
            }

            return { output, trace };
        },
    };
}
