#!/usr/bin/env node
/**
 * Smoke tests for fetch_recommendation skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_fetch_recommendation.js
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
const { createFetchRecommendationSkill } = skills;

class StubToolClient {
    constructor(handler) {
        this.handler = handler;
    }

    async call(action) {
        return this.handler(action);
    }
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
        user_id: "u123",
        city: "Tokyo",
        tags: ["Sushi", "ramen", "sushi"],
        intent_tags: ["food"],
        intent: { city: "tokyo", type: "food" },
        ...overrides,
    };
}

async function runAll() {
    console.log("\n--- fetch_recommendation ---");

    await test("happy path: extracts ranked lists, mix_policy, decision_trace", async () => {
        const client = new StubToolClient(async (action) => {
            assert.strictEqual(action.tool, "recommendation.score");
            assert.strictEqual(action.input.data.city, "tokyo");
            assert.strictEqual(action.input.data.user_id, "u123");
            assert.deepStrictEqual(action.input.data.tags, ["ramen", "sushi"]);
            return {
                ok: true,
                tool: "recommendation.score",
                trace_id: "t_ok",
                latency_ms: 11,
                output: {
                    cz_ranked: [{ id: "cz1", score_CZ: 0.9 }],
                    ez_ranked: [{ id: "ez1", score_EZ: 0.7 }],
                    mix_policy: { ratio: "3:1", rule: "comfort_high" },
                    decision_trace: {
                        recall: { rule_id: "recall_v1" },
                        rerank: { rule_id: "rerank_v1" },
                    },
                },
            };
        });

        const skill = createFetchRecommendationSkill(client);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));

        assert.deepStrictEqual(result.output.cz_ranked, [{ id: "cz1", score_CZ: 0.9 }]);
        assert.deepStrictEqual(result.output.ez_ranked, [{ id: "ez1", score_EZ: 0.7 }]);
        assert.deepStrictEqual(result.output.mix_policy, { ratio: "3:1", rule: "comfort_high" });
        assert.deepStrictEqual(result.output.reco_mix_policy, { ratio: "3:1", rule: "comfort_high" });
        assert.ok(result.output.decision_trace.recall);
        assert.ok(result.output.reco_decision_trace.rerank);

        assert.strictEqual(result.trace.rule_id, "fetch_recommendation_v1");
        assert.strictEqual(result.trace.schema_version, "1.0");
        assert.strictEqual(result.trace.tool, "recommendation.score");
        assert.strictEqual(result.trace.fallback_used, false);
        assert.deepStrictEqual(result.trace.raw_counts, { cz: 1, ez: 1 });
        assert.strictEqual(result.trace.request_summary.city, "tokyo");
        assert.strictEqual(result.trace.request_summary.tags_count, 2);
        assert.strictEqual(result.trace.request_summary.intent_present, true);
        assert.strictEqual(result.trace.latency_ms, 11);
    });

    await test("tool_error fallback: toolClient throws", async () => {
        const client = new StubToolClient(async () => {
            throw new Error("network down");
        });
        const skill = createFetchRecommendationSkill(client);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));

        assert.deepStrictEqual(result.output.cz_ranked, []);
        assert.deepStrictEqual(result.output.ez_ranked, []);
        assert.strictEqual(result.output.mix_policy, null);
        assert.deepStrictEqual(result.output.decision_trace, {});
        assert.strictEqual(result.trace.fallback_used, true);
        assert.strictEqual(result.trace.fallback_reason, "tool_error");
        assert.ok(typeof result.trace.error_message === "string");
        assert.ok(result.trace.error_message.includes("network down"));
    });

    await test("invalid_output fallback: missing ranked list fields", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "recommendation.score",
            trace_id: "t_bad",
            latency_ms: 5,
            output: {
                mix_policy: { ratio: "2:1" },
                decision_trace: { recall: { rule_id: "r" } },
            },
        }));
        const skill = createFetchRecommendationSkill(client);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));

        assert.deepStrictEqual(result.output.cz_ranked, []);
        assert.deepStrictEqual(result.output.ez_ranked, []);
        assert.strictEqual(result.trace.fallback_used, true);
        assert.strictEqual(result.trace.fallback_reason, "invalid_output");
    });

    await test("determinism: same input twice deepStrictEqual (fixed latency mock)", async () => {
        const fixedResponse = {
            ok: true,
            tool: "recommendation.score",
            trace_id: "t_det",
            latency_ms: 9,
            output: {
                cz_ranked: [{ id: "cz1", score_CZ: 0.9 }],
                ez_ranked: [{ id: "ez1", score_EZ: 0.7 }],
                mix_policy: { ratio: "3:1", rule: "comfort_high" },
                decision_trace: { mix_policy: { rule_id: "mix_v1" } },
            },
        };
        const client = new StubToolClient(async () => fixedResponse);
        const skill = createFetchRecommendationSkill(client);
        const input = makeInput();

        const result1 = await skill.execute(input, createExecutionContext({ text: "test" }));
        const result2 = await skill.execute(input, createExecutionContext({ text: "test" }));
        assert.deepStrictEqual(result1, result2);
    });

    await test("orchestrator keeps upstream trace + fetch_recommendation trace", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            tool: "recommendation.score",
            trace_id: "t_merge",
            latency_ms: 7,
            output: {
                cz_ranked: [{ id: "cz1" }],
                ez_ranked: [{ id: "ez1" }],
                mix_policy: { ratio: "3:1" },
                decision_trace: {
                    recall: { rule_id: "recall_v1" },
                },
            },
        }));
        const fetchSkill = createFetchRecommendationSkill(client);

        const registry = new SkillRegistry();
        registry.register({
            name: "upstream",
            inputSchema: { description: "upstream", required: [] },
            outputSchema: { description: "upstream", required: ["city", "user_id", "tags", "intent_tags"] },
            execute: async () => ({
                output: {
                    city: "Tokyo",
                    user_id: "u999",
                    tags: ["sushi", "ramen"],
                    intent_tags: ["food"],
                },
                trace: { rule_id: "upstream_v1", marker: "keep_me" },
            }),
        });
        registry.register(fetchSkill);

        const graph = {
            name: "test_fetch_trace_merge",
            version: "1.0",
            nodes: [
                {
                    id: "upstream",
                    skill: "upstream",
                    inputFrom: {},
                },
                {
                    id: "fetch",
                    skill: "fetch_recommendation",
                    inputFrom: {
                        city: "upstream.city",
                        user_id: "upstream.user_id",
                        tags: "upstream.tags",
                        intent_tags: "upstream.intent_tags",
                    },
                },
            ],
        };

        const orchestrator = new Orchestrator(registry, graph);
        const runResult = await orchestrator.run({ text: "test" });

        assert.strictEqual(runResult.ok, true);
        assert.ok(runResult.decision_trace.upstream, "upstream trace should exist");
        assert.ok(runResult.decision_trace.fetch_recommendation, "fetch_recommendation trace should exist");
        assert.strictEqual(runResult.decision_trace.upstream.marker, "keep_me");
        assert.strictEqual(
            runResult.decision_trace.fetch_recommendation.rule_id,
            "fetch_recommendation_v1"
        );
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL FETCH_RECOMMENDATION TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
