#!/usr/bin/env node
/**
 * Smoke tests for vision_describe skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_vision_describe.js
 */

const assert = require("assert");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();

const { createExecutionContext } = core;
const { createVisionDescribeSkill } = skills;

class StubToolClient {
    constructor(handler) {
        this.handler = handler;
    }
    async call(action) {
        return this.handler(action);
    }
}

function makeContext() {
    return createExecutionContext({ text: "test", request_ts: 1704067200000 });
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

async function runAll() {
    console.log("\n--- vision_describe ---");

    // ── no_image fallback (no gateway call) ───────────────────────────────────
    await test("no_image fallback: no gateway call, empty vision_features", async () => {
        let called = false;
        const client = new StubToolClient(async () => {
            called = true;
            return {};
        });
        const skill = createVisionDescribeSkill(client);
        const result = await skill.execute({}, makeContext());

        assert.strictEqual(called, false, "gateway must NOT be called for no_image");
        assert.deepStrictEqual(result.output.vision_features, []);
        assert.strictEqual(result.output.used, false);
        assert.strictEqual(result.output.fallback_used, true);
        assert.strictEqual(result.output.fallback_reason, "no_image");
        assert.strictEqual(result.output.tags_count, 0);
        assert.strictEqual(result.output.decision_trace.vision_describe.rule_id, "vision_describe_v1");
        assert.strictEqual(result.output.decision_trace.vision_describe.fallback_reason, "no_image");
    });

    await test("no_image fallback: whitespace-only fields treated as absent", async () => {
        let called = false;
        const client = new StubToolClient(async () => {
            called = true;
            return {};
        });
        const skill = createVisionDescribeSkill(client);
        const result = await skill.execute({ image_url: "   ", image_base64: "\t" }, makeContext());
        assert.strictEqual(called, false);
        assert.strictEqual(result.output.fallback_reason, "no_image");
    });

    // ── tool_error fallback ───────────────────────────────────────────────────
    await test("tool_error fallback: gateway throws", async () => {
        const client = new StubToolClient(async () => {
            throw new Error("connection refused");
        });
        const skill = createVisionDescribeSkill(client);
        const result = await skill.execute({ image_url: "http://example.com/img.jpg" }, makeContext());

        assert.deepStrictEqual(result.output.vision_features, []);
        assert.strictEqual(result.output.fallback_used, true);
        assert.strictEqual(result.output.fallback_reason, "tool_error");
        assert.strictEqual(result.output.used, false);
    });

    await test("tool_error fallback: gateway returns ok=false", async () => {
        const client = new StubToolClient(async () => ({
            ok: false,
            error: { message: "service_unavailable" },
            latency_ms: 50,
        }));
        const skill = createVisionDescribeSkill(client);
        const result = await skill.execute({ image_base64: "abc123" }, makeContext());

        assert.strictEqual(result.output.fallback_reason, "tool_error");
        assert.strictEqual(result.output.fallback_used, true);
    });

    // ── invalid_output fallback ───────────────────────────────────────────────
    await test("invalid_output fallback: output has no tags array", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            latency_ms: 10,
            output: { backend: "clip_v1" }, // missing tags
        }));
        const skill = createVisionDescribeSkill(client);
        const result = await skill.execute({ image_url: "http://example.com/img.jpg" }, makeContext());

        assert.strictEqual(result.output.fallback_reason, "invalid_output");
        assert.deepStrictEqual(result.output.vision_features, []);
    });

    // ── success path ──────────────────────────────────────────────────────────
    await test("success: tags sorted, deduped, lowercased", async () => {
        const client = new StubToolClient(async (action) => {
            assert.strictEqual(action.tool, "vision.describe");
            assert.ok(action.input.data.image_url, "image_url must be forwarded in data");
            return {
                ok: true,
                latency_ms: 42,
                output: {
                    tags: ["Ramen", "CAFE", "ramen", "  izakaya  ", "cafe"],
                    backend: "clip_v1",
                    model_id: "ViT-B-32/openai",
                    device: "cpu",
                },
            };
        });
        const skill = createVisionDescribeSkill(client);
        const result = await skill.execute(
            { image_url: "http://example.com/dish.jpg" },
            makeContext()
        );

        assert.strictEqual(result.output.used, true);
        assert.strictEqual(result.output.fallback_used, false);
        // sorted, deduped, lowercased: cafe < izakaya < ramen
        assert.deepStrictEqual(result.output.vision_features, ["cafe", "izakaya", "ramen"]);
        assert.strictEqual(result.output.tags_count, 3);
        assert.strictEqual(result.output.backend, "clip_v1");
        assert.strictEqual(result.output.model_id, "ViT-B-32/openai");
        assert.strictEqual(result.output.device, "cpu");
        assert.strictEqual(result.output.latency_ms, 42);

        const trace = result.output.decision_trace.vision_describe;
        assert.strictEqual(trace.rule_id, "vision_describe_v1");
        assert.strictEqual(trace.schema_version, "1.0");
        assert.strictEqual(trace.used, true);
        assert.strictEqual(trace.fallback_used, false);
        assert.strictEqual(trace.tags_count, 3);
        assert.strictEqual(trace.backend, "clip_v1");
        assert.strictEqual(trace.input_summary.has_url, true);
        assert.strictEqual(trace.input_summary.has_base64, false);
    });

    await test("success: base64 forwarded, model_id null accepted", async () => {
        const client = new StubToolClient(async (action) => {
            assert.ok(action.input.data.image_base64, "image_base64 must be forwarded in data");
            assert.strictEqual(action.input.data.image_url, undefined);
            return {
                ok: true,
                latency_ms: 15,
                output: {
                    tags: ["garden", "outdoor"],
                    backend: "rule_v0",
                    model_id: null,
                    device: "cpu",
                },
            };
        });
        const skill = createVisionDescribeSkill(client);
        const result = await skill.execute(
            { image_base64: "iVBORw0KGgo=" },
            makeContext()
        );

        assert.strictEqual(result.output.used, true);
        assert.deepStrictEqual(result.output.vision_features, ["garden", "outdoor"]);
        assert.strictEqual(result.output.model_id, null);
        assert.strictEqual(result.trace.input_summary.has_url, false);
        assert.strictEqual(result.trace.input_summary.has_base64, true);
    });

    await test("determinism: same input twice deepStrictEqual", async () => {
        const fixed = {
            ok: true,
            latency_ms: 8,
            output: {
                tags: ["noodles", "street_food"],
                backend: "clip_v1",
                model_id: "ViT-B-32/openai",
                device: "cpu",
            },
        };
        const client = new StubToolClient(async () => fixed);
        const skill = createVisionDescribeSkill(client);
        const input = { image_url: "http://example.com/img.jpg" };
        const ctx = makeContext();
        const r1 = await skill.execute(input, ctx);
        const r2 = await skill.execute(input, ctx);
        assert.deepStrictEqual(r1.output.vision_features, r2.output.vision_features);
    });

    // ── V1 schema (clip_v1 cues + vision_type) ────────────────────────────────
    await test("clip_v1 V1 schema: cues merged with tags, vision_type in trace", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            latency_ms: 20,
            output: {
                backend: "clip_v1",
                type: "food",
                cues: ["ramen", "noodles", "izakaya"],
                tags: ["RAMEN", "cafe"],   // "ramen" deduped across cues+tags
                model_id: "ViT-B-32/openai",
                device: "cuda",
            },
        }));
        const skill = createVisionDescribeSkill(client);
        const result = await skill.execute(
            { image_url: "http://example.com/dish.jpg" },
            makeContext()
        );

        assert.strictEqual(result.output.used, true);
        assert.strictEqual(result.output.fallback_used, false);
        // cafe < izakaya < noodles < ramen — merged, deduped, lowercased, sorted
        assert.deepStrictEqual(result.output.vision_features, ["cafe", "izakaya", "noodles", "ramen"]);
        assert.strictEqual(result.output.tags_count, 4);

        const trace = result.output.decision_trace.vision_describe;
        assert.strictEqual(trace.vision_type, "food", "vision_type must be propagated from V1 schema");
        assert.strictEqual(trace.used, true);
        assert.strictEqual(trace.backend, "clip_v1");
    });

    await test("V1 schema cues-only (no tags field): cues used as sole source", async () => {
        const client = new StubToolClient(async () => ({
            ok: true,
            latency_ms: 12,
            output: {
                backend: "clip_v1",
                type: "scenery",
                cues: ["temple", "Garden", "  outdoor  "],
                // no tags field
                model_id: "ViT-B-32/openai",
                device: "cpu",
            },
        }));
        const skill = createVisionDescribeSkill(client);
        const result = await skill.execute(
            { image_base64: "iVBORw0KGgo=" },
            makeContext()
        );

        assert.strictEqual(result.output.used, true);
        assert.strictEqual(result.output.fallback_used, false);
        // garden < outdoor < temple
        assert.deepStrictEqual(result.output.vision_features, ["garden", "outdoor", "temple"]);
        assert.strictEqual(result.trace.vision_type, "scenery");
    });

    await test("top_k clamped and forwarded", async () => {
        let capturedTopK;
        const client = new StubToolClient(async (action) => {
            capturedTopK = action.input.data.top_k;
            return {
                ok: true,
                latency_ms: 5,
                output: { tags: ["ramen"], backend: "clip_v1", device: "cpu" },
            };
        });
        const skill = createVisionDescribeSkill(client);
        // top_k=200 should be clamped to 50
        await skill.execute({ image_url: "http://x.com/img.jpg", top_k: 200 }, makeContext());
        assert.strictEqual(capturedTopK, 50);
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL VISION_DESCRIBE TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
