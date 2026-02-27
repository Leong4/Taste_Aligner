#!/usr/bin/env node
/**
 * Integration smoke: agent_runtime /run with OpenAI-compatible LLM provider.
 *
 * Verifies that when agent_runtime is configured with LLM_PROVIDER=openai_compat,
 * the LLM-backed skills (tag_expand, explain_from_trace) use a real provider —
 * not the mock fallback — and that the response is structurally sound.
 *
 * NOTE:
 *   This is an integration smoke and depends on external LLM availability.
 *   If LLM_API_KEY is absent, the test auto-SKIPs and exits 0.
 *
 * Skip behavior:
 *   If LLM_API_KEY is not set in the test environment, prints
 *   "SKIP (missing LLM_API_KEY)" and exits 0.  Safe for offline CI.
 *
 * Hard-fail behavior:
 *   - agent_runtime unreachable or timeout  → exit 1
 *   - non-2xx HTTP                          → exit 1
 *   - invalid JSON                          → exit 1
 *   - NaN/Infinity in response              → exit 1
 *   - llm_call.provider === "mock"          → exit 1
 *   - llm_call.fallback_used !== false      → exit 1
 *
 * Prerequisites (when LLM_API_KEY is present):
 *   - agent_runtime running at AGENT_BASE_URL with:
 *       LLM_PROVIDER=openai_compat
 *       LLM_API_KEY=<your key>
 *       LLM_BASE_URL=<optional, e.g. https://api.openai.com/v1>
 *       LLM_MODEL=<optional, default gpt-4o-mini>
 *
 * Env vars:
 *   AGENT_BASE_URL              default: http://localhost:8787
 *   AGENT_LLM_SMOKE_TIMEOUT_MS  default: 60000
 *   LLM_API_KEY                 required to run (SKIP if absent)
 *
 * Run:
 *   LLM_API_KEY=sk-... node tests/integration/agent_llm_openai_compat_smoke.js
 */

"use strict";

const assert = require("assert");
const http = require("http");
const https = require("https");

const AGENT_BASE_URL = (process.env.AGENT_BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.AGENT_LLM_SMOKE_TIMEOUT_MS || 60000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message, details) {
    details = details || {};
    console.error(`  FAIL: ${message}`);
    if (details.url) console.error(`  URL: ${details.url}`);
    if (details.status !== undefined) console.error(`  HTTP status: ${details.status}`);
    if (details.bodyPreview) console.error(`  Response body (first 500 chars): ${details.bodyPreview}`);
    if (details.errorMessage) console.error(`  Error: ${details.errorMessage}`);
    process.exit(1);
}

function warn(message) {
    console.warn(`  WARN: ${message}`);
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

/** Walk a parsed JSON value; return path + value of the first non-finite number found, or null. */
function findNonFinite(obj, path) {
    path = path || "";
    if (typeof obj === "number") {
        if (!Number.isFinite(obj)) return `${path}=${obj}`;
    } else if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            const found = findNonFinite(obj[i], `${path}[${i}]`);
            if (found) return found;
        }
    } else if (obj !== null && typeof obj === "object") {
        for (const key of Object.keys(obj)) {
            const found = findNonFinite(obj[key], path ? `${path}.${key}` : key);
            if (found) return found;
        }
    }
    return null;
}

function assertNoForbiddenTraceKeys(obj, basePath, forbiddenKeys) {
    const hits = [];
    function walk(value, path) {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                walk(value[i], `${path}[${i}]`);
            }
            return;
        }
        for (const key of Object.keys(value)) {
            const nextPath = path ? `${path}.${key}` : key;
            if (forbiddenKeys.has(key)) {
                hits.push(nextPath);
            }
            walk(value[key], nextPath);
        }
    }
    walk(obj, basePath);
    return hits;
}

/** Assert an llm_call trace node is present and strict-valid for openai_compat integration. */
function assertLLMCall(llmCall, nodeName, raw, runUrl) {
    if (!llmCall || typeof llmCall !== "object") {
        fail(`decision_trace.${nodeName}.llm_call missing or not an object`, {
            url: runUrl,
            bodyPreview: String(raw || "").slice(0, 500),
        });
    }

    if (llmCall.provider !== "openai_compat") {
        fail(
            `decision_trace.${nodeName}.llm_call.provider expected "openai_compat", got "${llmCall.provider}".`,
            { url: runUrl, bodyPreview: String(raw || "").slice(0, 500) }
        );
    }

    if (llmCall.fallback_used !== false) {
        fail(
            `decision_trace.${nodeName}.llm_call.fallback_used expected false, got ${llmCall.fallback_used}. ` +
            "Check runtime logs for LLM errors.",
            { url: runUrl, bodyPreview: String(raw || "").slice(0, 500) }
        );
    }

    if (!llmCall.usage || typeof llmCall.usage !== "object") {
        warn(`decision_trace.${nodeName}.llm_call.usage absent or not an object (provider may omit it)`);
    }

    return llmCall.provider;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log("\n--- agent /run LLM openai_compat smoke ---");

    // Guard: skip when no API key available (offline CI / local dev without LLM)
    if (!process.env.LLM_API_KEY) {
        console.log("  SKIP (missing LLM_API_KEY)");
        console.log("  Set LLM_API_KEY and start agent_runtime with LLM_PROVIDER=openai_compat to run this smoke.");
        process.exit(0);
    }

    const runUrl = `${AGENT_BASE_URL}/run`;
    const payload = {
        text: "I want cozy ramen spots in Tokyo for dinner.",
        user_id: "smoke_llm_u001",
    };

    console.log(`  POST ${runUrl}`);
    console.log(`  timeout: ${TIMEOUT_MS}ms`);

    let resp;
    let resp2;
    try {
        resp = await postJson(runUrl, payload);
        resp2 = await postJson(runUrl, payload);
    } catch (err) {
        fail(
            "agent_runtime /run unreachable or timed out. " +
            "Start agent_runtime with LLM_PROVIDER=openai_compat + LLM_API_KEY before running this smoke.",
            {
                url: runUrl,
                status: err && err.status,
                bodyPreview: err && err.raw ? String(err.raw).slice(0, 500) : undefined,
                errorMessage: err instanceof Error ? err.message : String(err),
            }
        );
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

    // ── Non-finite number check (primary: structured scan) ───────────────────
    // String-level check kept as diagnostic only.
    if (resp.raw.includes("NaN") || resp.raw.includes("Infinity")) {
        warn('response body text contains "NaN" or "Infinity" token (diagnostic only)');
    }

    // Structured parsed-value walk (hard gate) scoped to trace payload only.
    const traceScope = {
        decision_trace: (resp.body && typeof resp.body === "object") ? resp.body.decision_trace : null,
        decision_trace_bundle:
            (resp.body.decision_trace_bundle && typeof resp.body.decision_trace_bundle === "object")
                ? resp.body.decision_trace_bundle
                : null,
    };
    const nonFinitePath = findNonFinite(traceScope);
    if (nonFinitePath) {
        fail(`trace payload contains non-finite number: ${nonFinitePath}`, {
            url: runUrl,
            status: resp.status,
            bodyPreview: resp.raw.slice(0, 500),
        });
    }

    // ── decision_trace ────────────────────────────────────────────────────────

    const dt = resp.body.decision_trace;
    if (!dt || typeof dt !== "object" || Array.isArray(dt)) {
        fail("missing or invalid decision_trace in /run response", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    const forbiddenTraceKeys = new Set([
        "latency_ms",
        "timestamp",
        "request_id",
        "created_at",
        "time",
        "date",
    ]);
    const forbiddenHits = [
        ...assertNoForbiddenTraceKeys(dt, "decision_trace", forbiddenTraceKeys),
        ...assertNoForbiddenTraceKeys(
            (resp.body.decision_trace_bundle && typeof resp.body.decision_trace_bundle === "object")
                ? resp.body.decision_trace_bundle
                : null,
            "decision_trace_bundle",
            forbiddenTraceKeys
        ),
    ];
    if (forbiddenHits.length > 0) {
        fail(`forbidden trace keys found: ${forbiddenHits.join(", ")}`, {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    // ── tag_expand ────────────────────────────────────────────────────────────

    const tagExpand = dt.tag_expand;
    if (!tagExpand || typeof tagExpand !== "object") {
        fail("decision_trace.tag_expand missing", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    const tagExpandProvider = assertLLMCall(tagExpand.llm_call, "tag_expand", resp.raw, runUrl);
    if (tagExpand.fallback_used !== undefined && tagExpand.fallback_used !== false) {
        fail(
            `decision_trace.tag_expand.fallback_used expected false when present, got ${tagExpand.fallback_used}`,
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }

    // ── explain_from_trace ────────────────────────────────────────────────────

    const explain = dt.explain_from_trace;
    if (!explain || typeof explain !== "object") {
        fail("decision_trace.explain_from_trace missing", {
            url: runUrl,
            status: resp.status,
            bodyPreview: String(resp.raw || "").slice(0, 500),
        });
    }

    const explainProvider = assertLLMCall(explain.llm_call, "explain_from_trace", resp.raw, runUrl);
    if (explain.fallback_used !== undefined && explain.fallback_used !== false) {
        fail(
            `decision_trace.explain_from_trace.fallback_used expected false when present, got ${explain.fallback_used}`,
            { url: runUrl, bodyPreview: String(resp.raw || "").slice(0, 500) }
        );
    }

    // ── Determinism gate (same payload, two /run calls) ─────────────────────
    if (resp2.status < 200 || resp2.status >= 300) {
        fail("second /run call returned non-2xx", {
            url: runUrl,
            status: resp2.status,
            bodyPreview: String(resp2.raw || "").slice(0, 500),
        });
    }
    if (!resp2.body || typeof resp2.body !== "object" || Array.isArray(resp2.body)) {
        fail("second /run response body must be a JSON object", {
            url: runUrl,
            status: resp2.status,
            bodyPreview: String(resp2.raw || "").slice(0, 500),
        });
    }
    const dt2 = resp2.body.decision_trace;
    if (!dt2 || typeof dt2 !== "object" || Array.isArray(dt2)) {
        fail("missing or invalid decision_trace in second /run response", {
            url: runUrl,
            status: resp2.status,
            bodyPreview: String(resp2.raw || "").slice(0, 500),
        });
    }
    if (!dt2.tag_expand || typeof dt2.tag_expand !== "object") {
        fail("decision_trace.tag_expand missing in second /run response", {
            url: runUrl,
            status: resp2.status,
            bodyPreview: String(resp2.raw || "").slice(0, 500),
        });
    }
    if (!dt2.explain_from_trace || typeof dt2.explain_from_trace !== "object") {
        fail("decision_trace.explain_from_trace missing in second /run response", {
            url: runUrl,
            status: resp2.status,
            bodyPreview: String(resp2.raw || "").slice(0, 500),
        });
    }
    try {
        assert.deepStrictEqual(tagExpand, dt2.tag_expand);
    } catch (err) {
        fail("determinism gate failed for decision_trace.tag_expand across two /run calls", {
            url: runUrl,
            bodyPreview: String(resp2.raw || "").slice(0, 500),
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        assert.deepStrictEqual(explain, dt2.explain_from_trace);
    } catch (err) {
        fail("determinism gate failed for decision_trace.explain_from_trace across two /run calls", {
            url: runUrl,
            bodyPreview: String(resp2.raw || "").slice(0, 500),
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    }

    // ── Top-level response fields ─────────────────────────────────────────────

    if (typeof resp.body.explanation !== "string" || resp.body.explanation.length === 0) {
        warn("response.explanation is absent or empty (LLM may have returned fallback content)");
    }

    // ── Evidence print ────────────────────────────────────────────────────────

    console.log("  LLM evidence:");
    console.log(`    tag_expand.llm_call.provider=${tagExpandProvider}`);
    console.log(`    tag_expand.llm_call.fallback_used=${tagExpand.llm_call.fallback_used}`);
    if (tagExpand.llm_call.usage) {
        const u = tagExpand.llm_call.usage;
        console.log(`    tag_expand.llm_call.usage={prompt:${u.prompt_tokens}, completion:${u.completion_tokens}, total:${u.total_tokens}}`);
    } else {
        console.log("    tag_expand.llm_call.usage=(absent)");
    }
    console.log(`    explain_from_trace.llm_call.provider=${explainProvider}`);
    console.log(`    explain_from_trace.llm_call.fallback_used=${explain.llm_call.fallback_used}`);
    if (explain.llm_call.usage) {
        const u = explain.llm_call.usage;
        console.log(`    explain_from_trace.llm_call.usage={prompt:${u.prompt_tokens}, completion:${u.completion_tokens}, total:${u.total_tokens}}`);
    } else {
        console.log("    explain_from_trace.llm_call.usage=(absent)");
    }
    if (resp.body.explanation) {
        console.log(`    response.explanation preview: "${String(resp.body.explanation).slice(0, 80)}..."`);
    }

    console.log("\n==================================================");
    console.log("agent_llm_openai_compat_smoke: PASS");
}

if (require.main === module) {
    main().catch((err) => {
        fail("unexpected exception", {
            url: `${AGENT_BASE_URL}/run`,
            errorMessage: err instanceof Error ? err.message : String(err),
        });
    });
}
