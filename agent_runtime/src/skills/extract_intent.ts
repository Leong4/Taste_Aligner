/**
 * ExtractIntent skill — wraps the existing deterministic intent
 * extraction logic from IntentAgent.
 *
 * This skill extracts city, type, tags, and zone seeds from raw
 * user text using regex patterns and keyword matching.
 * NO LLM involved — purely rule-based.
 *
 * The logic is copied directly from agents/intentAgent.ts to avoid
 * importing the Agent interface. The business rules are identical.
 */

import { Skill, SkillResult, ExecutionContext, ExtractIntentOutput } from "../core/types";

// ---------------------------------------------------------------------------
// Rule tables (identical to intentAgent.ts)
// ---------------------------------------------------------------------------

const CITY_RULES: Array<{ name: string; patterns: RegExp[] }> = [
    { name: "london", patterns: [/\blondon\b/i] },
    { name: "kyoto", patterns: [/\bkyoto\b/i] },
    { name: "osaka", patterns: [/\bosaka\b/i] },
    { name: "tokyo", patterns: [/\btokyo\b/i] },
    { name: "madrid", patterns: [/\bmadrid\b/i] },
    { name: "barcelona", patterns: [/\bbarcelona\b/i] },
    { name: "munich", patterns: [/\bmunich\b/i] },
    { name: "berlin", patterns: [/\bberlin\b/i] },
];

const FOOD_KEYWORDS = [
    "food", "eat", "ramen", "izakaya", "restaurant", "sushi", "cafe",
];

const CULTURE_KEYWORDS = [
    "museum", "temple", "shrine", "culture", "history", "art", "park",
];

// ---------------------------------------------------------------------------
// Detection functions (identical to intentAgent.ts)
// ---------------------------------------------------------------------------

function detectCity(text: string): string | null {
    for (const rule of CITY_RULES) {
        if (rule.patterns.some((p) => p.test(text))) {
            return rule.name;
        }
    }
    return null;
}

function containsAny(text: string, keywords: string[]): boolean {
    return keywords.some((kw) => text.includes(kw));
}

type IntentType = "food" | "culture" | "mixed" | "unknown";

function detectType(text: string): IntentType {
    const hasFood = containsAny(text, FOOD_KEYWORDS);
    const hasCulture = containsAny(text, CULTURE_KEYWORDS);
    if (hasFood && hasCulture) return "mixed";
    if (hasFood) return "food";
    if (hasCulture) return "culture";
    return "unknown";
}

function extractMatchedTags(text: string): string[] {
    const tags: string[] = [];
    for (const kw of FOOD_KEYWORDS) {
        if (text.includes(kw)) tags.push(kw);
    }
    for (const kw of CULTURE_KEYWORDS) {
        if (text.includes(kw)) tags.push(kw);
    }
    return Array.from(new Set(tags));
}

function buildZoneSeed(type: IntentType): { cz_seed: string[]; ez_seed: string[] } {
    if (type === "food") return { cz_seed: ["ramen_shop", "izakaya"], ez_seed: [] };
    if (type === "culture") return { cz_seed: [], ez_seed: ["temple", "park"] };
    if (type === "mixed") return { cz_seed: ["ramen_shop", "izakaya"], ez_seed: ["temple", "park"] };
    return { cz_seed: ["ramen_shop"], ez_seed: ["park"] };
}

// ---------------------------------------------------------------------------
// Skill implementation
// ---------------------------------------------------------------------------

export const extractIntentSkill: Skill<{ text: string; user_id?: string }, ExtractIntentOutput> = {
    name: "extract_intent",

    inputSchema: {
        description: "Raw user text and optional user ID",
        required: ["text"],
        optional: ["user_id"],
    },

    outputSchema: {
        description: "Structured intent with city, type, tags, zone seeds",
        required: ["city", "type", "tags", "cz_seed", "ez_seed", "raw_text", "confidence", "user_id"],
    },

    async execute(
        input: { text: string; user_id?: string },
        _context: ExecutionContext
    ): Promise<SkillResult<ExtractIntentOutput>> {
        const text = (input.text ?? "").toLowerCase();
        const city = detectCity(text);
        const type = detectType(text);
        const tags = extractMatchedTags(text);
        const seed = buildZoneSeed(type);

        const output: ExtractIntentOutput = {
            city,
            type,
            tags,
            cz_seed: seed.cz_seed,
            ez_seed: seed.ez_seed,
            raw_text: input.text,
            confidence: city ? 0.8 : 0.2,
            user_id: input.user_id ?? "u001",
        };

        const trace = city
            ? {
                rule_id: "intent_v1_keywords",
                city_detected: true,
                city,
                type,
                cz_seed: seed.cz_seed,
                ez_seed: seed.ez_seed,
                tags,
                text: input.text,
            }
            : {
                rule_id: "intent_v1_keywords",
                city_detected: false,
                abort_reason: "no_city_detected",
                type,
                tags,
                text: input.text,
            };

        // Signal terminal if no city detected — the pipeline cannot
        // continue without a city. The orchestrator will stop without
        // needing to know anything about this skill's semantics.
        if (!city) {
            return {
                output,
                trace,
                terminal: true,
                terminalReason: "no_city_detected",
            };
        }

        return { output, trace };
    },
};
