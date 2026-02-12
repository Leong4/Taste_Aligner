/**
 * FetchRecommendation skill — calls the recommendation service's /score
 * endpoint via the gateway.
 *
 * The recommendation service runs the full pipeline (recall → rerank →
 * mix_policy) in a single /score call. This skill honestly exposes
 * the full response shape so downstream nodes consume correct semantics:
 *
 *   - cz_ranked:   already-scored CZ items (not raw recall candidates)
 *   - ez_ranked:   already-scored EZ items
 *   - mix_policy:  the computed CZ:EZ ratio
 *   - recall_summary: counts/rules from the recall stage
 *   - decision_trace: { recall, rerank, mix_policy } from the service
 */
import { Skill, FetchRecommendationInput } from "../core/types";
import { ToolClient } from "../tools/toolClient";
export declare function createFetchRecommendationSkill(toolClient: ToolClient): Skill<FetchRecommendationInput, unknown>;
//# sourceMappingURL=fetch_recommendation.d.ts.map