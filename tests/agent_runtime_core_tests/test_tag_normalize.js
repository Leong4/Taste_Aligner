#!/usr/bin/env node
/**
 * Smoke tests for deterministic tag_normalize skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_tag_normalize.js
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

    await test("trace schema is complete", async () => {
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
    });

    await test("deterministic deepStrictEqual on repeated runs", async () => {
        const skill = createTagNormalizeSkill();
        const input = makeInput(["ramen shop", "sushi-spot", "notarealtag"]);

        const result1 = await skill.execute(input, createExecutionContext({ text: "test" }));
        const result2 = await skill.execute(input, createExecutionContext({ text: "test" }));
        assert.deepStrictEqual(result1, result2);
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
