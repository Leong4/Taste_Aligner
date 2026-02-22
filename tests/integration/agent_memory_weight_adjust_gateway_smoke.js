#!/usr/bin/env node
/**
 * Strict integration smoke test: memory_weight_adjust gateway connectivity.
 *
 * Hard fail policy:
 *   1) gateway unreachable / timeout / non-2xx => FAIL
 *   2) response JSON parse failure => FAIL
 *   3) response must contain results array => FAIL
 *   4) request payload must satisfy gateway memory.search contract => FAIL
 *
 * Run:
 *   node tests/integration/agent_memory_weight_adjust_gateway_smoke.js
 */

const http = require("http");
const https = require("https");

const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "http://localhost:8080";
const ENDPOINT = "/tool/memory.search";
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 5000);

function fail(message, details = {}) {
    console.error(`  FAIL: ${message}`);
    if (details.url) {
        console.error(`  URL: ${details.url}`);
    }
    if (details.status !== undefined) {
        console.error(`  HTTP status: ${details.status}`);
    }
    if (details.bodyPreview) {
        console.error(`  Response body (first 500 chars): ${details.bodyPreview}`);
    }
    if (details.errorMessage) {
        console.error(`  Error: ${details.errorMessage}`);
    }
    process.exit(1);
}

function isNumberArray(value) {
    return Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

function validatePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return "payload must be an object";
    }
    if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
        return "payload.data must be an object";
    }
    const data = payload.data;
    if (typeof data.user_id !== "string" || !data.user_id.trim()) {
        return "payload.data.user_id must be a non-empty string";
    }
    const hasQueryTags = Array.isArray(data.query_tags);
    const hasQueryEmbedding = isNumberArray(data.query_embedding);
    if (!hasQueryTags && !hasQueryEmbedding) {
        return "payload.data must include query_tags(array) or query_embedding(number[])";
    }
    if (hasQueryTags && !data.query_tags.every((t) => typeof t === "string")) {
        return "payload.data.query_tags must be string[]";
    }
    if (data.city !== undefined && typeof data.city !== "string") {
        return "payload.data.city must be string when provided";
    }
    if (data.top_k !== undefined && (!Number.isInteger(data.top_k) || data.top_k < 1)) {
        return "payload.data.top_k must be positive integer when provided";
    }
    if (data.now_ts !== undefined && (!Number.isFinite(data.now_ts) || typeof data.now_ts !== "number")) {
        return "payload.data.now_ts must be finite number when provided";
    }
    return null;
}

function postJson(url, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const data = JSON.stringify(body);
        const isHttps = parsed.protocol === "https:";
        const transport = isHttps ? https : http;

        const req = transport.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
            },
            timeout: TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf-8");
                let json;
                try {
                    json = JSON.parse(raw);
                } catch (err) {
                    return reject(Object.assign(new Error("response is not valid JSON"), {
                        status: res.statusCode,
                        raw,
                        parseError: err instanceof Error ? err.message : String(err),
                    }));
                }
                resolve({ status: res.statusCode || 0, body: json, raw });
            });
        });

        req.on("timeout", () => {
            req.destroy(new Error(`request timed out after ${TIMEOUT_MS}ms`));
        });
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

async function main() {
    console.log("\n--- memory_weight_adjust gateway smoke (strict) ---");
    const url = `${GATEWAY_BASE_URL.replace(/\/$/, "")}${ENDPOINT}`;
    console.log(`  Target: ${url}`);

    const payload = {
        data: {
            user_id: "u001",
            query_tags: ["ramen"],
            city: "tokyo",
            top_k: 3,
        },
    };

    const payloadError = validatePayload(payload);
    if (payloadError) {
        fail("payload self-check failed", { url, errorMessage: payloadError });
    }

    let resp;
    try {
        resp = await postJson(url, payload);
    } catch (err) {
        fail("gateway unreachable / timeout / invalid response", {
            url,
            status: err && err.status,
            bodyPreview: err && err.raw ? String(err.raw).slice(0, 500) : undefined,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }

    if (resp.status < 200 || resp.status >= 300) {
        fail("non-2xx response", {
            url,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    if (!resp.body || typeof resp.body !== "object" || Array.isArray(resp.body)) {
        fail("response body must be a JSON object", {
            url,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    // Some gateway modes may wrap tool output as {output:{results:[...]}}.
    const results = resp.body.results
        ?? (resp.body.output && resp.body.output.results);

    if (!Array.isArray(results)) {
        fail("response must include results array", {
            url,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    console.log(`  HTTP ${resp.status} OK`);
    console.log(`  results array present (length=${results.length})`);
    console.log("agent_memory_weight_adjust_gateway_smoke: PASS");
}

if (require.main === module) {
    main().catch((err) => {
        fail("unexpected exception", {
            url: `${GATEWAY_BASE_URL.replace(/\/$/, "")}${ENDPOINT}`,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    });
}

module.exports = {
    validatePayload,
};
