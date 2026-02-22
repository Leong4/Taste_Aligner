#!/usr/bin/env node
/**
 * Smoke tests for tes_builder deterministic skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_tes_builder.js
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

const { createExecutionContext, SkillRegistry, Orchestrator } = core;
const { createTesBuilderSkill } = skills;

class StubToolClient {
    constructor(handler) {
        this.handler = handler;
    }
    async call(action) {
        return this.handler(action);
    }
}

function makeUnitVector512() {
    const out = Array.from({ length: 512 }, () => 0);
    out[0] = 1;
    return out;
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
        anchor_tags: ["izakaya", " ramen ", "izakaya", "quiet"],
        request_ts: 1704067200000,
        user_city: "tokyo",
        ...overrides,
    };
}

function makeContext() {
    return createExecutionContext({ text: "test", request_ts: 1704067200000 });
}

async function runAll() {
    console.log("\n--- tes_builder ---");

    await test("happy path: valid 512 vector + trace contract", async () => {
        const unit = makeUnitVector512();
        const client = new StubToolClient(async (action) => {
            assert.strictEqual(action.tool, "embedding.tes_build");
            assert.deepStrictEqual(action.input.data.normalized_tags, ["izakaya", "quiet", "ramen"]);
            return {
                ok: true,
                tool: "embedding.tes_build",
                trace_id: "t_ok",
                latency_ms: 10,
                output: {
                    vector: unit,
                    dim: 512,
                    normalized: true,
                    components: { vision_dim: 128, tag_dim: 256, scalar_dim: 128 },
                    meta: { backend: "hash_v2", tes_version: "2.0" },
                },
            };
        });

        const skill = createTesBuilderSkill(client);
        const result = await skill.execute(makeInput(), makeContext());

        assert.strictEqual(result.output.tes_vector.length, 512);
        assert.strictEqual(result.output.tes_dim, 512);
        assert.strictEqual(result.output.normalized, true);
        assert.strictEqual(result.output.backend, "hash_v2");
        assert.strictEqual(result.output.tes_version, "2.0");
        assert.deepStrictEqual(result.output.input_anchor_tags, ["izakaya", "quiet", "ramen"]);
        assert.deepStrictEqual(result.output.used_anchor_tags, ["izakaya", "quiet", "ramen"]);
        assert.strictEqual(result.output.fallback_used, false);

        assert.strictEqual(result.trace.rule_id, "tes_builder_v1");
        assert.strictEqual(result.trace.schema_version, "1.0");
        assert.strictEqual(result.trace.tool.name, "embedding.tes_build");
        assert.strictEqual(result.trace.vector_checks.dim_expected, 512);
        assert.strictEqual(result.trace.vector_checks.dim_actual, 512);
    });

    await test("anchor_tags normalization: trim + dedup + stable numeric/base sort", async () => {
        const client = new StubToolClient(async (action) => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_sort",
            latency_ms: 5,
            output: {
                vector: makeUnitVector512(),
                dim: 512,
                normalized: true,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        }));
        const skill = createTesBuilderSkill(client);
        const result = await skill.execute(
            makeInput({ anchor_tags: ["t10", "t2", "T2", "  t2 "] }),
            makeContext()
        );
        assert.deepStrictEqual(result.output.input_anchor_tags, ["t2", "t10"]);
        assert.deepStrictEqual(result.output.used_anchor_tags, ["t2", "t10"]);
    });

    await test("determinism: same input twice deepStrictEqual", async () => {
        const fixed = {
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_det",
            latency_ms: 9,
            output: {
                vector: makeUnitVector512(),
                dim: 512,
                normalized: true,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        };
        const client = new StubToolClient(async () => fixed);
        const skill = createTesBuilderSkill(client);
        const input = makeInput();
        const result1 = await skill.execute(input, makeContext());
        const result2 = await skill.execute(input, makeContext());
        assert.deepStrictEqual(result1, result2);
    });

    await test("no_tags fallback", async () => {
        let called = false;
        const client = new StubToolClient(async () => {
            called = true;
            return {};
        });
        const skill = createTesBuilderSkill(client);
        const result = await skill.execute(makeInput({ anchor_tags: [] }), makeContext());
        assert.strictEqual(called, false);
        assert.strictEqual(result.output.tes_vector.length, 512);
        assert.strictEqual(result.output.normalized, false);
        assert.strictEqual(result.output.fallback_used, true);
        assert.strictEqual(result.output.fallback_reason, "no_tags");
    });

    await test("tool_error fallback", async () => {
        const client = new StubToolClient(async () => {
            throw new Error("timeout");
        });
        const skill = createTesBuilderSkill(client);
        const result = await skill.execute(makeInput(), makeContext());
        assert.strictEqual(result.output.fallback_used, true);
        assert.strictEqual(result.output.fallback_reason, "tool_error");
        assert.ok(result.trace.error_message.includes("timeout"));
    });

    await test("invalid_output fallback", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_bad",
            latency_ms: 3,
            output: {},
        }));
        const skill = createTesBuilderSkill(client);
        const result = await skill.execute(makeInput(), makeContext());
        assert.strictEqual(result.output.fallback_used, true);
        assert.strictEqual(result.output.fallback_reason, "invalid_output");
        assert.strictEqual(result.output.tes_vector.length, 512);
    });

    await test("invalid_vector fallback: length mismatch", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_bad_len",
            latency_ms: 3,
            output: {
                vector: [1, 2, 3],
                dim: 3,
                normalized: true,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        }));
        const skill = createTesBuilderSkill(client);
        const result = await skill.execute(makeInput(), makeContext());
        assert.strictEqual(result.output.fallback_used, true);
        assert.strictEqual(result.output.fallback_reason, "invalid_vector");
    });

    await test("invalid_vector fallback: NaN/Inf/normalized false/norm mismatch", async () => {
        const nanVec = makeUnitVector512();
        nanVec[2] = Number.NaN;
        const client1 = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_bad_nan",
            latency_ms: 3,
            output: {
                vector: nanVec,
                dim: 512,
                normalized: true,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        }));
        const skill1 = createTesBuilderSkill(client1);
        const r1 = await skill1.execute(makeInput(), makeContext());
        assert.strictEqual(r1.output.fallback_reason, "invalid_vector");

        const normBad = Array.from({ length: 512 }, () => 0);
        normBad[0] = 0.5; // norm 0.5
        const client2 = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_bad_norm",
            latency_ms: 3,
            output: {
                vector: normBad,
                dim: 512,
                normalized: true,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        }));
        const skill2 = createTesBuilderSkill(client2);
        const r2 = await skill2.execute(makeInput(), makeContext());
        assert.strictEqual(r2.output.fallback_reason, "invalid_vector");

        const client3 = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_bad_flag",
            latency_ms: 3,
            output: {
                vector: makeUnitVector512(),
                dim: 512,
                normalized: false,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        }));
        const skill3 = createTesBuilderSkill(client3);
        const r3 = await skill3.execute(makeInput(), makeContext());
        assert.strictEqual(r3.output.fallback_reason, "invalid_vector");
    });

    await test("orchestrator integration: decision_trace contains tes_builder", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_merge",
            latency_ms: 5,
            output: {
                vector: makeUnitVector512(),
                dim: 512,
                normalized: true,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        }));
        const tesSkill = createTesBuilderSkill(client);

        const registry = new SkillRegistry();
        registry.register({
            name: "memory_signal_stub",
            inputSchema: { description: "stub", required: [] },
            outputSchema: { description: "stub", required: ["anchor_tags"] },
            execute: async () => ({
                output: { anchor_tags: ["ramen", "quiet"] },
                trace: { rule_id: "memory_signal_v1" },
            }),
        });
        registry.register(tesSkill);

        const graph = {
            name: "test_tes_builder_graph",
            version: "1.0",
            nodes: [
                { id: "memory_signal", skill: "memory_signal_stub", inputFrom: {} },
                {
                    id: "tes_builder",
                    skill: "tes_builder",
                    inputFrom: {
                        anchor_tags: "memory_signal.anchor_tags",
                        request_ts: "input.request_ts",
                    },
                },
            ],
        };
        const orchestrator = new Orchestrator(registry, graph);
        const runResult = await orchestrator.run({ text: "test", request_ts: 1704067200000 });
        assert.strictEqual(runResult.ok, true);
        assert.ok(runResult.decision_trace.tes_builder);
        assert.strictEqual(runResult.decision_trace.tes_builder.rule_id, "tes_builder_v1");
    });

    await test("decision_trace deep-merge: preserve upstream trace + add tes_builder", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_trace_merge",
            latency_ms: 5,
            output: {
                vector: makeUnitVector512(),
                dim: 512,
                normalized: true,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        }));
        const skill = createTesBuilderSkill(client);
        const result = await skill.execute(
            makeInput({
                decision_trace: {
                    memory_signal: { rule_id: "memory_signal_v1", marker: "keep" },
                },
            }),
            makeContext()
        );
        assert.ok(result.output.decision_trace.memory_signal);
        assert.strictEqual(result.output.decision_trace.memory_signal.marker, "keep");
        assert.ok(result.output.decision_trace.tes_builder);
        assert.strictEqual(result.output.decision_trace.tes_builder.rule_id, "tes_builder_v1");
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL TES_BUILDER TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
