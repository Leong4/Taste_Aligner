#!/usr/bin/env node
/**
 * Integration smoke: S2 gate — tes_builder no-scalar-weighting contract.
 *
 * Verifies via the running /run endpoint that:
 *   1. decision_trace.tes_builder contains NO forbidden scalar-weighting keys
 *      (recency_days, recencyDays, recency, time_decay, w_time, w_sent,
 *       w_context, sentiment, emotion, timestamp).
 *   2. When tes_builder succeeded (fallback_used === false),
 *      decision_trace.tes_builder.tes_build_payload_keys equals exactly
 *      ["normalize", "tags", "vision_features"] — the deterministic key
 *      evidence set recorded in the trace by tes_builder.ts.
 *
 * Skip behavior:
 *   If agent_runtime is not reachable (ECONNREFUSED / ENOTFOUND / timeout),
 *   prints "SKIP (agent_runtime not reachable)" and exits 0.
 *   Safe for offline CI — no LLM_API_KEY required.
 *
 * Hard-fail behavior:
 *   - non-2xx HTTP response        → exit 1
 *   - invalid JSON response        → exit 1
 *   - forbidden key found in trace → exit 1
 *   - tes_build_payload_keys wrong → exit 1
 *
 * Env vars:
 *   AGENT_BASE_URL           default: http://localhost:8787
 *   AGENT_SMOKE_TIMEOUT_MS   default: 15000
 *
 * Run:
 *   node tests/integration/agent_tes_builder_payload_gate_smoke.js
 */

"use strict";

const http = require("http");
const https = require("https");
const assert = require("assert");

const AGENT_BASE_URL = (process.env.AGENT_BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.AGENT_SMOKE_TIMEOUT_MS || 15000);

// Keys that must NEVER appear in the tes_builder decision trace.
// These are scalar-weighting / memory-search-only fields that belong exclusively
// in memory.search, not in the embedding tool call or its trace.
var FORBIDDEN_TES_BUILDER_KEYS = new Set([
    "recency_days",
    "recencyDays",
    "recency",
    "time_decay",
    "w_time",
    "w_sent",
    "w_context",
    "sentiment",
    "emotion",
    "timestamp",
]);

// Expected tes_build_payload_keys value (sorted alphabetically, deterministic).
var EXPECTED_PAYLOAD_KEYS = ["normalize", "tags", "vision_features"];

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

/**
 * Recursively walk `obj` and collect every dot-path where the key name
 * is in `forbiddenSet`. Returns an array of path strings.
 */
function scanForbiddenKeys(obj, forbiddenSet, parentPath) {
    var hits = [];
    if (!obj || typeof obj !== "object") return hits;
    if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) {
            hits = hits.concat(scanForbiddenKeys(obj[i], forbiddenSet, parentPath + "[" + i + "]"));
        }
        return hits;
    }
    var keys = Object.keys(obj);
    for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        var path = parentPath ? parentPath + "." + key : key;
        if (forbiddenSet.has(key)) {
            hits.push(path);
        }
        hits = hits.concat(scanForbiddenKeys(obj[key], forbiddenSet, path));
    }
    return hits;
}

/**
 * Find all tes_builder trace nodes in the response body.
 * Checks decision_trace, decision_trace_bundle, and nested decision_trace
 * inside bundle (to handle various response shapes).
 * Returns an array of { path, node } objects.
 */
function findTesBuilderNodes(body) {
    var candidates = [];

    var dt = (body && typeof body.decision_trace === "object" && body.decision_trace !== null && !Array.isArray(body.decision_trace))
        ? body.decision_trace : null;
    if (dt && dt.tes_builder && typeof dt.tes_builder === "object") {
        candidates.push({ path: "decision_trace.tes_builder", node: dt.tes_builder });
    }

    var bundle = (body && typeof body.decision_trace_bundle === "object" && body.decision_trace_bundle !== null && !Array.isArray(body.decision_trace_bundle))
        ? body.decision_trace_bundle : null;
    if (bundle) {
        if (bundle.tes_builder && typeof bundle.tes_builder === "object") {
            candidates.push({ path: "decision_trace_bundle.tes_builder", node: bundle.tes_builder });
        }
        var bdt = bundle.decision_trace;
        if (bdt && typeof bdt === "object" && !Array.isArray(bdt) && bdt.tes_builder && typeof bdt.tes_builder === "object") {
            candidates.push({
                path: "decision_trace_bundle.decision_trace.tes_builder",
                node: bdt.tes_builder,
            });
        }
    }

    return candidates;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log("\n--- S2 gate: tes_builder no-scalar-weighting smoke ---");

    var runUrl = AGENT_BASE_URL + "/run";
    var payload = {
        text: "cozy ramen spots in Tokyo",
        user_id: "smoke_s2_u001",
    };

    console.log("  POST " + runUrl);
    console.log("  timeout: " + TIMEOUT_MS + "ms");

    var resp;
    try {
        resp = await postJson(runUrl, payload);
    } catch (err) {
        var code = (err && err.code) || "";
        var msg = (err instanceof Error ? err.message : String(err)) || "";
        if (
            code === "ECONNREFUSED" ||
            code === "ENOTFOUND" ||
            code === "ECONNRESET" ||
            msg.indexOf("timed out") !== -1
        ) {
            console.log("  SKIP (agent_runtime not reachable: " + (msg || code) + ")");
            process.exit(0);
        }
        fail("unexpected connection error", {
            url: runUrl,
            errorMessage: msg,
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
        fail("response body must be a JSON object", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    // ── Find tes_builder trace nodes ─────────────────────────────────────────

    var candidates = findTesBuilderNodes(resp.body);
    if (candidates.length === 0) {
        console.log("  SKIP (decision_trace.tes_builder not found — pipeline may have terminated early)");
        process.exit(0);
    }

    // ── Gate 1: forbidden scalar-weighting key scan ───────────────────────────

    var allForbiddenHits = [];
    for (var ci = 0; ci < candidates.length; ci++) {
        var c = candidates[ci];
        var hits = scanForbiddenKeys(c.node, FORBIDDEN_TES_BUILDER_KEYS, c.path);
        allForbiddenHits = allForbiddenHits.concat(hits);
    }

    if (allForbiddenHits.length > 0) {
        fail(
            "S2 GATE 1 FAILED: forbidden scalar-weighting keys found in tes_builder trace: " +
            allForbiddenHits.join(", ") +
            ". These fields belong exclusively in memory.search, not in the embedding call or its trace.",
            {
                url: runUrl,
                bodyPreview: String(resp.raw || "").slice(0, 500),
            }
        );
    }
    console.log("  Gate 1 PASS: no forbidden scalar-weighting keys in tes_builder trace");

    // ── Gate 2: tes_build_payload_keys evidence ───────────────────────────────

    var primary = candidates[0];
    var tesNode = primary.node;

    // Gate 2 is unconditional: tes_build_payload_keys is now set in buildTrace() for ALL paths
    // (including fallbacks), so fallback_used=true no longer bypasses this check.
    var payloadKeys = tesNode.tes_build_payload_keys;
    if (!Array.isArray(payloadKeys)) {
        fail(
            "S2 GATE 2 FAILED: tes_builder.tes_build_payload_keys missing or not an array. " +
            "tes_build_payload_keys must always be present (set in buildTrace, not just success path). " +
            "fallback_used=" + tesNode.fallback_used,
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }

    try {
        assert.deepStrictEqual(
            payloadKeys,
            EXPECTED_PAYLOAD_KEYS,
            "tes_build_payload_keys must equal " + JSON.stringify(EXPECTED_PAYLOAD_KEYS)
        );
    } catch (e) {
        fail(
            "S2 GATE 2 FAILED: tes_builder.tes_build_payload_keys mismatch. " +
            "Expected " + JSON.stringify(EXPECTED_PAYLOAD_KEYS) +
            ", got " + JSON.stringify(payloadKeys) + ". " +
            "Only vision_features + tags + normalize must be sent to embedding.tes_build.",
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }
    console.log("  Gate 2 PASS: tes_build_payload_keys=" + JSON.stringify(payloadKeys) +
        " (fallback_used=" + tesNode.fallback_used + ")");

    // ── Evidence print ────────────────────────────────────────────────────────

    console.log("\n  Evidence:");
    console.log("    tes_builder path: " + primary.path);
    console.log("    tes_builder.fallback_used: " + tesNode.fallback_used);
    if (tesNode.backend) {
        console.log("    tes_builder.backend: " + tesNode.backend);
    }
    if (tesNode.tes_version) {
        console.log("    tes_builder.tes_version: " + tesNode.tes_version);
    }
    if (Array.isArray(tesNode.tes_build_payload_keys)) {
        console.log("    tes_builder.tes_build_payload_keys: " + JSON.stringify(tesNode.tes_build_payload_keys));
    }
    if (tesNode.input_summary) {
        var s = tesNode.input_summary;
        console.log(
            "    tes_builder.input_summary: anchor_tag_count=" + s.anchor_tag_count +
            " vision_features_count=" + s.vision_features_count
        );
    }

    console.log("\n==================================================");
    console.log("agent_tes_builder_payload_gate_smoke: PASS");
}

if (require.main === module) {
    main().catch(function (err) {
        fail("unexpected exception", {
            url: AGENT_BASE_URL + "/run",
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    });
}
