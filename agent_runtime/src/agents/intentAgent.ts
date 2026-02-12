import { Agent } from "../runtime/agent";
import { Action, Thought } from "../types/react";

export type Intent = {
    city: string | null;
    type: "food" | "culture" | "mixed" | "unknown";
    tags: string[];
    cz_seed: string[];
    ez_seed: string[];
    raw_text: string;
    confidence: number;
};

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
    "food",
    "eat",
    "ramen",
    "izakaya",
    "restaurant",
    "sushi",
    "cafe",
];

const CULTURE_KEYWORDS = [
    "museum",
    "temple",
    "shrine",
    "culture",
    "history",
    "art",
    "park",
];

function detectCity(text: string): string | null {
    for (const rule of CITY_RULES) {
        if (rule.patterns.some((pattern) => pattern.test(text))) {
            return rule.name;
        }
    }
    return null;
}

function containsAny(text: string, keywords: string[]): boolean {
    return keywords.some((keyword) => text.includes(keyword));
}

function detectType(text: string): Intent["type"] {
    const hasFood = containsAny(text, FOOD_KEYWORDS);
    const hasCulture = containsAny(text, CULTURE_KEYWORDS);

    if (hasFood && hasCulture) return "mixed";
    if (hasFood) return "food";
    if (hasCulture) return "culture";
    return "unknown";
}

function extractMatchedTags(text: string): string[] {
    const tags: string[] = [];
    for (const keyword of FOOD_KEYWORDS) {
        if (text.includes(keyword)) tags.push(keyword);
    }
    for (const keyword of CULTURE_KEYWORDS) {
        if (text.includes(keyword)) tags.push(keyword);
    }
    return Array.from(new Set(tags));
}

function buildZoneSeed(type: Intent["type"]): { cz_seed: string[]; ez_seed: string[] } {
    if (type === "food") {
        return { cz_seed: ["ramen_shop", "izakaya"], ez_seed: [] };
    }
    if (type === "culture") {
        return { cz_seed: [], ez_seed: ["temple", "park"] };
    }
    if (type === "mixed") {
        return { cz_seed: ["ramen_shop", "izakaya"], ez_seed: ["temple", "park"] };
    }
    return { cz_seed: ["ramen_shop"], ez_seed: ["park"] };
}

export class IntentAgent implements Agent {
    name = "intent-agent";

    async think(ctx: { userInput: string }): Promise<Thought> {
        const text = ctx.userInput.toLowerCase();
        const city = detectCity(text);
        const type = detectType(text);
        const tags = extractMatchedTags(text);
        const seed = buildZoneSeed(type);
        const done = city === null;
        const structuredIntent: Intent = {
            city,
            type,
            tags,
            cz_seed: seed.cz_seed,
            ez_seed: seed.ez_seed,
            raw_text: ctx.userInput,
            confidence: city ? 0.8 : 0.2,
        };
        const intentTrace = city
            ? {
                rule_id: "intent_v1_keywords",
                city_detected: true,
                city,
                type,
                cz_seed: seed.cz_seed,
                ez_seed: seed.ez_seed,
                tags,
                text: ctx.userInput,
            }
            : {
                rule_id: "intent_v1_keywords",
                city_detected: false,
                abort_reason: "no_city_detected",
                type,
                tags,
                text: ctx.userInput,
            };

        return {
            text: done ? "city not found" : `I should call planner.compose for city=${city} type=${type}`,
            done,
            state: {
                city,
                type,
                intent: structuredIntent,
                decision_trace: {
                    intent_agent: intentTrace,
                },
            },
        };
    }

    async act(thought: Thought): Promise<Action | null> {
        const city = thought.state?.city ?? null;
        const type = thought.state?.type ?? "unknown";
        const intent: Intent | undefined = thought.state?.intent;

        if (!city) {
            return null;
        }

        const seed = buildZoneSeed(type);
        const cz = intent?.cz_seed ?? seed.cz_seed;
        const ez = intent?.ez_seed ?? seed.ez_seed;
        const tags = intent?.tags ?? [];
        const intentTrace = thought.state?.decision_trace?.intent_agent ?? {
            rule_id: "intent_v1_keywords",
            city_detected: true,
            city,
            type,
            cz_seed: cz,
            ez_seed: ez,
            tags,
            text: intent?.raw_text ?? "",
        };

        return {
            tool: "planner.compose",
            input: {
                city,
                cz,
                ez,
                tags,
                user_id: "u001",
                intent,
                meta: {
                    intent,
                    decision_trace: {
                        intent_agent: intentTrace,
                    },
                },
            },
        };
    }
}
