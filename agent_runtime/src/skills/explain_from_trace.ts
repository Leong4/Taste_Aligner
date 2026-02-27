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

// ---------------------------------------------------------------------------
// Trace compaction — extract salient fields for the prompt
// ---------------------------------------------------------------------------

function compactTrace(trace: Record<string, unknown>): Record<string, unknown> {
    const compact: Record<string, unknown> = {};

    // extract_intent summary
    const intent = trace.extract_intent;
    if (intent && typeof intent === "object") {
        const ei = intent as Record<string, unknown>;
        compact.intent = {
            city: ei.city,
            type: ei.type,
            tags: ei.tags,
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
            topIds = topItems
                .slice(0, 5)
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

    // planner / build_cards summary
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
            compact.planner = plannerCompact;
            break;
        }
    }

    return compact;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
    "You are a recommendation explanation assistant. Given a JSON summary of " +
    "how a food/travel recommendation was produced, write a clear, friendly " +
    "explanation for the end user. Return structured JSON only.";

function buildUserPrompt(
    compactTrace: Record<string, unknown>,
    locale: string,
    style: string,
    userText?: string
): string {
    const parts: string[] = [];

    if (userText) {
        parts.push(`User query: "${userText}"`);
    }

    parts.push(`Decision summary:\n${JSON.stringify(compactTrace, null, 2)}`);
    parts.push(`Locale: ${locale}`);
    parts.push(`Style: ${style}`);
    parts.push(
        "Respond with JSON: { \"explanation\": \"...\", \"bullets\": [\"...\", ...] }. " +
        `Provide 3-6 bullet points. Language: ${locale === "zh" ? "Chinese" : "English"}.`
    );

    return parts.join("\n\n");
}

/** JSON schema descriptor for the structured output. */
const OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        explanation: { type: "string" },
        bullets: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 },
    },
    required: ["explanation", "bullets"],
};

// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------

const PROMPT_VERSION = "explain_v1";

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
            const userPrompt = buildUserPrompt(compact, locale, style, input.user_text);

            let explanation: string;
            let bullets: string[];
            let callTrace: LLMCallTrace | null = null;
            let fallbackUsed = false;
            let fallbackReason = "";

            try {
                const result = await adapter.generateStructuredJSON<{
                    explanation: string;
                    bullets: string[];
                }>({
                    systemPrompt: SYSTEM_PROMPT,
                    userPrompt,
                    schema: OUTPUT_SCHEMA,
                    temperature: 0.3,
                    promptVersion: PROMPT_VERSION,
                    traceContext: compact,
                });

                explanation = result.data.explanation;
                bullets = result.data.bullets;
                callTrace = result.callTrace;
                if (callTrace.fallback_used || adapter.fallbackReason) {
                    fallbackUsed = true;
                    fallbackReason = callTrace.fallback_reason ?? adapter.fallbackReason ?? "adapter_error";
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
                    temperature: 0.3,
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
                inputs_used: Object.keys(compact),
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
