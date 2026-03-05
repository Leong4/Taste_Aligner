#!/usr/bin/env node
/**
 * Smoke tests for memory_weight_adjust deterministic skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_memory_weight_adjust.js
 */

const assert = require("assert");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();

const { createExecutionContext } = core;
const { createMemoryWeightAdjustSkill } = skills;

// ---------------------------------------------------------------------------
// Stub ToolClient
// ---------------------------------------------------------------------------

class StubToolClient {
    constructor(handler) {
        this.handler = handler;
    }
    async call(action) {
        return this.handler(action);
    }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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
        ...overrides,
    };
}

function makeContext() {
    return createExecutionContext({ text: "test", request_ts: 1704067200000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runAll() {
    console.log("\n--- memory_weight_adjust ---");

    // =====================================================================
    // 1. Happy path with tie-breaker
    // =====================================================================
    await test("happy path: 3 results with equal scores -> tie-break by memory_id asc", async () => {
        const client = new StubToolClient(async (action) => {
            // Verify tool payload matches gateway contract
            assert.strictEqual(action.tool, "memory.search");
            assert.strictEqual(action.input.data.user_id, "u123");
            assert.deepStrictEqual(action.input.data.query_tags, ["food", "sushi"]);
            assert.strictEqual(action.input.data.city, "tokyo");
            assert.strictEqual(action.input.data.top_k, 10);
            assert.strictEqual(action.input.data.now_ts, "2024-01-01T00:00:00.000Z");

            return {
                ok: true,
                tool: "memory.search",
                trace_id: "t_happy",
                latency_ms: 15,
                output: {
                    results: [
                        { memory_id: "m_c", score: 0.8, normalized_tags: ["sushi", "ramen"] },
                        { memory_id: "m_a", score: 0.8, normalized_tags: ["izakaya"] },
                        { memory_id: "m_b", score: 0.9, normalized_tags: ["sushi", "quiet"] },
                    ],
                },
            };
        });

        const skill = createMemoryWeightAdjustSkill(client);
        const result = await skill.execute(makeInput(), makeContext());
        const out = result.output;

        // m_b (0.9) first, then m_a and m_c tied at 0.8 -> m_a before m_c (lex order)
        assert.deepStrictEqual(out.anchor_memory_ids, ["m_b", "m_a", "m_c"]);

        // Anchor tags: sushi appears 2x in top 3, others 1x each
        // Sorted by (-count, lex): sushi(2), izakaya(1), quiet(1), ramen(1)
        assert.deepStrictEqual(out.anchor_tags, ["sushi", "izakaya", "quiet", "ramen"]);

        // Confidence: top3 avg = (0.9+0.8+0.8)/3 = 0.833...
        // coverage = min(1, 4/2) = 1
        // confidence = clamp01(0.7*0.8333 + 0.3*1) = 0.883333
        assert.strictEqual(out.memory_confidence, 0.883333);

        assert.strictEqual(out.weighted_results.length, 3);
        assert.strictEqual(out.stats.input_tags_count, 2);
        assert.strictEqual(out.stats.results_count, 3);
        assert.strictEqual(out.stats.anchor_count, 3);
        assert.strictEqual(out.stats.anchor_tags_count, 4);

        // Trace contract
        const trace = result.output.decision_trace.memory_weight_adjust;
        assert.strictEqual(trace.rule_id, "memory_weight_adjust_v1");
        assert.strictEqual(trace.schema_version, "1.0");
        assert.strictEqual(trace.tool.name, "memory.search");
        assert.strictEqual(trace.input_summary.user_id_present, true);
        assert.strictEqual(trace.input_summary.city, "tokyo");
        assert.strictEqual(trace.input_summary.tags_count, 2);
        assert.strictEqual(trace.input_summary.top_k, 10);
        assert.strictEqual(trace.input_summary.now_ts_present, true);
        assert.strictEqual(trace.aggregation.anchor_top_n, 3);
        assert.strictEqual(trace.aggregation.confidence_formula, "clamp01(0.7*top_score_avg + 0.3*coverage)");
        assert.strictEqual(trace.fallback_used, false);
        assert.strictEqual(trace.latency_ms, 15);
    });

    // =====================================================================
    // 2. Determinism: same input twice -> deepStrictEqual
    // =====================================================================
    await test("determinism: same input twice -> identical output + trace", async () => {
        const fixedObs = {
            ok: true,
            tool: "memory.search",
            trace_id: "t_det",
            latency_ms: 9,
            output: {
                results: [
                    { memory_id: "m1", score: 0.9, normalized_tags: ["sushi"] },
                    { memory_id: "m2", score: 0.8, normalized_tags: ["ramen"] },
                ],
            },
        };

        const client = new StubToolClient(async () => fixedObs);
        const skill = createMemoryWeightAdjustSkill(client);
        const input = makeInput({ city: "Kyoto", tags: ["ramen", "sushi"], now_ts: 1704067200000 });

        const r1 = await skill.execute(input, makeContext());
        const r2 = await skill.execute(input, makeContext());
        assert.deepStrictEqual(r1, r2);
    });

    // =====================================================================
    // 3. no_tags fallback
    // =====================================================================
    await test("no_tags fallback: returns stable empty output without tool call", async () => {
        let callCount = 0;
        const client = new StubToolClient(async () => {
            callCount++;
            throw new Error("should not call");
        });
        const skill = createMemoryWeightAdjustSkill(client);
        const result = await skill.execute(
            makeInput({ tags: [], intent_tags: [] }),
            makeContext(),
        );

        assert.strictEqual(callCount, 0, "tool should not be called");
        assert.deepStrictEqual(result.output.weighted_results, []);
        assert.deepStrictEqual(result.output.anchor_memory_ids, []);
        assert.deepStrictEqual(result.output.anchor_tags, []);
        assert.strictEqual(result.output.memory_confidence, 0);
        assert.strictEqual(result.output.stats.input_tags_count, 0);
        assert.strictEqual(result.output.stats.results_count, 0);

        const trace = result.output.decision_trace.memory_weight_adjust;
        assert.strictEqual(trace.fallback_used, true);
        assert.strictEqual(trace.fallback_reason, "no_tags");
        assert.strictEqual(trace.rule_id, "memory_weight_adjust_v1");
    });

    // =====================================================================
    // 4. tool_error fallback (mock throws)
    // =====================================================================
    await test("tool_error fallback: trace contains reason + error_message", async () => {
        const client = new StubToolClient(async () => {
            throw new Error("memory service timeout");
        });
        const skill = createMemoryWeightAdjustSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        assert.deepStrictEqual(result.output.weighted_results, []);
        assert.strictEqual(result.output.memory_confidence, 0);

        const trace = result.output.decision_trace.memory_weight_adjust;
        assert.strictEqual(trace.fallback_used, true);
        assert.strictEqual(trace.fallback_reason, "tool_error");
        assert.ok(trace.error_message.includes("timeout"));
        assert.ok(typeof trace.latency_ms === "number");
    });

    // =====================================================================
    // 5. invalid_output fallback (results missing or not array)
    // =====================================================================
    await test("invalid_output fallback: results missing", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "memory.search",
            trace_id: "t_bad",
            latency_ms: 4,
            output: {},
        }));
        const skill = createMemoryWeightAdjustSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        const trace = result.output.decision_trace.memory_weight_adjust;
        assert.strictEqual(trace.fallback_used, true);
        assert.strictEqual(trace.fallback_reason, "invalid_output");
        assert.strictEqual(result.output.memory_confidence, 0);
    });

    await test("invalid_output fallback: results is a string", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "memory.search",
            trace_id: "t_bad2",
            latency_ms: 3,
            output: { results: "not_an_array" },
        }));
        const skill = createMemoryWeightAdjustSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        const trace = result.output.decision_trace.memory_weight_adjust;
        assert.strictEqual(trace.fallback_used, true);
        assert.strictEqual(trace.fallback_reason, "invalid_output");
    });

    // =====================================================================
    // 6. empty_results fallback
    // =====================================================================
    await test("empty_results fallback: results array is empty", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "memory.search",
            trace_id: "t_empty",
            latency_ms: 6,
            output: { results: [] },
        }));
        const skill = createMemoryWeightAdjustSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        const trace = result.output.decision_trace.memory_weight_adjust;
        assert.strictEqual(trace.fallback_used, true);
        assert.strictEqual(trace.fallback_reason, "empty_results");
        assert.strictEqual(result.output.memory_confidence, 0);
    });

    // =====================================================================
    // Summary
    // =====================================================================
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL MEMORY_WEIGHT_ADJUST TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
