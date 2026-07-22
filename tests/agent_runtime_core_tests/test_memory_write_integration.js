#!/usr/bin/env node
/** Integration tests for confirmed, idempotent persist_memory writes. */

const assert = require("assert");
const http = require("http");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();
const { createExecutionContext } = core;
const { createPersistMemorySkill } = skills;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS: ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL: ${name}`);
        console.error(`        ${error.stack || error.message}`);
        failed++;
    }
}

function unitVector() {
    return [1, ...new Array(511).fill(0)];
}

function validInput(overrides = {}) {
    return {
        user_id: "upload_user",
        memory_id: "stable-upload-id",
        city: "tokyo",
        caption_text: "Terrible meal",
        request_ts: 1784678400000,
        image_base64: "data:image/jpeg;base64,YWJj",
        normalized_tags: ["ramen", "food"],
        vision_tags: ["ramen"],
        vision_features: ["noodles"],
        vision_type: "food",
        tes_vector: unitVector(),
        tes_dim: 512,
        tes_normalized: true,
        tes_fallback_used: false,
        sentiment: -0.9,
        sentiment_confidence: 0.8,
        sentiment_available: true,
        sentiment_source: "caption_lexicon_v1",
        ...overrides,
    };
}

function context() {
    return createExecutionContext({
        text: "remember upload",
        user_id: "upload_user",
        request_ts: 1784678400000,
    });
}

async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function withServer(handler, fn) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const previousUrl = process.env.MEMORY_SERVICE_URL;
    const previousAttempts = process.env.MEMORY_WRITE_MAX_ATTEMPTS;
    const previousRetry = process.env.MEMORY_WRITE_RETRY_BASE_MS;
    process.env.MEMORY_SERVICE_URL = `http://127.0.0.1:${address.port}`;
    process.env.MEMORY_WRITE_MAX_ATTEMPTS = "3";
    process.env.MEMORY_WRITE_RETRY_BASE_MS = "1";
    try {
        return await fn();
    } finally {
        if (previousUrl === undefined) delete process.env.MEMORY_SERVICE_URL;
        else process.env.MEMORY_SERVICE_URL = previousUrl;
        if (previousAttempts === undefined) delete process.env.MEMORY_WRITE_MAX_ATTEMPTS;
        else process.env.MEMORY_WRITE_MAX_ATTEMPTS = previousAttempts;
        if (previousRetry === undefined) delete process.env.MEMORY_WRITE_RETRY_BASE_MS;
        else process.env.MEMORY_WRITE_RETRY_BASE_MS = previousRetry;
        await new Promise((resolve) => server.close(resolve));
    }
}

async function runAll() {
    console.log("\n--- persist_memory confirmed write ---");

    await test("2xx acknowledgement is the only persisted success", async () => {
        let captured;
        await withServer(async (request, response) => {
            captured = await readBody(request);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true, memory_id: "stable-upload-id" }));
        }, async () => {
            const result = await createPersistMemorySkill().execute(validInput(), context());
            assert.strictEqual(result.output.memory_write_status, "persisted");
            assert.strictEqual(result.output.memory_persisted, true);
            assert.strictEqual(result.output.memory_id, "stable-upload-id");
            assert.strictEqual(result.output.attempts, 1);
            assert.strictEqual(result.trace.http_status, 200);
        });
        assert.strictEqual(captured.data.memory_id, "stable-upload-id");
        assert.strictEqual(captured.data.sentiment, -0.9);
        assert.strictEqual(captured.data.sentiment_confidence, 0.8);
        assert.strictEqual(captured.data.sentiment_available, true);
        assert.strictEqual(captured.data.sentiment_source, "caption_lexicon_v1");
    });

    await test("HTTP 500 retries three times and reports failed, never persisted", async () => {
        let calls = 0;
        await withServer(async (request, response) => {
            await readBody(request);
            calls++;
            response.writeHead(500, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ detail: "database unavailable" }));
        }, async () => {
            const result = await createPersistMemorySkill().execute(validInput(), context());
            assert.strictEqual(result.output.memory_write_status, "failed");
            assert.strictEqual(result.output.memory_persisted, false);
            assert.strictEqual(result.output.attempts, 3);
            assert.strictEqual(result.output.error_code, "http_500");
            assert.strictEqual(result.trace.fallback_reason, "write_failed");
        });
        assert.strictEqual(calls, 3);
    });

    await test("transient 500 then success reuses the same memory_id", async () => {
        const ids = [];
        await withServer(async (request, response) => {
            const body = await readBody(request);
            ids.push(body.data.memory_id);
            if (ids.length === 1) {
                response.writeHead(500, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ detail: "retry" }));
                return;
            }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true, memory_id: body.data.memory_id }));
        }, async () => {
            const result = await createPersistMemorySkill().execute(validInput(), context());
            assert.strictEqual(result.output.memory_write_status, "persisted");
            assert.strictEqual(result.output.attempts, 2);
        });
        assert.deepStrictEqual(ids, ["stable-upload-id", "stable-upload-id"]);
    });

    await test("HTTP 422 is not retried and is shown as failed", async () => {
        let calls = 0;
        await withServer(async (request, response) => {
            await readBody(request);
            calls++;
            response.writeHead(422, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ detail: "invalid embedding" }));
        }, async () => {
            const result = await createPersistMemorySkill().execute(validInput(), context());
            assert.strictEqual(result.output.memory_write_status, "failed");
            assert.strictEqual(result.output.attempts, 1);
            assert.strictEqual(result.output.http_status, 422);
        });
        assert.strictEqual(calls, 1);
    });

    await test("non-upload request is explicitly skipped without HTTP", async () => {
        const result = await createPersistMemorySkill().execute(
            validInput({ image_base64: undefined }),
            context(),
        );
        assert.strictEqual(result.output.memory_write_status, "skipped");
        assert.strictEqual(result.output.memory_persisted, false);
        assert.strictEqual(result.output.attempts, 0);
        assert.strictEqual(result.trace.fallback_reason, "not_upload_flow");
    });

    await test("invalid TES fails before any write attempt", async () => {
        const result = await createPersistMemorySkill().execute(
            validInput({ tes_vector: [1, 0], tes_dim: 2 }),
            context(),
        );
        assert.strictEqual(result.output.memory_write_status, "failed");
        assert.strictEqual(result.output.memory_persisted, false);
        assert.strictEqual(result.output.attempts, 0);
        assert.strictEqual(result.output.error_code, "invalid_tes");
    });

    await test("2xx without memory_id is not accepted as success", async () => {
        await withServer(async (request, response) => {
            await readBody(request);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true }));
        }, async () => {
            const result = await createPersistMemorySkill().execute(validInput(), context());
            assert.strictEqual(result.output.memory_write_status, "failed");
            assert.strictEqual(result.output.memory_persisted, false);
            assert.strictEqual(result.output.error_code, "invalid_response");
        });
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log("ALL PERSIST_MEMORY INTEGRATION TESTS: PASS");
}

runAll().catch((error) => {
    console.error(error);
    process.exit(1);
});
