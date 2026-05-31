#!/usr/bin/env node
/**
 * Strict integration smoke:
 *  - Calls agent_runtime /run with image_base64
 *  - Verifies decision_trace.vision_describe.used === true
 *  - Verifies decision_trace.tes_builder.input_summary.vision_features_count > 0
 *
 * Hard fail policy:
 *  - endpoint unreachable / timeout / non-2xx / invalid JSON => FAIL
 *  - missing vision trace evidence => FAIL
 *
 * Prerequisites:
 *   - Gateway running on localhost:8080
 *   - Vision service running (clip_v1)
 *   - Agent runtime running on localhost:8787
 *
 * Run:
 *   node tests/integration/agent_run_vision_trace_smoke.js
 */

const http = require("http");
const https = require("https");

const AGENT_RUNTIME_BASE_URL = process.env.AGENT_RUNTIME_BASE_URL || "http://localhost:8787";
const TIMEOUT_MS = Number(process.env.AGENT_RUNTIME_TIMEOUT_MS || 20000);

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

        req.on("timeout", () => req.destroy(new Error(`request timed out after ${TIMEOUT_MS}ms`)));
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

async function main() {
    console.log("\n--- agent /run vision trace smoke (strict) ---");

    const runUrl = `${AGENT_RUNTIME_BASE_URL.replace(/\/$/, "")}/run`;
    const payload = {
        text: "I want to travel to tokyo for food and ramen.",
        user_id: "u001",
        image_base64: TINY_PNG_BASE64,
    };

    console.log(`  POST ${runUrl} (with image_base64)`);

    let resp;
    try {
        resp = await postJson(runUrl, payload);
    } catch (err) {
        fail("agent_runtime /run unreachable or timeout", {
            url: runUrl,
            status: err && err.status,
            bodyPreview: err && err.raw ? String(err.raw).slice(0, 500) : undefined,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }

    if (resp.status < 200 || resp.status >= 300) {
        fail("non-2xx from /run", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    if (!resp.body || typeof resp.body !== "object" || Array.isArray(resp.body)) {
        fail("response body must be JSON object", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    const dt = resp.body.decision_trace;
    if (!dt || typeof dt !== "object") {
        fail("missing decision_trace in /run response", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    // ── vision_describe trace must be present ────────────────────────────────
    const vd = dt.vision_describe;
    if (!vd || typeof vd !== "object") {
        fail("decision_trace.vision_describe missing", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    if (vd.used !== true) {
        fail(`decision_trace.vision_describe.used expected true, got ${vd.used}`, {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    if (vd.fallback_used !== false) {
        fail(`vision_describe fallback_used must be false when image provided, got ${vd.fallback_used}`, {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    // ── tes_builder trace must show vision_features_count > 0 ────────────────
    const tb = dt.tes_builder;
    if (!tb || typeof tb !== "object") {
        fail("decision_trace.tes_builder missing", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    const inputSummary = tb.input_summary;
    if (!inputSummary || typeof inputSummary !== "object") {
        fail("decision_trace.tes_builder.input_summary missing", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    if (typeof inputSummary.vision_features_count !== "number" || inputSummary.vision_features_count <= 0) {
        fail(
            `tes_builder.input_summary.vision_features_count must be > 0, got ${inputSummary.vision_features_count}`,
            {
                url: runUrl,
                status: resp.status,
                bodyPreview: String(resp.raw || "").slice(0, 500),
            }
        );
    }

    // ── Print evidence ────────────────────────────────────────────────────────
    console.log("  vision trace evidence:");
    console.log(`    vision_describe.used=${vd.used}`);
    console.log(`    vision_describe.tags_count=${vd.tags_count ?? "n/a"}`);
    console.log(`    vision_describe.backend=${vd.backend ?? "n/a"}`);
    console.log(`    vision_describe.fallback_used=${vd.fallback_used}`);
    console.log(`    tes_builder.input_summary.vision_features_count=${inputSummary.vision_features_count}`);
    console.log(`    tes_builder.fallback_used=${tb.fallback_used}`);

    console.log("\n==================================================");
    console.log("agent_run_vision_trace_smoke: PASS");
}

if (require.main === module) {
    main().catch((err) => {
        fail("unexpected exception", {
            url: `${AGENT_RUNTIME_BASE_URL.replace(/\/$/, "")}/run`,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    });
}
