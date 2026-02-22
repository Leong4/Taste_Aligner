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
import { Skill, DecideTagBudgetInput, DecideTagBudgetOutput } from "../core/types";
export declare const decideTagBudgetSkill: Skill<DecideTagBudgetInput, DecideTagBudgetOutput>;
//# sourceMappingURL=decide_tag_budget.d.ts.map