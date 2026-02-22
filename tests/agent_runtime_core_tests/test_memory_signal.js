#!/usr/bin/env node
/**
 * Smoke tests for memory_signal deterministic skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_memory_signal.js
 */

const assert = require("assert");
const path = require("path");

let core, skills;
try {
    require("ts-node").register({
        project: path.join(__dirname, "../../agent_runtime/tsconfig.json"),
        transpileOnly: true,
    });
    core = require("../../agent_runtime/src/core");
    skills = require("../../agent_runtime/src/skills");
} catch (e) {
    try {
        core = require("../../agent_runtime/dist/core");
        skills = require("../../agent_runtime/dist/skills");
    } catch (e2) {
        console.error("Cannot load modules. Run 'npm run build' in agent_runtime/ first.");
        console.error(e2.message);
        process.exit(1);
    }
}

const { createExecutionContext } = core;
const { createMemorySignalSkill } = skills;

class StubToolClient {
    constructor(handler) {
        this.handler = handler;
    }

    async call(action) {
        return this.handler(action);
    }
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS: ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL: ${name}`);
        console.error(`        ${e.message}`);
        failed++;
    }
}

function makeInput(overrides = {}) {
    return {
        user_id: "u123",
        city: "Tokyo",
        tags: ["Sushi", "food", "sushi"],
        intent_tags: ["fallback_tag"],
        top_k: 10,
        now_ts: 1704067200000,
        mode: "auto",
        ...overrides,
    };
}

function makeContext() {
    return createExecutionContext({ text: "test", request_ts: 1704067200000 });
}

async function runAll() {
    console.log("\n--- memory_signal ---");

    await test("happy path: sorted anchors + confidence formula + trace contract", async () => {
        const client = new StubToolClient(async (action) => {
            assert.strictEqual(action.tool, "memory.search");
            assert.strictEqual(action.input.data.user_id, "u123");
            assert.strictEqual(action.input.data.city, "tokyo");
            assert.deepStrictEqual(action.input.data.query_tags, ["food", "sushi"]);
            assert.strictEqual(action.input.data.top_k, 10);
            assert.strictEqual(action.input.data.now_ts, "2024-01-01T00:00:00.000Z");

            return {
                ok: true,
                tool: "memory.search",
                trace_id: "t_memory_happy",
                latency_ms: 13,
                output: {
                    method: "embedding",
                    stats: { total_loaded: 12, total_scored: 6 },
                    weights: { lambda_time: 0.03, alpha_sent: 0.5 },
                    results: [
                        { memory_id: "m_b", score: 0.8, normalized_tags: ["sushi", "ramen"] },
                        { memory_id: "m_a", score: 0.8, normalized_tags: ["izakaya"] },
                        { memory_id: "m_c", score: 0.9, normalized_tags: ["quiet"] },
                    ],
                },
            };
        });

        const skill = createMemorySignalSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        assert.deepStrictEqual(result.output.anchor_memory_ids, ["m_c", "m_a", "m_b"]);
        assert.deepStrictEqual(result.output.anchor_tags, ["izakaya", "quiet", "ramen", "sushi"]);
        assert.strictEqual(result.output.memory_confidence, 0.883333);
        assert.ok(Array.isArray(result.output.memory_results));
        assert.strictEqual(result.output.memory_results.length, 3);

        const trace = result.trace;
        assert.strictEqual(trace.rule_id, "memory_signal_v1");
        assert.strictEqual(trace.schema_version, "1.0");
        assert.strictEqual(trace.method, "embedding");
        assert.strictEqual(trace.fallback_used, false);
        assert.strictEqual(trace.fallback_reason, undefined);
        assert.strictEqual(trace.input_summary.user_id, "u123");
        assert.strictEqual(trace.input_summary.city, "tokyo");
        assert.strictEqual(trace.input_summary.tags_count, 2);
        assert.deepStrictEqual(trace.input_summary.tags_sample, ["food", "sushi"]);
        assert.strictEqual(trace.stats.total_loaded, 12);
        assert.strictEqual(trace.stats.total_scored, 6);
        assert.strictEqual(trace.stats.returned, 3);
        assert.strictEqual(trace.stats.top_n_used, 3);
        assert.strictEqual(trace.aggregation.confidence_formula, "clamp01(0.7*top_score_avg + 0.3*coverage)");
        assert.strictEqual(trace.aggregation.confidence_components.top_score_avg, 0.833333);
        assert.strictEqual(trace.aggregation.confidence_components.coverage, 1);
        assert.strictEqual(trace.weights.lambda_time, 0.03);
        assert.strictEqual(trace.weights.alpha_sent, 0.5);
        assert.strictEqual(trace.latency_ms, 13);
    });

    await test("no_tags fallback: returns stable empty output without tool call", async () => {
        let callCount = 0;
        const client = new StubToolClient(async () => {
            callCount++;
            throw new Error("should not call");
        });
        const skill = createMemorySignalSkill(client);
        const result = await skill.execute(
            makeInput({ tags: [], intent_tags: [] }),
            makeContext()
        );

        assert.strictEqual(callCount, 0, "toolClient should not be called when tags are empty");
        assert.deepStrictEqual(result.output.anchor_memory_ids, []);
        assert.deepStrictEqual(result.output.anchor_tags, []);
        assert.strictEqual(result.output.memory_confidence, 0);
        assert.strictEqual(result.trace.method, "none");
        assert.strictEqual(result.trace.fallback_used, true);
        assert.strictEqual(result.trace.fallback_reason, "no_tags");
        assert.ok(result.output.decision_trace.memory_signal);
        assert.strictEqual(result.trace.rule_id, "memory_signal_v1");
        assert.strictEqual(result.trace.schema_version, "1.0");
    });

    await test("tool_error fallback: trace contains reason + error_message", async () => {
        const client = new StubToolClient(async () => {
            throw new Error("memory service timeout");
        });
        const skill = createMemorySignalSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        assert.deepStrictEqual(result.output.anchor_memory_ids, []);
        assert.deepStrictEqual(result.output.anchor_tags, []);
        assert.strictEqual(result.output.memory_confidence, 0);
        assert.strictEqual(result.trace.fallback_used, true);
        assert.strictEqual(result.trace.fallback_reason, "tool_error");
        assert.ok(typeof result.trace.error_message === "string");
        assert.ok(result.trace.error_message.includes("timeout"));
        assert.ok(result.output.decision_trace.memory_signal);
    });

    await test("invalid_output fallback: missing results array", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "memory.search",
            trace_id: "t_bad",
            latency_ms: 4,
            output: {},
        }));
        const skill = createMemorySignalSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        assert.deepStrictEqual(result.output.anchor_memory_ids, []);
        assert.deepStrictEqual(result.output.anchor_tags, []);
        assert.strictEqual(result.output.memory_confidence, 0);
        assert.strictEqual(result.trace.fallback_used, true);
        assert.strictEqual(result.trace.fallback_reason, "invalid_output");
        assert.ok(result.output.decision_trace.memory_signal);
    });

    await test("invalid_output fallback: item missing memory_id", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "memory.search",
            trace_id: "t_bad_item",
            latency_ms: 4,
            output: {
                results: [{ score: 0.8, normalized_tags: ["sushi"] }],
            },
        }));
        const skill = createMemorySignalSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        assert.deepStrictEqual(result.output.anchor_memory_ids, []);
        assert.deepStrictEqual(result.output.anchor_tags, []);
        assert.strictEqual(result.output.memory_confidence, 0);
        assert.strictEqual(result.trace.fallback_used, true);
        assert.strictEqual(result.trace.fallback_reason, "invalid_output");
        assert.ok(result.output.decision_trace.memory_signal);
    });

    await test("empty_results fallback: results array is empty", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "memory.search",
            trace_id: "t_empty",
            latency_ms: 6,
            output: {
                results: [],
            },
        }));
        const skill = createMemorySignalSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        assert.deepStrictEqual(result.output.anchor_memory_ids, []);
        assert.deepStrictEqual(result.output.anchor_tags, []);
        assert.strictEqual(result.output.memory_confidence, 0);
        assert.strictEqual(result.trace.fallback_used, true);
        assert.strictEqual(result.trace.fallback_reason, "empty_results");
        assert.ok(result.output.decision_trace.memory_signal);
    });

    await test("determinism: same input twice deepStrictEqual", async () => {
        const fixedObservation = {
            ok: true,
            tool: "memory.search",
            trace_id: "t_det",
            latency_ms: 9,
            output: {
                method: "tag_fallback",
                stats: { total_loaded: 3, total_scored: 3 },
                weights: { lambda_time: 0.03, alpha_sent: 0.5 },
                results: [
                    { memory_id: "m1", score: 0.9, normalized_tags: ["sushi"] },
                    { memory_id: "m2", score: 0.8, normalized_tags: ["ramen"] },
                ],
            },
        };

        const client = new StubToolClient(async () => fixedObservation);
        const skill = createMemorySignalSkill(client);
        const input = makeInput({
            city: "Kyoto",
            tags: ["ramen", "sushi"],
            now_ts: 1704067200000,
        });

        const result1 = await skill.execute(input, makeContext());
        const result2 = await skill.execute(input, makeContext());
        assert.deepStrictEqual(result1, result2);
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL MEMORY_SIGNAL TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
