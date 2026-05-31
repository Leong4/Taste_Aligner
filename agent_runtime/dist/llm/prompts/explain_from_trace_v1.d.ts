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
export declare const PROMPT_VERSION = "explain_v1";
export declare const SYSTEM_PROMPT: string;
export declare function buildUserPrompt(compactTrace: Record<string, unknown>, locale: string, style: string, userText?: string): string;
export declare const OUTPUT_JSON_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly explanation: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly bullets: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly minItems: 3;
            readonly maxItems: 5;
        };
        readonly disclaimer: {
            readonly type: "string";
        };
    };
    readonly required: readonly ["explanation", "bullets"];
};
export declare const LIMITS: {
    /** LLM sampling temperature — fixed to 0 for deterministic output. */
    readonly temperature: 0;
    /** Max total_tokens before skill falls back with "token_budget_exceeded". Override via EXPLAIN_MAX_TOTAL_TOKENS env var. */
    readonly max_total_tokens: 1000;
};
//# sourceMappingURL=explain_from_trace_v1.d.ts.map