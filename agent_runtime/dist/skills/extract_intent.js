"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractIntentSkill = void 0;
// ---------------------------------------------------------------------------
// Rule tables (identical to intentAgent.ts)
// ---------------------------------------------------------------------------
const CITY_RULES = [
    { name: "london", patterns: [/\blondon\b/i] },
    { name: "tokyo", patterns: [/\btokyo\b/i] },
    { name: "kyoto", patterns: [/\bkyoto\b/i] },
    { name: "osaka", patterns: [/\bosaka\b/i] },
    { name: "madrid", patterns: [/\bmadrid\b/i] },
    { name: "barcelona", patterns: [/\bbarcelona\b/i] },
    { name: "munich", patterns: [/\bmunich\b/i] },
    { name: "berlin", patterns: [/\bberlin\b/i] },
    { name: "guangzhou", patterns: [/\bguangzhou\b/i] },
    { name: "shanghai", patterns: [/\bshanghai\b/i] },
    { name: "beijing", patterns: [/\bbeijing\b/i] },
    { name: "chengdu", patterns: [/\bchengdu\b/i] },
    { name: "shenzhen", patterns: [/\bshenzhen\b/i] },
    { name: "hangzhou", patterns: [/\bhangzhou\b/i] },
    { name: "paris", patterns: [/\bparis\b/i] },
    { name: "rome", patterns: [/\brome\b/i] },
    { name: "milan", patterns: [/\bmilan\b/i] },
    { name: "naples", patterns: [/\bnaples\b/i] },
    { name: "vienna", patterns: [/\bvienna\b/i] },
    { name: "prague", patterns: [/\bprague\b/i] },
    { name: "budapest", patterns: [/\bbudapest\b/i] },
    { name: "amsterdam", patterns: [/\bamsterdam\b/i] },
    { name: "new york", patterns: [/\bnew york\b/i] },
    { name: "los angeles", patterns: [/\blos angeles\b/i] },
    { name: "san francisco", patterns: [/\bsan francisco\b/i] },
    { name: "singapore", patterns: [/\bsingapore\b/i] },
    { name: "bangkok", patterns: [/\bbangkok\b/i] },
    { name: "seoul", patterns: [/\bseoul\b/i] },
];
const FOOD_KEYWORDS = [
    "food", "eat", "ramen", "izakaya", "restaurant", "sushi", "cafe",
];
const CULTURE_KEYWORDS = [
    "museum", "temple", "shrine", "culture", "history", "art", "park",
];
const TRAVEL_INTENT_PATTERNS = [
    /\btrip\b/,
    /\btravel\b/,
    /\bvisit\b/,
    /\bplanning\b/,
    /\brecommendations?\b/,
    /\bgoing to\b/,
    /\bwant to go\b/,
];
// ---------------------------------------------------------------------------
// Detection functions (identical to intentAgent.ts)
// ---------------------------------------------------------------------------
function detectCity(text) {
    for (const rule of CITY_RULES) {
        if (rule.patterns.some((p) => p.test(text))) {
            return rule.name;
        }
    }
    return null;
}
function containsAny(text, keywords) {
    return keywords.some((kw) => text.includes(kw));
}
function detectType(text) {
    const hasFood = containsAny(text, FOOD_KEYWORDS);
    const hasCulture = containsAny(text, CULTURE_KEYWORDS);
    if (hasFood && hasCulture)
        return "mixed";
    if (hasFood)
        return "food";
    if (hasCulture)
        return "culture";
    return "unknown";
}
function extractMatchedTags(text) {
    const tags = [];
    for (const kw of FOOD_KEYWORDS) {
        if (text.includes(kw))
            tags.push(kw);
    }
    for (const kw of CULTURE_KEYWORDS) {
        if (text.includes(kw))
            tags.push(kw);
    }
    return Array.from(new Set(tags));
}
function hasTravelIntent(text) {
    return TRAVEL_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}
function buildZoneSeed(type) {
    if (type === "food")
        return { cz_seed: ["ramen_shop", "izakaya"], ez_seed: [] };
    if (type === "culture")
        return { cz_seed: [], ez_seed: ["temple", "park"] };
    if (type === "mixed")
        return { cz_seed: ["ramen_shop", "izakaya"], ez_seed: ["temple", "park"] };
    return { cz_seed: ["ramen_shop"], ez_seed: ["park"] };
}
function hasUploadImageSignal(input, context) {
    const rootInput = context.input;
    const rootContext = context;
    return !!(rootContext.image ||
        rootInput.image ||
        (typeof input.image_url === "string" && input.image_url.trim()) ||
        (typeof input.image_base64 === "string" && input.image_base64.trim()) ||
        (typeof rootInput.image_url === "string" && rootInput.image_url.trim()) ||
        (typeof rootInput.image_base64 === "string" && rootInput.image_base64.trim()));
}
// ---------------------------------------------------------------------------
// Skill implementation
// ---------------------------------------------------------------------------
exports.extractIntentSkill = {
    name: "extract_intent",
    inputSchema: {
        description: "Raw user text and optional user ID",
        required: ["text"],
        optional: ["user_id", "city", "image_url", "image_base64"],
    },
    outputSchema: {
        description: "Structured intent with city, type, tags, zone seeds",
        required: ["city", "type", "tags", "cz_seed", "ez_seed", "raw_text", "confidence", "user_id"],
    },
    async execute(input, context) {
        const text = (input.text ?? "").toLowerCase();
        let city = detectCity(text);
        if (!city && typeof input.city === "string" && input.city.trim()) {
            city = input.city.toLowerCase().trim();
        }
        const matchedTags = extractMatchedTags(text);
        const generalTravelQuery = matchedTags.length === 0 && hasTravelIntent(text);
        const type = generalTravelQuery ? "general" : detectType(text);
        const tags = generalTravelQuery ? ["general"] : matchedTags;
        const seed = buildZoneSeed(type);
        const isUploadFlow = hasUploadImageSignal(input, context);
        const output = {
            city,
            type: type,
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
                upload_flow: isUploadFlow,
                type,
                cz_seed: seed.cz_seed,
                ez_seed: seed.ez_seed,
                tags,
                text: input.text,
            }
            : {
                rule_id: "intent_v1_keywords",
                city_detected: false,
                upload_flow: isUploadFlow,
                type,
                tags,
                text: input.text,
            };
        if (!city && !isUploadFlow) {
            // Query flow still requires city detection to keep downstream
            // recommendation quality unchanged. Upload flow is exempt.
            return {
                output,
                trace: { ...trace, abort_reason: "no_city_detected" },
                terminal: true,
                terminalReason: "no_city_detected",
            };
        }
        return { output, trace };
    },
};
//# sourceMappingURL=extract_intent.js.map