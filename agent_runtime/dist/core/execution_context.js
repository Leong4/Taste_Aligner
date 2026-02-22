"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createExecutionContext = createExecutionContext;
exports.storeResult = storeResult;
exports.getResult = getResult;
exports.resolveContextPath = resolveContextPath;
exports.resolveNodeInput = resolveNodeInput;
exports.addError = addError;
exports.recordTiming = recordTiming;
/**
 * Create a fresh ExecutionContext for a new orchestrator run.
 */
function createExecutionContext(input) {
    const providedTs = typeof input.request_ts === "number" && Number.isFinite(input.request_ts)
        ? Math.trunc(input.request_ts)
        : undefined;
    return {
        input,
        request_ts: providedTs ?? Date.now(),
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
function storeResult(ctx, nodeId, output) {
    ctx.intermediate_results[nodeId] = output;
}
/**
 * Retrieve a previously stored result by node ID.
 * Returns undefined if the node hasn't executed yet.
 */
function getResult(ctx, nodeId) {
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
function resolveContextPath(ctx, path) {
    const parts = path.split(".");
    const root = parts[0];
    if (!root)
        return undefined;
    let current;
    if (root === "input") {
        current = ctx.input;
    }
    else {
        current = ctx.intermediate_results[root];
    }
    for (let i = 1; i < parts.length; i++) {
        if (current === null || current === undefined)
            return undefined;
        if (typeof current !== "object")
            return undefined;
        current = current[parts[i]];
    }
    return current;
}
/**
 * Build the resolved input object for a skill node by mapping each
 * declared `inputFrom` entry to its value in the context.
 */
function resolveNodeInput(ctx, inputFrom) {
    const resolved = {};
    for (const [key, path] of Object.entries(inputFrom)) {
        resolved[key] = resolveContextPath(ctx, path);
    }
    return resolved;
}
/**
 * Record an execution error without halting the pipeline.
 */
function addError(ctx, nodeId, skill, code, message) {
    const error = {
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
function recordTiming(ctx, nodeId, durationMs) {
    ctx.timing[nodeId] = durationMs;
}
//# sourceMappingURL=execution_context.js.map