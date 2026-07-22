#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();

const {
    SkillRegistry,
    Orchestrator,
    createExecutionContext,
} = core;
const { extractIntentSkill } = skills;

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
    console.log("\n--- extract_intent upload gating ---");

    await test("query flow without city remains terminal", async () => {
        const ctx = createExecutionContext({ text: "show me ramen" });
        const result = await extractIntentSkill.execute({ text: "show me ramen" }, ctx);
        assert.strictEqual(result.terminal, true);
        assert.strictEqual(result.terminalReason, "no_city_detected");
        assert.strictEqual(result.trace.abort_reason, "no_city_detected");
        assert.strictEqual(result.trace.city_detected, false);
    });

    await test("upload flow with image_base64 and no city does not terminate", async () => {
        const ctx = createExecutionContext({
            text: "remember this photo",
            image_base64: "data:image/png;base64,AAAA",
        });
        const result = await extractIntentSkill.execute({
            text: "remember this photo",
            image_base64: "data:image/png;base64,AAAA",
        }, ctx);
        assert.strictEqual(result.terminal, undefined);
        assert.strictEqual(result.terminalReason, undefined);
        assert.strictEqual(result.trace.city_detected, false);
        assert.strictEqual(result.trace.abort_reason, undefined);
        assert.strictEqual(result.trace.upload_flow, true);
    });

    await test("orchestrator upload flow reaches tes_builder without pipeline_terminated", async () => {
        const reg = new SkillRegistry();
        reg.register(extractIntentSkill);
        reg.register({
            name: "tes_builder_stub",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    tes_vector: [],
                    decision_trace: {
                        tes_builder: {
                            rule_id: "tes_builder_v1",
                        },
                    },
                },
                trace: {
                    rule_id: "tes_builder_v1",
                },
            }),
        });

        const graph = {
            name: "extract_upload_graph",
            version: "1.0",
            nodes: [
                {
                    id: "extract_intent",
                    skill: "extract_intent",
                    inputFrom: {
                        text: "input.text",
                        user_id: "input.user_id",
                        image_base64: "input.image_base64",
                        image_url: "input.image_url",
                    },
                },
                {
                    id: "tes_builder",
                    skill: "tes_builder_stub",
                    inputFrom: {
                        anchor_tags: "extract_intent.tags",
                    },
                },
            ],
        };

        const orchestrator = new Orchestrator(reg, graph);
        const result = await orchestrator.runWithTrace({
            text: "remember this photo",
            user_id: "step5_demo_user",
            image_base64: "data:image/png;base64,AAAA",
        });

        assert.strictEqual(result.ok, true);
        assert.ok(result.decision_trace.extract_intent, "extract_intent trace present");
        assert.ok(result.decision_trace.tes_builder, "tes_builder trace present");
        assert.strictEqual(result.decision_trace.extract_intent.abort_reason, undefined);
        assert.strictEqual(
            result.errors.some((e) => e.code === "pipeline_terminated"),
            false,
            "upload flow must not record pipeline_terminated"
        );
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL EXTRACT_INTENT TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
