#!/usr/bin/env node
/**
 * Smoke tests for the core orchestration layer.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/run.js
 *
 * These tests validate:
 *   1. deepMergeTrace — object conflicts, array dedup, nested merge
 *   2. SkillRegistry — duplicate rejection
 *   3. Graph validation — missing skill, missing dependency
 *   4. Orchestrator — terminal signal, node-id independence
 */

const assert = require("assert");
const path = require("path");
const { loadCore } = require("./_load_src_runtime");

let deepMergeTrace, SkillRegistry, validateGraph, Orchestrator,
    createExecutionContext, mergeTrace, mergeTraceBundle;
const core = loadCore();
deepMergeTrace = core.deepMergeTrace;
SkillRegistry = core.SkillRegistry;
validateGraph = core.validateGraph;
Orchestrator = core.Orchestrator;
createExecutionContext = core.createExecutionContext;
mergeTrace = core.mergeTrace;
mergeTraceBundle = core.mergeTraceBundle;

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

async function runAll() {
    // =========================================================================
    // 1. deepMergeTrace tests
    // =========================================================================
    console.log("\n--- deepMergeTrace ---");

    await test("object + object: incoming wins on leaf conflict", () => {
        const base = { rule_id: "v1", confidence: 0.8, city: "tokyo" };
        const incoming = { rule_id: "v2", confidence: 0.9 };
        const result = deepMergeTrace(base, incoming);

        assert.strictEqual(result.rule_id, "v2", "incoming should win on conflict");
        assert.strictEqual(result.confidence, 0.9, "incoming should win on conflict");
        assert.strictEqual(result.city, "tokyo", "base-only keys preserved");
    });

    await test("object + object: nested recursive merge", () => {
        const base = {
            weights: { alpha: 1.0, beta: 0.6 },
            filters: { cross_city: true },
        };
        const incoming = {
            weights: { beta: 0.8, gamma: 0.3 },
        };
        const result = deepMergeTrace(base, incoming);

        assert.strictEqual(result.weights.alpha, 1.0, "nested base key preserved");
        assert.strictEqual(result.weights.beta, 0.8, "nested incoming wins");
        assert.strictEqual(result.weights.gamma, 0.3, "nested new key added");
        assert.strictEqual(result.filters.cross_city, true, "unrelated nested preserved");
    });

    await test("arrays: concatenate with string dedup", () => {
        const base = { rules_used: ["cz_city_match", "ez_city_excellence"] };
        const incoming = { rules_used: ["ez_city_excellence", "ez_fallback"] };
        const result = deepMergeTrace(base, incoming);

        assert.deepStrictEqual(
            result.rules_used,
            ["cz_city_match", "ez_city_excellence", "ez_fallback"],
            "arrays concat + dedup"
        );
    });

    await test("arrays: id-based dedup for objects", () => {
        const base = {
            items: [
                { id: "a", score: 1.0 },
                { id: "b", score: 0.8 },
            ],
        };
        const incoming = {
            items: [
                { id: "b", score: 0.9 },
                { id: "c", score: 0.7 },
            ],
        };
        const result = deepMergeTrace(base, incoming);

        assert.strictEqual(result.items.length, 3, "3 items after id-dedup");
        const ids = result.items.map((i) => i.id);
        assert.deepStrictEqual(ids, ["a", "b", "c"], "correct ids");
        // id="b" should be the incoming version (last-write-wins)
        const bItem = result.items.find((i) => i.id === "b");
        assert.strictEqual(bItem.score, 0.9, "incoming version wins for dup id");
    });

    await test("incoming wins on type mismatch", () => {
        const base = { count: 5 };
        const incoming = { count: { cz: 3, ez: 2 } };
        const result = deepMergeTrace(base, incoming);

        assert.deepStrictEqual(result.count, { cz: 3, ez: 2 }, "incoming wins type mismatch");
    });

    await test("does not mutate inputs", () => {
        const base = { a: { b: 1 } };
        const incoming = { a: { c: 2 } };
        const baseCopy = JSON.parse(JSON.stringify(base));
        const incomingCopy = JSON.parse(JSON.stringify(incoming));
        deepMergeTrace(base, incoming);

        assert.deepStrictEqual(base, baseCopy, "base not mutated");
        assert.deepStrictEqual(incoming, incomingCopy, "incoming not mutated");
    });

    // =========================================================================
    // 2. mergeTrace / mergeTraceBundle with deep merge
    // =========================================================================
    console.log("\n--- mergeTrace context integration ---");

    await test("mergeTrace deep-merges into existing skill trace", () => {
        const ctx = createExecutionContext({ text: "test" });
        mergeTrace(ctx, "rerank", { rule_id: "v1", weights: { alpha: 1.0 } });
        mergeTrace(ctx, "rerank", { weights: { beta: 0.6 }, fallback_used: true });

        assert.strictEqual(ctx.decision_trace.rerank.rule_id, "v1", "first merge preserved");
        assert.strictEqual(ctx.decision_trace.rerank.weights.alpha, 1.0, "nested preserved");
        assert.strictEqual(ctx.decision_trace.rerank.weights.beta, 0.6, "nested added");
        assert.strictEqual(ctx.decision_trace.rerank.fallback_used, true, "new key added");
    });

    await test("mergeTraceBundle deep-merges per key", () => {
        const ctx = createExecutionContext({ text: "test" });
        mergeTrace(ctx, "recall", { rule_id: "recall_v1", counts: { cz: 5 } });

        mergeTraceBundle(ctx, {
            recall: { counts: { ez: 3 }, source: "downstream" },
            planner: { rule_id: "planner_v1" },
        });

        assert.strictEqual(ctx.decision_trace.recall.rule_id, "recall_v1", "recall base preserved");
        assert.strictEqual(ctx.decision_trace.recall.counts.cz, 5, "nested base preserved");
        assert.strictEqual(ctx.decision_trace.recall.counts.ez, 3, "nested incoming added");
        assert.strictEqual(ctx.decision_trace.recall.source, "downstream", "incoming key added");
        assert.strictEqual(ctx.decision_trace.planner.rule_id, "planner_v1", "new bundle key added");
    });

    // =========================================================================
    // 3. SkillRegistry tests
    // =========================================================================
    console.log("\n--- SkillRegistry ---");

    await test("rejects duplicate registration", () => {
        const reg = new SkillRegistry();
        const skill = {
            name: "test_skill",
            inputSchema: { description: "test", required: [] },
            outputSchema: { description: "test", required: [] },
            execute: async () => ({ output: {}, trace: {} }),
        };
        reg.register(skill);

        assert.throws(
            () => reg.register(skill),
            /already registered/,
            "should throw on duplicate"
        );
    });

    await test("get throws on missing skill", () => {
        const reg = new SkillRegistry();
        assert.throws(
            () => reg.get("nonexistent"),
            /not found/,
            "should throw on missing"
        );
    });

    await test("list returns registered names", () => {
        const reg = new SkillRegistry();
        const makeSkill = (name) => ({
            name,
            inputSchema: { description: "test", required: [] },
            outputSchema: { description: "test", required: [] },
            execute: async () => ({ output: {}, trace: {} }),
        });
        reg.register(makeSkill("a"));
        reg.register(makeSkill("b"));

        assert.deepStrictEqual(reg.list(), ["a", "b"]);
        assert.strictEqual(reg.size, 2);
    });

    // =========================================================================
    // 4. Graph validation tests
    // =========================================================================
    console.log("\n--- Graph validation ---");

    await test("valid graph returns no errors", () => {
        const errors = validateGraph({
            name: "test",
            version: "1.0",
            nodes: [
                { id: "a", skill: "s1", inputFrom: { text: "input.text" } },
                { id: "b", skill: "s2", inputFrom: { data: "a.output" } },
            ],
        });
        assert.strictEqual(errors.length, 0, "no errors for valid graph");
    });

    await test("detects forward reference", () => {
        const errors = validateGraph({
            name: "test",
            version: "1.0",
            nodes: [
                { id: "a", skill: "s1", inputFrom: { data: "b.output" } },
                { id: "b", skill: "s2", inputFrom: { text: "input.text" } },
            ],
        });
        assert.strictEqual(errors.length, 1, "one error for forward ref");
        assert.ok(errors[0].includes('"b"'), "error mentions the undefined node");
    });

    await test("detects duplicate node ID", () => {
        const errors = validateGraph({
            name: "test",
            version: "1.0",
            nodes: [
                { id: "a", skill: "s1", inputFrom: { text: "input.text" } },
                { id: "a", skill: "s2", inputFrom: { text: "input.text" } },
            ],
        });
        assert.strictEqual(errors.length, 1, "one error for dup ID");
        assert.ok(errors[0].includes("Duplicate"), "error mentions duplicate");
    });

    // =========================================================================
    // 5. Orchestrator — terminal signal and node-id independence
    // =========================================================================
    console.log("\n--- Orchestrator terminal + node-id independence ---");

    await test("orchestrator stops on terminal signal from skill", async () => {
        const reg = new SkillRegistry();
        reg.register({
            name: "step1",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: { city: null, type: "unknown" },
                trace: { rule_id: "test" },
                terminal: true,
                terminalReason: "no_data",
            }),
        });
        reg.register({
            name: "step2",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => {
                throw new Error("step2 should not execute");
            },
        });

        const graph = {
            name: "test_terminal",
            version: "1.0",
            nodes: [
                { id: "first", skill: "step1", inputFrom: { text: "input.text" } },
                { id: "second", skill: "step2", inputFrom: { data: "first.output" } },
            ],
        };

        const orch = new Orchestrator(reg, graph);
        const result = await orch.run({ text: "test" });

        assert.strictEqual(result.ok, false, "pipeline incomplete = not ok");
        assert.ok(result.timing.first !== undefined, "first node has timing");
        assert.strictEqual(result.timing.second, undefined, "second node was not executed");
        assert.ok(
            result.errors.some((e) => e.code === "pipeline_terminated"),
            "terminal reason recorded"
        );
    });

    await test("renaming node IDs does not break orchestrator", async () => {
        const reg = new SkillRegistry();
        let executionOrder = [];

        const makeSkill = (name) => ({
            name,
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async (input) => {
                executionOrder.push(name);
                return {
                    output: { city: "london", type: "food", val: name, cards: [name], mix_policy: {} },
                    trace: { skill: name },
                };
            },
        });

        reg.register(makeSkill("s1"));
        reg.register(makeSkill("s2"));

        // Run with node ids "alpha", "beta"
        const graph1 = {
            name: "test",
            version: "1.0",
            nodes: [
                { id: "alpha", skill: "s1", inputFrom: { text: "input.text" } },
                { id: "beta", skill: "s2", inputFrom: { data: "alpha.val" } },
            ],
        };
        executionOrder = [];
        const orch1 = new Orchestrator(reg, graph1);
        const r1 = await orch1.run({ text: "test" });

        // Run with node ids "node_x", "node_y" (renamed)
        const graph2 = {
            name: "test",
            version: "1.0",
            nodes: [
                { id: "node_x", skill: "s1", inputFrom: { text: "input.text" } },
                { id: "node_y", skill: "s2", inputFrom: { data: "node_x.val" } },
            ],
        };
        executionOrder = [];
        const orch2 = new Orchestrator(reg, graph2);
        const r2 = await orch2.run({ text: "test" });

        assert.strictEqual(r1.ok, true, "graph1 ok");
        assert.strictEqual(r2.ok, true, "graph2 ok");
        assert.deepStrictEqual(r1.cards, r2.cards, "same output regardless of node IDs");
        assert.deepStrictEqual(
            Object.keys(r1.decision_trace),
            Object.keys(r2.decision_trace),
            "same trace keys regardless of node IDs"
        );
    });

    // =========================================================================
    // 6. Satellite test suites (decide_tag_budget, explain_from_trace)
    // =========================================================================
    console.log("\n--- Satellite test suites ---");

    const { execSync } = require("child_process");
    const satelliteFiles = [
        path.join(__dirname, "test_orchestrator_trace_aggregation.js"),
        path.join(__dirname, "test_final_trace_completeness.js"),
        path.join(__dirname, "test_decide_tag_budget.js"),
        path.join(__dirname, "test_memory_signal.js"),
        path.join(__dirname, "test_memory_weight_adjust.js"),
        path.join(__dirname, "test_build_profile_vector.js"),
        path.join(__dirname, "test_tes_builder.js"),
        path.join(__dirname, "test_vision_describe.js"),
        path.join(__dirname, "test_fetch_recommendation.js"),
        path.join(__dirname, "test_rerank_tes.js"),
        path.join(__dirname, "test_tag_expand.js"),
        path.join(__dirname, "test_tag_normalize.js"),
        path.join(__dirname, "test_extract_intent.js"),
        path.join(__dirname, "test_explain_from_trace.js"),
        path.join(__dirname, "test_llm_adapter_fallback.js"),
        path.join(__dirname, "test_memory_write_integration.js"),
    ];

    for (const filePath of satelliteFiles) {
        const fileName = path.basename(filePath);
        try {
            execSync(`node "${filePath}"`, { stdio: "inherit" });
        } catch (_e) {
            console.error(`  SATELLITE FAIL: ${fileName}`);
            failed++;
        }
    }

    // =========================================================================
    // Summary
    // =========================================================================
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Core results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL SMOKE TESTS (core + satellites): PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
