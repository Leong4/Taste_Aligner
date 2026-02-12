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

// ---------------------------------------------------------------------------
// Deep merge implementation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        !(value instanceof RegExp)
    );
}

/**
 * Deduplicate an array after concatenation.
 *
 * - If items are objects with an "id" field, deduplicate by id
 *   (last occurrence wins).
 * - Otherwise, deduplicate by JSON.stringify for objects or
 *   strict equality for primitives.
 */
function deduplicateArray(arr: unknown[]): unknown[] {
    if (arr.length === 0) return arr;

    // Check if items have an "id" field
    const hasId = arr.every(
        (item) => isPlainObject(item) && "id" in item
    );

    if (hasId) {
        const seen = new Map<unknown, unknown>();
        for (const item of arr) {
            const id = (item as Record<string, unknown>).id;
            seen.set(id, item);
        }
        return Array.from(seen.values());
    }

    // General dedup: primitives by identity, objects by JSON
    const seen = new Set<string>();
    const result: unknown[] = [];
    for (const item of arr) {
        const key =
            typeof item === "object" && item !== null
                ? JSON.stringify(item)
                : String(item);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
        }
    }
    return result;
}

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
export function deepMergeTrace(
    base: Record<string, unknown>,
    incoming: Record<string, unknown>
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };

    for (const key of Object.keys(incoming)) {
        const baseVal = base[key];
        const incVal = incoming[key];

        if (isPlainObject(baseVal) && isPlainObject(incVal)) {
            result[key] = deepMergeTrace(baseVal, incVal);
        } else if (Array.isArray(baseVal) && Array.isArray(incVal)) {
            result[key] = deduplicateArray([...baseVal, ...incVal]);
        } else {
            // Incoming wins — covers: new key, type mismatch, primitive conflict
            result[key] = incVal;
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Context-level merge operations
// ---------------------------------------------------------------------------

/**
 * Merge a skill's trace into the execution context under the skill's
 * namespace.
 *
 * If a trace already exists for that skill (e.g. a retry), the new
 * trace is deep-merged in with "incoming wins" policy.
 */
export function mergeTrace(
    ctx: ExecutionContext,
    skillName: string,
    trace: SkillTrace
): void {
    const existing = ctx.decision_trace[skillName];
    if (existing && isPlainObject(existing)) {
        ctx.decision_trace[skillName] = deepMergeTrace(
            existing as Record<string, unknown>,
            trace
        );
    } else {
        ctx.decision_trace[skillName] = trace;
    }
}

/**
 * Deep-merge an entire decision_trace bundle (e.g. from a downstream
 * service like planner that returns pre-merged traces) into the
 * context.
 *
 * Each key in the incoming bundle is deep-merged individually, so
 * existing keys from prior skills get enriched rather than overwritten.
 */
export function mergeTraceBundle(
    ctx: ExecutionContext,
    bundle: Record<string, SkillTrace>
): void {
    for (const [key, trace] of Object.entries(bundle)) {
        const existing = ctx.decision_trace[key];
        if (existing && isPlainObject(existing) && isPlainObject(trace)) {
            ctx.decision_trace[key] = deepMergeTrace(
                existing as Record<string, unknown>,
                trace as Record<string, unknown>
            );
        } else {
            ctx.decision_trace[key] = trace;
        }
    }
}

/**
 * Get the full merged decision_trace.
 */
export function getDecisionTrace(
    ctx: ExecutionContext
): Record<string, SkillTrace> {
    return ctx.decision_trace;
}

/**
 * Get the trace for a specific skill.
 */
export function getSkillTrace(
    ctx: ExecutionContext,
    skillName: string
): SkillTrace | undefined {
    return ctx.decision_trace[skillName];
}
