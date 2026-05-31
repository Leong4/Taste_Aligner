/**
 * Prompt module for the tag_expand skill — v1.
 *
 * All prompt constants live here so they can be versioned, reviewed,
 * and tested in isolation from skill orchestration logic.
 *
 * Exports:
 *   PROMPT_VERSION       — string literal version tag stamped on every llm_call trace
 *   SYSTEM_PROMPT        — model-role preamble demanding strict JSON output
 *   buildUserPrompt      — function that serialises a TagExpandInput into a user prompt
 *   OUTPUT_JSON_SCHEMA   — JSON-schema descriptor passed to the adapter's schema field
 *   LIMITS               — default cost / size guardrails (env overrides applied at runtime)
 */
import { TagExpandInput } from "../../core/types";
export declare const PROMPT_VERSION = "v1";
export declare const SYSTEM_PROMPT: string;
export declare function buildUserPrompt(input: TagExpandInput): string;
export declare const OUTPUT_JSON_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly hard_expansions: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly properties: {
                    readonly tag: {
                        readonly type: "string";
                    };
                    readonly confidence: {
                        readonly type: "number";
                        readonly minimum: 0;
                        readonly maximum: 1;
                    };
                };
                readonly required: readonly ["tag", "confidence"];
            };
        };
        readonly soft_expansions: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly properties: {
                    readonly tag: {
                        readonly type: "string";
                    };
                    readonly confidence: {
                        readonly type: "number";
                        readonly minimum: 0;
                        readonly maximum: 1;
                    };
                };
                readonly required: readonly ["tag", "confidence"];
            };
        };
    };
    readonly required: readonly ["hard_expansions", "soft_expansions"];
};
export declare const LIMITS: {
    /** Max total_tokens before skill falls back with "token_budget_exceeded". Override via TAG_EXPAND_MAX_TOTAL_TOKENS. */
    readonly max_total_tokens: 800;
    /** Hard cap on combined hard+soft tags added (hard tags take priority over soft). */
    readonly max_tags: 20;
    /** LLM sampling temperature — 0 for determinism. */
    readonly temperature: 0;
};
//# sourceMappingURL=tag_expand_v1.d.ts.map