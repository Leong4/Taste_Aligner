/**
 * Rerank skill (v2) — TES-driven rerank with deterministic fallback.
 *
 * When a valid user TES vector is available from tes_builder:
 *   1. For each candidate item (up to TES_MAX_CALLS budget), build an
 *      item TES vector via embedding.tes_build using item tags.
 *   2. Compute cosine similarity between user and item TES vectors.
 *   3. Fuse: fused_score = base_score + TES_SIM_WEIGHT * tes_similarity.
 *   4. Sort deterministically: fused_score desc, base_score desc, id asc.
 *
 * Fallback: if user TES vector is missing/invalid, degrade to pass-through
 * of cz_ranked/ez_ranked from upstream (v1 behavior). Never throws.
 *
 * Determinism:
 *   - Tag signatures are sorted for cache key computation.
 *   - Stable sort with triple tie-breaker (fused desc, base desc, id asc).
 *   - No Date.now() in decision logic (only for latency measurement).
 */
import { Skill, RerankInput, RerankOutput } from "../core/types";
import { ToolClient } from "../tools/toolClient";
export declare function createRerankSkill(toolClient: ToolClient): Skill<RerankInput, RerankOutput>;
/**
 * Legacy export for backward compatibility with tests that use rerankSkill
 * without a ToolClient. Creates a no-op toolClient that always fails,
 * ensuring fallback path is taken.
 */
export declare const rerankSkill: Skill<RerankInput, RerankOutput>;
//# sourceMappingURL=rerank.d.ts.map