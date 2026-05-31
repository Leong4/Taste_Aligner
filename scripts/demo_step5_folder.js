#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const AGENT_BASE_URL = process.env.AGENT_BASE_URL || "http://localhost:8787";
const MEMORY_BASE_URL = process.env.MEMORY_BASE_URL || "http://localhost:5001";
const STEP5_INPUT_DIR = process.env.STEP5_INPUT_DIR ||
    path.join(process.cwd(), "demo_inputs", "step5");
const STEP5_QUERY = process.env.STEP5_QUERY || "I want ramen in tokyo";
const STEP5_USER_ID = process.env.STEP5_USER_ID || "step5_demo_user";
const STEP5_CITY = process.env.STEP5_CITY || "tokyo";
const UPLOAD_TEXT_PREFIX = "Please remember this tokyo ramen food photo for my taste profile.";
const SUPPORTED_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function listImages(dirPath) {
    return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith("."))
        .filter((name) => SUPPORTED_EXTS.has(path.extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
        .map((name) => path.join(dirPath, name));
}

function mimeFromExt(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    return "application/octet-stream";
}

function toDataUrl(filePath) {
    const buf = fs.readFileSync(filePath);
    return `data:${mimeFromExt(filePath)};base64,${buf.toString("base64")}`;
}

function readCaptionForImage(filePath, index) {
    const ext = path.extname(filePath);
    const baseWithoutExt = filePath.slice(0, filePath.length - ext.length);
    const sidecarPaths = [
        `${baseWithoutExt}.txt`,
        `${filePath}.txt`,
    ];
    for (const p of sidecarPaths) {
        if (!fs.existsSync(p)) continue;
        const value = fs.readFileSync(p, "utf8").trim();
        if (value) return value;
    }
    return `Photo ${index + 1}: travel memory in ${STEP5_CITY}.`;
}

function postJson(urlString, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const payload = JSON.stringify(body);
        const client = url.protocol === "https:" ? https : http;
        const req = client.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname + url.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
            timeout: 15000,
        }, (res) => {
            let raw = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { raw += chunk; });
            res.on("end", () => {
                let parsed = null;
                try {
                    parsed = raw ? JSON.parse(raw) : null;
                } catch (err) {
                    reject(new Error(`Non-JSON response from ${urlString}: ${raw.slice(0, 300)}`));
                    return;
                }
                resolve({ status: res.statusCode || 0, body: parsed, raw });
            });
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error(`Request timed out: ${urlString}`)));
        req.write(payload);
        req.end();
    });
}

function getJson(urlString) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const client = url.protocol === "https:" ? https : http;
        const req = client.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname + url.search,
            method: "GET",
            timeout: 10000,
        }, (res) => {
            let raw = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { raw += chunk; });
            res.on("end", () => {
                let parsed = null;
                try {
                    parsed = raw ? JSON.parse(raw) : null;
                } catch (err) {
                    reject(new Error(`Non-JSON response from ${urlString}: ${raw.slice(0, 300)}`));
                    return;
                }
                resolve({ status: res.statusCode || 0, body: parsed, raw });
            });
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error(`Request timed out: ${urlString}`)));
        req.end();
    });
}

function getStatus(urlString) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const client = url.protocol === "https:" ? https : http;
        const req = client.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname + url.search,
            method: "GET",
            timeout: 10000,
        }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode || 0));
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error(`Request timed out: ${urlString}`)));
        req.end();
    });
}

function fail(message, extra) {
    console.error(`[step5] FAIL: ${message}`);
    if (extra) {
        console.error(JSON.stringify(extra, null, 2));
    }
    process.exit(1);
}

function getTesBuilderTrace(resp) {
    return resp && resp.body && resp.body.decision_trace && resp.body.decision_trace.tes_builder;
}

function getProfileNode(resp) {
    return resp && resp.body && resp.body.decision_trace && resp.body.decision_trace.profile_vector_node;
}

function extractCards(resp) {
    return Array.isArray(resp && resp.body && resp.body.cards)
        ? resp.body.cards
        : Array.isArray(resp && resp.body && resp.body.output && resp.body.output.cards)
        ? resp.body.output.cards
        : [];
}

function extractCardTitles(resp) {
    const cards = extractCards(resp);
    const titles = [];
    for (const card of cards) {
        if (!card || typeof card !== "object") continue;
        if (typeof card.title === "string" && card.title.trim()) {
            titles.push(card.title.trim());
            continue;
        }
        if (Array.isArray(card.items)) {
            for (const item of card.items) {
                if (item && typeof item === "object") {
                    if (typeof item.title === "string" && item.title.trim()) {
                        titles.push(item.title.trim());
                        continue;
                    }
                    if (typeof item.name === "string" && item.name.trim()) {
                        titles.push(item.name.trim());
                    }
                } else if (typeof item === "string" && item.trim()) {
                    titles.push(item.trim());
                }
            }
        }
    }
    return titles;
}

function extractTopItems(resp, limit) {
    const cards = extractCards(resp);
    const items = [];
    for (const card of cards) {
        if (!card || typeof card !== "object" || !Array.isArray(card.items)) continue;
        for (const item of card.items) {
            if (!item || typeof item !== "object") continue;
            items.push({
                item_id: typeof item.item_id === "string" ? item.item_id : "",
                name: typeof item.name === "string" ? item.name : "",
                city: typeof item.city === "string" ? item.city : "",
                type: typeof item.type === "string" ? item.type : "",
                zone: typeof card.zone === "string" ? card.zone : "",
                score_breakdown:
                    item.score_breakdown && typeof item.score_breakdown === "object"
                        ? item.score_breakdown
                        : null,
                scores:
                    item.scores && typeof item.scores === "object"
                        ? item.scores
                        : null,
            });
            if (items.length >= limit) {
                return items;
            }
        }
    }
    return items;
}

function extractTopItemIds(resp, limit) {
    return extractTopItems(resp, limit).map((item) => item.item_id);
}

function formatMaybeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function extractAnchorSummary(profileNode) {
    const anchors = Array.isArray(profileNode && profileNode.anchors) ? profileNode.anchors : [];
    return anchors.map((anchor) => ({
        memory_id: anchor.memory_id,
        final_weight: anchor.final_weight,
        w_time: anchor.w_time,
        w_sent: anchor.w_sent,
    }));
}

function normalizeProfileNodeForGate(profileNode) {
    if (!profileNode || typeof profileNode !== "object") {
        return null;
    }
    const anchors = Array.isArray(profileNode.anchors) ? profileNode.anchors : [];
    return {
        rule_id: profileNode.rule_id,
        schema_version: profileNode.schema_version,
        now_source: profileNode.now_source,
        total_memories_considered: profileNode.total_memories_considered,
        profile_vector_dim: profileNode.profile_vector_dim,
        has_embeddings: profileNode.has_embeddings,
        fallback_used: profileNode.fallback_used,
        weights_summary: profileNode.weights_summary && typeof profileNode.weights_summary === "object"
            ? {
                dominant_reason: profileNode.weights_summary.dominant_reason,
                sentiment_bias: profileNode.weights_summary.sentiment_bias,
                context_bias: profileNode.weights_summary.context_bias,
            }
            : null,
        anchor_keys: anchors.map((anchor) => ({
            memory_id: anchor.memory_id,
            cosine: anchor.cosine,
            w_sent: anchor.w_sent,
            w_context: anchor.w_context,
        })),
    };
}

function extractQueryTagsFromUpload(resp) {
    const normalized = resp && resp.body && resp.body.decision_trace &&
        resp.body.decision_trace.tag_normalize &&
        resp.body.decision_trace.tag_normalize.normalized_tags;
    if (Array.isArray(normalized) && normalized.length > 0) {
        return normalized
            .filter((tag) => typeof tag === "string" && tag.trim())
            .map((tag) => tag.trim().toLowerCase());
    }
    const intentTags = resp && resp.body && resp.body.decision_trace &&
        resp.body.decision_trace.extract_intent &&
        resp.body.decision_trace.extract_intent.tags;
    if (Array.isArray(intentTags) && intentTags.length > 0) {
        return intentTags
            .filter((tag) => typeof tag === "string" && tag.trim())
            .map((tag) => tag.trim().toLowerCase());
    }
    return ["ramen"];
}

function extractCityFromUpload(resp) {
    const city = resp && resp.body && resp.body.decision_trace &&
        resp.body.decision_trace.extract_intent &&
        resp.body.decision_trace.extract_intent.city;
    return (typeof city === "string" && city.trim()) ? city.trim().toLowerCase() : "tokyo";
}

function parseIsoMs(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

async function searchMemoryDirect(queryTags, city) {
    const url = new URL("/search", MEMORY_BASE_URL).toString();
    const resp = await postJson(url, {
        data: {
            user_id: STEP5_USER_ID,
            query_tags: queryTags,
            city,
            top_k: 10,
            now_ts: new Date().toISOString(),
        },
    });
    if (resp.status !== 200 || !resp.body || typeof resp.body !== "object") {
        return [];
    }
    return Array.isArray(resp.body.results) ? resp.body.results : [];
}

async function readMemoryDirect(memoryId) {
    const url = new URL(`/read/${encodeURIComponent(memoryId)}`, MEMORY_BASE_URL).toString();
    const resp = await getJson(url);
    if (resp.status !== 200 || !resp.body || typeof resp.body !== "object") {
        return null;
    }
    return resp.body;
}

function extractRecallSummary(resp) {
    const candidates = [
        resp && resp.body && resp.body.decision_trace_bundle &&
            resp.body.decision_trace_bundle.memory_weight_adjust &&
            resp.body.decision_trace_bundle.memory_weight_adjust.weighted_results,
        resp && resp.body && resp.body.output &&
            resp.body.output.decision_trace_bundle &&
            resp.body.output.decision_trace_bundle.memory_weight_adjust &&
            resp.body.output.decision_trace_bundle.memory_weight_adjust.weighted_results,
        resp && resp.body && resp.body.decision_trace &&
            resp.body.decision_trace.memory_weight_adjust &&
            resp.body.decision_trace.memory_weight_adjust.weighted_results,
    ];
    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) continue;
        return candidate.map((row) => ({
            memory_id: row.memory_id,
            score: row.score,
            w_time: row.w_time,
            w_sent: row.w_sent,
            timestamp: row.timestamp,
        }));
    }
    return [];
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMemoryVisible(uploadStartMs, queryTags, city) {
    const timeoutMs = 5000;
    const pollMs = 250;
    const deadline = Date.now() + timeoutMs;
    let lastResults = [];
    while (Date.now() < deadline) {
        lastResults = await searchMemoryDirect(queryTags, city);
        const visible = [];
        for (const row of lastResults) {
            if (!row || typeof row !== "object" || typeof row.memory_id !== "string") continue;
            const memory = await readMemoryDirect(row.memory_id);
            if (!memory || memory.user_id !== STEP5_USER_ID || memory.source !== "upload") continue;
            const timestampMs = parseIsoMs(memory.timestamp);
            if (timestampMs === null || timestampMs < uploadStartMs - 5000) continue;
            visible.push({
                memory_id: memory.memory_id,
                timestamp: memory.timestamp,
                source: memory.source,
                city: memory.city || null,
            });
        }
        if (visible.length > 0) {
            visible.sort((a, b) => {
                const aTs = parseIsoMs(a.timestamp) || 0;
                const bTs = parseIsoMs(b.timestamp) || 0;
                if (bTs !== aTs) return bTs - aTs;
                return String(a.memory_id).localeCompare(String(b.memory_id));
            });
            return visible;
        }
        await delay(pollMs);
    }
    fail("upload queued but memory not visible in memory.search within timeout", {
        user_id: STEP5_USER_ID,
        query_tags: queryTags,
        city,
        last_results_preview: lastResults.slice(0, 3),
    });
}

async function uploadOne(runUrl, filePath, index) {
    const uploadStartMs = Date.now();
    const caption = readCaptionForImage(filePath, index);
    const resp = await postJson(runUrl, {
        text: `${UPLOAD_TEXT_PREFIX} [${index + 1}] ${path.basename(filePath)}`,
        caption,
        city: STEP5_CITY,
        user_id: STEP5_USER_ID,
        image_base64: toDataUrl(filePath),
    });
    if (resp.status !== 200) {
        fail(`upload /run returned ${resp.status}`, { filePath, bodyPreview: String(resp.raw).slice(0, 500) });
    }
    const tesBuilder = getTesBuilderTrace(resp);
    if (!tesBuilder || typeof tesBuilder !== "object") {
        fail("missing decision_trace.tes_builder on upload call", { filePath, bodyPreview: String(resp.raw).slice(0, 500) });
    }
    const extractIntent = resp.body && resp.body.decision_trace && resp.body.decision_trace.extract_intent;
    if (!extractIntent || typeof extractIntent !== "object") {
        fail("missing decision_trace.extract_intent on upload call", {
            filePath,
            bodyPreview: String(resp.raw).slice(0, 500),
        });
    }
    assert.strictEqual(extractIntent.abort_reason, undefined);
    assert.strictEqual(
        Array.isArray(resp.body && resp.body.errors)
            ? resp.body.errors.some((e) => e && e.code === "pipeline_terminated")
            : false,
        false
    );
    if (tesBuilder.memory_persisted === true) {
        assert.strictEqual(tesBuilder.memory_write_status, "queued");
        console.log("[step5] upload queued: memory_persisted=true memory_write_status=queued");
    } else {
        console.log(
            `[step5] upload warning: tes_builder reached but memory write not queued ` +
            `(fallback_reason=${tesBuilder.fallback_reason || "n/a"})`
        );
    }
    const queryTags = extractQueryTagsFromUpload(resp);
    const city = extractCityFromUpload(resp);
    const visible = await waitForMemoryVisible(uploadStartMs, queryTags, city);
    console.log("[step5] upload visible:");
    for (const memory of visible.slice(0, 2)) {
        const fileUrl = new URL(`/files/${encodeURIComponent(memory.memory_id)}`, MEMORY_BASE_URL).toString();
        const fileStatus = await getStatus(fileUrl).catch(() => 0);
        console.log(
            `  - ${memory.memory_id} timestamp=${memory.timestamp} source=${memory.source} ` +
            `file_url=${fileUrl} status=${fileStatus}`
        );
    }
    return { resp, visible, queryTags, city };
}

async function runQuery(runUrl, text) {
    const resp = await postJson(runUrl, {
        text,
        user_id: STEP5_USER_ID,
    });
    if (resp.status !== 200) {
        fail(`query /run returned ${resp.status}`, { bodyPreview: String(resp.raw).slice(0, 500) });
    }
    if (!resp.body || typeof resp.body !== "object") {
        fail("query /run returned invalid JSON body", { bodyPreview: String(resp.raw).slice(0, 500) });
    }
    if (!resp.body.decision_trace || typeof resp.body.decision_trace !== "object") {
        fail("query response missing decision_trace", { bodyPreview: String(resp.raw).slice(0, 500) });
    }
    if (!getProfileNode(resp)) {
        fail("query response missing decision_trace.profile_vector_node", { bodyPreview: String(resp.raw).slice(0, 500) });
    }
    return resp;
}

async function runDeterministicQuery(runUrl, text) {
    let first = null;
    let second = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
        first = await runQuery(runUrl, text);
        await delay(250);
        second = await runQuery(runUrl, text);
        const p1 = getProfileNode(first);
        const p2 = getProfileNode(second);
        const profileGate1 = normalizeProfileNodeForGate(p1);
        const profileGate2 = normalizeProfileNodeForGate(p2);
        const anchors1 = extractAnchorSummary(p1);
        const anchors2 = extractAnchorSummary(p2);
        const titles1 = extractCardTitles(first);
        const titles2 = extractCardTitles(second);
        const topItemIds1 = extractTopItemIds(first, 3);
        const topItemIds2 = extractTopItemIds(second, 3);
        try {
            assert.deepStrictEqual(profileGate1, profileGate2);
            assert.deepStrictEqual(
                anchors1.map((anchor) => anchor.memory_id),
                anchors2.map((anchor) => anchor.memory_id)
            );
            assert.deepStrictEqual(titles1, titles2);
            assert.deepStrictEqual(topItemIds1, topItemIds2);
            return { first, second, determinismPassed: true };
        } catch (err) {
            if (attempt === 5) {
                fail("determinism failed across repeated query calls", {
                    error: err instanceof Error ? err.message : String(err),
                    profile1: profileGate1,
                    profile2: profileGate2,
                    anchors1,
                    anchors2,
                    titles1,
                    titles2,
                    topItemIds1,
                    topItemIds2,
                });
            }
            await delay(500);
        }
    }
    return { first, second, determinismPassed: false };
}

async function main() {
    ensureDir(STEP5_INPUT_DIR);
    const images = listImages(STEP5_INPUT_DIR);
    if (images.length === 0) {
        console.log(`[step5] input folder created: ${STEP5_INPUT_DIR}`);
        console.log("[step5] folder is empty. Put at least 2 real photos into it, for example:");
        console.log("        - 1 food photo");
        console.log("        - 1 scenery photo");
        console.log("[step5] supported extensions: jpg, jpeg, png, webp");
        process.exit(0);
    }
    if (images.length < 2) {
        console.log(`[step5] found only ${images.length} image(s) in ${STEP5_INPUT_DIR}`);
        console.log("[step5] add at least 2 real photos, then run again.");
        process.exit(0);
    }

    const runUrl = new URL("/run", AGENT_BASE_URL).toString();
    const selected = images.slice(0, 2);

    console.log(`[step5] agent: ${AGENT_BASE_URL}`);
    console.log(`[step5] input dir: ${STEP5_INPUT_DIR}`);
    console.log(`[step5] user_id: ${STEP5_USER_ID}`);
    console.log(`[step5] query: ${STEP5_QUERY}`);
    console.log("[step5] note: LLM text is nondeterministic; only structural trace is gated.");
    console.log(`[step5] selected images: ${selected.map((p) => path.basename(p)).join(", ")}`);

    const visibleUploads = [];
    for (let i = 0; i < selected.length; i++) {
        const filePath = selected[i];
        console.log(`[step5] upload ${i + 1}/${selected.length}: ${path.basename(filePath)}`);
        const upload = await uploadOne(runUrl, filePath, i);
        visibleUploads.push(...upload.visible);
        await delay(300);
    }

    const { first, determinismPassed } = await runDeterministicQuery(runUrl, STEP5_QUERY);
    const profileNode = getProfileNode(first);
    const anchors = extractAnchorSummary(profileNode);
    const recallTop = extractRecallSummary(first);
    const titles = extractCardTitles(first);
    const topItems = extractTopItems(first, 3);
    const explanation = String(first && first.body && first.body.explanation || "");
    const visibleUploadIds = new Set(visibleUploads.map((row) => row.memory_id));
    const matchedAnchors = anchors.filter((anchor) => visibleUploadIds.has(anchor.memory_id));

    if (anchors.length === 0) {
        fail("anchors missing: uploaded memories became visible, but query produced no profile anchors", {
            visible_uploads: visibleUploads,
            recall_top: recallTop,
            bodyPreview: JSON.stringify(first.body).slice(0, 800),
        });
    }
    if (matchedAnchors.length === 0) {
        fail("anchors do not reference memories from this upload run", {
            visible_uploads: visibleUploads,
            anchors,
            recall_top: recallTop,
        });
    }

    console.log("[step5] visible uploads:");
    for (const memory of visibleUploads) {
        const fileUrl = new URL(`/files/${encodeURIComponent(memory.memory_id)}`, MEMORY_BASE_URL).toString();
        console.log(`  - ${memory.memory_id} timestamp=${memory.timestamp} source=${memory.source} file_url=${fileUrl}`);
    }
    console.log("[step5] recall top memories:");
    if (recallTop.length === 0) {
        console.log("  (not exposed in /run trace)");
    } else {
        for (const row of recallTop.slice(0, 3)) {
            console.log(`  - ${row.memory_id} score=${row.score} w_time=${row.w_time} w_sent=${row.w_sent}`);
        }
    }
    console.log("[step5] anchors:");
    if (anchors.length === 0) {
        console.log("  (none)");
    } else {
        for (const anchor of anchors) {
            console.log(`  - ${anchor.memory_id} final_weight=${anchor.final_weight} w_time=${anchor.w_time} w_sent=${anchor.w_sent}`);
        }
    }
    console.log("[step5] recommended titles:");
    if (titles.length === 0) {
        console.log("  (none)");
    } else {
        for (const title of titles) {
            console.log(`  - ${title}`);
        }
    }
    console.log("[step5] recommended items:");
    if (topItems.length === 0) {
        console.log("  (none)");
    } else {
        for (const item of topItems) {
            console.log(
                `  - ${item.item_id || "(missing_id)"} | ${item.name || "(unnamed)"} ` +
                `| city=${item.city || "n/a"} | type=${item.type || "n/a"} | zone=${item.zone || "n/a"}`
            );
            if (item.score_breakdown && typeof item.score_breakdown === "object") {
                const breakdown = item.score_breakdown;
                console.log(
                    `    score_breakdown | cz_score=${formatMaybeNumber(item.scores && item.scores.cz)} ` +
                    `| memory_influence=${formatMaybeNumber(breakdown.memory_influence)} ` +
                    `| tag_similarity=${formatMaybeNumber(breakdown.tag_similarity)} ` +
                    `| location_relevance=${formatMaybeNumber(breakdown.location_relevance)}`
                );
            }
        }
    }
    console.log(`[step5] explain preview: ${explanation.slice(0, 160) || "(empty)"}`);
    console.log(`[step5] determinism: ${determinismPassed ? "PASS" : "FAIL"}`);
}

main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
});
