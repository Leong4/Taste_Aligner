#!/usr/bin/env node
/**
 * Strict integration smoke test: TES-driven rerank gateway connectivity.
 *
 * Validates:
 *   1) POST /tool/embedding.tes_build accepts the v2 payload and returns
 *      a valid 512-dim vector.
 *   2) The rerank skill can be exercised end-to-end with real ToolClient
 *      pointing at the live gateway.
 *
 * Hard fail policy: gateway unreachable / timeout / non-2xx / invalid shape => FAIL.
 *
 * Prerequisites:
 *   - Gateway running on localhost:8080
 *   - Embedding service running
 *
 * Run:
 *   node tests/integration/agent_rerank_tes_gateway_smoke.js
 */

const http = require("http");
const https = require("https");

const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "http://localhost:8080";
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 5000);

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
                } catch (err) {
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
    console.log("\n--- rerank TES gateway smoke (strict) ---");
    const base = GATEWAY_BASE_URL.replace(/\/$/, "");

    // =====================================================================
    // Step 1: Call embedding.tes_build to build a user vector
    // =====================================================================
    const tesBuildUrl = `${base}/tool/embedding.tes_build`;
    console.log(`  [1] POST ${tesBuildUrl}`);

    const tesBuildPayload = {
        tags: ["ramen", "sushi"],
        normalize: true,
    };

    let tesResp;
    try {
        tesResp = await postJson(tesBuildUrl, tesBuildPayload);
    } catch (err) {
        fail("gateway unreachable for embedding.tes_build", {
            url: tesBuildUrl,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }

    if (tesResp.status < 200 || tesResp.status >= 300) {
        fail("non-2xx from embedding.tes_build", {
            url: tesBuildUrl,
            status: tesResp.status,
            bodyPreview: String(tesResp.raw || "").slice(0, 500),
        });
    }

    if (!tesResp.body || typeof tesResp.body !== "object") {
        fail("response body not JSON object", {
            url: tesBuildUrl,
            status: tesResp.status,
            bodyPreview: String(tesResp.raw || "").slice(0, 500),
        });
    }

    const vector = tesResp.body.vector;
    if (!Array.isArray(vector)) {
        fail("response.vector must be array", {
            url: tesBuildUrl,
            status: tesResp.status,
            bodyPreview: String(tesResp.raw || "").slice(0, 500),
        });
    }

    if (vector.length !== 512) {
        fail(`response.vector.length=${vector.length}, expected 512`, {
            url: tesBuildUrl,
            status: tesResp.status,
        });
    }
    const meta1 = tesResp.body.meta;
    if (!meta1 || typeof meta1 !== "object" || meta1.backend !== "st_v1") {
        fail("response.meta.backend must be st_v1", {
            url: tesBuildUrl,
            status: tesResp.status,
            bodyPreview: String(tesResp.raw || "").slice(0, 500),
        });
    }

    console.log(`  HTTP ${tesResp.status} OK — vector dim=${vector.length}, backend=${meta1.backend}`);

    // =====================================================================
    // Step 2: Call embedding.tes_build for an item (sanity)
    // =====================================================================
    const itemTesBuildUrl = `${base}/tool/embedding.tes_build`;
    console.log(`  [2] POST ${itemTesBuildUrl} (item TES)`);

    const itemPayload = {
        tags: ["curry"],
        normalize: true,
    };

    let itemResp;
    try {
        itemResp = await postJson(itemTesBuildUrl, itemPayload);
    } catch (err) {
        fail("gateway unreachable for item embedding.tes_build", {
            url: itemTesBuildUrl,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }

    if (itemResp.status < 200 || itemResp.status >= 300) {
        fail("non-2xx from item embedding.tes_build", {
            url: itemTesBuildUrl,
            status: itemResp.status,
            bodyPreview: String(itemResp.raw || "").slice(0, 500),
        });
    }

    const itemVector = itemResp.body && itemResp.body.vector;
    if (!Array.isArray(itemVector) || itemVector.length !== 512) {
        fail("item vector must be 512-dim array", {
            url: itemTesBuildUrl,
            status: itemResp.status,
            bodyPreview: String(itemResp.raw || "").slice(0, 500),
        });
    }
    const meta2 = itemResp.body && itemResp.body.meta;
    if (!meta2 || typeof meta2 !== "object" || meta2.backend !== "st_v1") {
        fail("item response.meta.backend must be st_v1", {
            url: itemTesBuildUrl,
            status: itemResp.status,
            bodyPreview: String(itemResp.raw || "").slice(0, 500),
        });
    }

    console.log(`  HTTP ${itemResp.status} OK — item vector dim=${itemVector.length}, backend=${meta2.backend}`);

    // =====================================================================
    // Summary
    // =====================================================================
    console.log("\n==================================================");
    console.log("agent_rerank_tes_gateway_smoke: PASS");
}

if (require.main === module) {
    main().catch((err) => {
        fail("unexpected exception", {
            url: `${GATEWAY_BASE_URL.replace(/\/$/, "")}/tool/embedding.tes_build`,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    });
}
