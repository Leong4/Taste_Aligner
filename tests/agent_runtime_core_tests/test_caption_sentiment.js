#!/usr/bin/env node
/** Contract tests for the canonical caption_sentiment skill. */

const assert = require("assert");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();
const { createExecutionContext, RECOMMENDATION_GRAPH } = core;
const { captionSentimentSkill, analyzeCaptionSentiment } = skills;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS: ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL: ${name}`);
        console.error(`        ${error.message}`);
        failed++;
    }
}

async function runAll() {
    console.log("\n--- caption_sentiment ---");

    await test("missing caption is unavailable, not measured neutral", async () => {
        const result = await captionSentimentSkill.execute(
            {},
            createExecutionContext({ text: "remember photo" }),
        );
        assert.strictEqual(result.output.sentiment, 0);
        assert.strictEqual(result.output.sentiment_available, false);
        assert.strictEqual(result.output.sentiment_confidence, 0);
        assert.strictEqual(result.output.sentiment_source, "missing_caption");
        assert.strictEqual(result.trace.fallback_reason, "missing_caption");
    });

    await test("caption without opinion is unavailable", async () => {
        const output = analyzeCaptionSentiment("Tokyo, 22 July, dinner at 8pm");
        assert.strictEqual(output.sentiment_available, false);
        assert.strictEqual(output.sentiment_source, "no_sentiment_signal");
    });

    await test("positive English caption produces signed positive sentiment", async () => {
        const output = analyzeCaptionSentiment("Absolutely amazing ramen, I loved it!!");
        assert.ok(output.sentiment > 0.7, output.sentiment);
        assert.ok(output.sentiment_confidence > 0.7, output.sentiment_confidence);
        assert.strictEqual(output.sentiment_available, true);
        assert.strictEqual(output.sentiment_scale, "signed_v1");
    });

    await test("negative English caption produces signed negative sentiment", async () => {
        const output = analyzeCaptionSentiment("Terrible and disappointing. I hated it.");
        assert.ok(output.sentiment < -0.75, output.sentiment);
        assert.ok(output.sentiment_confidence > 0.7, output.sentiment_confidence);
    });

    await test("English negation reverses the following signal", async () => {
        const notGood = analyzeCaptionSentiment("The meal was not good");
        const notBad = analyzeCaptionSentiment("The meal was not bad");
        assert.ok(notGood.sentiment < 0, notGood.sentiment);
        assert.ok(notBad.sentiment > 0, notBad.sentiment);
    });

    await test("Chinese captions differentiate positive and negative opinions", async () => {
        const positive = analyzeCaptionSentiment("这家店非常好吃，值得推荐！");
        const negative = analyzeCaptionSentiment("太难吃了，非常失望，踩雷");
        assert.ok(positive.sentiment > 0.7, positive.sentiment);
        assert.ok(negative.sentiment < -0.8, negative.sentiment);
    });

    await test("v14 graph places caption analysis and confirmed persistence before fetch", async () => {
        assert.strictEqual(RECOMMENDATION_GRAPH.version, "14.0.0");
        const ids = RECOMMENDATION_GRAPH.nodes.map((node) => node.id);
        const vision = ids.indexOf("vision_describe");
        const caption = ids.indexOf("caption_sentiment");
        const tes = ids.indexOf("tes_builder");
        const persist = ids.indexOf("persist_memory");
        const fetch = ids.indexOf("fetch_recommendation");
        assert.ok(vision >= 0 && vision < caption);
        assert.ok(caption < tes);
        assert.ok(tes < persist);
        assert.ok(persist < fetch);
        const persistNode = RECOMMENDATION_GRAPH.nodes[persist];
        assert.strictEqual(persistNode.inputFrom.sentiment, "caption_sentiment.sentiment");
        assert.strictEqual(persistNode.inputFrom.memory_id, "input.memory_id");
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log("ALL CAPTION_SENTIMENT TESTS: PASS");
}

runAll().catch((error) => {
    console.error(error);
    process.exit(1);
});
