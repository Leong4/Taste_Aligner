/**
 * build_profile_vector skill — P4 dynamic weighting unification
 *
 * Transforms memory.search weighted results into a deterministic profile
 * vector and per-memory weight breakdown.  This is the SINGLE authoritative
 * source for dynamic weighting in the runtime pipeline.  No other node may
 * recompute time/sentiment weights.
 *
 * Weight formulas (all deterministic):
 *   w_time    = exp(-LAMBDA_TIME * delta_days)
 *               delta_days = (now_ms - timestamp_ms) / 86400000
 *               Falls back to 1.0 when timestamp is absent or unparseable.
 *   w_sent    = clamp(1 + ALPHA_SENT * sentiment, W_SENT_MIN, W_SENT_MAX)
 *               Falls back to 1.0 when sentiment is absent.
 *   w_context = passed through from memory.search (no re-computation).
 *   final_weight = cosine * w_time * w_sent * w_context
 *
 * Profile vector:
 *   Weighted average of MemoryUnit.embedding (512-dim) using final_weight /
 *   total_weight normalization.  Returns a deterministic 512-dim zero vector
 *   when no embeddings are supplied (typical — memory.search does not return
 *   raw embeddings in standard mode).
 *
 * Determinism contract:
 *   - Given identical input + nowMs → identical output.
 *   - All floats rounded to 6 decimal places.
 *   - Anchors sorted by final_weight desc, memory_id asc (tie-break).
 *   - No Date.now() in decision logic; nowMs comes from ExecutionContext.
 *   - No side effects, no DB writes, no randomness.
 *
 * Decision trace:
 *   output.decision_trace = { profile_vector_node: ProfileVectorDecisionTrace }
 *   The orchestrator's mergeResultTraceBundles picks this up and writes it to
 *   ctx.decision_trace.profile_vector_node so explain_from_trace can read it.
 */
import { Skill, MemoryUnit, TopKMemory, ProfileVectorWeights, BuildProfileVectorInput, BuildProfileVectorOutput } from "../core/types";
export interface BuildProfileVectorResult {
    profile_vector: number[];
    anchors: TopKMemory[];
    total_memories_considered: number;
    weights: ProfileVectorWeights;
    has_embeddings: boolean;
    anchor_gate: {
        enabled: boolean;
        cosine_threshold: number;
        relative_ratio: number;
        candidates_before: number;
        candidates_after: number;
        dropped_count: number;
    };
}
/**
 * Pure function: compute profile vector + weight breakdown from MemoryUnit[].
 *
 * @param memories  Memory records from memory.search (MemoryUnit[]).
 * @param nowMs     Reference epoch timestamp in milliseconds.
 * @returns         Deterministic profile vector, anchors, and weights.
 */
export declare function buildProfileVector(memories: MemoryUnit[], nowMs: number): BuildProfileVectorResult;
export declare function createBuildProfileVectorSkill(): Skill<BuildProfileVectorInput, BuildProfileVectorOutput>;
//# sourceMappingURL=build_profile_vector.d.ts.map