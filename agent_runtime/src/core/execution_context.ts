/**
 * ExecutionContext — shared mutable state carried through the entire
 * graph execution lifecycle.
 *
 * The Orchestrator creates one context per request. Each skill reads
 * from `intermediate_results` (populated by prior nodes) and writes
 * its output back. The context also accumulates the merged
 * decision_trace and any non-fatal errors.
 *
 * This module provides factory and accessor helpers so that the
 * Orchestrator and skills don't manipulate the raw object directly.
 */

import {
    ExecutionContext,
    ExecutionError,
    OrchestratorInput,
    SkillTrace,
} from "./types";

/**
 * Create a fresh ExecutionContext for a new orchestrator run.
 */
export function createExecutionContext(input: OrchestratorInput): ExecutionContext {
    return {
        input,
        intermediate_results: {},
        final_result: null,
        decision_trace: {},
        errors: [],
        timing: {},
    };
}

/**
 * Store a skill's output in the context under the given node ID.
 */
export function storeResult(
    ctx: ExecutionContext,
    nodeId: string,
    output: unknown
): void {
    ctx.intermediate_results[nodeId] = output;
}

/**
 * Retrieve a previously stored result by node ID.
 * Returns undefined if the node hasn't executed yet.
 */
export function getResult(ctx: ExecutionContext, nodeId: string): unknown {
    return ctx.intermediate_results[nodeId];
}

/**
 * Resolve a dotted path from the context.
 *
 * Supported prefixes:
 *   - "input.field"          → ctx.input[field]
 *   - "node_id.field"        → ctx.intermediate_results[node_id][field]
 *   - "node_id.field.nested" → deep traversal
 *
 * Returns undefined if any segment is missing.
 */
export function resolveContextPath(ctx: ExecutionContext, path: string): unknown {
    const parts = path.split(".");
    const root = parts[0];
    if (!root) return undefined;

    let current: unknown;
    if (root === "input") {
        current = ctx.input;
    } else {
        current = ctx.intermediate_results[root];
    }

    for (let i = 1; i < parts.length; i++) {
        if (current === null || current === undefined) return undefined;
        if (typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[parts[i]!];
    }

    return current;
}

/**
 * Build the resolved input object for a skill node by mapping each
 * declared `inputFrom` entry to its value in the context.
 */
export function resolveNodeInput(
    ctx: ExecutionContext,
    inputFrom: Record<string, string>
): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, path] of Object.entries(inputFrom)) {
        resolved[key] = resolveContextPath(ctx, path);
    }
    return resolved;
}

/**
 * Record an execution error without halting the pipeline.
 */
export function addError(
    ctx: ExecutionContext,
    nodeId: string,
    skill: string,
    code: string,
    message: string
): void {
    const error: ExecutionError = {
        node_id: nodeId,
        skill,
        code,
        message,
        timestamp: Date.now(),
    };
    ctx.errors.push(error);
}

/**
 * Record timing for a node execution.
 */
export function recordTiming(
    ctx: ExecutionContext,
    nodeId: string,
    durationMs: number
): void {
    ctx.timing[nodeId] = durationMs;
}
