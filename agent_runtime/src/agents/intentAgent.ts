import { Agent } from "../runtime/agent";
import { Action, Thought } from "../types/react";

export type Intent = {
    city: string | null;
    type: "food" | "culture" | "mixed" | "unknown";
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

export class IntentAgent implements Agent {
    name = "intent-agent";

    async think(ctx: { userInput: string }): Promise<Thought> {
        const text = ctx.userInput.toLowerCase();
        const city = detectCity(text);
        const type = detectType(text);
        const done = city === null;

        return {
            text: done ? "city not found" : `I should call planner.compose for city=${city} type=${type}`,
            done,
            state: { city, type },
        };
    }

    async act(thought: Thought): Promise<Action | null> {
        const city = thought.state?.city ?? null;
        const type = thought.state?.type ?? "unknown";

        if (!city) {
            return null;
        }

        let cz: string[] = [];
        let ez: string[] = [];

        if (type === "food") {
            cz = ["ramen_shop", "izakaya"];
        } else if (type === "culture") {
            ez = ["temple", "park"];
        } else if (type === "mixed") {
            cz = ["ramen_shop", "izakaya"];
            ez = ["temple", "park"];
        } else {
            cz = ["ramen_shop"];
            ez = ["park"];
        }

        return {
            tool: "planner.compose",
            input: { city, cz, ez, user_id: "u001" },
        };
    }
}
