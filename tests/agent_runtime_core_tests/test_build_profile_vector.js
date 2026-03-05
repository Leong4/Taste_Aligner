#!/usr/bin/env node
/**
 * Core tests for the build_profile_vector skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_build_profile_vector.js
 *
 * Tests:
 *   1. Determinism: same input twice → deepStrictEqual output
 *   2. Empty memories → 512-dim zero vector + empty anchors (fallback)
 *   3. Time decay: newer memory → higher w_time → higher final_weight
 *   4. Sentiment: positive sentiment boosts w_sent → higher final_weight
 *   5. Trace contract: profile_vector_node structure + rule_id + schema_version
 *   6. Embedding present: profile_vector is weighted average, not zero
 *   7. Anchors sorted by final_weight desc, memory_id asc (tie-break)
 *   8. Orchestrator integration: decision_trace.profile_vector_node present
 */

"use strict";

const assert = require("assert");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();
const { createExecutionContext, SkillRegistry, Orchestrator } = core;
const { createBuildProfileVectorSkill, buildProfileVector } = skills;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log("  PASS: " + name);
        passed++;
    } catch (e) {
        console.error("  FAIL: " + name);
        console.error("        " + e.message);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext() {
    return createExecutionContext({ text: "test", request_ts: 1704067200000 });
}

/** Returns a fixed ISO timestamp that is `daysAgo` days before NOW_MS. */
const NOW_MS = 1704067200000; // 2024-01-01T00:00:00.000Z
function tsAgo(daysAgo) {
    return new Date(NOW_MS - daysAgo * 86400000).toISOString();
}

function makeMemory(id, overrides) {
    return Object.assign({
        memory_id: id,
        score: 0.8,
        cosine: 0.8,
        w_time: 1.0,       // ignored — build_profile_vector recomputes from timestamp
        w_sent: 1.0,       // ignored — recomputed from sentiment
        w_context: 0.9,
        city_boost: 1.0,
        tag_boost: 1.0,
        timestamp: tsAgo(1),  // 1 day ago → w_time ≈ exp(-0.1)
        sentiment: 0.0,
        normalized_tags: ["ramen"],
    }, overrides || {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runAll() {
    console.log("\n--- build_profile_vector ---");

    // ── 1. Determinism ───────────────────────────────────────────────────────
    await test("determinism: same input twice → deepStrictEqual output", function () {
        const memories = [
            makeMemory("m1", { cosine: 0.9, timestamp: tsAgo(2), sentiment: 0.1 }),
            makeMemory("m2", { cosine: 0.7, timestamp: tsAgo(10), sentiment: -0.1 }),
        ];
        const r1 = buildProfileVector(memories, NOW_MS);
        const r2 = buildProfileVector(memories, NOW_MS);
        assert.deepStrictEqual(r1, r2, "identical inputs must produce identical outputs");
    });

    // ── 2. Empty memories ────────────────────────────────────────────────────
    await test("empty memories: 512-dim zero vector + empty anchors", async function () {
        const skill = createBuildProfileVectorSkill();
        const result = await skill.execute({ weighted_results: [] }, makeContext());

        assert.strictEqual(result.output.profile_vector.length, 512);
        assert.ok(result.output.profile_vector.every(v => v === 0), "all zeros");
        assert.deepStrictEqual(result.output.anchors, []);
        assert.strictEqual(result.output.total_memories_considered, 0);
        assert.strictEqual(result.output.decision_trace.profile_vector_node.fallback_used, true);
        assert.strictEqual(result.output.decision_trace.profile_vector_node.fallback_reason, "empty_input");
        assert.strictEqual(result.output.decision_trace.profile_vector_node.rule_id, "profile_vector_v1");
    });

    // ── 3. Time decay ────────────────────────────────────────────────────────
    await test("time decay: newer memory has higher w_time and final_weight", function () {
        const mNew = makeMemory("m_new", { cosine: 0.9, timestamp: tsAgo(1), sentiment: 0.0, w_context: 1.0 });
        const mOld = makeMemory("m_old", { cosine: 0.9, timestamp: tsAgo(30), sentiment: 0.0, w_context: 1.0 });
        const result = buildProfileVector([mNew, mOld], NOW_MS);

        const newEntry = result.weights.per_memory.find(p => p.memory_id === "m_new");
        const oldEntry = result.weights.per_memory.find(p => p.memory_id === "m_old");

        assert.ok(newEntry, "m_new in per_memory");
        assert.ok(oldEntry, "m_old in per_memory");
        assert.ok(
            newEntry.w_time > oldEntry.w_time,
            "newer memory must have higher w_time: new=" + newEntry.w_time + " old=" + oldEntry.w_time
        );
        assert.ok(
            newEntry.final_weight > oldEntry.final_weight,
            "newer memory must have higher final_weight"
        );

        // Anchor should be the newer memory (higher final_weight)
        assert.strictEqual(result.anchors[0].memory_id, "m_new");
    });

    // ── 4. Sentiment boost ───────────────────────────────────────────────────
    await test("positive sentiment boosts w_sent and final_weight", function () {
        const mPos = makeMemory("m_pos", { cosine: 0.8, timestamp: tsAgo(1), sentiment: 0.5, w_context: 1.0 });
        const mNeu = makeMemory("m_neu", { cosine: 0.8, timestamp: tsAgo(1), sentiment: 0.0, w_context: 1.0 });
        const result = buildProfileVector([mPos, mNeu], NOW_MS);

        const posEntry = result.weights.per_memory.find(p => p.memory_id === "m_pos");
        const neuEntry = result.weights.per_memory.find(p => p.memory_id === "m_neu");

        // w_sent_pos = clamp(1 + 0.2*0.5, 0.5, 2.0) = 1.1
        // w_sent_neu = clamp(1 + 0.2*0.0, 0.5, 2.0) = 1.0
        assert.ok(posEntry.w_sent > neuEntry.w_sent,
            "positive sentiment must give higher w_sent: pos=" + posEntry.w_sent + " neu=" + neuEntry.w_sent);
        assert.ok(posEntry.final_weight > neuEntry.final_weight,
            "positive sentiment must give higher final_weight");
    });

    // ── 5. Trace contract ────────────────────────────────────────────────────
    await test("trace contract: rule_id, schema_version, anchors, weights_summary, dim", async function () {
        const skill = createBuildProfileVectorSkill();
        const result = await skill.execute(
            { weighted_results: [makeMemory("m1"), makeMemory("m2")], now_ts: NOW_MS },
            makeContext()
        );

        const trace = result.output.decision_trace.profile_vector_node;
        assert.strictEqual(trace.rule_id, "profile_vector_v1");
        assert.strictEqual(trace.schema_version, "1.0");
        assert.ok(Array.isArray(trace.anchors), "anchors is array");
        assert.ok(typeof trace.weights_summary === "object", "weights_summary is object");
        assert.ok(typeof trace.weights_summary.dominant_reason === "string");
        assert.strictEqual(typeof trace.time_bias === "number" || trace.weights_summary.time_bias !== undefined, true);
        assert.strictEqual(trace.profile_vector_dim, 512);
        assert.strictEqual(typeof trace.fallback_used, "boolean");
        assert.strictEqual(result.output.profile_vector.length, 512, "output vector is 512-dim");

        // No latency/timestamp/random fields
        const forbidden = ["latency_ms", "timestamp", "request_id", "created_at", "random"];
        for (const key of forbidden) {
            assert.strictEqual(trace[key], undefined,
                "trace must not contain '" + key + "' (non-deterministic field)");
        }
    });

    await test("missing now_ts + invalid context.request_ts -> fixed_epoch now_source", async function () {
        const skill = createBuildProfileVectorSkill();
        const ctx = {
            input: { text: "test" },
            request_ts: Number.NaN,
            intermediate_results: {},
            final_result: null,
            decision_trace: {},
            errors: [],
            timing: {},
        };
        const result = await skill.execute(
            { weighted_results: [makeMemory("m1", { timestamp: "not-a-date" })] },
            ctx
        );
        assert.strictEqual(result.trace.now_source, "fixed_epoch");
        assert.strictEqual(result.output.decision_trace.profile_vector_node.now_source, "fixed_epoch");
    });

    // ── 6. Embedding: weighted average ───────────────────────────────────────
    await test("embedding present: profile_vector is weighted average, not zero", function () {
        const emb1 = new Array(512).fill(0); emb1[0] = 1; // unit vector along dim 0
        const emb2 = new Array(512).fill(0); emb2[1] = 1; // unit vector along dim 1

        const m1 = Object.assign(makeMemory("m1", { cosine: 0.9, timestamp: tsAgo(1), sentiment: 0, w_context: 1.0 }), { embedding: emb1 });
        const m2 = Object.assign(makeMemory("m2", { cosine: 0.9, timestamp: tsAgo(1), sentiment: 0, w_context: 1.0 }), { embedding: emb2 });

        const result = buildProfileVector([m1, m2], NOW_MS);

        assert.strictEqual(result.has_embeddings, true);
        // Both memories have same timestamp and sentiment → same final_weight → equal mix
        // profile_vector[0] ≈ 0.5, profile_vector[1] ≈ 0.5
        assert.ok(result.profile_vector[0] > 0, "dim 0 > 0 from emb1");
        assert.ok(result.profile_vector[1] > 0, "dim 1 > 0 from emb2");
        assert.ok(result.profile_vector.every(v => Number.isFinite(v)), "all finite");
    });

    // ── 7. Anchor sort order ─────────────────────────────────────────────────
    await test("anchors sorted by final_weight desc, memory_id asc (tie-break)", function () {
        // Two memories with equal cosine, same timestamp, same sentiment — tie on final_weight
        // memory_id asc should be tie-break
        const mA = makeMemory("m_a", { cosine: 0.5, timestamp: tsAgo(1), sentiment: 0.0, w_context: 1.0 });
        const mB = makeMemory("m_b", { cosine: 0.5, timestamp: tsAgo(1), sentiment: 0.0, w_context: 1.0 });
        const mHigh = makeMemory("m_high", { cosine: 0.9, timestamp: tsAgo(1), sentiment: 0.0, w_context: 1.0 });

        const result = buildProfileVector([mB, mA, mHigh], NOW_MS);

        // m_high should be first (highest final_weight)
        assert.strictEqual(result.anchors[0].memory_id, "m_high");
        // m_a before m_b for equal weights (lex asc)
        const ids = result.anchors.map(a => a.memory_id);
        const mAIdx = ids.indexOf("m_a");
        const mBIdx = ids.indexOf("m_b");
        if (mAIdx !== -1 && mBIdx !== -1) {
            assert.ok(mAIdx < mBIdx, "m_a must appear before m_b (lex tie-break)");
        }
    });

    // ── 8. Orchestrator integration ──────────────────────────────────────────
    await test("orchestrator integration: decision_trace.profile_vector_node present", async function () {
        const registry = new SkillRegistry();
        registry.register({
            name: "memory_weight_adjust",
            inputSchema: { description: "stub", required: [] },
            outputSchema: { description: "stub", required: ["weighted_results"] },
            execute: async () => ({
                output: {
                    weighted_results: [
                        makeMemory("m1", { cosine: 0.9, timestamp: tsAgo(2), sentiment: 0.1 }),
                        makeMemory("m2", { cosine: 0.7, timestamp: tsAgo(10), sentiment: -0.2 }),
                    ],
                    anchor_memory_ids: ["m1"],
                    anchor_tags: ["ramen"],
                    memory_confidence: 0.8,
                    stats: { input_tags_count: 2, results_count: 2, anchor_count: 1, anchor_tags_count: 1 },
                    decision_trace: { memory_weight_adjust: { rule_id: "memory_weight_adjust_v1" } },
                },
                trace: { rule_id: "memory_weight_adjust_v1" },
            }),
        });
        registry.register(createBuildProfileVectorSkill());

        const graph = {
            name: "test_pv_graph",
            version: "1.0",
            nodes: [
                {
                    id: "memory_weight_adjust",
                    skill: "memory_weight_adjust",
                    inputFrom: {},
                },
                {
                    id: "build_profile_vector",
                    skill: "build_profile_vector",
                    inputFrom: {
                        weighted_results: "memory_weight_adjust.weighted_results",
                        now_ts: "input.request_ts",
                    },
                },
            ],
        };

        const orchestrator = new Orchestrator(registry, graph);
        const runResult = await orchestrator.runWithTrace({ text: "test", request_ts: NOW_MS });

        assert.strictEqual(runResult.ok, true, "pipeline must succeed");
        const dt = runResult.decision_trace;

        // profile_vector_node written via mergeResultTraceBundles (from output.decision_trace)
        assert.ok(dt.profile_vector_node, "decision_trace.profile_vector_node must be present");
        assert.strictEqual(dt.profile_vector_node.rule_id, "profile_vector_v1");
        assert.strictEqual(dt.profile_vector_node.fallback_used, false);
        assert.strictEqual(dt.profile_vector_node.now_source, "input_now_ts");
        assert.ok(Array.isArray(dt.profile_vector_node.anchors));
        assert.ok(typeof dt.profile_vector_node.weights_summary === "object");
        assert.strictEqual(dt.profile_vector_node.profile_vector_dim, 512);

        // No non-deterministic fields
        assert.strictEqual(dt.profile_vector_node.latency_ms, undefined);
        assert.strictEqual(dt.profile_vector_node.timestamp, undefined);
    });

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log("\n" + "=".repeat(50));
    console.log("Results: " + passed + " passed, " + failed + " failed");
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL BUILD_PROFILE_VECTOR TESTS: PASS");
    }
}

runAll().catch(function (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
});
