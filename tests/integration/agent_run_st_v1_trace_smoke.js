#!/usr/bin/env node
/**
 * Strict integration smoke:
 *  - Calls agent_runtime /run (real HTTP entrypoint)
 *  - Verifies decision_trace carries st_v1 TES evidence
 *
 * Hard fail policy:
 *  - endpoint unreachable / timeout / non-2xx / invalid JSON => FAIL
 *  - missing trace evidence => FAIL
 */

const http = require("http");
const https = require("https");

const AGENT_RUNTIME_BASE_URL = process.env.AGENT_RUNTIME_BASE_URL || "http://localhost:8787";
const TIMEOUT_MS = Number(process.env.AGENT_RUNTIME_TIMEOUT_MS || 8000);

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

    req.on("timeout", () => req.destroy(new Error(`request timed out after ${TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log("\n--- agent /run st_v1 trace smoke (strict) ---");

  const runUrl = `${AGENT_RUNTIME_BASE_URL.replace(/\/$/, "")}/run`;
  const payload = {
    text: "I want to travel to tokyo for food and ramen.",
    user_id: "u001",
  };

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
    fail("missing decision_trace", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 500),
    });
  }

  const tesBuilder = dt.tes_builder && typeof dt.tes_builder === "object" ? dt.tes_builder : null;
  const rerank = dt.rerank;
  if (!rerank || typeof rerank !== "object" || rerank.tes_used !== true) {
    fail("rerank trace missing tes_used=true", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 500),
    });
  }

  const hasTesBuilderBackend = tesBuilder && tesBuilder.backend === "st_v1";
  const hasRerankBackend = rerank.tes_backend === "st_v1";
  if (!hasTesBuilderBackend && !hasRerankBackend) {
    fail("missing st_v1 backend evidence in tes_builder/rerank trace", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 500),
    });
  }
  if (tesBuilder && tesBuilder.fallback_used === true && !tesBuilder.fallback_reason) {
    fail("tes_builder fallback is silent (fallback_used=true but no fallback_reason)", {
      url: runUrl,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 500),
    });
  }
  if (hasTesBuilderBackend) {
    if (!(typeof tesBuilder.model_id === "string" && tesBuilder.model_id.length > 0)
        && !(typeof tesBuilder.device === "string" && tesBuilder.device.length > 0)) {
      fail("tes_builder trace missing model_id/device evidence", {
        url: runUrl,
        status: resp.status,
        bodyPreview: String(resp.raw || "").slice(0, 500),
      });
    }
  }

  console.log("  st_v1 evidence:");
  console.log(`    tes_builder.backend=${tesBuilder?.backend ?? "n/a"}`);
  console.log(`    tes_builder.model_id=${tesBuilder?.model_id ?? "n/a"}`);
  console.log(`    tes_builder.device=${tesBuilder?.device ?? "n/a"}`);
  console.log(`    rerank.tes_backend=${rerank.tes_backend ?? "n/a"}`);
  console.log(`    rerank.tes_used=${rerank.tes_used}`);
  console.log("agent_run_st_v1_trace_smoke: PASS");
}

if (require.main === module) {
  main().catch((err) => {
    fail("unexpected exception", {
      url: `${AGENT_RUNTIME_BASE_URL.replace(/\/$/, "")}/run`,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  });
}
