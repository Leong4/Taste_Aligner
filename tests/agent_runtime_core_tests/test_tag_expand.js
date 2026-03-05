#!/usr/bin/env node
/**
 * Smoke tests for tag_expand with fallback coverage.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_tag_expand.js
 */

const assert = require("assert");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();

const { createExecutionContext } = core;
const { createTagExpandSkill } = skills;

class FixedMockAdapter {
    constructor(data) {
        this.data = data;
        this.modelInfo = { provider: "mock", model_name: "mock-v1", version: "1.0.0" };
    }

    async generateStructuredJSON(input) {
        return {
            data: this.data,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            callTrace: {
                model: this.modelInfo,
                temperature: input.temperature,
                prompt_version: input.promptVersion,
                latency_ms: 0,
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                fallback_used: false,
            },
        };
    }
}

class ThrowingAdapter {
    constructor(message = "Timeout") {
        this.message = message;
        this.modelInfo = { provider: "mock", model_name: "mock-v1", version: "1.0.0" };
    }

    async generateStructuredJSON() {
        throw new Error(this.message);
    }
}

class InvalidOutputAdapter {
    constructor(data) {
        this.data = data;
        this.modelInfo = { provider: "mock", model_name: "mock-v1", version: "1.0.0" };
    }

    async generateStructuredJSON(input) {
        return {
            data: this.data,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            callTrace: {
                model: this.modelInfo,
                temperature: input.temperature,
                prompt_version: input.promptVersion,
                latency_ms: 0,
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                fallback_used: false,
            },
        };
    }
}

/** Returns valid tag data but reports total_tokens=801 to trigger the budget guard. */
class HighTokenAdapter {
    constructor() {
        this.modelInfo = { provider: "mock", model_name: "mock-v1", version: "1.0.0" };
    }

    async generateStructuredJSON(input) {
        const usage = { prompt_tokens: 400, completion_tokens: 401, total_tokens: 801 };
        return {
            data: {
                hard_expansions: [{ tag: "izakaya", confidence: 0.9 }],
                soft_expansions: [{ tag: "quiet", confidence: 0.75 }],
            },
            usage,
            callTrace: {
                model: this.modelInfo,
                temperature: input.temperature,
                prompt_version: input.promptVersion,
                latency_ms: 0,
                usage,
                fallback_used: false,
            },
        };
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
        user_text: "I want quiet cozy ramen and local culture in tokyo",
        intent: {
            tags: ["ramen", "food"],
            type: "mixed",
        },
        tag_budget: {
            budget: 8,
            hard_expand_limit: 2,
            soft_expand_limit: 2,
            thresholds: {
                min_confidence_soft: 0.6,
                min_confidence_hard: 0.55,
            },
        },
        ...overrides,
    };
}

function assertFallback(result, reason, expectedSeed) {
    assert.deepStrictEqual(result.output.tags_seed, expectedSeed, "fallback should preserve seed tags");
    assert.deepStrictEqual(result.output.tags_final, expectedSeed, "fallback tags_final must equal seed_tags");
    assert.deepStrictEqual(result.output.tags_added, [], "fallback tags_added must be []");
    assert.deepStrictEqual(result.output.tags_dropped, [], "fallback tags_dropped must be []");
    assert.strictEqual(result.trace.fallback_used, true, "fallback_used must be true");
    assert.strictEqual(result.trace.fallback_reason, reason, `fallback_reason should be ${reason}`);
}

async function runAll() {
    console.log("\n--- tag_expand ---");

    await test("normal flow: tags_final includes seed + added", async () => {
        const adapter = new FixedMockAdapter({
            hard_expansions: [{ tag: "izakaya", confidence: 0.9 }],
            soft_expansions: [{ tag: "quiet", confidence: 0.8 }],
        });
        const skill = createTagExpandSkill(adapter);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));

        assert.strictEqual(result.trace.fallback_used, false);
        assert.deepStrictEqual(result.output.tags_seed, ["ramen", "food"]);
        assert.deepStrictEqual(result.output.tags_added, ["izakaya", "quiet"]);
        assert.deepStrictEqual(result.output.tags_final, ["ramen", "food", "izakaya", "quiet"]);
        assert.ok(Array.isArray(result.output.tags_dropped));
    });

    await test("fallback: adapter_error", async () => {
        const adapter = new ThrowingAdapter("Timeout");
        const skill = createTagExpandSkill(adapter);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));

        assertFallback(result, "adapter_error", ["ramen", "food"]);
        assert.ok(result.trace.error_message.includes("Timeout"), "error_message should include adapter error");
    });

    await test("fallback: invalid_output (malformed/non-object data)", async () => {
        const adapter = new InvalidOutputAdapter("not-json-object");
        const skill = createTagExpandSkill(adapter);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));

        assertFallback(result, "invalid_output", ["ramen", "food"]);
    });

    await test("fallback: empty_generation (no generated tags and no seed)", async () => {
        const adapter = new FixedMockAdapter({
            hard_expansions: [],
            soft_expansions: [],
        });
        const skill = createTagExpandSkill(adapter);
        const input = makeInput({
            intent: {
                tags: [],
                type: "unknown",
            },
        });
        const result = await skill.execute(input, createExecutionContext({ text: "test" }));

        assertFallback(result, "empty_generation", []);
    });

    await test("fallback: all_filtered (generated tags exist but all dropped)", async () => {
        const adapter = new FixedMockAdapter({
            hard_expansions: [{ tag: "bad###", confidence: 0.9 }],
            soft_expansions: [{ tag: "too_low", confidence: 0.1 }],
        });
        const skill = createTagExpandSkill(adapter);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));

        assertFallback(result, "all_filtered", ["ramen", "food"]);
    });

    await test("determinism: identical input produces deepStrictEqual output+trace", async () => {
        const adapter = new FixedMockAdapter({
            hard_expansions: [{ tag: "izakaya", confidence: 0.91 }],
            soft_expansions: [{ tag: "quiet", confidence: 0.75 }],
        });
        const skill = createTagExpandSkill(adapter);
        const input = makeInput();

        const result1 = await skill.execute(input, createExecutionContext({ text: "test" }));
        const result2 = await skill.execute(input, createExecutionContext({ text: "test" }));
        assert.deepStrictEqual(result1.output, result2.output);
        assert.deepStrictEqual(result1.trace, result2.trace);
    });

    await test("trace contains required fields in non-fallback path", async () => {
        const adapter = new FixedMockAdapter({
            hard_expansions: [{ tag: "izakaya", confidence: 0.9 }],
            soft_expansions: [{ tag: "quiet", confidence: 0.8 }],
        });
        const skill = createTagExpandSkill(adapter);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));
        const t = result.trace;

        assert.strictEqual(t.rule_id, "tag_expand_v1");
        assert.strictEqual(t.schema_version, "1.0");
        assert.strictEqual(typeof t.provider, "string");
        assert.strictEqual(typeof t.model_name, "string");
        assert.strictEqual(t.prompt_version, "v1");
        assert.ok(t.limits && typeof t.limits.hard_expand_limit === "number");
        assert.ok(t.thresholds && typeof t.thresholds.min_confidence_soft === "number");
        assert.ok(t.raw_counts && typeof t.raw_counts.hard_generated === "number");
        assert.ok(t.kept_counts && typeof t.kept_counts.soft_kept === "number");
        assert.ok(t.drop_stats && typeof t.drop_stats.by_invalid === "number");
        assert.strictEqual(t.fallback_used, false);
        assert.strictEqual(t.fallback_reason, "");
        assert.strictEqual(t.error_message, "");
    });

    await test(">20 valid tags from LLM → capped at exactly 20 (hard tags take priority)", async () => {
        // Return 12 hard + 12 soft expansions — all valid, all above threshold, all unique.
        // With expanded limits (15/15), all 24 pass filtering.
        // The slice(0, MAX_GENERATED_TAGS=20) must cap the result deterministically.
        const adapter = new FixedMockAdapter({
            hard_expansions: Array.from({ length: 12 }, (_, i) => ({
                tag: `tag${String(i + 1).padStart(2, "0")}`,
                confidence: 0.9,
            })),
            soft_expansions: Array.from({ length: 12 }, (_, i) => ({
                tag: `stag${String(i + 1).padStart(2, "0")}`,
                confidence: 0.75,
            })),
        });
        const skill = createTagExpandSkill(adapter);
        const input = makeInput({
            tag_budget: {
                budget: 40,
                hard_expand_limit: 15,
                soft_expand_limit: 15,
                thresholds: { min_confidence_soft: 0.6, min_confidence_hard: 0.55 },
            },
        });
        const result = await skill.execute(input, createExecutionContext({ text: "test" }));

        assert.strictEqual(result.trace.fallback_used, false, "should not fall back");
        assert.strictEqual(result.output.tags_added.length, 20,
            "tags_added capped at MAX_GENERATED_TAGS=20");
        // Hard tags fill the first 12 slots; soft tags fill the remaining 8.
        assert.ok(result.output.tags_added.every((t) => typeof t === "string"),
            "all tags_added are strings");
        // Determinism: same input always produces the same 20 tags.
        const result2 = await skill.execute(input, createExecutionContext({ text: "test" }));
        assert.deepStrictEqual(result.output.tags_added, result2.output.tags_added,
            "tag cap is deterministic across calls");
    });

    await test("wrong-schema JSON from LLM ({ tags: [...] }) → invalid_output fallback", async () => {
        // Adapter returns an object with wrong keys — not the expected shape.
        const adapter = new InvalidOutputAdapter({ tags: ["ramen", "izakaya"] });
        const skill = createTagExpandSkill(adapter);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));

        assertFallback(result, "invalid_output", ["ramen", "food"]);
    });

    await test("token_budget_exceeded: total_tokens > 800 → deterministic fallback", async () => {
        const adapter = new HighTokenAdapter();
        const skill = createTagExpandSkill(adapter);
        const result = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));

        assertFallback(result, "token_budget_exceeded", ["ramen", "food"]);
        // llm_call must still be present (the call completed, just over budget)
        assert.ok(result.trace.llm_call, "llm_call present even on token_budget_exceeded");
        assert.strictEqual(result.trace.llm_call.usage.total_tokens, 801,
            "llm_call.usage reflects actual token count");

        // Determinism
        const result2 = await skill.execute(makeInput(), createExecutionContext({ text: "test" }));
        assert.deepStrictEqual(result, result2, "token_budget_exceeded is deterministic");
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL TAG_EXPAND TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
