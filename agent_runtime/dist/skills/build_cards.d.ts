/**
 * BuildCards skill — calls the planner service via the gateway to
 * assemble final journey cards.
 *
 * Forwards the FULL accumulated decision_trace from the graph input
 * (not just extract_intent). This ensures the planner receives all
 * upstream traces from recommendation service stages.
 */
import { Skill, BuildCardsInput } from "../core/types";
import { ToolClient } from "../tools/toolClient";
export declare function createBuildCardsSkill(toolClient: ToolClient): Skill<BuildCardsInput, unknown>;
//# sourceMappingURL=build_cards.d.ts.map