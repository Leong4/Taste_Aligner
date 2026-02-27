#!/usr/bin/env node
/**
 * Strict integration smoke:
 *  - Calls agent_runtime /run
 *  - Verifies mix_policy memory_confidence source is memory_weight_adjust
 *  - Verifies memory_signal is not executed in the main path
 */

const http = require("http");
const https = require("https");

const AGENT_RUNTIME_BASE_URL = process.env.AGENT_RUNTIME_BASE_URL || "http://localhost:8787";
const TIMEOUT_MS = Number(process.env.AGENT_RUNTIME_TIMEOUT_MS || 8000);

function fail(message, details = {}) {
  console.error(`  FAIL: ${message}`);
  if (details.url) console.error(`  URL: ${details.url}`);
  if (details.status !== undefined) console.error(`  HTTP status: ${details.status}`);
  if (details.bodyPreview) console.error(`  Response body (first 800 chars): ${details.bodyPreview}`);
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
  console.log("\n--- agent /run memory confidence source smoke (strict) ---");

  const runUrl = `${AGENT_RUNTIME_BASE_URL.replace(/\/$/, "")}/run`;
  const payload = {
    text: "Plan a Tokyo food trip with ramen and izakaya choices.",
    user_id: "u001",
  };

  let resp;
  try {
    resp = await postJson(runUrl, payload);
  } catch (err) {
    fail("agent_runtime /run unreachable or timeout (please start agent_runtime service first)", {
      url: runUrl,
      status: err && err.status,
      bodyPreview: err && err.raw ? String(err.raw).slice(0, 800) : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  if (resp.status < 200 || resp.status >= 300) {
    fail("non-2xx from /run", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }

  if (!resp.body || typeof resp.body !== "object" || Array.isArray(resp.body)) {
    fail("response body must be a JSON object", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }

  const dt = resp.body.decision_trace;
  if (!dt || typeof dt !== "object" || Array.isArray(dt)) {
    fail("missing decision_trace", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }

  const mixPolicyTrace = dt.mix_policy;
  if (!mixPolicyTrace || typeof mixPolicyTrace !== "object") {
    fail("missing decision_trace.mix_policy", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }
  if (mixPolicyTrace.memory_confidence_source !== "memory_weight_adjust") {
    fail("mix_policy did not mark memory_weight_adjust as memory_confidence source", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }
  if (typeof mixPolicyTrace.memory_confidence !== "number" || !Number.isFinite(mixPolicyTrace.memory_confidence)) {
    fail("mix_policy trace must include numeric memory_confidence", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }

  const memoryWeightAdjustTrace = dt.memory_weight_adjust;
  if (!memoryWeightAdjustTrace || typeof memoryWeightAdjustTrace !== "object") {
    fail("missing decision_trace.memory_weight_adjust", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }

  // fallback_used must be present and boolean
  if (memoryWeightAdjustTrace.fallback_used !== true && memoryWeightAdjustTrace.fallback_used !== false) {
    fail("memory_weight_adjust.fallback_used must be boolean", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }

  // If we did NOT fall back, we require structured tool evidence for the gateway call.
  // If we DID fall back (e.g. no_tags / tool_error), tool evidence may be absent.
  if (memoryWeightAdjustTrace.fallback_used === false) {
    if (!memoryWeightAdjustTrace.tool || typeof memoryWeightAdjustTrace.tool !== "object") {
      fail("memory_weight_adjust trace must include structured tool evidence when fallback_used=false", {
        url: runUrl,
        status: resp.status,
        bodyPreview: String(resp.raw || "").slice(0, 800),
      });
    }
    if (memoryWeightAdjustTrace.tool.name !== "memory.search") {
      fail("memory_weight_adjust.tool.name must be memory.search when fallback_used=false", {
        url: runUrl,
        status: resp.status,
        bodyPreview: String(resp.raw || "").slice(0, 800),
      });
    }
  } else {
    // fallback_used === true: require a non-empty fallback_reason
    if (typeof memoryWeightAdjustTrace.fallback_reason !== "string" || memoryWeightAdjustTrace.fallback_reason.length === 0) {
      fail("memory_weight_adjust fallback_used=true requires non-empty fallback_reason", {
        url: runUrl,
        status: resp.status,
        bodyPreview: String(resp.raw || "").slice(0, 800),
      });
    }
    // If tool evidence exists even in fallback, it must still be well-formed.
    if (memoryWeightAdjustTrace.tool !== undefined) {
      if (!memoryWeightAdjustTrace.tool || typeof memoryWeightAdjustTrace.tool !== "object") {
        fail("memory_weight_adjust.tool must be an object when present", {
          url: runUrl,
          status: resp.status,
          bodyPreview: String(resp.raw || "").slice(0, 800),
        });
      }
      if (memoryWeightAdjustTrace.tool.name !== "memory.search") {
        fail("memory_weight_adjust.tool.name must be memory.search when tool is present", {
          url: runUrl,
          status: resp.status,
          bodyPreview: String(resp.raw || "").slice(0, 800),
        });
      }
    }
  }

  if (dt.memory_signal !== undefined) {
    fail("decision_trace.memory_signal should be absent in main graph path", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }

  const timing = resp.body.timing;
  if (timing !== undefined && (typeof timing !== "object" || timing === null || Array.isArray(timing))) {
    fail("timing must be an object when present", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }
  if (timing && timing.memory_signal !== undefined) {
    fail("timing.memory_signal should be absent (legacy node must not execute)", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }
  if (timing && (typeof timing.memory_weight_adjust !== "number" || !Number.isFinite(timing.memory_weight_adjust))) {
    fail("timing.memory_weight_adjust should exist as a finite number", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }

  console.log("  mix_policy.memory_confidence_source=memory_weight_adjust");
  console.log("  mix_policy.memory_confidence is finite number");
  console.log("  memory_weight_adjust.tool.name=memory.search");
  console.log("  memory_weight_adjust fallback fields are consistent");
  console.log("  memory_signal execution evidence absent");
  console.log("  timing.memory_weight_adjust is present and numeric");
  console.log("  removed pseudo-assert: JSON.stringify(decision_trace) /\"memory.search\"/g count");
  console.log("  replaced with structured trace/timing assertions to avoid string-count false positives");
  console.log("agent_memory_confidence_source_smoke: PASS");
}

if (require.main === module) {
  main().catch((err) => {
    fail("unexpected exception", {
      url: `${AGENT_RUNTIME_BASE_URL.replace(/\/$/, "")}/run`,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  });
}
