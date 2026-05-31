#!/usr/bin/env node
/**
 * Integration tests for memory.write side effect in the tes_builder skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_memory_write_integration.js
 *
 * Upload flow detection: any of context.image, context.input.image,
 * context.input.image_url, or context.input.image_base64 triggers memory.write.
 * vision_features alone is NOT sufficient.
 *
 * memory.write is fire-and-forget (never awaited by the skill).
 * trace.memory_write_status is set deterministically to "queued" when triggered.
 *
 * Tests (all offline — uses in-process HTTP stub server):
 *   1. Upload flow (image_url in context) → memory.write called with correct shape,
 *      trace.memory_write_status = "queued"
 *   2. Query-only flow (no image in context) → memory.write NOT called,
 *      trace.memory_persisted = false, no memory_write_status field
 *   3. memory.write server error → skill still succeeds,
 *      trace.memory_write_status = "queued" (fire-and-forget: result discarded)
 *   4. Upload flow with no tags but non-empty vision_features → memory.write still queued
 */

"use strict";

const assert = require("assert");
const http = require("http");
const { loadSkills, loadCore } = require("./_load_src_runtime");

const skills = loadSkills();
const core = loadCore();
const { createTesBuilderSkill } = skills;
const { createExecutionContext } = core;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log("  PASS: " + name);
        passed++;
    } catch (e) {
        console.error("  FAIL: " + name);
        console.error("        " + e.message);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Stub HTTP server helpers
// ---------------------------------------------------------------------------

/**
 * Start an in-process HTTP server that responds with the given statusCode.
 * Returns { port, server, bodyPromise, close, getRequestCount }.
 *
 * bodyPromise resolves with the first parsed request body received.
 */
function startStubMemoryServer(statusCode) {
    statusCode = statusCode !== undefined ? statusCode : 200;
    var resolveBody = null;
    var bodyPromise = new Promise(function (res) { resolveBody = res; });
    var requestCount = 0;
    var lastRequest = null;

    var server = http.createServer(function (req, res) {
        requestCount++;
        var raw = "";
        req.on("data", function (chunk) { raw += chunk; });
        req.on("end", function () {
            var parsed;
            try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
            lastRequest = {
                method: req.method,
                url: req.url,
                body: parsed,
            };
            resolveBody(parsed);
            res.writeHead(statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: statusCode >= 200 && statusCode < 300 }));
        });
    });

    return new Promise(function (resolve) {
        server.listen(0, "127.0.0.1", function () {
            var port = server.address().port;
            resolve({
                port: port,
                server: server,
                bodyPromise: bodyPromise,
                getRequestCount: function () { return requestCount; },
                getLastRequest: function () { return lastRequest; },
                close: function () { return new Promise(function (r) { server.close(r); }); },
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeUnitVector512() {
    var out = Array.from({ length: 512 }, function () { return 0; });
    out[0] = 1;
    return out;
}

function StubToolClient(handler) { this.handler = handler; }
StubToolClient.prototype.call = async function (action) { return this.handler(action); };

function makeSuccessClient() {
    return new StubToolClient(async function () {
        return {
            ok: true,
            tool: "embedding.tes_build",
            trace_id: "t_ok",
            latency_ms: 5,
            output: {
                vector: makeUnitVector512(),
                dim: 512,
                normalized: true,
                meta: { backend: "hash_v2", tes_version: "2.0" },
            },
        };
    });
}

/**
 * makeContext — wraps createExecutionContext with sensible defaults.
 * Pass { image_url, image_base64, image_original_base64 } to simulate an upload request.
 */
function makeContext(overrides) {
    return createExecutionContext(
        Object.assign({ text: "test", user_id: "test_user" }, overrides || {})
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runAll() {
    console.log("\n--- memory.write side effect (tes_builder) ---");

    await test(
        "upload flow: memory.write called when context has root image object, status=queued",
        async function () {
            var stub = await startStubMemoryServer(200);
            process.env.MEMORY_SERVICE_URL = "http://127.0.0.1:" + stub.port;

            try {
                var skill = createTesBuilderSkill(makeSuccessClient());
                var ctx = makeContext({ request_ts: 1704067200000 });
                ctx.image = { kind: "mock-upload", mime: "image/jpeg" };

                var result = await skill.execute(
                    {
                        anchor_tags: ["ramen", "quiet"],
                        normalized_tags: ["ramen", "quiet"],
                        vision_features: ["cozy", "japanese"],
                        vision_type: "food",
                        user_city: "tokyo",
                        request_ts: 1704067200000,
                    },
                    ctx
                );

                assert.strictEqual(result.output.fallback_used, false, "skill must succeed");
                assert.strictEqual(result.trace.memory_persisted, true, "memory_persisted=true");
                assert.strictEqual(result.trace.memory_write_status, "queued",
                    "memory_write_status must be 'queued' for root context.image upload flow");

                var body = await stub.bodyPromise;
                assert.strictEqual(stub.getRequestCount(), 1, "memory.write must be called exactly once");
                assert.ok(body, "stub received request body");
                var req = stub.getLastRequest();
                assert.strictEqual(req.method, "POST");
                assert.strictEqual(req.url, "/write");
                assert.ok(body.data, "memory service payload must wrap request in data");
                assert.strictEqual(body.data.user_id, "test_user", "user_id forwarded");
                assert.strictEqual(body.data.city, "tokyo", "city forwarded");
                assert.strictEqual(body.data.timestamp, "2024-01-01T00:00:00.000Z", "timestamp derived from request_ts");
                assert.strictEqual(result.trace.timestamp_source, "context_request_ts");
                assert.ok(Array.isArray(body.data.embedding) && body.data.embedding.length === 512,
                    "embedding forwarded");
                assert.strictEqual(body.data.source, "upload", "source=upload");
                assert.strictEqual(body.data.vision_type, "food", "vision_type forwarded to memory.write");
            } finally {
                await stub.close();
                delete process.env.MEMORY_SERVICE_URL;
            }
        }
    );

    await test(
        "upload flow: memory.write called when context has image_url, status=queued",
        async function () {
            var stub = await startStubMemoryServer(200);
            process.env.MEMORY_SERVICE_URL = "http://127.0.0.1:" + stub.port;

            try {
                var skill = createTesBuilderSkill(makeSuccessClient());

                // Upload signal is context.input.image_url — NOT vision_features
                var ctx = makeContext({
                    image_url: "http://example.com/dish.jpg",
                    request_ts: 1704067200000,
                });

                var result = await skill.execute(
                    {
                        anchor_tags: ["ramen", "quiet"],
                        normalized_tags: ["ramen", "quiet"],
                        vision_features: ["cozy", "japanese"],
                        user_city: "tokyo",
                        request_ts: 1704067200000,
                    },
                    ctx
                );

                // Skill must succeed
                assert.strictEqual(result.output.fallback_used, false, "skill must succeed");
                assert.strictEqual(result.output.tes_vector.length, 512, "output vector present");

                // Trace flags — status is "queued" (fire-and-forget)
                assert.strictEqual(result.trace.memory_persisted, true, "memory_persisted=true");
                assert.strictEqual(result.trace.memory_write_status, "queued",
                    "memory_write_status must be 'queued' (fire-and-forget, not awaited)");

                // Stub received the write request (fire-and-forget still sends the request)
                var body = await stub.bodyPromise;
                assert.strictEqual(stub.getRequestCount(), 1, "memory.write must be called exactly once");
                assert.ok(body, "stub received request body");
                var req = stub.getLastRequest();
                assert.strictEqual(req.method, "POST");
                assert.strictEqual(req.url, "/write");
                assert.ok(body.data, "memory service payload must wrap request in data");
                assert.strictEqual(body.data.user_id, "test_user", "user_id forwarded");
                assert.strictEqual(body.data.city, "tokyo", "city forwarded");
                assert.strictEqual(body.data.timestamp, "2024-01-01T00:00:00.000Z",
                    "timestamp derived from request_ts");
                assert.strictEqual(result.trace.timestamp_source, "context_request_ts");
                assert.ok(Array.isArray(body.data.embedding) && body.data.embedding.length === 512,
                    "embedding forwarded");
                assert.ok(Array.isArray(body.data.raw_tags), "raw_tags present");
                assert.ok(Array.isArray(body.data.normalized_tags), "normalized_tags present");
                assert.strictEqual(body.data.source, "upload", "source=upload");
                assert.strictEqual(body.data.sentiment, 0.5, "sentiment defaults to neutral 0.5");
                // Must NOT include time-weighting fields (those belong to memory.search only)
                assert.strictEqual(body.data.recency_days, undefined, "no recency_days in body");
                assert.strictEqual(body.data.w_time, undefined, "no w_time in body");
            } finally {
                await stub.close();
                delete process.env.MEMORY_SERVICE_URL;
            }
        }
    );

    await test(
        "upload flow: prefers image_original_base64 and forwards image_vision_input_base64",
        async function () {
            var stub = await startStubMemoryServer(200);
            process.env.MEMORY_SERVICE_URL = "http://127.0.0.1:" + stub.port;

            try {
                var skill = createTesBuilderSkill(makeSuccessClient());
                var ctx = makeContext({
                    image_base64: "data:image/webp;base64,VISION_PAYLOAD",
                    image_original_base64: "data:image/jpeg;base64,ORIGINAL_PAYLOAD",
                    request_ts: 1704067200000,
                });

                var result = await skill.execute(
                    {
                        anchor_tags: ["ramen"],
                        normalized_tags: ["ramen"],
                        vision_features: ["food"],
                        user_city: "tokyo",
                        request_ts: 1704067200000,
                    },
                    ctx
                );

                assert.strictEqual(result.output.fallback_used, false, "skill must succeed");
                assert.strictEqual(result.trace.memory_persisted, true, "memory_persisted=true");
                assert.strictEqual(result.trace.memory_write_status, "queued", "memory_write queued");

                var body = await stub.bodyPromise;
                assert.strictEqual(body.data.image_base64, "data:image/jpeg;base64,ORIGINAL_PAYLOAD");
                assert.strictEqual(
                    body.data.image_vision_input_base64,
                    "data:image/webp;base64,VISION_PAYLOAD",
                    "vision_input payload should be forwarded separately"
                );
            } finally {
                await stub.close();
                delete process.env.MEMORY_SERVICE_URL;
            }
        }
    );

    await test(
        "upload flow: no tags but non-empty vision_features still queues memory.write",
        async function () {
            var stub = await startStubMemoryServer(200);
            process.env.MEMORY_SERVICE_URL = "http://127.0.0.1:" + stub.port;

            try {
                var skill = createTesBuilderSkill(makeSuccessClient());
                var ctx = makeContext({
                    image_base64: "data:image/jpeg;base64,AAAA",
                    request_ts: 1704067200000,
                });

                var result = await skill.execute(
                    {
                        anchor_tags: [],
                        normalized_tags: [],
                        vision_features: ["Scenery", " ramen ", "scenery"],
                        user_city: "tokyo",
                        request_ts: 1704067200000,
                    },
                    ctx
                );

                assert.strictEqual(result.output.fallback_used, false, "skill must succeed");
                assert.strictEqual(result.trace.memory_persisted, true, "memory_persisted=true");
                assert.strictEqual(result.trace.memory_write_status, "queued",
                    "memory_write_status must be queued for vision-only upload flow");
                assert.strictEqual(result.trace.timestamp_source, "context_request_ts");

                var body = await stub.bodyPromise;
                assert.strictEqual(stub.getRequestCount(), 1, "memory.write must be called exactly once");
                assert.strictEqual(body.data.timestamp, "2024-01-01T00:00:00.000Z");
                assert.deepStrictEqual(body.data.raw_tags, ["ramen", "scenery"]);
                assert.deepStrictEqual(body.data.normalized_tags, ["ramen", "scenery"]);
                assert.ok(Array.isArray(body.data.embedding) && body.data.embedding.length === 512,
                    "embedding forwarded");
            } finally {
                await stub.close();
                delete process.env.MEMORY_SERVICE_URL;
            }
        }
    );

    await test(
        "upload flow: context.input.timestamp wins over context.request_ts",
        async function () {
            var stub = await startStubMemoryServer(200);
            process.env.MEMORY_SERVICE_URL = "http://127.0.0.1:" + stub.port;

            try {
                var skill = createTesBuilderSkill(makeSuccessClient());
                var ctx = makeContext({
                    image_base64: "data:image/jpeg;base64,AAAA",
                    timestamp: "2025-02-03T04:05:06Z",
                    request_ts: 1704067200000,
                });

                var result = await skill.execute(
                    {
                        anchor_tags: ["ramen"],
                        normalized_tags: ["ramen"],
                        vision_features: [],
                        user_city: "tokyo",
                        request_ts: 1704067200000,
                    },
                    ctx
                );

                var body = await stub.bodyPromise;
                assert.strictEqual(result.trace.timestamp_source, "input_timestamp");
                assert.strictEqual(body.data.timestamp, "2025-02-03T04:05:06Z");
            } finally {
                await stub.close();
                delete process.env.MEMORY_SERVICE_URL;
            }
        }
    );

    await test(
        "query-only flow: no image in context → memory.write NOT called",
        async function () {
            var writeWasCalled = false;
            var stub = await startStubMemoryServer(200);
            stub.server.removeAllListeners("request");
            stub.server.on("request", function (_req, res) {
                writeWasCalled = true;
                res.writeHead(200);
                res.end("{}");
            });
            process.env.MEMORY_SERVICE_URL = "http://127.0.0.1:" + stub.port;

            try {
                var skill = createTesBuilderSkill(makeSuccessClient());

                // No image in context → NOT an upload flow even if vision_features are present
                var ctx = makeContext(); // no image_url / image_base64

                var result = await skill.execute(
                    {
                        anchor_tags: ["ramen", "quiet"],
                        vision_features: ["cozy"], // present but context has no image
                        user_city: "tokyo",
                        request_ts: 1704067200000,
                    },
                    ctx
                );

                // Brief yield to confirm no async write fires
                await new Promise(function (r) { setTimeout(r, 100); });

                assert.strictEqual(result.output.fallback_used, false, "skill must succeed");
                assert.strictEqual(result.trace.memory_persisted, false, "memory_persisted=false");
                assert.strictEqual(result.trace.memory_write_status, undefined,
                    "no memory_write_status field in query-only trace");
                assert.strictEqual(writeWasCalled, false, "memory service must NOT be contacted");
            } finally {
                await stub.close();
                delete process.env.MEMORY_SERVICE_URL;
            }
        }
    );

    await test(
        "upload flow with server error: skill still succeeds, trace.memory_write_status=queued",
        async function () {
            var stub = await startStubMemoryServer(500);
            process.env.MEMORY_SERVICE_URL = "http://127.0.0.1:" + stub.port;

            try {
                var skill = createTesBuilderSkill(makeSuccessClient());

                var ctx = makeContext({ image_base64: "data:image/jpeg;base64,AAAA" });

                var result = await skill.execute(
                    {
                        anchor_tags: [],
                        normalized_tags: ["sushi"],
                        vision_features: ["minimalist"],
                        user_city: "osaka",
                        request_ts: 1704067200000,
                    },
                    ctx
                );

                // Skill must succeed regardless of write outcome
                assert.strictEqual(result.output.fallback_used, false,
                    "skill must succeed despite server error");
                assert.strictEqual(result.output.tes_vector.length, 512, "output vector present");

                // Status is always "queued" — we never await the write result
                assert.strictEqual(result.trace.memory_persisted, true,
                    "memory_persisted=true (write was attempted)");
                assert.strictEqual(result.trace.memory_write_status, "queued",
                    "status=queued regardless of server response (fire-and-forget)");
            } finally {
                await stub.close();
                delete process.env.MEMORY_SERVICE_URL;
            }
        }
    );

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
    console.log("\n" + "=".repeat(50));
    console.log("Results: " + passed + " passed, " + failed + " failed");
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL MEMORY_WRITE INTEGRATION TESTS: PASS");
    }
}

runAll().catch(function (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
});
