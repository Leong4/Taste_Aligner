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
import { ExecutionContext, OrchestratorInput } from "./types";
/**
 * Create a fresh ExecutionContext for a new orchestrator run.
 */
export declare function createExecutionContext(input: OrchestratorInput): ExecutionContext;
/**
 * Store a skill's output in the context under the given node ID.
 */
export declare function storeResult(ctx: ExecutionContext, nodeId: string, output: unknown): void;
/**
 * Retrieve a previously stored result by node ID.
 * Returns undefined if the node hasn't executed yet.
 */
export declare function getResult(ctx: ExecutionContext, nodeId: string): unknown;
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
export declare function resolveContextPath(ctx: ExecutionContext, path: string): unknown;
/**
 * Build the resolved input object for a skill node by mapping each
 * declared `inputFrom` entry to its value in the context.
 */
export declare function resolveNodeInput(ctx: ExecutionContext, inputFrom: Record<string, string>): Record<string, unknown>;
/**
 * Record an execution error without halting the pipeline.
 */
export declare function addError(ctx: ExecutionContext, nodeId: string, skill: string, code: string, message: string): void;
/**
 * Record timing for a node execution.
 */
export declare function recordTiming(ctx: ExecutionContext, nodeId: string, durationMs: number): void;
//# sourceMappingURL=execution_context.d.ts.map