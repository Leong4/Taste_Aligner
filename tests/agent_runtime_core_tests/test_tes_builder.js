#!/usr/bin/env node
/**
 * Smoke tests for tes_builder deterministic skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_tes_builder.js
 */

const assert = require("assert");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();

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
            // New root-level format: { tags, vision_features, normalize }
            assert.deepStrictEqual(action.input.tags, ["izakaya", "quiet", "ramen"]);
            assert.deepStrictEqual(action.input.vision_features, []);
            assert.strictEqual(action.input.normalize, true);
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
        // S2 gate: deterministic payload key evidence in trace
        assert.deepStrictEqual(result.trace.tes_build_payload_keys, ["normalize", "tags", "vision_features"]);
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
        const result = await skill.execute(makeInput({ anchor_tags: [], vision_features: [] }), makeContext());
        assert.strictEqual(called, false);
        assert.strictEqual(result.output.tes_vector.length, 512);
        assert.strictEqual(result.output.normalized, false);
        assert.strictEqual(result.output.fallback_used, true);
        assert.strictEqual(result.output.fallback_reason, "no_tags");
    });

    await test("vision_features forwarded in tool call when no anchor_tags", async () => {
        let capturedAction = null;
        const client = new StubToolClient(async (action) => {
            capturedAction = action;
            return {
                ok: true,
                tool: "embedding.tes_build",
                trace_id: "t_vis",
                latency_ms: 7,
                output: {
                    vector: makeUnitVector512(),
                    dim: 512,
                    normalized: true,
                    meta: { backend: "hash_v2", tes_version: "2.0" },
                },
            };
        });
        const skill = createTesBuilderSkill(client);
        const result = await skill.execute(
            makeInput({ anchor_tags: [], normalized_tags: [], vision_features: ["ramen", "cafe", "Ramen"] }),
            makeContext()
        );
        assert.ok(capturedAction, "tool should have been called");
        // vision_features are sorted deduplicated
        assert.deepStrictEqual(capturedAction.input.vision_features, ["cafe", "ramen"]);
        assert.deepStrictEqual(capturedAction.input.tags, []);
        assert.strictEqual(result.output.fallback_used, false);
        assert.strictEqual(result.trace.input_summary.vision_features_count, 2);
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
            name: "memory_weight_adjust_stub",
            inputSchema: { description: "stub", required: [] },
            outputSchema: { description: "stub", required: ["anchor_tags"] },
            execute: async () => ({
                output: { anchor_tags: ["ramen", "quiet"] },
                trace: { rule_id: "memory_weight_adjust_v1" },
            }),
        });
        registry.register(tesSkill);

        const graph = {
            name: "test_tes_builder_graph",
            version: "1.0",
            nodes: [
                { id: "memory_weight_adjust", skill: "memory_weight_adjust_stub", inputFrom: {} },
                {
                    id: "tes_builder",
                    skill: "tes_builder",
                    inputFrom: {
                        anchor_tags: "memory_weight_adjust.anchor_tags",
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
                    memory_weight_adjust: { rule_id: "memory_weight_adjust_v1", marker: "keep" },
                },
            }),
            makeContext()
        );
        assert.ok(result.output.decision_trace.memory_weight_adjust);
        assert.strictEqual(result.output.decision_trace.memory_weight_adjust.marker, "keep");
        assert.ok(result.output.decision_trace.tes_builder);
        assert.strictEqual(result.output.decision_trace.tes_builder.rule_id, "tes_builder_v1");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Goal B gate: tes_build payload must NOT include recency/sentiment fields.
    // This test FAILS if someone adds recency_days/sentiment/w_time/etc to the
    // embedding service call, which would cause double-weighting (those scalars
    // belong exclusively in memory.search).
    // ─────────────────────────────────────────────────────────────────────────

    await test("tes_build payload: only {vision_features, tags, normalize} — no recency/sentiment", async () => {
        let capturedInput = null;
        const client = new StubToolClient(async (action) => {
            capturedInput = action.input;
            return {
                ok: true,
                tool: "embedding.tes_build",
                trace_id: "t_payload_gate",
                latency_ms: 3,
                output: {
                    vector: makeUnitVector512(),
                    dim: 512,
                    normalized: true,
                    meta: { backend: "hash_v2", tes_version: "2.0" },
                },
            };
        });
        const skill = createTesBuilderSkill(client);
        await skill.execute(
            makeInput({ vision_features: ["cozy", "warm"] }),
            makeContext()
        );

        assert.ok(capturedInput !== null, "tool was called");

        // Exact key whitelist: only these three keys are allowed.
        // Any extra key (recency, sentiment, time, etc.) breaks this assertion.
        const actualKeys = Object.keys(capturedInput).sort();
        assert.deepStrictEqual(
            actualKeys,
            ["normalize", "tags", "vision_features"],
            "tes_build payload must have exactly {vision_features, tags, normalize} — " +
            "got: " + JSON.stringify(actualKeys)
        );

        // Explicit absence checks for double-weighting scalar fields
        const forbidden = [
            "recency_days", "recencyDays", "recency",
            "sentiment", "emotion", "mood",
            "w_time", "w_sent", "w_context",
            "timestamp", "time_decay",
        ];
        for (const key of forbidden) {
            assert.strictEqual(
                capturedInput[key],
                undefined,
                `tes_build must NOT send '${key}' (scalar encoding belongs in memory.search only)`
            );
        }
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
