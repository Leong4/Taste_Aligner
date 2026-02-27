#!/usr/bin/env node
/**
 * Gateway ontology.normalize contract smoke.
 *
 * Cases:
 *  A) missing data -> 400
 *  B) data.tags is string -> 400
 *  C) valid payload -> 200 + normalized_tags:string[] + deterministic output
 */

const http = require("http");
const https = require("https");
const assert = require("assert");

const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "http://localhost:8080";
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 8000);

function fail(message, details = {}) {
  console.error(`FAIL: ${message}`);
  if (details.url) console.error(`URL: ${details.url}`);
  if (details.status !== undefined) console.error(`HTTP status: ${details.status}`);
  if (details.bodyPreview) console.error(`Body (first 800 chars): ${details.bodyPreview}`);
  if (details.errorMessage) console.error(`Error: ${details.errorMessage}`);
  process.exit(1);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const isHttps = parsed.protocol === "https:";
    const client = isHttps ? https : http;

    const req = client.request({
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

function assertInvalidInputEnvelope(resp, label, url) {
  assert.strictEqual(resp.status, 400, `${label}: expected HTTP 400`);
  assert.ok(resp.body && typeof resp.body === "object" && !Array.isArray(resp.body), `${label}: response must be JSON object`);
  assert.strictEqual(resp.body.ok, false, `${label}: ok must be false`);
  assert.ok(resp.body.error && typeof resp.body.error === "object", `${label}: error must be object`);
  assert.strictEqual(resp.body.error.code, "INVALID_TOOL_INPUT", `${label}: error.code mismatch`);
  assert.ok(typeof resp.body.error.message === "string" && resp.body.error.message.length > 0, `${label}: error.message must be non-empty`);
  if (!resp.body.error.details || typeof resp.body.error.details !== "object") {
    fail(`${label}: missing error.details`, {
      url,
      status: resp.status,
      bodyPreview: String(resp.raw || "").slice(0, 800),
    });
  }
}

async function main() {
  const url = `${GATEWAY_BASE_URL.replace(/\/$/, "")}/tool/ontology.normalize`;
  console.log("\n--- ontology.normalize gateway smoke ---");

  let caseA;
  try {
    caseA = await postJson(url, { tags: ["ramen"] });
  } catch (err) {
    fail("gateway is unreachable or response is not JSON", {
      url,
      status: err && err.status,
      bodyPreview: err && err.raw ? String(err.raw).slice(0, 800) : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
  assertInvalidInputEnvelope(caseA, "Case A (missing data)", url);

  const caseB = await postJson(url, { data: { tags: "ramen" } });
  assertInvalidInputEnvelope(caseB, "Case B (data.tags is string)", url);

  const validPayload = { data: { tags: ["ramen", "izakaya"], lang: "auto", strict: true } };
  const caseC1 = await postJson(url, validPayload);
  const caseC2 = await postJson(url, validPayload);

  assert.strictEqual(caseC1.status, 200, "Case C first call: expected HTTP 200");
  assert.strictEqual(caseC2.status, 200, "Case C second call: expected HTTP 200");

  const body1 = caseC1.body;
  const body2 = caseC2.body;

  assert.ok(body1 && typeof body1 === "object" && !Array.isArray(body1), "Case C first call: body must be object");
  assert.ok(body2 && typeof body2 === "object" && !Array.isArray(body2), "Case C second call: body must be object");
  assert.ok(Array.isArray(body1.normalized_tags), "Case C first call: normalized_tags must be an array");
  assert.ok(Array.isArray(body2.normalized_tags), "Case C second call: normalized_tags must be an array");
  assert.ok(body1.normalized_tags.every((v) => typeof v === "string"), "Case C first call: normalized_tags must be string[]");
  assert.ok(body2.normalized_tags.every((v) => typeof v === "string"), "Case C second call: normalized_tags must be string[]");
  assert.deepStrictEqual(body1.normalized_tags, body2.normalized_tags, "Case C deterministic check failed: normalized_tags mismatch");

  console.log("PASS: Case A missing data -> HTTP 400");
  console.log("PASS: Case B data.tags string -> HTTP 400");
  console.log("PASS: Case C valid payload -> HTTP 200 + normalized_tags:string[] + deterministic");
}

if (require.main === module) {
  main().catch((err) => {
    fail("unexpected exception", {
      url: `${GATEWAY_BASE_URL.replace(/\/$/, "")}/tool/ontology.normalize`,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  });
}

