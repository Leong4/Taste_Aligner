/**
 * Prompt module for the explain_from_trace skill — v1.
 *
 * All prompt constants live here so they can be versioned, reviewed,
 * and tested in isolation from skill orchestration logic.
 *
 * Exports:
 *   PROMPT_VERSION       — string literal version tag stamped on every llm_call trace
 *   SYSTEM_PROMPT        — model-role preamble demanding strict JSON output
 *   buildUserPrompt      — function that serialises the compact trace into a user prompt
 *   OUTPUT_JSON_SCHEMA   — JSON-schema descriptor passed to the adapter's schema field
 *   LIMITS               — default sampling parameters
 */

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export const PROMPT_VERSION = "explain_v1";

// ---------------------------------------------------------------------------
// Prompts — strict JSON output, no prose, no markdown
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT =
    "You are a recommendation explanation assistant. " +
    "Given a JSON summary of how a food/travel recommendation was produced, " +
    "write a clear, friendly explanation for the end user. " +
    "When anchor evidence is provided, cite it explicitly using memory_id and weights. " +
    "Return structured JSON only. No prose outside the JSON. No markdown.";

export function buildUserPrompt(
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
        `Provide 3-5 bullet points. Language: ${locale === "zh" ? "Chinese" : "English"}. ` +
        "If anchor_evidence exists, include at least two evidence bullets that reference memory_id."
    );

    return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Output schema — passed to the adapter for structured-output enforcement
// ---------------------------------------------------------------------------

export const OUTPUT_JSON_SCHEMA = {
    type: "object",
    properties: {
        explanation: { type: "string", minLength: 1 },
        bullets: { type: "array", items: { type: "string", minLength: 1 }, minItems: 3, maxItems: 5 },
        disclaimer: { type: "string" },
    },
    required: ["explanation", "bullets"],
} as const;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
    /** LLM sampling temperature — fixed to 0 for deterministic output. */
    temperature: 0,
    /** Max total_tokens before skill falls back with "token_budget_exceeded". Override via EXPLAIN_MAX_TOTAL_TOKENS env var. */
    max_total_tokens: 1000,
} as const;
