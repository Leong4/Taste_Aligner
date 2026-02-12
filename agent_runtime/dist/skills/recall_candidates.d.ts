/**
 * RecallCandidates skill — calls the recommendation service's /score
 * endpoint via the gateway to get recall results.
 *
 * In the current architecture, the recommendation service runs the
 * full pipeline (recall → rerank → mix_policy) in a single /score
 * call. This skill wraps that call and extracts the recall-stage
 * output for downstream nodes.
 *
 * IMPORTANT: This skill calls the gateway exactly as ToolClient did
 * before. It does NOT rewrite any recall logic.
 */
import { Skill, RecallInput } from "../core/types";
import { ToolClient } from "../tools/toolClient";
/**
 * Factory: create a recall_candidates skill bound to a ToolClient.
 *
 * We use a factory so the skill can reference the shared ToolClient
 * configured with the gateway URL and timeout.
 */
export declare function createRecallCandidatesSkill(toolClient: ToolClient): Skill<RecallInput, unknown>;
//# sourceMappingURL=recall_candidates.d.ts.map