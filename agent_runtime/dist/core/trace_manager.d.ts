/**
 * TraceManager — handles merging decision_trace fragments from each
 * skill into the ExecutionContext's unified decision_trace.
 *
 * All merges go through deepMergeTrace() which implements a canonical
 * deep-merge with "incoming wins" policy:
 *   - Conflicting leaf values: incoming replaces base
 *   - Objects: recursive merge
 *   - Arrays: concatenate with deduplication
 */
import { ExecutionContext, SkillTrace } from "./types";
/**
 * Canonical deep-merge function for decision traces.
 *
 * Policy (incoming wins on conflict):
 *   - If both values are plain objects → recursive merge
 *   - If both values are arrays → concatenate + deduplicate
 *   - Otherwise → incoming value replaces base
 *
 * Returns a NEW object; does not mutate inputs.
 */
export declare function deepMergeTrace(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown>;
/**
 * Merge a skill's trace into the execution context under the skill's
 * namespace.
 *
 * If a trace already exists for that skill (e.g. a retry), the new
 * trace is deep-merged in with "incoming wins" policy.
 */
export declare function mergeTrace(ctx: ExecutionContext, skillName: string, trace: SkillTrace): void;
/**
 * Deep-merge an entire decision_trace bundle (e.g. from a downstream
 * service like planner that returns pre-merged traces) into the
 * context.
 *
 * Each key in the incoming bundle is deep-merged individually, so
 * existing keys from prior skills get enriched rather than overwritten.
 */
export declare function mergeTraceBundle(ctx: ExecutionContext, bundle: Record<string, SkillTrace>): void;
/**
 * Get the full merged decision_trace.
 */
export declare function getDecisionTrace(ctx: ExecutionContext): Record<string, SkillTrace>;
/**
 * Get the trace for a specific skill.
 */
export declare function getSkillTrace(ctx: ExecutionContext, skillName: string): SkillTrace | undefined;
//# sourceMappingURL=trace_manager.d.ts.map