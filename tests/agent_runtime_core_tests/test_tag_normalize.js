#!/usr/bin/env node
/**
 * Smoke tests for deterministic tag_normalize skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_tag_normalize.js
 */

const assert = require("assert");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();

const { createExecutionContext } = core;
const { createTagNormalizeSkill } = skills;

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

function makeInput(tagsFinal) {
    return {
        user_text: "Looking for sushi spots and coffee shop in tokyo",
        intent: {
            city: "tokyo",
            type: "mixed",
            tags: ["food"],
        },
        tag_expand: {
            tags_final: tagsFinal,
        },
    };
}

async function runAll() {
    console.log("\n--- tag_normalize ---");

    await test("standard matching (exact)", async () => {
        const skill = createTagNormalizeSkill();
        const result = await skill.execute(
            makeInput(["ramen", "museum"]),
            createExecutionContext({ text: "test" })
        );
        assert.deepStrictEqual(result.output.normalized_tags, ["ramen", "museum"]);
        assert.strictEqual(result.output.mapping.ramen, "ramen");
        assert.strictEqual(result.output.mapping.museum, "museum");
    });

    await test("alias matching", async () => {
        const skill = createTagNormalizeSkill();
        const result = await skill.execute(
            makeInput(["ramen shop", "coffee shop"]),
            createExecutionContext({ text: "test" })
        );
        assert.deepStrictEqual(result.output.normalized_tags, ["ramen", "cafe"]);
        assert.strictEqual(result.output.mapping["ramen shop"], "ramen");
        assert.strictEqual(result.output.mapping["coffee shop"], "cafe");
    });

    await test("safe token-aware match", async () => {
        const skill = createTagNormalizeSkill();
        const result = await skill.execute(
            makeInput(["sushi-spot"]),
            createExecutionContext({ text: "test" })
        );
        assert.deepStrictEqual(result.output.normalized_tags, ["sushi"]);
        assert.strictEqual(result.output.mapping["sushi-spot"], "sushi");
    });

    await test("drop non-dictionary / non-token-aware-match tags", async () => {
        const skill = createTagNormalizeSkill();
        const result = await skill.execute(
            makeInput(["museumish", "notarealtag"]),
            createExecutionContext({ text: "test" })
        );
        assert.deepStrictEqual(result.output.normalized_tags, []);
        assert.strictEqual(result.output.dropped.museumish, "not_in_dictionary");
        assert.strictEqual(result.output.dropped.notarealtag, "not_in_dictionary");
    });

    await test("negative cases: no unsafe short-token fuzzy mapping", async () => {
        const skill = createTagNormalizeSkill();
        const result = await skill.execute(
            makeInput(["art", "ram", "bar"]),
            createExecutionContext({ text: "test" })
        );

        assert.notStrictEqual(
            result.output.mapping.art,
            "department_store",
            "art must not map to department_store"
        );
        assert.notStrictEqual(
            result.output.mapping.ram,
            "ramen",
            "ram must not map to ramen"
        );
        assert.notStrictEqual(
            result.output.mapping.bar,
            "barbecue",
            "bar must not map to barbecue"
        );

        assert.strictEqual(
            result.output.dropped.art,
            "not_in_dictionary",
            "art should be dropped for conservative matching"
        );
        assert.strictEqual(
            result.output.dropped.ram,
            "not_in_dictionary",
            "ram should be dropped for conservative matching"
        );
    });

    await test("trace schema is complete (local path)", async () => {
        const skill = createTagNormalizeSkill();
        const result = await skill.execute(
            makeInput(["ramen shop", "notarealtag"]),
            createExecutionContext({ text: "test" })
        );

        const node = result.output.decision_trace.tag_normalize;
        assert.strictEqual(node.rule_id, "tag_normalize_v1");
        assert.strictEqual(node.schema_version, "1.0");
        assert.ok(typeof node.mapping === "object");
        assert.ok(typeof node.dropped === "object");
        assert.ok(Array.isArray(node.normalized_tags));
        assert.strictEqual(result.trace.rule_id, "tag_normalize_v1");
        // local-only path additions
        assert.strictEqual(node.provider, "local");
        assert.strictEqual(node.used, false);
        assert.strictEqual(node.fallback_used, false);
    });

    await test("deterministic deepStrictEqual on repeated runs (local path)", async () => {
        const skill = createTagNormalizeSkill();
        const input = makeInput(["ramen shop", "sushi-spot", "notarealtag"]);

        const result1 = await skill.execute(input, createExecutionContext({ text: "test" }));
        const result2 = await skill.execute(input, createExecutionContext({ text: "test" }));
        assert.deepStrictEqual(result1, result2);
    });

    // ── Remote ontology path ──────────────────────────────────────────────

    await test("remote ontology: success path sets provider=ontology, used=true", async () => {
        const stubClient = {
            async call(action) {
                assert.strictEqual(action.tool, "ontology.normalize");
                assert.deepStrictEqual(action.input.data.tags, ["ramen shop", "museum"]);
                assert.strictEqual(action.input.data.lang, "auto");
                assert.strictEqual(action.input.data.strict, true);
                return {
                    ok: true,
                    output: { normalized_tags: ["ramen", "museum"] },
                };
            },
        };
        const skill = createTagNormalizeSkill(stubClient);
        const result = await skill.execute(
            makeInput(["ramen shop", "museum"]),
            createExecutionContext({ text: "test" })
        );
        assert.deepStrictEqual(result.output.normalized_tags, ["museum", "ramen"]);
        const node = result.output.decision_trace.tag_normalize;
        assert.strictEqual(node.provider, "ontology");
        assert.strictEqual(node.used, true);
        assert.strictEqual(node.fallback_used, false);
        assert.strictEqual(node.tool.name, "ontology.normalize");
        assert.strictEqual(node.latency_ms, undefined);
        assert.strictEqual(node.rule_id, "tag_normalize_v1");
    });

    await test("remote ontology: trim/lowercase/filter-empty/dedupe/stable-sort", async () => {
        const stubClient = {
            async call() {
                return {
                    ok: true,
                    output: { normalized_tags: ["b", "a", "b", " A ", ""] },
                };
            },
        };
        const skill = createTagNormalizeSkill(stubClient);
        const result = await skill.execute(
            makeInput(["b", "a"]),
            createExecutionContext({ text: "test" })
        );
        assert.deepStrictEqual(result.output.normalized_tags, ["a", "b"]);
        assert.strictEqual(result.output.decision_trace.tag_normalize.used, true);
    });

    await test("remote ontology: deterministic on repeated calls (deepStrictEqual full result)", async () => {
        const fixedResponse = {
            ok: true,
            output: { normalized_tags: ["b", "a", "b", " A ", ""] },
        };
        const stubClient = { async call() { return fixedResponse; } };
        const skill = createTagNormalizeSkill(stubClient);
        const input = makeInput(["b", "a"]);
        const ctx = createExecutionContext({ text: "test" });
        const r1 = await skill.execute(input, ctx);
        const r2 = await skill.execute(input, ctx);
        assert.deepStrictEqual(r1, r2);
    });

    // ── Fallback paths ────────────────────────────────────────────────────

    await test("fallback tool_error: tool throws → local normalization used", async () => {
        const stubClient = {
            async call() { throw new Error("connection refused"); },
        };
        // Use local-only skill to get the expected fallback output.
        const localSkill = createTagNormalizeSkill();
        const localResult = await localSkill.execute(
            makeInput(["ramen shop", "sushi-spot"]),
            createExecutionContext({ text: "test" })
        );

        const skill = createTagNormalizeSkill(stubClient);
        const result = await skill.execute(
            makeInput(["ramen shop", "sushi-spot"]),
            createExecutionContext({ text: "test" })
        );
        assert.deepStrictEqual(result.output.normalized_tags, localResult.output.normalized_tags);
        const node = result.output.decision_trace.tag_normalize;
        assert.strictEqual(node.fallback_used, true);
        assert.strictEqual(node.fallback_reason, "tool_error");
        assert.strictEqual(node.provider, "local");
        assert.strictEqual(node.used, false);
    });

    await test("fallback tool_error: ok=false response → local normalization used", async () => {
        const stubClient = {
            async call() {
                return { ok: false, error: { code: "gateway_error", message: "503" } };
            },
        };
        const skill = createTagNormalizeSkill(stubClient);
        const result = await skill.execute(
            makeInput(["ramen"]),
            createExecutionContext({ text: "test" })
        );
        assert.strictEqual(result.output.decision_trace.tag_normalize.fallback_reason, "service_not_ok");
        assert.deepStrictEqual(result.output.normalized_tags, ["ramen"]);
    });

    await test("fallback invalid_output: missing normalized_tags → local normalization", async () => {
        const stubClient = {
            async call() {
                return { ok: true, latency_ms: 3, output: { tags_list: ["ramen"] } };
            },
        };
        const skill = createTagNormalizeSkill(stubClient);
        const result = await skill.execute(
            makeInput(["ramen"]),
            createExecutionContext({ text: "test" })
        );
        assert.strictEqual(result.output.decision_trace.tag_normalize.fallback_reason, "invalid_output");
        assert.strictEqual(result.output.decision_trace.tag_normalize.provider, "local");
        assert.deepStrictEqual(result.output.normalized_tags, ["ramen"]);
    });

    await test("fallback invalid_output: normalized_tags not array → local", async () => {
        const stubClient = {
            async call() {
                return { ok: true, latency_ms: 3, output: { normalized_tags: "ramen" } };
            },
        };
        const skill = createTagNormalizeSkill(stubClient);
        const result = await skill.execute(
            makeInput(["ramen"]),
            createExecutionContext({ text: "test" })
        );
        assert.strictEqual(result.output.decision_trace.tag_normalize.fallback_reason, "invalid_output");
    });

    await test("fallback: output equals local when remote fails", async () => {
        const stubClient = {
            async call() { throw new Error("timeout"); },
        };
        const localSkill = createTagNormalizeSkill();
        const remoteSkill = createTagNormalizeSkill(stubClient);
        const input = makeInput(["ramen shop", "coffee shop", "notarealtag"]);
        const ctx = createExecutionContext({ text: "test" });

        const localResult = await localSkill.execute(input, ctx);
        const remoteResult = await remoteSkill.execute(input, ctx);

        // Same normalized_tags, mapping, dropped
        assert.deepStrictEqual(localResult.output.normalized_tags, remoteResult.output.normalized_tags);
        assert.deepStrictEqual(localResult.output.mapping, remoteResult.output.mapping);
        assert.deepStrictEqual(localResult.output.dropped, remoteResult.output.dropped);
        // But trace differs: remote has fallback_used=true, local has fallback_used=false
        assert.strictEqual(remoteResult.output.decision_trace.tag_normalize.fallback_used, true);
        assert.strictEqual(localResult.output.decision_trace.tag_normalize.fallback_used, false);
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL TAG_NORMALIZE TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
