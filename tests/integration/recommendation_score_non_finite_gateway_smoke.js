#!/usr/bin/env node
/**
 * Strict gateway smoke for recommendation.score:
 *  - must return HTTP 200
 *  - response must be valid JSON
 *  - response must not contain NaN/Infinity tokens
 *  - all numeric values in parsed JSON must be finite
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

function assertFiniteNumbers(value, path = "") {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number at ${path || "<root>"}: ${String(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertFiniteNumbers(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.keys(value).forEach((k) => {
      const next = path ? `${path}.${k}` : k;
      assertFiniteNumbers(value[k], next);
    });
  }
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let bodyJson;
        try {
          bodyJson = JSON.parse(raw);
        } catch (err) {
          return reject(Object.assign(new Error("response is not valid JSON"), {
            status: res.statusCode,
            raw,
          }));
        }
        resolve({ status: res.statusCode || 0, body: bodyJson, raw });
      });
    });

    req.on("timeout", () => req.destroy(new Error(`request timed out after ${TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log("\n--- recommendation.score non-finite gateway smoke ---");
  const url = `${GATEWAY_BASE_URL.replace(/\/$/, "")}/tool/recommendation.score`;
  const payload = {
    data: {
      user_id: "u001",
      city: "tokyo",
      tags: ["ramen", "izakaya"],
      top_k: 10,
    },
  };

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

  if (resp.status !== 200) {
    fail("recommendation.score must return HTTP 200", {
      url,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 500),
    });
  }

  if (/Infinity|NaN/.test(resp.raw)) {
    fail("response raw JSON contains non-finite tokens", {
      url,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 500),
    });
  }

  try {
    assertFiniteNumbers(resp.body);
  } catch (err) {
    fail("parsed response contains non-finite number", {
      url,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 500),
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  console.log("  HTTP 200 OK");
  console.log("  response JSON contains only finite numbers");
  console.log("recommendation_score_non_finite_gateway_smoke: PASS");
}

if (require.main === module) {
  main().catch((err) => {
    fail("unexpected exception", {
      url: `${GATEWAY_BASE_URL.replace(/\/$/, "")}/tool/recommendation.score`,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  });
}
