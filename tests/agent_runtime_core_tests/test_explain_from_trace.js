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
const { loadCore, loadLLM, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const llm = loadLLM();
const skills = loadSkills();

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
        assert.strictEqual(result.trace.fallback_reason, "adapter_error");
        assert.strictEqual(result.trace.error, "adapter_error");

        const llmCall = result.trace.llm_call;
        assert.ok(llmCall, "llm_call present even on error");
        assert.strictEqual(llmCall.fallback_used, true);
        assert.strictEqual(llmCall.fallback_reason, "adapter_error");
    });

    await test("determinism: same input twice → deepStrictEqual output+trace (mock)", async () => {
        const adapter = new MockLLMAdapter("short");
        const skill = createExplainFromTraceSkill(adapter);
        const input = {
            decision_trace: {
                extract_intent: { city: "tokyo", type: "food", tags: ["ramen"], confidence: 0.85 },
                mix_policy: { rule_id: "comfort_high", ratio: { label: "3:1", cz: 3, ez: 1 }, confidence: 0.9 },
            },
            user_text: "cozy ramen in tokyo",
            locale: "en",
            style: "concise",
        };
        const ctx = createExecutionContext({ text: "test" });

        const r1 = await skill.execute(input, ctx);
        const r2 = await skill.execute(input, ctx);

        assert.deepStrictEqual(r1.output, r2.output, "output must be deepStrictEqual");
        assert.deepStrictEqual(r1.trace, r2.trace, "trace must be deepStrictEqual");
        // Confirm prompt_version is wired from the prompt module
        assert.strictEqual(r1.trace.llm_call.prompt_version, "explain_v1",
            "llm_call.prompt_version must equal PROMPT_VERSION from module");
    });

    await test("invalid_output: bad schema → fallback_reason=invalid_output", async () => {
        // Adapter returns a response that fails isValidOutput (no explanation/bullets)
        class BadOutputAdapter {
            get modelInfo() { return { provider: "mock", model_name: "mock-bad", version: "1.0.0" }; }
            async generateStructuredJSON(input) {
                return {
                    data: { summary: "some text" }, // wrong shape
                    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                    callTrace: {
                        model: this.modelInfo,
                        temperature: input.temperature,
                        prompt_version: input.promptVersion,
                        latency_ms: 0,
                        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                        fallback_used: false,
                    },
                };
            }
        }
        const adapter = new BadOutputAdapter();
        const skill = createExplainFromTraceSkill(adapter);
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            decision_trace: { extract_intent: { city: "london", type: "food", tags: ["pasta"], confidence: 0.9 } },
            user_text: "food in london",
        };

        const result = await skill.execute(input, ctx);

        assert.strictEqual(result.trace.fallback_used, true, "fallback_used must be true");
        assert.strictEqual(result.trace.fallback_reason, "invalid_output", "fallback_reason=invalid_output");
        assert.strictEqual(result.output.explanation, "Explanation unavailable.", "explanation is fallback text");
        assert.deepStrictEqual(result.output.bullets, [], "bullets empty on invalid_output");
        // Must NOT set trace.error (only adapter_error sets it)
        assert.strictEqual(result.trace.error, undefined, "error must not be set for invalid_output");
    });

    await test("token_budget_exceeded: usage > limit → local fallback, fallback_reason=token_budget_exceeded", async () => {
        // Adapter returns valid output but with total_tokens > 1000 (EXPLAIN_MAX_TOTAL_TOKENS default)
        class HighTokenExplainAdapter {
            get modelInfo() { return { provider: "mock", model_name: "mock-high-token", version: "1.0.0" }; }
            async generateStructuredJSON(input) {
                return {
                    data: {
                        explanation: "Some valid explanation from LLM.",
                        bullets: ["bullet 1", "bullet 2", "bullet 3"],
                    },
                    usage: { prompt_tokens: 500, completion_tokens: 502, total_tokens: 1001 },
                    callTrace: {
                        model: this.modelInfo,
                        temperature: input.temperature,
                        prompt_version: input.promptVersion,
                        latency_ms: 0,
                        usage: { prompt_tokens: 500, completion_tokens: 502, total_tokens: 1001 },
                        fallback_used: false,
                    },
                };
            }
        }
        const adapter = new HighTokenExplainAdapter();
        const skill = createExplainFromTraceSkill(adapter);
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            decision_trace: {
                extract_intent: { city: "paris", type: "cafe", tags: ["coffee"], confidence: 0.85 },
            },
            user_text: "cafe in paris",
        };

        const r1 = await skill.execute(input, ctx);
        const r2 = await skill.execute(input, ctx);

        assert.strictEqual(r1.trace.fallback_used, true, "fallback_used must be true");
        assert.strictEqual(r1.trace.fallback_reason, "token_budget_exceeded", "fallback_reason=token_budget_exceeded");
        // Local fallback must be deterministic (not "Explanation unavailable.")
        assert.ok(r1.output.explanation.length > 0, "local fallback explanation non-empty");
        assert.notStrictEqual(r1.output.explanation, "Explanation unavailable.", "must not be error text");
        assert.ok(Array.isArray(r1.output.bullets) && r1.output.bullets.length >= 3, "local fallback has >=3 bullets");
        // Determinism
        assert.deepStrictEqual(r1.output, r2.output, "output deterministic");
        assert.deepStrictEqual(r1.trace, r2.trace, "trace deterministic");
        // Must NOT set trace.error
        assert.strictEqual(r1.trace.error, undefined, "error must not be set for token_budget_exceeded");
    });

    await test("compaction: oversized trace (10 cards) is capped — cards<=6, items<=3, tags<=5, JSON<=8KB", async () => {
        let capturedTraceContext = null;

        class CapturingAdapter {
            get modelInfo() { return { provider: "mock", model_name: "mock-capture", version: "1.0.0" }; }
            async generateStructuredJSON(input) {
                capturedTraceContext = input.traceContext;
                return {
                    data: {
                        explanation: "Capped trace explanation.",
                        bullets: ["bullet 1", "bullet 2", "bullet 3"],
                    },
                    usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
                    callTrace: {
                        model: this.modelInfo,
                        temperature: input.temperature,
                        prompt_version: input.promptVersion,
                        latency_ms: 0,
                        usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
                        fallback_used: false,
                    },
                };
            }
        }

        // Build an oversized trace: 10 cards, each with 5 items, each item has 8 tags
        const oversizedCards = Array.from({ length: 10 }, (_, i) => ({
            zone: i % 2 === 0 ? "CZ" : "EZ",
            label: `Card ${i}`,
            items: Array.from({ length: 5 }, (_, j) => ({
                id: `item_${i}_${j}`,
                name: `Restaurant ${i}-${j}`,
                tags: Array.from({ length: 8 }, (_, k) => `tag_${k}`),
                reasons: Array.from({ length: 8 }, (_, k) => `reason_${k}`),
                score: 0.9 - j * 0.1,
            })),
        }));

        const adapter = new CapturingAdapter();
        const skill = createExplainFromTraceSkill(adapter);
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            decision_trace: {
                extract_intent: { city: "seoul", type: "bbq", tags: ["grilled", "meat", "beef", "pork", "chicken", "spicy", "side", "banchan"], confidence: 0.95 },
                build_cards: {
                    rule_id: "planner_v1",
                    cards_count: 10,
                    cards: oversizedCards,
                },
            },
            user_text: "bbq in seoul",
        };

        await skill.execute(input, ctx);

        assert.ok(capturedTraceContext !== null, "traceContext was captured");

        // intent.tags should be capped at 5
        const intentTags = capturedTraceContext.intent?.tags;
        assert.ok(Array.isArray(intentTags), "intent.tags is array");
        assert.ok(intentTags.length <= 5, `intent.tags capped to 5, got ${intentTags.length}`);

        // planner.cards should be capped at 6
        const plannerCards = capturedTraceContext.planner?.cards;
        assert.ok(Array.isArray(plannerCards), "planner.cards is array");
        assert.ok(plannerCards.length <= 6, `cards capped to 6, got ${plannerCards.length}`);

        // items per card should be capped at 3
        for (const card of plannerCards) {
            if (Array.isArray(card.items)) {
                assert.ok(card.items.length <= 3, `items per card capped to 3, got ${card.items.length}`);
                // tags per item should be capped at 5
                for (const item of card.items) {
                    if (Array.isArray(item.tags)) {
                        assert.ok(item.tags.length <= 5, `tags per item capped to 5, got ${item.tags.length}`);
                    }
                    if (Array.isArray(item.reasons)) {
                        assert.ok(item.reasons.length <= 5, `reasons per item capped to 5, got ${item.reasons.length}`);
                    }
                }
            }
        }

        // Serialized compact must be <= 8KB
        const compactJson = JSON.stringify(capturedTraceContext);
        assert.ok(
            compactJson.length <= 8 * 1024,
            `compact JSON must be <= 8KB, got ${compactJson.length} bytes`
        );
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

    await test("RECOMMENDATION_GRAPH keeps explain_from_trace after build_profile_vector", () => {
        const nodeIds = RECOMMENDATION_GRAPH.nodes.map((n) => n.id);
        const requiredNodeIds = [
            "vision_describe",
            "tes_builder",
            "memory_weight_adjust",
            "build_profile_vector",
            "explain_from_trace",
        ];
        for (const requiredId of requiredNodeIds) {
            assert.ok(nodeIds.includes(requiredId), `graph must include node ${requiredId}`);
        }

        const explainNode = RECOMMENDATION_GRAPH.nodes.find((n) => n.id === "explain_from_trace");
        assert.ok(explainNode, "explain_from_trace node must exist");
        assert.strictEqual(explainNode.id, "explain_from_trace");
        assert.strictEqual(explainNode.skill, "explain_from_trace");
        assert.ok(explainNode.inputFrom.decision_trace, "has decision_trace input");
        assert.ok(explainNode.inputFrom.user_text, "has user_text input");

        const profileIdx = nodeIds.indexOf("build_profile_vector");
        const explainIdx = nodeIds.indexOf("explain_from_trace");
        assert.ok(profileIdx !== -1 && explainIdx !== -1 && profileIdx < explainIdx,
            "build_profile_vector must execute before explain_from_trace");

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
