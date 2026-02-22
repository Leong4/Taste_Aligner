/**
 * FetchRecommendation skill — calls recommendation.score via gateway ToolClient.
 *
 * This skill is responsible for:
 *   1) building a stable request payload from graph inputs
 *   2) extracting ranked results + service decision_trace
 *   3) returning deterministic fallback output on any tool/output failure
 *
 * It does NOT perform rerank or mix-policy computation itself.
 */
import { Skill, FetchRecommendationInput, FetchRecommendationOutput } from "../core/types";
import { ToolClient } from "../tools/toolClient";
export declare function createFetchRecommendationSkill(toolClient: ToolClient): Skill<FetchRecommendationInput, FetchRecommendationOutput>;
//# sourceMappingURL=fetch_recommendation.d.ts.map