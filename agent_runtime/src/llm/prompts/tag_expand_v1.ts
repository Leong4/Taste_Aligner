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

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export const PROMPT_VERSION = "v1";

// ---------------------------------------------------------------------------
// Prompts — strict JSON output, no prose, no markdown
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT =
    "You expand recommendation tags. " +
    "Return JSON only with keys \"hard_expansions\" and \"soft_expansions\". " +
    "Each item must be {\"tag\": string, \"confidence\": number}. " +
    "No prose. No markdown. No extra text outside the JSON object.";

export function buildUserPrompt(input: TagExpandInput): string {
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

// ---------------------------------------------------------------------------
// Output schema — passed to the adapter for structured-output enforcement
// ---------------------------------------------------------------------------

export const OUTPUT_JSON_SCHEMA = {
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
} as const;

// ---------------------------------------------------------------------------
// Limits — defaults; env overrides are applied in the skill at runtime
// ---------------------------------------------------------------------------

export const LIMITS = {
    /** Max total_tokens before skill falls back with "token_budget_exceeded". Override via TAG_EXPAND_MAX_TOTAL_TOKENS. */
    max_total_tokens: 800,
    /** Hard cap on combined hard+soft tags added (hard tags take priority over soft). */
    max_tags: 20,
    /** LLM sampling temperature — 0 for determinism. */
    temperature: 0,
} as const;
