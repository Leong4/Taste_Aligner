#!/usr/bin/env node
/**
 * Integration smoke: P4 build_profile_vector node contract.
 *
 * Gates verified on each /run call:
 *   1. decision_trace.profile_vector_node exists
 *   2. profile_vector_node has rule_id="profile_vector_v1"
 *   3. profile_vector_node has anchors (array), weights_summary (object),
 *      total_memories_considered (number), profile_vector_dim=512
 *   4. No non-deterministic fields in profile_vector_node
 *      (latency_ms, timestamp, request_id, created_at, random)
 *   5. Two identical /run calls produce the same decision_trace key set
 *      (explain stability check)
 *
 * Skip behavior:
 *   ECONNREFUSED / ENOTFOUND / timeout → "SKIP" + exit 0 (offline-CI safe).
 *
 * Hard-fail behavior:
 *   - non-2xx response, invalid JSON → exit 1
 *   - any gate above fails → exit 1
 *
 * Env vars:
 *   AGENT_BASE_URL           default: http://localhost:8787
 *   AGENT_SMOKE_TIMEOUT_MS   default: 15000
 *
 * Run:
 *   node tests/integration/agent_run_profile_vector_smoke.js
 */

"use strict";

var http = require("http");
var https = require("https");
var assert = require("assert");

var AGENT_BASE_URL = (process.env.AGENT_BASE_URL || "http://localhost:8787").replace(/\/$/, "");
var TIMEOUT_MS = Number(process.env.AGENT_SMOKE_TIMEOUT_MS || 15000);

// Non-deterministic fields that must NEVER appear in profile_vector_node
var FORBIDDEN_TRACE_KEYS = [
    "latency_ms", "timestamp", "request_id", "created_at", "updated_at", "random",
];

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

/**
 * Validate a single /run response against P4 profile_vector_node gates.
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

    // ── Gate 1: profile_vector_node must exist ────────────────────────────────
    var pvn = dt.profile_vector_node;
    if (!pvn || typeof pvn !== "object" || Array.isArray(pvn)) {
        fail(
            callLabel + ": decision_trace.profile_vector_node missing. " +
            "Ensure build_profile_vector skill is registered and graph v13+ is loaded.",
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }
    console.log("  Gate 1 PASS [" + callLabel + "]: profile_vector_node present");

    // ── Gate 2: rule_id contract ───────────────────────────────────────────────
    if (pvn.rule_id !== "profile_vector_v1") {
        fail(callLabel + ": profile_vector_node.rule_id must be 'profile_vector_v1', got " +
            JSON.stringify(pvn.rule_id), { url: runUrl });
    }
    console.log("  Gate 2 PASS [" + callLabel + "]: rule_id=profile_vector_v1");

    // ── Gate 3: required fields ────────────────────────────────────────────────
    if (!Array.isArray(pvn.anchors)) {
        fail(callLabel + ": profile_vector_node.anchors must be an array", { url: runUrl });
    }
    if (!pvn.weights_summary || typeof pvn.weights_summary !== "object") {
        fail(callLabel + ": profile_vector_node.weights_summary missing", { url: runUrl });
    }
    if (typeof pvn.total_memories_considered !== "number") {
        fail(callLabel + ": profile_vector_node.total_memories_considered must be a number", { url: runUrl });
    }
    if (pvn.profile_vector_dim !== 512) {
        fail(callLabel + ": profile_vector_node.profile_vector_dim must be 512, got " + pvn.profile_vector_dim, { url: runUrl });
    }
    console.log("  Gate 3 PASS [" + callLabel + "]: required fields present (anchors=" +
        pvn.anchors.length + " total_considered=" + pvn.total_memories_considered + ")");

    // ── Gate 4: no non-deterministic fields ────────────────────────────────────
    var forbiddenFound = FORBIDDEN_TRACE_KEYS.filter(function (k) { return pvn[k] !== undefined; });
    if (forbiddenFound.length > 0) {
        fail(
            callLabel + ": profile_vector_node contains forbidden non-deterministic fields: " +
            forbiddenFound.join(", "),
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }
    console.log("  Gate 4 PASS [" + callLabel + "]: no forbidden non-deterministic fields in profile_vector_node");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log("\n--- P4 profile_vector_node contract smoke ---");

    var runUrl = AGENT_BASE_URL + "/run";
    var payload = {
        text: "looking for ramen spots in tokyo",
        user_id: "smoke_pv_u001",
        request_ts: 1704067200000,  // fixed timestamp for determinism
    };

    // ── Call 1 ─────────────────────────────────────────────────────────────
    console.log("\n  Call 1: POST " + runUrl);
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

    // ── Call 2 — stability check ─────────────────────────────────────────────
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

    // ── Gate 5: explain stability — top-level decision_trace key set stable ──
    var keys1 = Object.keys(resp1.body.decision_trace || {}).sort();
    var keys2 = Object.keys(resp2.body.decision_trace || {}).sort();
    try {
        assert.deepStrictEqual(keys1, keys2,
            "decision_trace top-level keys must match across calls");
    } catch (_e) {
        fail(
            "stability: decision_trace keys differ — call1=" +
            JSON.stringify(keys1) + " call2=" + JSON.stringify(keys2),
            { url: runUrl }
        );
    }
    console.log("  Gate 5 PASS: decision_trace key set stable across 2 calls");

    // ── Evidence summary ──────────────────────────────────────────────────────
    var pvn = resp1.body.decision_trace.profile_vector_node;
    console.log("\n  Evidence (call 1):");
    console.log("    profile_vector_node.rule_id:                 " + pvn.rule_id);
    console.log("    profile_vector_node.total_memories_considered: " + pvn.total_memories_considered);
    console.log("    profile_vector_node.anchors.length:           " + pvn.anchors.length);
    console.log("    profile_vector_node.profile_vector_dim:       " + pvn.profile_vector_dim);
    console.log("    profile_vector_node.has_embeddings:           " + pvn.has_embeddings);
    console.log("    profile_vector_node.fallback_used:            " + pvn.fallback_used);
    if (pvn.weights_summary) {
        console.log("    profile_vector_node.weights_summary.dominant_reason: " +
            pvn.weights_summary.dominant_reason);
    }

    console.log("\n==================================================");
    console.log("agent_run_profile_vector_smoke: PASS");
}

if (require.main === module) {
    main().catch(function (err) {
        fail("unexpected exception", {
            url: AGENT_BASE_URL + "/run",
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    });
}
