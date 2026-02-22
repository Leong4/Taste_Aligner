#!/usr/bin/env node
/**
 * Smoke tests for the explain_from_trace LLM skill and LLM adapter layer.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_explain_from_trace.js
 *
 * Tests:
 *   1. MockLLMAdapter returns structured output (short mode)
 *   2. MockLLMAdapter returns structured output (long mode)
 *   3. MockLLMAdapter throws on error mode
 *   4. createLLMAdapterFromEnv defaults to mock
 *   5. explain_from_trace skill returns explanation + bullets
 *   6. explain_from_trace skill records decision_trace with provider/model/prompt_version
 *   7. explain_from_trace skill handles adapter error gracefully (fallback_used=true)
 *   8. explain_from_trace wired into orchestrator — output includes explanation
 *   9. RECOMMENDATION_GRAPH v8.0 includes explain_from_trace node
 */

const assert = require("assert");
const path = require("path");

// ---------------------------------------------------------------------------
// Load compiled modules
// ---------------------------------------------------------------------------
let core, llm, skills;
try {
    require("ts-node").register({
        project: path.join(__dirname, "../../agent_runtime/tsconfig.json"),
        transpileOnly: true,
    });
    core = require("../../agent_runtime/src/core");
    llm = require("../../agent_runtime/src/llm");
    skills = require("../../agent_runtime/src/skills");
} catch (e) {
    try {
        core = require("../../agent_runtime/dist/core");
        llm = require("../../agent_runtime/dist/llm");
        skills = require("../../agent_runtime/dist/skills");
    } catch (e2) {
        console.error(
            "Cannot load modules. Run 'npm run build' in agent_runtime/ first."
        );
        console.error(e2.message);
        process.exit(1);
    }
}

const { SkillRegistry, Orchestrator, validateGraph, createExecutionContext, RECOMMENDATION_GRAPH } = core;
const { MockLLMAdapter, createLLMAdapterFromEnv } = llm;
const { createExplainFromTraceSkill } = skills;

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === "function") {
            // Handle async tests
            return result
                .then(() => {
                    console.log(`  PASS: ${name}`);
                    passed++;
                })
                .catch((e) => {
                    console.error(`  FAIL: ${name}`);
                    console.error(`        ${e.message}`);
                    failed++;
                });
        }
        console.log(`  PASS: ${name}`);
        passed++;
        return Promise.resolve();
    } catch (e) {
        console.error(`  FAIL: ${name}`);
        console.error(`        ${e.message}`);
        failed++;
        return Promise.resolve();
    }
}

async function runAll() {
    // =========================================================================
    // 1. MockLLMAdapter tests
    // =========================================================================
    console.log("\n--- MockLLMAdapter ---");

    await test("short mode returns explanation + bullets", async () => {
        const adapter = new MockLLMAdapter("short");
        const result = await adapter.generateStructuredJSON({
            systemPrompt: "test",
            userPrompt: "test",
            schema: {},
            temperature: 0.3,
            promptVersion: "test_v1",
        });

        assert.ok(typeof result.data.explanation === "string", "has explanation");
        assert.ok(Array.isArray(result.data.bullets), "has bullets array");
        assert.ok(result.data.bullets.length >= 3, "at least 3 bullets");
        assert.strictEqual(result.callTrace.model.provider, "mock");
        assert.strictEqual(result.callTrace.model.model_name, "mock-v1");
        assert.strictEqual(result.callTrace.prompt_version, "test_v1");
        assert.strictEqual(result.callTrace.fallback_used, false);
    });

    await test("long mode returns more bullets", async () => {
        const adapter = new MockLLMAdapter("long");
        const result = await adapter.generateStructuredJSON({
            systemPrompt: "test",
            userPrompt: "test",
            schema: {},
            temperature: 0.3,
            promptVersion: "test_v1",
        });

        assert.ok(result.data.bullets.length >= 5, "long mode has 5+ bullets");
    });

    await test("error mode throws", async () => {
        const adapter = new MockLLMAdapter("error");
        let threw = false;
        try {
            await adapter.generateStructuredJSON({
                systemPrompt: "test",
                userPrompt: "test",
                schema: {},
                temperature: 0,
                promptVersion: "test_v1",
            });
        } catch (e) {
            threw = true;
            assert.ok(e.message.includes("Simulated"), "error message mentions simulated");
        }
        assert.ok(threw, "error mode should throw");
    });

    // =========================================================================
    // 2. createLLMAdapterFromEnv
    // =========================================================================
    console.log("\n--- createLLMAdapterFromEnv ---");

    await test("defaults to mock adapter", () => {
        const adapter = createLLMAdapterFromEnv();
        assert.strictEqual(adapter.modelInfo.provider, "mock");
        assert.strictEqual(adapter.modelInfo.model_name, "mock-v1");
    });

    // =========================================================================
    // 3. explain_from_trace skill
    // =========================================================================
    console.log("\n--- explain_from_trace skill ---");

    await test("returns explanation + bullets + meta", async () => {
        const adapter = new MockLLMAdapter("short");
        const skill = createExplainFromTraceSkill(adapter);

        assert.strictEqual(skill.name, "explain_from_trace");

        const ctx = createExecutionContext({ text: "food in london" });
        const input = {
            decision_trace: {
                extract_intent: {
                    rule_id: "intent_v1",
                    city: "london",
                    type: "food",
                    tags: ["food"],
                    confidence: 0.9,
                },
                mix_policy: {
                    rule_id: "comfort_high",
                    ratio: { label: "3:1", cz: 3, ez: 1 },
                    confidence: 0.9,
                },
            },
            user_text: "food in london",
            locale: "en",
            style: "concise",
        };

        const result = await skill.execute(input, ctx);

        // Check output
        assert.ok(typeof result.output.explanation === "string", "explanation is string");
        assert.ok(result.output.explanation.length > 0, "explanation not empty");
        assert.ok(Array.isArray(result.output.bullets), "bullets is array");
        assert.ok(result.output.bullets.length >= 3, "at least 3 bullets");
        assert.strictEqual(result.output.meta.locale, "en");
        assert.strictEqual(result.output.meta.style, "concise");
    });

    await test("decision_trace includes provider/model_name/prompt_version", async () => {
        const adapter = new MockLLMAdapter("short");
        const skill = createExplainFromTraceSkill(adapter);
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            decision_trace: { extract_intent: { city: "tokyo" } },
        };

        const result = await skill.execute(input, ctx);

        // Check trace
        assert.strictEqual(result.trace.schema_version, "explain_v1");
        assert.ok(Array.isArray(result.trace.inputs_used), "inputs_used is array");
        assert.strictEqual(result.trace.fallback_used, false);

        const llmCall = result.trace.llm_call;
        assert.ok(llmCall, "llm_call present in trace");
        assert.strictEqual(llmCall.provider, "mock");
        assert.strictEqual(llmCall.model_name, "mock-v1");
        assert.strictEqual(llmCall.prompt_version, "explain_v1");
        assert.strictEqual(llmCall.fallback_used, false);
    });

    await test("handles adapter error gracefully (fallback_used=true)", async () => {
        const adapter = new MockLLMAdapter("error");
        const skill = createExplainFromTraceSkill(adapter);
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            decision_trace: { extract_intent: { city: "london" } },
        };

        // Should NOT throw
        const result = await skill.execute(input, ctx);

        assert.strictEqual(result.output.explanation, "Explanation unavailable.");
        assert.deepStrictEqual(result.output.bullets, []);
        assert.strictEqual(result.trace.fallback_used, true);
        assert.ok(typeof result.trace.error === "string", "error recorded in trace");
        assert.ok(result.trace.error.includes("Simulated"), "error mentions simulated");

        const llmCall = result.trace.llm_call;
        assert.ok(llmCall, "llm_call present even on error");
        assert.strictEqual(llmCall.fallback_used, true);
    });

    // =========================================================================
    // 4. Orchestrator integration
    // =========================================================================
    console.log("\n--- Orchestrator integration ---");

    await test("orchestrator output includes explanation and bullets", async () => {
        const reg = new SkillRegistry();

        // Stub skills for a minimal pipeline
        reg.register({
            name: "s_cards",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    cards: [{ zone: "CZ", items: ["ramen"] }],
                    mix_policy: { ratio: "3:1" },
                    city: "london",
                    type: "food",
                    decision_trace: {},
                },
                trace: { rule_id: "cards_v1" },
            }),
        });

        const adapter = new MockLLMAdapter("short");
        reg.register(createExplainFromTraceSkill(adapter));

        const graph = {
            name: "test_explain",
            version: "1.0",
            nodes: [
                {
                    id: "cards",
                    skill: "s_cards",
                    inputFrom: { text: "input.text" },
                },
                {
                    id: "explain",
                    skill: "explain_from_trace",
                    inputFrom: {
                        decision_trace: "cards.decision_trace",
                        user_text: "input.text",
                    },
                },
            ],
        };

        const orch = new Orchestrator(reg, graph);
        const result = await orch.run({ text: "food in london" });

        assert.strictEqual(result.ok, true, "pipeline ok");
        assert.ok(result.cards, "cards present");
        assert.ok(result.mix_policy, "mix_policy present");
        assert.ok(typeof result.explanation === "string", "explanation present");
        assert.ok(result.explanation.length > 0, "explanation not empty");
        assert.ok(Array.isArray(result.bullets), "bullets present");
        assert.ok(result.bullets.length >= 3, "at least 3 bullets");

        // Verify decision_trace has explain_from_trace entry
        assert.ok(
            result.decision_trace.explain_from_trace,
            "explain_from_trace in decision_trace"
        );
        assert.strictEqual(
            result.decision_trace.explain_from_trace.schema_version,
            "explain_v1"
        );
    });

    // =========================================================================
    // 5. Graph structure
    // =========================================================================
    console.log("\n--- Graph structure ---");

    await test("RECOMMENDATION_GRAPH v10.0 includes explain_from_trace node", () => {
        assert.strictEqual(RECOMMENDATION_GRAPH.version, "10.0.0");
        assert.strictEqual(RECOMMENDATION_GRAPH.nodes.length, 12, "12 nodes");

        const lastNode = RECOMMENDATION_GRAPH.nodes[11];
        assert.strictEqual(lastNode.id, "explain_from_trace");
        assert.strictEqual(lastNode.skill, "explain_from_trace");
        assert.ok(lastNode.inputFrom.decision_trace, "has decision_trace input");
        assert.ok(lastNode.inputFrom.user_text, "has user_text input");

        // Validate graph structure
        const errors = validateGraph(RECOMMENDATION_GRAPH);
        assert.strictEqual(errors.length, 0, "graph valid: " + errors.join(", "));
    });

    // =========================================================================
    // Summary
    // =========================================================================
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL EXPLAIN_FROM_TRACE TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
