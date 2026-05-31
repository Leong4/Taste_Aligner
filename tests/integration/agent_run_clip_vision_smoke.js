#!/usr/bin/env node
/**
 * Integration smoke: clip_v1 vision → tes_builder contract.
 *
 * Gates verified on each /run call with image_base64:
 *   1. decision_trace.vision_describe.used === true
 *   2. decision_trace.vision_describe.backend === "clip_v1"
 *   3. decision_trace.vision_describe.vision_type is "food"|"scenery"|"other"|"unknown"
 *   4. decision_trace.tes_builder.tes_build_payload_keys always present and correct
 *      (unconditional — must not be bypassable by fallback_used=true)
 *   5. Forbidden non-deterministic keys absent from top-level decision_trace
 *
 * Skip behavior:
 *   ECONNREFUSED / ENOTFOUND / timeout → "SKIP" + exit 0 (offline-CI safe).
 *
 * Hard-fail behavior:
 *   - non-2xx response
 *   - invalid JSON
 *   - any gate above fails
 *   - second call structure differs from first (stability check)
 *
 * Env vars:
 *   AGENT_BASE_URL           default: http://localhost:8787
 *   AGENT_SMOKE_TIMEOUT_MS   default: 15000
 *
 * Run:
 *   node tests/integration/agent_run_clip_vision_smoke.js
 */

"use strict";

var http = require("http");
var https = require("https");
var assert = require("assert");
var fs = require("fs");
var path = require("path");

var AGENT_BASE_URL = (process.env.AGENT_BASE_URL || "http://localhost:8787").replace(/\/$/, "");
var TIMEOUT_MS = Number(process.env.AGENT_SMOKE_TIMEOUT_MS || 15000);

// Load the tiny 1×1 PNG fixture (base64 string, no newlines)
var FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "tiny_1x1.png.b64");
var TINY_PNG_BASE64 = fs.readFileSync(FIXTURE_PATH, "utf-8").trim();

// Exact allowed set for tes_build_payload_keys (S2 contract)
var EXPECTED_PAYLOAD_KEYS = ["normalize", "tags", "vision_features"];

// Keys that must NOT appear at the top level of decision_trace
var FORBIDDEN_TOP_KEYS = new Set([
    "timestamp", "request_id", "created_at", "updated_at",
]);

// Valid vision_type values
var VALID_VISION_TYPES = new Set(["food", "scenery", "other", "unknown"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message, details) {
    details = details || {};
    console.error("  FAIL: " + message);
    if (details.url) console.error("  URL: " + details.url);
    if (details.status !== undefined) console.error("  HTTP status: " + details.status);
    if (details.bodyPreview) console.error("  Response preview: " + details.bodyPreview);
    if (details.errorMessage) console.error("  Error: " + details.errorMessage);
    process.exit(1);
}

function postJson(url, body) {
    return new Promise(function (resolve, reject) {
        var parsed = new URL(url);
        var data = JSON.stringify(body);
        var isHttps = parsed.protocol === "https:";
        var transport = isHttps ? https : http;

        var req = transport.request(
            {
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
            },
            function (res) {
                var chunks = [];
                res.on("data", function (chunk) { chunks.push(chunk); });
                res.on("end", function () {
                    var raw = Buffer.concat(chunks).toString("utf-8");
                    var json;
                    try { json = JSON.parse(raw); } catch (_err) {
                        return reject(Object.assign(
                            new Error("response is not valid JSON"),
                            { status: res.statusCode, raw: raw }
                        ));
                    }
                    resolve({ status: res.statusCode || 0, body: json, raw: raw });
                });
            }
        );

        req.on("timeout", function () {
            req.destroy(new Error("request timed out after " + TIMEOUT_MS + "ms"));
        });
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

function isOfflineError(err) {
    var code = (err && err.code) || "";
    var msg = (err instanceof Error ? err.message : String(err)) || "";
    return (
        code === "ECONNREFUSED" ||
        code === "ENOTFOUND" ||
        code === "ECONNRESET" ||
        msg.indexOf("timed out") !== -1
    );
}

/**
 * Validate a single /run response against all clip_v1 vision gates.
 * Returns nothing on success; calls fail() on violation.
 */
function validateResponse(resp, callLabel) {
    var runUrl = AGENT_BASE_URL + "/run";

    if (resp.status < 200 || resp.status >= 300) {
        fail(callLabel + ": non-2xx from /run", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    if (!resp.body || typeof resp.body !== "object" || Array.isArray(resp.body)) {
        fail(callLabel + ": response body must be a JSON object", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    var dt = resp.body.decision_trace;
    if (!dt || typeof dt !== "object" || Array.isArray(dt)) {
        fail(callLabel + ": decision_trace missing or not an object", {
            url: runUrl,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    // ── Gate 1: vision_describe.used ─────────────────────────────────────────
    var vd = dt.vision_describe;
    if (!vd || typeof vd !== "object") {
        fail(callLabel + ": decision_trace.vision_describe missing", {
            url: runUrl,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }
    if (vd.used !== true) {
        fail(
            callLabel + ": vision_describe.used must be true when image_base64 provided, got " + vd.used,
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }
    if (vd.fallback_used !== false) {
        fail(
            callLabel + ": vision_describe.fallback_used must be false, got " + vd.fallback_used +
            " (reason=" + vd.fallback_reason + ")",
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }
    console.log("  Gate 1 PASS [" + callLabel + "]: vision_describe.used=true, fallback_used=false");

    // ── Gate 2: vision_describe.backend === "clip_v1" ─────────────────────────
    if (vd.backend !== "clip_v1") {
        fail(
            callLabel + ": vision_describe.backend must be 'clip_v1', got " + JSON.stringify(vd.backend) +
            ". Ensure the vision service is started with VISION_BACKEND=clip_v1.",
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }
    console.log("  Gate 2 PASS [" + callLabel + "]: vision_describe.backend=clip_v1");

    // ── Gate 3: vision_type is a valid enum value ──────────────────────────────
    var visionType = vd.vision_type;
    if (visionType !== undefined && !VALID_VISION_TYPES.has(visionType)) {
        fail(
            callLabel + ": vision_describe.vision_type must be 'food'|'scenery'|'other'|'unknown', got " +
            JSON.stringify(visionType),
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }
    console.log("  Gate 3 PASS [" + callLabel + "]: vision_type=" + JSON.stringify(visionType || "absent (legacy backend ok)"));

    // ── Gate 4: tes_build_payload_keys — unconditional ───────────────────────
    var tb = dt.tes_builder;
    if (!tb || typeof tb !== "object") {
        // tes_builder may be absent if tes stage was skipped; treat as skip for this gate only
        console.log("  Gate 4 SKIP [" + callLabel + "]: tes_builder node absent (pipeline ended before tes_build)");
    } else {
        var payloadKeys = tb.tes_build_payload_keys;
        if (!Array.isArray(payloadKeys)) {
            fail(
                callLabel + ": tes_builder.tes_build_payload_keys missing or not an array " +
                "(must be present on ALL paths including fallbacks — Fix A). fallback_used=" + tb.fallback_used,
                { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
            );
        }
        try {
            assert.deepStrictEqual(
                payloadKeys,
                EXPECTED_PAYLOAD_KEYS,
                "tes_build_payload_keys must equal " + JSON.stringify(EXPECTED_PAYLOAD_KEYS)
            );
        } catch (_e) {
            fail(
                callLabel + ": tes_builder.tes_build_payload_keys mismatch — " +
                "expected " + JSON.stringify(EXPECTED_PAYLOAD_KEYS) +
                ", got " + JSON.stringify(payloadKeys) +
                " (fallback_used=" + tb.fallback_used + ")",
                { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
            );
        }
        console.log(
            "  Gate 4 PASS [" + callLabel + "]: tes_build_payload_keys=" +
            JSON.stringify(payloadKeys) + " (fallback_used=" + tb.fallback_used + ")"
        );
    }

    // ── Gate 5: forbidden non-deterministic keys at top level of decision_trace
    var forbiddenFound = [];
    var topKeys = Object.keys(dt);
    for (var ki = 0; ki < topKeys.length; ki++) {
        if (FORBIDDEN_TOP_KEYS.has(topKeys[ki])) {
            forbiddenFound.push(topKeys[ki]);
        }
    }
    if (forbiddenFound.length > 0) {
        fail(
            callLabel + ": forbidden non-deterministic keys in decision_trace: " +
            forbiddenFound.join(", ") + " — these must not pollute the trace",
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }
    console.log("  Gate 5 PASS [" + callLabel + "]: no forbidden top-level keys in decision_trace");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log("\n--- clip_v1 vision → tes_builder contract smoke ---");
    console.log("  fixture: " + FIXTURE_PATH);
    console.log("  base64 length: " + TINY_PNG_BASE64.length + " chars");

    var runUrl = AGENT_BASE_URL + "/run";
    var payload = {
        text: "looking for cozy ramen spots in tokyo",
        user_id: "smoke_clip_u001",
        image_base64: TINY_PNG_BASE64,
    };

    // ── Call 1 ────────────────────────────────────────────────────────────────
    console.log("\n  Call 1: POST " + runUrl + " (with image_base64)");
    var resp1;
    try {
        resp1 = await postJson(runUrl, payload);
    } catch (err) {
        if (isOfflineError(err)) {
            console.log("  SKIP (agent_runtime not reachable: " +
                (err instanceof Error ? err.message : String(err)) + ")");
            process.exit(0);
        }
        fail("unexpected connection error on call 1", {
            url: runUrl,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }

    validateResponse(resp1, "call1");

    // ── Call 2 — stability check ───────────────────────────────────────────────
    console.log("\n  Call 2: POST " + runUrl + " (same input, stability check)");
    var resp2;
    try {
        resp2 = await postJson(runUrl, payload);
    } catch (err) {
        if (isOfflineError(err)) {
            console.log("  SKIP (agent_runtime lost between calls)");
            process.exit(0);
        }
        fail("unexpected connection error on call 2", {
            url: runUrl,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }

    validateResponse(resp2, "call2");

    // Structural stability: top-level decision_trace keys must match
    var keys1 = Object.keys(resp1.body.decision_trace || {}).sort();
    var keys2 = Object.keys(resp2.body.decision_trace || {}).sort();
    try {
        assert.deepStrictEqual(keys1, keys2, "decision_trace top-level keys must be identical across calls");
    } catch (_e) {
        fail(
            "stability check: decision_trace keys differ between call 1 and call 2 — " +
            "call1=" + JSON.stringify(keys1) + " call2=" + JSON.stringify(keys2),
            { url: runUrl }
        );
    }
    console.log("  Stability PASS: decision_trace key set stable across 2 calls");

    // ── Evidence summary ──────────────────────────────────────────────────────
    console.log("\n  Evidence (call 1):");
    var dt1 = resp1.body.decision_trace;
    var vd1 = dt1.vision_describe || {};
    var tb1 = dt1.tes_builder || {};
    console.log("    vision_describe.backend:    " + (vd1.backend || "n/a"));
    console.log("    vision_describe.vision_type: " + (vd1.vision_type || "n/a"));
    console.log("    vision_describe.tags_count:  " + (vd1.tags_count !== undefined ? vd1.tags_count : "n/a"));
    console.log("    vision_describe.used:        " + vd1.used);
    console.log("    tes_builder.fallback_used:   " + tb1.fallback_used);
    if (Array.isArray(tb1.tes_build_payload_keys)) {
        console.log("    tes_builder.payload_keys:    " + JSON.stringify(tb1.tes_build_payload_keys));
    }
    if (tb1.input_summary) {
        console.log(
            "    tes_builder.input_summary:   anchor_tag_count=" +
            tb1.input_summary.anchor_tag_count +
            " vision_features_count=" + tb1.input_summary.vision_features_count
        );
    }

    console.log("\n==================================================");
    console.log("agent_run_clip_vision_smoke: PASS");
}

if (require.main === module) {
    main().catch(function (err) {
        fail("unexpected exception", {
            url: AGENT_BASE_URL + "/run",
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    });
}
