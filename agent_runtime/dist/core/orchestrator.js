"use strict";
/**
 * Orchestrator — the central execution engine for the Taste Aligner pipeline.
 *
 * The orchestrator is GENERIC — it does not reference any specific
 * node IDs, skill names, or output shapes. All domain knowledge lives
 * in the skills and the graph definition.
 *
 * Termination contract:
 *   - A skill may return { terminal: true } to stop the pipeline early.
 *   - The orchestrator treats the last executed node's output as the
 *     final result regardless of how many nodes remain.
 *   - The graph's outputMapping (if present) controls how the final
 *     node's output is projected into OrchestratorOutput.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Orchestrator = void 0;
const execution_context_1 = require("./execution_context");
const trace_manager_1 = require("./trace_manager");
const graph_definition_1 = require("./graph_definition");
function isTraceBundleCandidate(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
class Orchestrator {
    constructor(registry, graph) {
        this.registry = registry;
        this.graph = graph;
        // Validate graph at construction time — fail fast if misconfigured
        const graphErrors = (0, graph_definition_1.validateGraph)(this.graph);
        if (graphErrors.length > 0) {
            throw new Error(`[Orchestrator] Invalid graph "${this.graph.name}":\n` +
                graphErrors.map((e) => `  - ${e}`).join("\n"));
        }
        // Validate that all skills referenced by the graph are registered
        for (const node of this.graph.nodes) {
            if (!this.registry.has(node.skill)) {
                throw new Error(`[Orchestrator] Graph node "${node.id}" references ` +
                    `skill "${node.skill}" which is not registered. ` +
                    `Registered: [${this.registry.list().join(", ")}]`);
            }
        }
    }
    /**
     * Execute the full pipeline for a user request.
     */
    async run(input) {
        const { output } = await this.executeInternal(input);
        return output;
    }
    /**
     * Execute pipeline and always return the FULL aggregated decision_trace
     * from ExecutionContext (including merged service bundles).
     */
    async runWithTrace(input) {
        const { output, ctx } = await this.executeInternal(input);
        return {
            ...output,
            decision_trace: ctx.decision_trace,
        };
    }
    async executeInternal(input) {
        const ctx = (0, execution_context_1.createExecutionContext)(input);
        const pipelineStart = Date.now();
        let lastExecutedNodeId = null;
        console.log(`[Orchestrator] Starting pipeline "${this.graph.name}" v${this.graph.version} ` +
            `with ${this.graph.nodes.length} nodes`);
        for (const node of this.graph.nodes) {
            const nodeStart = Date.now();
            console.log(`[Orchestrator] Executing node: ${node.id} (skill: ${node.skill})`);
            try {
                // 1. Resolve input from context
                const resolvedInput = (0, execution_context_1.resolveNodeInput)(ctx, node.inputFrom);
                // 2. Execute skill
                const skill = this.registry.get(node.skill);
                const result = await skill.execute(resolvedInput, ctx);
                // 3. Store output
                (0, execution_context_1.storeResult)(ctx, node.id, result.output);
                lastExecutedNodeId = node.id;
                // 4. Merge decision trace
                if (result.trace && Object.keys(result.trace).length > 0) {
                    (0, trace_manager_1.mergeTrace)(ctx, node.skill, result.trace);
                }
                this.mergeResultTraceBundles(ctx, result);
                // 5. Record timing
                const durationMs = Date.now() - nodeStart;
                (0, execution_context_1.recordTiming)(ctx, node.id, durationMs);
                console.log(`[Orchestrator] Node "${node.id}" completed in ${durationMs}ms`);
                // 6. Check terminal signal from skill
                if (result.terminal) {
                    console.log(`[Orchestrator] Skill "${node.skill}" signaled terminal` +
                        (result.terminalReason ? `: ${result.terminalReason}` : ""));
                    (0, execution_context_1.recordTiming)(ctx, "_total", Date.now() - pipelineStart);
                    return {
                        output: this.buildOutput(ctx, lastExecutedNodeId, false, result.terminalReason),
                        ctx,
                    };
                }
            }
            catch (err) {
                const durationMs = Date.now() - nodeStart;
                (0, execution_context_1.recordTiming)(ctx, node.id, durationMs);
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[Orchestrator] Node "${node.id}" FAILED: ${message}`);
                (0, execution_context_1.addError)(ctx, node.id, node.skill, "skill_execution_error", message);
                // Fail-fast: all nodes in the linear pipeline are critical
                (0, execution_context_1.recordTiming)(ctx, "_total", Date.now() - pipelineStart);
                return {
                    output: this.buildOutput(ctx, lastExecutedNodeId, false),
                    ctx,
                };
            }
        }
        // Pipeline complete — build final output from last node
        (0, execution_context_1.recordTiming)(ctx, "_total", Date.now() - pipelineStart);
        return {
            output: this.buildOutput(ctx, lastExecutedNodeId, true),
            ctx,
        };
    }
    /**
     * Build OrchestratorOutput from the execution context.
     *
     * This method is generic — it does NOT reference any specific
     * node IDs. It uses the graph's outputMapping (if present) or
     * falls back to extracting common fields from the last node's output.
     */
    buildOutput(ctx, lastNodeId, pipelineComplete, terminalReason) {
        // Extract structured fields from ALL intermediate results.
        // Walk every node output to find city, type, cards, mix_policy,
        // explanation, and bullets — first occurrence wins for each.
        // This keeps the orchestrator generic: it does not know which
        // node produces which field.
        let city = null;
        let type = "unknown";
        let cards = null;
        let mix_policy = null;
        let explanation;
        let bullets;
        for (const nodeOutput of Object.values(ctx.intermediate_results)) {
            const obj = nodeOutput;
            if (!obj)
                continue;
            if (typeof obj.city === "string" && city === null) {
                city = obj.city;
            }
            if (typeof obj.type === "string" && type === "unknown") {
                type = obj.type;
            }
            if (obj.cards != null && cards === null) {
                cards = obj.cards;
            }
            if (obj.mix_policy != null && mix_policy === null) {
                mix_policy = obj.mix_policy;
            }
            if (typeof obj.explanation === "string" && explanation === undefined) {
                explanation = obj.explanation;
            }
            if (Array.isArray(obj.bullets) && bullets === undefined) {
                bullets = obj.bullets;
            }
        }
        // If pipeline didn't complete and there were errors, ok = false
        const ok = pipelineComplete && ctx.errors.length === 0;
        // If terminal reason, add it to errors for visibility
        if (terminalReason && !pipelineComplete) {
            (0, execution_context_1.addError)(ctx, lastNodeId ?? "unknown", "orchestrator", "pipeline_terminated", terminalReason);
        }
        const output = {
            ok,
            city,
            type,
            cards,
            mix_policy,
            decision_trace: ctx.decision_trace,
            errors: ctx.errors,
            timing: ctx.timing,
        };
        if (explanation !== undefined) {
            output.explanation = explanation;
        }
        if (bullets !== undefined) {
            output.bullets = bullets;
        }
        return output;
    }
    /**
     * Merge any trace bundle emitted in skill output.
     *
     * Supported bundle keys:
     * - output.decision_trace
     * - output.decision_trace_bundle
     * - output.trace_bundle
     *
     * Also supports legacy top-level keys returned directly on SkillResult
     * (outside `output`) for backward compatibility.
     */
    mergeResultTraceBundles(ctx, result) {
        if (!isTraceBundleCandidate(result)) {
            return;
        }
        const resultObj = result;
        const outputObj = isTraceBundleCandidate(resultObj.output)
            ? resultObj.output
            : null;
        const bundles = [
            outputObj?.decision_trace,
            outputObj?.decision_trace_bundle,
            outputObj?.trace_bundle,
            resultObj.decision_trace,
            resultObj.decision_trace_bundle,
            resultObj.trace_bundle,
        ];
        for (const candidate of bundles) {
            if (!isTraceBundleCandidate(candidate)) {
                continue;
            }
            (0, trace_manager_1.mergeTraceBundle)(ctx, candidate);
        }
    }
}
exports.Orchestrator = Orchestrator;
//# sourceMappingURL=orchestrator.js.map