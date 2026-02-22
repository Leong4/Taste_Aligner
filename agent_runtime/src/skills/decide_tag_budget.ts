/**
 * DecideTagBudget skill — computes a tag expansion budget and
 * allocation (hard vs soft) based on the extracted intent.
 *
 * This skill runs AFTER extract_intent and BEFORE any future
 * tag_expand skill. It is fully deterministic — no LLM, no
 * randomness, no network calls.
 *
 * Budget formula:
 *   base = 4
 *   budget = clamp(
 *       base
 *       + min(3, hard_seed_count)
 *       + min(2, soft_hint_count)
 *       + type_bonus
 *       + length_bonus,
 *       4, 10
 *   )
 *
 *   hard_expand_limit = clamp(min(2, hard_seed_count), 0, 3)
 *   soft_expand_limit = max(0, budget - hard_expand_limit)
 *
 * The skill passes through tags, cz_seed, ez_seed unchanged so
 * downstream nodes can read from decide_tag_budget if desired.
 */

import {
    Skill,
    SkillResult,
    ExecutionContext,
    DecideTagBudgetInput,
    DecideTagBudgetOutput,
    TagBudgetThresholds,
    TagBudgetFeatures,
} from "../core/types";

// ---------------------------------------------------------------------------
// Soft hint keyword tables
// ---------------------------------------------------------------------------

const SOFT_HINTS_EN = [
    "quiet", "cozy", "casual", "local",
    "non-touristy", "hidden", "chill", "authentic",
];

const SOFT_HINTS_ZH = [
    "\u5b89\u9759",       // 安静
    "\u5c0f\u4f17",       // 小众
    "\u4e0d\u5546\u4e1a\u5316", // 不商业化
    "\u8f7b\u677e",       // 轻松
    "\u672c\u5730\u4eba", // 本地人
    "\u5730\u9053",       // 地道
    "\u6c1b\u56f4",       // 氛围
    "\u968f\u610f",       // 随意
];

const ALL_SOFT_HINTS = [...SOFT_HINTS_EN, ...SOFT_HINTS_ZH];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function detectSoftHints(text: string): string[] {
    const lower = text.toLowerCase();
    const matched = ALL_SOFT_HINTS.filter((hint) => lower.includes(hint.toLowerCase()));
    // Sort alphabetically for deterministic output
    return matched.sort();
}

function typeBonus(type: string): number {
    switch (type) {
        case "food":    return 1;
        case "culture": return 1;
        case "mixed":   return 2;
        default:        return 0;
    }
}

function lengthBonus(rawText: string): number {
    return rawText.length > 40 ? 1 : 0;
}

function countTokens(text: string): number {
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed.split(/\s+/).length : 0;
}

// ---------------------------------------------------------------------------
// Reasons builder — deterministic, stable ordering
// ---------------------------------------------------------------------------

function buildReasons(
    tokenCount: number,
    hardSeedCount: number,
    softHintCount: number,
    softHintsDetected: string[],
    intentType: string,
    tBonus: number,
    lBonus: number,
    budget: number,
): string[] {
    const reasons: string[] = [];

    reasons.push(`token_count=${tokenCount}`);
    reasons.push(`hard_seed_count=${hardSeedCount}`);

    if (softHintCount > 0) {
        // Keywords already sorted alphabetically
        reasons.push(`soft_hint_count=${softHintCount} (keywords: ${softHintsDetected.join(", ")})`);
    } else {
        reasons.push(`soft_hint_count=0`);
    }

    reasons.push(`type=${intentType}`);
    reasons.push(`bonuses: type_bonus=${tBonus}, length_bonus=${lBonus}`);
    reasons.push(`budget=${budget} clamped_to=[4,10]`);

    return reasons;
}

// ---------------------------------------------------------------------------
// Skill implementation
// ---------------------------------------------------------------------------

export const decideTagBudgetSkill: Skill<DecideTagBudgetInput, DecideTagBudgetOutput> = {
    name: "decide_tag_budget",

    inputSchema: {
        description: "Intent fields needed to compute tag expansion budget",
        required: ["tags", "cz_seed", "ez_seed", "type", "raw_text", "confidence"],
    },

    outputSchema: {
        description: "Tag expansion budget with hard/soft allocation, thresholds, features, reasons",
        required: [
            "budget", "hard_expand_limit", "soft_expand_limit",
            "thresholds", "features", "reasons",
            "hard_seed_count", "soft_hint_count", "soft_hints_detected",
            "type_bonus", "length_bonus",
            "tags", "cz_seed", "ez_seed",
        ],
    },

    async execute(
        input: DecideTagBudgetInput,
        _context: ExecutionContext
    ): Promise<SkillResult<DecideTagBudgetOutput>> {
        const tags = input.tags ?? [];
        const czSeed = input.cz_seed ?? [];
        const ezSeed = input.ez_seed ?? [];
        const rawText = input.raw_text ?? "";
        const intentType = input.type ?? "unknown";

        // 1. Count hard seeds
        const hardSeedCount = czSeed.length + ezSeed.length;

        // 2. Detect soft hints (sorted alphabetically)
        const softHintsDetected = detectSoftHints(rawText);
        const softHintCount = softHintsDetected.length;

        // 3. Compute bonuses
        const tBonus = typeBonus(intentType);
        const lBonus = lengthBonus(rawText);

        // 4. Compute total budget
        const base = 4;
        const budget = clamp(
            base
            + Math.min(3, hardSeedCount)
            + Math.min(2, softHintCount)
            + tBonus
            + lBonus,
            4,
            10
        );

        // 5. Compute allocation
        const hardExpandLimit = clamp(Math.min(2, hardSeedCount), 0, 3);
        const softExpandLimit = Math.max(0, budget - hardExpandLimit);

        // 6. Compute thresholds
        const thresholds: TagBudgetThresholds = {
            min_confidence_soft: budget >= 9 ? 0.65 : 0.55,
            min_confidence_hard: 0.55,
        };

        // 7. Build features vector
        const tokenCount = countTokens(rawText);
        const features: TagBudgetFeatures = {
            token_count: tokenCount,
            hard_seed_count: hardSeedCount,
            soft_hint_count: softHintCount,
            type: intentType,
        };

        // 8. Build deterministic reasons
        const reasons = buildReasons(
            tokenCount, hardSeedCount, softHintCount, softHintsDetected,
            intentType, tBonus, lBonus, budget,
        );

        const output: DecideTagBudgetOutput = {
            budget,
            hard_expand_limit: hardExpandLimit,
            soft_expand_limit: softExpandLimit,
            thresholds,
            features,
            reasons,
            hard_seed_count: hardSeedCount,
            soft_hint_count: softHintCount,
            soft_hints_detected: softHintsDetected,
            type_bonus: tBonus,
            length_bonus: lBonus,
            tags,
            cz_seed: czSeed,
            ez_seed: ezSeed,
        };

        const trace = {
            rule_id: "tag_budget_v1",
            schema_version: "1.0",
            base,
            budget,
            hard_expand_limit: hardExpandLimit,
            soft_expand_limit: softExpandLimit,
            thresholds,
            features,
            reasons,
            hard_seed_count: hardSeedCount,
            soft_hint_count: softHintCount,
            soft_hints_detected: softHintsDetected,
            type_bonus: tBonus,
            length_bonus: lBonus,
        };

        return { output, trace };
    },
};
