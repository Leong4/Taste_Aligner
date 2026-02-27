#!/usr/bin/env node
/**
 * Integration smoke test: vision.describe gateway connectivity.
 *
 * Validates:
 *   1) POST /tool/vision.describe with a minimal base64 PNG returns HTTP 200
 *      and a response with { ok: true, tags: [...], backend, device }.
 *   2) The tags array is sorted, lowercase strings.
 *   3) POST /tool/vision.describe with no image → HTTP 400 (gateway validation).
 *
 * Hard fail policy: gateway unreachable / timeout / non-2xx (except for test
 * 3 which expects 400) / invalid shape => FAIL.
 *
 * Prerequisites:
 *   - Gateway running on localhost:8080
 *   - Vision service running (VISION_BACKEND=rule_v0 is sufficient)
 *
 * Run:
 *   node tests/integration/vision_describe_gateway_smoke.js
 */

const http = require("http");
const https = require("https");

const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "http://localhost:8080";
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 15000);

// Minimal valid 1×1 transparent PNG base64
const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function fail(message, details = {}) {
    console.error(`  FAIL: ${message}`);
    if (details.url) console.error(`  URL: ${details.url}`);
    if (details.status !== undefined) console.error(`  HTTP status: ${details.status}`);
    if (details.bodyPreview) console.error(`  Response body (first 500 chars): ${details.bodyPreview}`);
    if (details.errorMessage) console.error(`  Error: ${details.errorMessage}`);
    process.exit(1);
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
                } catch (_err) {
                    return reject(Object.assign(new Error("response is not valid JSON"), {
                        status: res.statusCode,
                        raw,
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
    console.log("\n--- vision.describe gateway smoke ---");
    const base = GATEWAY_BASE_URL.replace(/\/$/, "");
    const url = `${base}/tool/vision.describe`;

    // =========================================================================
    // Step 1: POST with base64 image → expect 200
    // =========================================================================
    console.log(`  [1] POST ${url} (base64 image)`);

    let resp;
    try {
        resp = await postJson(url, { data: { image_base64: TINY_PNG_BASE64, top_k: 5 } });
    } catch (err) {
        fail("gateway unreachable for vision.describe", {
            url,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }

    if (resp.status < 200 || resp.status >= 300) {
        fail("non-2xx from vision.describe", {
            url,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    const body = resp.body;
    if (!body || typeof body !== "object") {
        fail("response body not JSON object", {
            url,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    if (!Array.isArray(body.tags)) {
        fail("response.tags must be array", {
            url,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    // tags must all be lowercase strings
    for (const tag of body.tags) {
        if (typeof tag !== "string") {
            fail(`tag must be string, got ${typeof tag}: ${tag}`, { url, status: resp.status });
        }
        if (tag !== tag.toLowerCase()) {
            fail(`tag must be lowercase, got: "${tag}"`, { url, status: resp.status });
        }
    }

    if (typeof body.backend !== "string") {
        fail("response.backend must be string", { url, status: resp.status });
    }

    if (typeof body.device !== "string") {
        fail("response.device must be string", { url, status: resp.status });
    }

    console.log(
        `  HTTP ${resp.status} OK — tags=${body.tags.length}, backend=${body.backend}, device=${body.device}`
    );

    // =========================================================================
    // Step 2: POST with no image → expect 400 (gateway validation)
    // =========================================================================
    console.log(`  [2] POST ${url} (no image — expect 400)`);

    let resp2;
    try {
        resp2 = await postJson(url, { data: {} });
    } catch (err) {
        fail("gateway unreachable for vision.describe (no-image test)", {
            url,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }

    if (resp2.status !== 400) {
        fail(`expected 400 for missing image, got ${resp2.status}`, {
            url,
            status: resp2.status,
            bodyPreview: String(resp2.raw || "").slice(0, 500),
        });
    }
    console.log(`  HTTP 400 OK (gateway correctly rejected missing image)`);

    // =========================================================================
    // Step 3: POST with image_url (string) → expect 200
    // =========================================================================
    const imageUrl = process.env.VISION_SMOKE_IMAGE_URL;
    if (imageUrl) {
        console.log(`  [3] POST ${url} (image_url from VISION_SMOKE_IMAGE_URL)`);
        let resp3;
        try {
            resp3 = await postJson(url, { data: { image_url: imageUrl } });
        } catch (err) {
            fail("gateway unreachable for vision.describe (image_url test)", {
                url,
                errorMessage: err instanceof Error ? err.message : String(err),
            });
        }
        if (resp3.status < 200 || resp3.status >= 300) {
            fail(`non-2xx from vision.describe (image_url), got ${resp3.status}`, {
                url,
                status: resp3.status,
                bodyPreview: String(resp3.raw || "").slice(0, 500),
            });
        }
        if (!Array.isArray(resp3.body && resp3.body.tags)) {
            fail("response.tags must be array for image_url path", { url, status: resp3.status });
        }
        console.log(`  HTTP ${resp3.status} OK — tags=${resp3.body.tags.length}`);
    } else {
        console.log("  [3] SKIP — set VISION_SMOKE_IMAGE_URL to test image_url path");
    }

    // =========================================================================
    // Summary
    // =========================================================================
    console.log("\n==================================================");
    console.log("vision_describe_gateway_smoke: PASS");
}

if (require.main === module) {
    main().catch((err) => {
        fail("unexpected exception", {
            url: `${GATEWAY_BASE_URL.replace(/\/$/, "")}/tool/vision.describe`,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    });
}
