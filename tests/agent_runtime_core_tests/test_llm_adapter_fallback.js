#!/usr/bin/env node
/**
 * Tests for LLM adapter fallback behavior.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_llm_adapter_fallback.js
 *
 * Tests:
 *   1. LLM_PROVIDER=openai_compat + no LLM_API_KEY → FallbackMockAdapter
 *      (adapter-level fallback: modelInfo.provider=mock, fallbackReason=missing_api_key)
 *   2. Unknown LLM_PROVIDER → FallbackMockAdapter with reason=unknown_provider
 *   3. OpenAICompatAdapter: modelInfo is correctly set
 *   4. OpenAICompatAdapter + closed port → explain_from_trace skill fallback
 *      (skill-level fallback: trace.fallback_used=true, trace.error present)
 *   5. FallbackMockAdapter: explain_from_trace records fallback_reason in trace.llm_call
 */

const assert = require("assert");
const { loadCore, loadLLM, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const llm = loadLLM();
const skills = loadSkills();

const { createExecutionContext } = core;
const { createLLMAdapterFromEnv, OpenAICompatAdapter } = llm;
const { createExplainFromTraceSkill, createTagExpandSkill } = skills;

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

const MINIMAL_INPUT = {
    decision_trace: { extract_intent: { city: "tokyo" } },
    user_text: "ramen in tokyo",
};

// ---------------------------------------------------------------------------
// Helpers for env var isolation
// ---------------------------------------------------------------------------

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    }
    const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
    let result;
    try {
        result = fn();
    } catch (e) {
        restore();
        throw e;
    }
    if (result && typeof result.then === "function") {
        return result.then(
            (v) => { restore(); return v; },
            (e) => { restore(); throw e; }
        );
    }
    restore();
    return result;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

async function runAll() {
    // =========================================================================
    // 1. Adapter-level fallback: missing API key
    // =========================================================================
    console.log("\n--- createLLMAdapterFromEnv: missing API key ---");

    await test(
        "LLM_PROVIDER=openai_compat without LLM_API_KEY → FallbackMockAdapter",
        () => withEnv({ LLM_PROVIDER: "openai_compat", LLM_API_KEY: undefined }, () => {
            const adapter = createLLMAdapterFromEnv();
            assert.strictEqual(adapter.modelInfo.provider, "mock",
                "provider is mock (fallback stands in for openai_compat)");
            assert.strictEqual(adapter.fallbackReason, "missing_api_key",
                "fallbackReason set on adapter");
        })
    );

    await test(
        "FallbackMockAdapter: explain_from_trace records fallback_reason in llm_call",
        async () => withEnv({ LLM_PROVIDER: "openai_compat", LLM_API_KEY: undefined }, async () => {
            const adapter = createLLMAdapterFromEnv();
            const skill = createExplainFromTraceSkill(adapter);
            const ctx = createExecutionContext({ text: "test" });

            const result = await skill.execute(MINIMAL_INPUT, ctx);

            // Adapter is fallback mock, so skill-level fallback flags must be visible.
            assert.strictEqual(result.trace.fallback_used, true,
                "skill-level fallback_used=true for adapter fallback");
            assert.strictEqual(result.trace.fallback_reason, "missing_api_key",
                "skill-level fallback_reason propagated");
            assert.ok(typeof result.output.explanation === "string",
                "explanation is present");
            assert.ok(result.output.explanation.length > 0,
                "explanation not empty");

            // llm_call should carry fallback_used=true + fallback_reason
            const llmCall = result.trace.llm_call;
            assert.ok(llmCall, "llm_call present in trace");
            assert.strictEqual(llmCall.provider, "mock", "llm_call.provider=mock");
            assert.strictEqual(llmCall.fallback_used, true,
                "llm_call.fallback_used=true (adapter-level)");
            assert.strictEqual(llmCall.fallback_reason, "missing_api_key",
                "llm_call.fallback_reason propagated from adapter");
        })
    );

    await test(
        "determinism (mock): explain_from_trace deepStrictEqual on repeated calls",
        async () => withEnv({ LLM_PROVIDER: "mock" }, async () => {
            const adapter = createLLMAdapterFromEnv();
            const skill = createExplainFromTraceSkill(adapter);
            const ctx = createExecutionContext({ text: "test" });
            const r1 = await skill.execute(MINIMAL_INPUT, ctx);
            const r2 = await skill.execute(MINIMAL_INPUT, ctx);
            assert.deepStrictEqual(r1, r2);
        })
    );

    await test(
        "determinism (mock): tag_expand deepStrictEqual on repeated calls",
        async () => withEnv({ LLM_PROVIDER: "mock" }, async () => {
            const adapter = createLLMAdapterFromEnv();
            const skill = createTagExpandSkill(adapter);
            const input = {
                user_text: "I want cozy ramen in tokyo",
                intent: { tags: ["ramen", "food"], type: "mixed" },
                tag_budget: {
                    budget: 8,
                    hard_expand_limit: 2,
                    soft_expand_limit: 2,
                    thresholds: { min_confidence_soft: 0.6, min_confidence_hard: 0.55 },
                },
            };
            const ctx = createExecutionContext({ text: "test" });
            const r1 = await skill.execute(input, ctx);
            const r2 = await skill.execute(input, ctx);
            assert.deepStrictEqual(r1, r2);
        })
    );

    // =========================================================================
    // 2. Adapter-level fallback: unknown provider
    // =========================================================================
    console.log("\n--- createLLMAdapterFromEnv: unknown provider ---");

    await test(
        "unknown LLM_PROVIDER → FallbackMockAdapter with reason=unknown_provider",
        () => withEnv({ LLM_PROVIDER: "not_a_real_provider" }, () => {
            const adapter = createLLMAdapterFromEnv();
            assert.strictEqual(adapter.modelInfo.provider, "mock");
            assert.strictEqual(adapter.fallbackReason, "unknown_provider");
        })
    );

    // =========================================================================
    // 3. OpenAICompatAdapter: static properties
    // =========================================================================
    console.log("\n--- OpenAICompatAdapter: static properties ---");

    await test(
        "modelInfo has provider=openai_compat and specified model",
        () => {
            const adapter = new OpenAICompatAdapter({
                apiKey: "sk-test",
                model: "gpt-4o",
            });
            assert.strictEqual(adapter.modelInfo.provider, "openai_compat");
            assert.strictEqual(adapter.modelInfo.model_name, "gpt-4o");
            assert.strictEqual(adapter.modelInfo.version, "1.0.0");
            assert.strictEqual(adapter.fallbackReason, undefined,
                "real adapter has no fallbackReason");
        }
    );

    await test(
        "defaults to gpt-4o-mini when no model specified",
        () => withEnv({ LLM_MODEL: undefined }, () => {
            const adapter = new OpenAICompatAdapter({ apiKey: "sk-test" });
            assert.strictEqual(adapter.modelInfo.model_name, "gpt-4o-mini");
        })
    );

    // =========================================================================
    // 4. Skill-level fallback: network error (ECONNREFUSED)
    // =========================================================================
    console.log("\n--- OpenAICompatAdapter + closed port → skill fallback ---");

    await test(
        "ECONNREFUSED → explain_from_trace fallback_used=true, error present",
        async () => {
            // Port 1 is always closed (ECONNREFUSED) with no delay.
            const adapter = new OpenAICompatAdapter({
                apiKey: "dummy",
                baseUrl: "http://127.0.0.1:1",
                maxRetries: 0,
            });

            const skill = createExplainFromTraceSkill(adapter);
            const ctx = createExecutionContext({ text: "test" });

            // Skill MUST NOT throw — it catches adapter errors gracefully
            const result = await skill.execute(MINIMAL_INPUT, ctx);

            assert.strictEqual(result.trace.fallback_used, true,
                "skill-level fallback_used=true");
            assert.strictEqual(result.trace.fallback_reason, "adapter_error",
                "skill-level fallback_reason=adapter_error");
            assert.strictEqual(result.trace.error, "adapter_error",
                "trace.error is stable enum");
            assert.strictEqual(result.output.explanation, "Explanation unavailable.",
                "fallback explanation");
            assert.deepStrictEqual(result.output.bullets, [],
                "fallback bullets empty");

            const llmCall = result.trace.llm_call;
            assert.ok(llmCall, "llm_call present even on error");
            assert.strictEqual(llmCall.provider, "openai_compat",
                "provider=openai_compat in error trace");
            assert.strictEqual(llmCall.fallback_used, true,
                "llm_call.fallback_used=true on error");
            assert.strictEqual(llmCall.fallback_reason, "adapter_error",
                "llm_call fallback reason is normalized");

            // Deterministic even when network is unreachable.
            const result2 = await skill.execute(MINIMAL_INPUT, ctx);
            assert.deepStrictEqual(result, result2);
        }
    );

    // =========================================================================
    // Summary
    // =========================================================================
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL LLM_ADAPTER_FALLBACK TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
