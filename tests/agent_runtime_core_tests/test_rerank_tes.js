#!/usr/bin/env node
/**
 * Smoke tests for TES-driven rerank (v2).
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_rerank_tes.js
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
const { createRerankSkill } = skills;

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
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake normalized 512-dim vector with a specific "signature" value. */
function makeUnitVector(value) {
    // Put the value at index 0, rest zeros, then normalize
    const vec = new Array(512).fill(0);
    vec[0] = 1.0; // unit vector pointing in dimension 0
    return vec;
}

/** Create a 512-dim unit vector pointing at dimension `dim`. */
function makeUnitVectorAt(dim) {
    const vec = new Array(512).fill(0);
    vec[dim] = 1.0;
    return vec;
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

function makeContext() {
    return createExecutionContext({ text: "test", request_ts: 1704067200000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runAll() {
    console.log("\n--- rerank TES ---");

    // =====================================================================
    // 1. Happy path: TES rerank with 3 items, different similarities
    // =====================================================================
    await test("happy path: TES rerank fuses scores and reorders", async () => {
        const userVec = makeUnitVectorAt(0); // points at dim 0

        // Item A: tags ["sushi"] -> returns vector pointing dim 0 (sim=1.0)
        // Item B: tags ["ramen"] -> returns vector pointing dim 1 (sim=0.0)
        // Item C: tags ["curry"] -> returns vector pointing dim 0 (sim=1.0)
        const itemVectors = {
            "curry": makeUnitVectorAt(0),
            "ramen": makeUnitVectorAt(1),
            "sushi": makeUnitVectorAt(0),
        };

        const client = new StubToolClient(async (action) => {
            assert.strictEqual(action.tool, "embedding.tes_build");
            const tags = action.input.tags;
            const key = tags.join("|");
            const vec = itemVectors[key];
            if (!vec) {
                return { ok: false, tool: "embedding.tes_build", trace_id: "t", latency_ms: 1 };
            }
            return {
                ok: true,
                tool: "embedding.tes_build",
                trace_id: "t_item",
                latency_ms: 5,
                output: {
                    vector: vec,
                    dim: 512,
                    normalized: true,
                    meta: { backend: "hash_v2", tes_version: "2.0" },
                },
            };
        });

        const skill = createRerankSkill(client);
        const input = {
            cz_ranked: [
                { id: "A", score: 0.5, tags: ["sushi"] },
                { id: "B", score: 0.9, tags: ["ramen"] },
                { id: "C", score: 0.5, tags: ["curry"] },
            ],
            ez_ranked: [],
            user_id: "u1",
            user_city: "tokyo",
            user_tags: ["food"],
            tes_vector: userVec,
            tes_dim: 512,
            tes_normalized: true,
            tes_fallback_used: false,
        };

        const result = await skill.execute(input, makeContext());

        // Item A: fused = 0.5 + 0.25*1.0 = 0.75
        // Item B: fused = 0.9 + 0.25*0.0 = 0.9
        // Item C: fused = 0.5 + 0.25*1.0 = 0.75
        // Order: B(0.9), A(0.75, base=0.5, id="A"), C(0.75, base=0.5, id="C")
        const czIds = result.output.cz_ranked.map((c) => c.id);
        assert.deepStrictEqual(czIds, ["B", "A", "C"]);

        // Trace
        assert.strictEqual(result.trace.rule_id, "rerank_v2_tes");
        assert.strictEqual(result.trace.schema_version, "1.0");
        assert.strictEqual(result.trace.tes_used, true);
        assert.strictEqual(result.trace.fallback_used, false);
        assert.strictEqual(result.trace.tes_budget.used_calls, 3);
        assert.strictEqual(result.trace.weights.tes_sim_weight, 0.25);
        assert.strictEqual(result.trace.stats.cz_items, 3);
        assert.strictEqual(result.trace.stats.tes_scored_items, 2); // A+C got sim>0
        assert.strictEqual(result.trace.stats.tool_errors, 0);
    });

    // =====================================================================
    // 2. Determinism: same input twice -> deepStrictEqual
    // =====================================================================
    await test("determinism: same input twice -> identical output + trace", async () => {
        const userVec = makeUnitVectorAt(0);
        const itemVec = makeUnitVectorAt(0);

        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_det",
            latency_ms: 3,
            output: {
                vector: itemVec,
                dim: 512,
                normalized: true,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        }));

        const skill = createRerankSkill(client);
        const input = {
            cz_ranked: [
                { id: "X", score: 0.7, tags: ["sushi"] },
                { id: "Y", score: 0.7, tags: ["ramen"] },
            ],
            ez_ranked: [{ id: "Z", score: 0.3, tags: ["pasta"] }],
            user_id: "u1",
            user_city: "tokyo",
            user_tags: ["food"],
            tes_vector: userVec,
            tes_dim: 512,
            tes_normalized: true,
            tes_fallback_used: false,
        };

        const r1 = await skill.execute(input, makeContext());
        const r2 = await skill.execute(input, makeContext());

        // Remove latency_ms from comparison (timing-dependent)
        delete r1.trace.latency_ms;
        delete r2.trace.latency_ms;
        assert.deepStrictEqual(r1, r2);
    });

    // =====================================================================
    // 3. Tie-breaker stability: equal fused scores
    // =====================================================================
    await test("tie-breaker: equal fused + base scores -> sort by id asc", async () => {
        const userVec = makeUnitVectorAt(0);
        const itemVec = makeUnitVectorAt(0); // sim=1.0 for all

        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t",
            latency_ms: 1,
            output: { vector: itemVec, dim: 512, normalized: true, meta: {} },
        }));

        const skill = createRerankSkill(client);
        const input = {
            cz_ranked: [
                { id: "C", score: 0.5, tags: ["sushi"] },
                { id: "A", score: 0.5, tags: ["ramen"] },
                { id: "B", score: 0.5, tags: ["curry"] },
            ],
            ez_ranked: [],
            user_id: "u1",
            user_city: "tokyo",
            user_tags: [],
            tes_vector: userVec,
            tes_dim: 512,
            tes_normalized: true,
            tes_fallback_used: false,
        };

        const result = await skill.execute(input, makeContext());
        const czIds = result.output.cz_ranked.map((c) => c.id);
        // All fused = 0.5 + 0.25*1.0 = 0.75, base = 0.5 => tie-break by id asc
        assert.deepStrictEqual(czIds, ["A", "B", "C"]);
    });

    // =====================================================================
    // 4. Fallback: missing user TES vector
    // =====================================================================
    await test("fallback: missing user tes vector -> tes_used=false, no tool calls", async () => {
        let callCount = 0;
        const client = new StubToolClient(async () => {
            callCount++;
            throw new Error("should not call");
        });

        const skill = createRerankSkill(client);
        const input = {
            cz_ranked: [{ id: "A", score: 0.5 }],
            ez_ranked: [],
            user_id: "u1",
            user_city: "tokyo",
            user_tags: [],
            // No tes_vector
        };

        const result = await skill.execute(input, makeContext());
        assert.strictEqual(callCount, 0, "tool should not be called");
        assert.strictEqual(result.trace.tes_used, false);
        assert.strictEqual(result.trace.fallback_used, true);
        assert.strictEqual(result.trace.fallback_reason, "no_user_tes");
        assert.strictEqual(result.trace.rule_id, "rerank_v2_tes");
        // Items passed through unchanged
        assert.strictEqual(result.output.cz_ranked.length, 1);
        assert.strictEqual(result.output.cz_ranked[0].id, "A");
    });

    // =====================================================================
    // 5. Fallback: upstream tes_builder fallback_used=true
    // =====================================================================
    await test("fallback: tes_fallback_used=true -> no TES rerank", async () => {
        let callCount = 0;
        const client = new StubToolClient(async () => {
            callCount++;
            return { ok: false, tool: "t", trace_id: "t", latency_ms: 0 };
        });

        const skill = createRerankSkill(client);
        const input = {
            cz_ranked: [{ id: "A", score: 0.5 }],
            ez_ranked: [],
            user_id: "u1",
            user_city: "tokyo",
            user_tags: [],
            tes_vector: makeUnitVectorAt(0),
            tes_dim: 512,
            tes_normalized: true,
            tes_fallback_used: true, // upstream failed
        };

        const result = await skill.execute(input, makeContext());
        assert.strictEqual(callCount, 0);
        assert.strictEqual(result.trace.tes_used, false);
        assert.strictEqual(result.trace.fallback_used, true);
        assert.strictEqual(result.trace.fallback_reason, "no_user_tes");
    });

    // =====================================================================
    // 6. Tool error on item TES build -> sim=0, tool_errors increments
    // =====================================================================
    await test("tool error on item TES: tes_used=true, per-item sim=0, tool_errors counted", async () => {
        const userVec = makeUnitVectorAt(0);
        let callCount = 0;

        const client = new StubToolClient(async () => {
            callCount++;
            throw new Error("service down");
        });

        const skill = createRerankSkill(client);
        const input = {
            cz_ranked: [
                { id: "A", score: 0.8, tags: ["sushi"] },
                { id: "B", score: 0.5, tags: ["ramen"] },
            ],
            ez_ranked: [],
            user_id: "u1",
            user_city: "tokyo",
            user_tags: [],
            tes_vector: userVec,
            tes_dim: 512,
            tes_normalized: true,
            tes_fallback_used: false,
        };

        const result = await skill.execute(input, makeContext());
        assert.strictEqual(result.trace.tes_used, true);
        assert.strictEqual(result.trace.fallback_used, false);
        assert.strictEqual(result.trace.stats.tool_errors, 2);
        assert.strictEqual(result.trace.tes_budget.used_calls, 2);
        assert.strictEqual(result.trace.stats.tes_scored_items, 0); // all sim=0
        // Order preserved by base_score: A(0.8) > B(0.5)
        const czIds = result.output.cz_ranked.map((c) => c.id);
        assert.deepStrictEqual(czIds, ["A", "B"]);
    });

    // =====================================================================
    // 7. Invalid item vector shape -> counted, sim=0
    // =====================================================================
    await test("invalid item vector: wrong dim -> invalid_vectors counted", async () => {
        const userVec = makeUnitVectorAt(0);

        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t",
            latency_ms: 1,
            output: {
                vector: [1.0, 0.0], // wrong dim (2 instead of 512)
                dim: 2,
                normalized: true,
                meta: {},
            },
        }));

        const skill = createRerankSkill(client);
        const input = {
            cz_ranked: [{ id: "A", score: 0.5, tags: ["sushi"] }],
            ez_ranked: [],
            user_id: "u1",
            user_city: "tokyo",
            user_tags: [],
            tes_vector: userVec,
            tes_dim: 512,
            tes_normalized: true,
            tes_fallback_used: false,
        };

        const result = await skill.execute(input, makeContext());
        assert.strictEqual(result.trace.tes_used, true);
        assert.strictEqual(result.trace.stats.invalid_vectors, 1);
        assert.strictEqual(result.trace.stats.tes_scored_items, 0);
    });

    // =====================================================================
    // 8. Cache hit: items with same tags share TES call
    // =====================================================================
    await test("cache: items with same sorted tags share one TES call", async () => {
        const userVec = makeUnitVectorAt(0);
        const itemVec = makeUnitVectorAt(0);
        let callCount = 0;

        const client = new StubToolClient(async () => {
            callCount++;
            return {
                ok: true,
                tool: "embedding.tes_build",
                trace_id: "t",
                latency_ms: 1,
                output: { vector: itemVec, dim: 512, normalized: true, meta: {} },
            };
        });

        const skill = createRerankSkill(client);
        const input = {
            cz_ranked: [
                { id: "A", score: 0.5, tags: ["ramen", "sushi"] },
                { id: "B", score: 0.6, tags: ["sushi", "ramen"] }, // same tags after sort
                { id: "C", score: 0.7, tags: ["curry"] }, // different
            ],
            ez_ranked: [],
            user_id: "u1",
            user_city: "tokyo",
            user_tags: [],
            tes_vector: userVec,
            tes_dim: 512,
            tes_normalized: true,
            tes_fallback_used: false,
        };

        const result = await skill.execute(input, makeContext());
        assert.strictEqual(callCount, 2, "only 2 calls: 'ramen|sushi' + 'curry'");
        assert.strictEqual(result.trace.tes_budget.used_calls, 2);
        assert.strictEqual(result.trace.tes_budget.cache_hits, 1);
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
        console.log("ALL RERANK TES TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
