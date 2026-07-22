#!/usr/bin/env node
/**
 * Smoke tests for the decide_tag_budget deterministic skill.
 *
 * Run from repo root:
 *   node tests/agent_runtime_core_tests/test_decide_tag_budget.js
 *
 * Tests:
 *   1.  Budget formula: food type with 2 seeds, no soft hints
 *   2.  Budget formula: mixed type with 4 seeds, 2 soft hints
 *   3.  Budget formula: unknown type, no seeds → minimum budget 4
 *   4.  Budget clamp: maximum budget capped at 10
 *   5.  Length bonus triggers at >40 chars
 *   6.  Soft hint detection: EN keywords
 *   7.  Soft hint detection: ZH keywords
 *   8.  Soft hint detection: mixed EN+ZH
 *   9.  Hard expand limit: clamp(min(2, hard_seed_count), 0, 3)
 *  10.  Soft expand limit: budget - hard_expand_limit
 *  11.  Pass-through: tags, cz_seed, ez_seed unchanged
 *  12.  Trace: rule_id, schema_version, all contract fields
 *  13.  Empty input: no seeds, no text → base budget
 *  14.  Wired into RECOMMENDATION_GRAPH v14.0 as node 2
 *  15.  Orchestrator integration: decide_tag_budget in decision_trace
 *  16.  Contract: output has thresholds, features, reasons
 *  17.  Thresholds: min_confidence_soft varies with budget
 *  18.  Features: token_count, hard_seed_count, soft_hint_count, type
 *  19.  Reasons: deterministic stable ordering with keywords sorted
 *  20.  Determinism: two identical calls → deepStrictEqual on output + trace
 */

const assert = require("assert");
const { loadCore, loadSkills } = require("./_load_src_runtime");

const core = loadCore();
const skills = loadSkills();

const {
    SkillRegistry,
    Orchestrator,
    validateGraph,
    createExecutionContext,
    RECOMMENDATION_GRAPH,
} = core;
const { decideTagBudgetSkill } = skills;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS: ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL: ${name}`);
        console.error(`        ${e.message}`);
        failed++;
    }
}

async function runAll() {
    // =========================================================================
    // 1. Budget formula tests
    // =========================================================================
    console.log("\n--- Budget formula ---");

    await test("food type, 2 seeds, no soft hints: budget=7", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food"],
            cz_seed: ["ramen_shop", "izakaya"],
            ez_seed: [],
            type: "food",
            raw_text: "food in london",
            confidence: 0.8,
        };

        const result = await decideTagBudgetSkill.execute(input, ctx);
        const o = result.output;

        // base(4) + min(3, 2)=2 + min(2, 0)=0 + type_bonus(1) + length_bonus(0) = 7
        assert.strictEqual(o.budget, 7, "budget should be 7");
        assert.strictEqual(o.hard_seed_count, 2, "hard_seed_count");
        assert.strictEqual(o.soft_hint_count, 0, "no soft hints");
        assert.strictEqual(o.type_bonus, 1, "food type bonus");
        assert.strictEqual(o.length_bonus, 0, "short text");
    });

    await test("mixed type, 4 seeds, 2 soft hints: budget=10", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food", "culture"],
            cz_seed: ["ramen_shop", "izakaya"],
            ez_seed: ["temple", "park"],
            type: "mixed",
            raw_text: "I want a quiet cozy place for food and culture",
            confidence: 0.9,
        };

        const result = await decideTagBudgetSkill.execute(input, ctx);
        const o = result.output;

        // base(4) + min(3,4)=3 + min(2,2)=2 + type_bonus(2) + length_bonus(1) = 12 → clamped to 10
        assert.strictEqual(o.budget, 10, "budget clamped to 10");
        assert.strictEqual(o.hard_seed_count, 4);
        assert.strictEqual(o.soft_hint_count, 2);
        assert.strictEqual(o.type_bonus, 2, "mixed type bonus");
        assert.strictEqual(o.length_bonus, 1, "long text");
    });

    await test("unknown type, no seeds: minimum budget 4", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: [],
            cz_seed: [],
            ez_seed: [],
            type: "unknown",
            raw_text: "hello",
            confidence: 0.2,
        };

        const result = await decideTagBudgetSkill.execute(input, ctx);
        const o = result.output;

        // base(4) + 0 + 0 + 0 + 0 = 4
        assert.strictEqual(o.budget, 4, "minimum budget");
        assert.strictEqual(o.type_bonus, 0, "unknown type bonus");
    });

    await test("budget clamped to max 10", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food", "culture"],
            cz_seed: ["a", "b", "c", "d", "e"],
            ez_seed: ["f", "g"],
            type: "mixed",
            raw_text: "I want a quiet cozy casual local hidden authentic place for food and culture in london",
            confidence: 0.9,
        };

        const result = await decideTagBudgetSkill.execute(input, ctx);
        assert.ok(result.output.budget <= 10, "budget <= 10");
    });

    // =========================================================================
    // 2. Length bonus
    // =========================================================================
    console.log("\n--- Length bonus ---");

    await test("length bonus 0 for short text (<=40 chars)", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: [], cz_seed: [], ez_seed: [],
            type: "unknown",
            raw_text: "short text here",
            confidence: 0.5,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        assert.strictEqual(result.output.length_bonus, 0);
    });

    await test("length bonus 1 for long text (>40 chars)", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: [], cz_seed: [], ez_seed: [],
            type: "unknown",
            raw_text: "I am looking for a really nice place to eat some food in london today",
            confidence: 0.5,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        assert.strictEqual(result.output.length_bonus, 1);
    });

    // =========================================================================
    // 3. Soft hint detection
    // =========================================================================
    console.log("\n--- Soft hint detection ---");

    await test("detects EN soft hints (sorted)", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: [], cz_seed: [], ez_seed: [],
            type: "unknown",
            raw_text: "I want a quiet cozy place",
            confidence: 0.5,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        // Output is pre-sorted alphabetically
        assert.deepStrictEqual(
            result.output.soft_hints_detected,
            ["cozy", "quiet"],
            "detected quiet and cozy (sorted)"
        );
        assert.strictEqual(result.output.soft_hint_count, 2);
    });

    await test("detects ZH soft hints", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: [], cz_seed: [], ez_seed: [],
            type: "unknown",
            raw_text: "\u6211\u60f3\u627e\u4e00\u4e2a\u5b89\u9759\u5730\u9053\u7684\u5730\u65b9",
            confidence: 0.5,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        assert.ok(
            result.output.soft_hints_detected.includes("\u5b89\u9759"),
            "detected \u5b89\u9759"
        );
        assert.ok(
            result.output.soft_hints_detected.includes("\u5730\u9053"),
            "detected \u5730\u9053"
        );
    });

    await test("detects mixed EN+ZH soft hints", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: [], cz_seed: [], ez_seed: [],
            type: "unknown",
            raw_text: "I want something authentic and \u5c0f\u4f17 in kyoto",
            confidence: 0.5,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        assert.ok(
            result.output.soft_hints_detected.includes("authentic"),
            "detected authentic"
        );
        assert.ok(
            result.output.soft_hints_detected.includes("\u5c0f\u4f17"),
            "detected \u5c0f\u4f17"
        );
    });

    // =========================================================================
    // 4. Hard/soft expand limits
    // =========================================================================
    console.log("\n--- Hard/soft expand limits ---");

    await test("hard_expand_limit = clamp(min(2, seeds), 0, 3)", async () => {
        const ctx = createExecutionContext({ text: "test" });

        // 0 seeds → hard_expand_limit = 0
        let result = await decideTagBudgetSkill.execute({
            tags: [], cz_seed: [], ez_seed: [],
            type: "unknown", raw_text: "test", confidence: 0.5,
        }, ctx);
        assert.strictEqual(result.output.hard_expand_limit, 0, "0 seeds → 0");

        // 1 seed → hard_expand_limit = 1
        result = await decideTagBudgetSkill.execute({
            tags: [], cz_seed: ["a"], ez_seed: [],
            type: "unknown", raw_text: "test", confidence: 0.5,
        }, ctx);
        assert.strictEqual(result.output.hard_expand_limit, 1, "1 seed → 1");

        // 2 seeds → hard_expand_limit = 2
        result = await decideTagBudgetSkill.execute({
            tags: [], cz_seed: ["a", "b"], ez_seed: [],
            type: "unknown", raw_text: "test", confidence: 0.5,
        }, ctx);
        assert.strictEqual(result.output.hard_expand_limit, 2, "2 seeds → 2");

        // 5 seeds → hard_expand_limit = min(2,5)=2, clamped to 2
        result = await decideTagBudgetSkill.execute({
            tags: [], cz_seed: ["a", "b", "c"], ez_seed: ["d", "e"],
            type: "unknown", raw_text: "test", confidence: 0.5,
        }, ctx);
        assert.strictEqual(result.output.hard_expand_limit, 2, "5 seeds → 2");
    });

    await test("soft_expand_limit = budget - hard_expand_limit", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food"],
            cz_seed: ["ramen_shop", "izakaya"],
            ez_seed: [],
            type: "food",
            raw_text: "food in london",
            confidence: 0.8,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        assert.strictEqual(
            result.output.soft_expand_limit,
            result.output.budget - result.output.hard_expand_limit,
            "soft = budget - hard"
        );
    });

    // =========================================================================
    // 5. Pass-through
    // =========================================================================
    console.log("\n--- Pass-through ---");

    await test("tags, cz_seed, ez_seed passed through unchanged", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food", "sushi"],
            cz_seed: ["ramen_shop"],
            ez_seed: ["temple"],
            type: "mixed",
            raw_text: "food and temple",
            confidence: 0.8,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        assert.deepStrictEqual(result.output.tags, ["food", "sushi"]);
        assert.deepStrictEqual(result.output.cz_seed, ["ramen_shop"]);
        assert.deepStrictEqual(result.output.ez_seed, ["temple"]);
    });

    // =========================================================================
    // 6. Trace structure (with schema_version)
    // =========================================================================
    console.log("\n--- Trace structure ---");

    await test("trace has rule_id, schema_version, and all contract fields", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food"],
            cz_seed: ["ramen_shop"],
            ez_seed: [],
            type: "food",
            raw_text: "I want a quiet ramen place in tokyo",
            confidence: 0.8,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        const t = result.trace;

        assert.strictEqual(t.rule_id, "tag_budget_v1");
        assert.strictEqual(t.schema_version, "1.0");
        assert.strictEqual(t.base, 4);
        assert.strictEqual(typeof t.budget, "number");
        assert.strictEqual(typeof t.hard_expand_limit, "number");
        assert.strictEqual(typeof t.soft_expand_limit, "number");

        // thresholds in trace
        assert.ok(t.thresholds, "thresholds in trace");
        assert.strictEqual(typeof t.thresholds.min_confidence_soft, "number");
        assert.strictEqual(typeof t.thresholds.min_confidence_hard, "number");

        // features in trace
        assert.ok(t.features, "features in trace");
        assert.strictEqual(typeof t.features.token_count, "number");
        assert.strictEqual(typeof t.features.hard_seed_count, "number");
        assert.strictEqual(typeof t.features.soft_hint_count, "number");
        assert.strictEqual(typeof t.features.type, "string");

        // reasons in trace
        assert.ok(Array.isArray(t.reasons), "reasons is array");
        assert.ok(t.reasons.length >= 6, "at least 6 reasons");

        // Legacy fields preserved
        assert.strictEqual(typeof t.hard_seed_count, "number");
        assert.strictEqual(typeof t.soft_hint_count, "number");
        assert.ok(Array.isArray(t.soft_hints_detected));
        assert.strictEqual(typeof t.type_bonus, "number");
        assert.strictEqual(typeof t.length_bonus, "number");
    });

    // =========================================================================
    // 7. Empty/edge input
    // =========================================================================
    console.log("\n--- Edge cases ---");

    await test("empty input defaults to base budget", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: [],
            cz_seed: [],
            ez_seed: [],
            type: "unknown",
            raw_text: "",
            confidence: 0,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        assert.strictEqual(result.output.budget, 4, "base budget");
        assert.strictEqual(result.output.hard_expand_limit, 0);
        assert.strictEqual(result.output.soft_expand_limit, 4);
        assert.deepStrictEqual(result.output.soft_hints_detected, []);
    });

    // =========================================================================
    // 8. Graph structure
    // =========================================================================
    console.log("\n--- Graph structure ---");

    await test("RECOMMENDATION_GRAPH contains required nodes and decide_tag_budget stays after extract_intent", () => {
        const nodeIds = RECOMMENDATION_GRAPH.nodes.map((n) => n.id);
        const requiredNodeIds = [
            "vision_describe",
            "caption_sentiment",
            "tes_builder",
            "persist_memory",
            "memory_weight_adjust",
            "build_profile_vector",
            "explain_from_trace",
        ];
        for (const requiredId of requiredNodeIds) {
            assert.ok(nodeIds.includes(requiredId), `graph must include node ${requiredId}`);
        }

        const node = RECOMMENDATION_GRAPH.nodes.find((n) => n.id === "decide_tag_budget");
        assert.ok(node, "decide_tag_budget node must exist");
        assert.strictEqual(node.id, "decide_tag_budget");
        assert.strictEqual(node.skill, "decide_tag_budget");
        assert.ok(node.inputFrom.tags, "has tags input");
        assert.ok(node.inputFrom.cz_seed, "has cz_seed input");
        assert.ok(node.inputFrom.ez_seed, "has ez_seed input");
        assert.ok(node.inputFrom.type, "has type input");
        assert.ok(node.inputFrom.raw_text, "has raw_text input");
        assert.ok(node.inputFrom.confidence, "has confidence input");

        // All inputs come from extract_intent
        for (const [, path] of Object.entries(node.inputFrom)) {
            assert.ok(
                path.startsWith("extract_intent."),
                `input path "${path}" should reference extract_intent`
            );
        }

        const extractIdx = nodeIds.indexOf("extract_intent");
        const budgetIdx = nodeIds.indexOf("decide_tag_budget");
        const profileIdx = nodeIds.indexOf("build_profile_vector");
        const explainIdx = nodeIds.indexOf("explain_from_trace");
        assert.ok(extractIdx !== -1 && budgetIdx !== -1 && budgetIdx > extractIdx,
            "decide_tag_budget must execute after extract_intent");
        assert.ok(profileIdx !== -1 && explainIdx !== -1 && profileIdx < explainIdx,
            "build_profile_vector must execute before explain_from_trace");

        const persistMemoryNode = RECOMMENDATION_GRAPH.nodes.find((n) => n.id === "persist_memory");
        assert.ok(persistMemoryNode, "persist_memory node must exist");
        assert.strictEqual(
            persistMemoryNode.inputFrom.vision_type,
            "vision_describe.vision_type",
            "persist_memory must read canonical vision_type field from vision_describe output"
        );

        const memoryWeightNode = RECOMMENDATION_GRAPH.nodes.find((n) => n.id === "memory_weight_adjust");
        assert.ok(memoryWeightNode, "memory_weight_adjust node must exist");
        assert.strictEqual(
            memoryWeightNode.inputFrom.query_type,
            "extract_intent.type",
            "memory_weight_adjust must receive query_type from extract_intent.type for memory pooling"
        );

        const fetchNode = RECOMMENDATION_GRAPH.nodes.find((n) => n.id === "fetch_recommendation");
        assert.ok(fetchNode, "fetch_recommendation node must exist");
        assert.strictEqual(
            fetchNode.inputFrom.memory_pool,
            "extract_intent.type",
            "fetch_recommendation must receive memory_pool hint from extract_intent.type"
        );

        // Graph still validates
        const errors = validateGraph(RECOMMENDATION_GRAPH);
        assert.strictEqual(errors.length, 0, "graph valid: " + errors.join(", "));
    });

    // =========================================================================
    // 9. Orchestrator integration
    // =========================================================================
    console.log("\n--- Orchestrator integration ---");

    await test("orchestrator records decide_tag_budget in decision_trace", async () => {
        const reg = new SkillRegistry();

        // Stub extract_intent
        reg.register({
            name: "extract_intent",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    city: "london",
                    type: "food",
                    tags: ["food"],
                    cz_seed: ["ramen_shop", "izakaya"],
                    ez_seed: [],
                    raw_text: "food in london",
                    confidence: 0.8,
                    user_id: "u001",
                },
                trace: { rule_id: "intent_v1" },
            }),
        });

        // Register the real decide_tag_budget skill
        reg.register(decideTagBudgetSkill);

        // Stub tag_expand (new node between budget and fetch)
        reg.register({
            name: "tag_expand",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    tags_seed: ["food"],
                    tags_added: ["izakaya", "quiet"],
                    tags_dropped: [],
                    tags_final: ["food", "izakaya", "quiet"],
                },
                trace: { rule_id: "tag_expand_v1", schema_version: "1.0" },
            }),
        });

        // Stub tag_normalize (new node between tag_expand and fetch_recommendation)
        reg.register({
            name: "tag_normalize",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    normalized_tags: ["food", "izakaya"],
                    mapping: [
                        { original: "food", normalized: "food" },
                        { original: "izakaya", normalized: "izakaya" },
                    ],
                    dropped: [],
                    decision_trace: {
                        tag_normalize: {
                            rule_id: "tag_normalize_v1",
                            schema_version: "1.0",
                            mapping: { food: "food", izakaya: "izakaya" },
                            dropped: {},
                            normalized_tags: ["food", "izakaya"],
                        },
                    },
                },
                trace: { rule_id: "tag_normalize_v1", schema_version: "1.0" },
            }),
        });

        // Stub memory_weight_adjust (the default graph's memory aggregation node)
        reg.register({
            name: "memory_weight_adjust",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    weighted_results: [],
                    anchor_memory_ids: ["m1"],
                    anchor_tags: ["food"],
                    memory_confidence: 0.7,
                    stats: { input_tags_count: 1, results_count: 0, anchor_count: 1, anchor_tags_count: 1 },
                    decision_trace: {
                        memory_weight_adjust: {
                            rule_id: "memory_weight_adjust_v1",
                            schema_version: "1.0",
                            fallback_used: false,
                        },
                    },
                },
                trace: { rule_id: "memory_weight_adjust_v1", schema_version: "1.0" },
            }),
        });

        // Stub memory_signal (legacy registry compatibility only; not in the default graph)
        reg.register({
            name: "memory_signal",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    anchor_memory_ids: ["m1"],
                    anchor_tags: ["food"],
                    memory_confidence: 0.7,
                    decision_trace: {
                        memory_signal: {
                            rule_id: "memory_signal_v1",
                            schema_version: "1.0",
                            fallback_used: false,
                        },
                    },
                },
                trace: { rule_id: "memory_signal_v1", schema_version: "1.0" },
            }),
        });

        // Stub vision_describe
        reg.register({
            name: "vision_describe",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    vision_features: [],
                    vision_type: "scenery",
                    used: false,
                    tags_count: 0,
                    fallback_used: true,
                    fallback_reason: "no_image",
                    decision_trace: {
                        vision_describe: {
                            rule_id: "vision_describe_v1",
                            schema_version: "1.0",
                            used: false,
                            tags_count: 0,
                            fallback_used: true,
                            fallback_reason: "no_image",
                            input_summary: { has_url: false, has_base64: false, top_k: 10 },
                        },
                    },
                },
                trace: { rule_id: "vision_describe_v1", schema_version: "1.0" },
            }),
        });

        reg.register({
            name: "caption_sentiment",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    sentiment: 0,
                    sentiment_scale: "signed_v1",
                    sentiment_confidence: 0,
                    sentiment_available: false,
                    sentiment_source: "missing_caption",
                    matched_terms: [],
                    decision_trace: {},
                },
                trace: { rule_id: "caption_sentiment_v1", schema_version: "1.0" },
            }),
        });

        // Stub build_profile_vector (new node between memory_weight_adjust and vision_describe)
        reg.register({
            name: "build_profile_vector",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    profile_vector: Array.from({ length: 512 }, () => 0),
                    anchors: [],
                    total_memories_considered: 1,
                    weights: {
                        per_memory: [],
                        summary: {
                            dominant_reason: "balanced",
                            time_bias: 1,
                            sentiment_bias: 1,
                            context_bias: 1,
                        },
                    },
                    decision_trace: {
                        profile_vector_node: {
                            rule_id: "profile_vector_v1",
                            schema_version: "1.0",
                            anchors: [],
                            weights_summary: {
                                dominant_reason: "balanced",
                                time_bias: 1,
                                sentiment_bias: 1,
                                context_bias: 1,
                            },
                            total_memories_considered: 1,
                            profile_vector_dim: 512,
                            has_embeddings: false,
                            fallback_used: false,
                        },
                    },
                },
                trace: { rule_id: "profile_vector_v1", schema_version: "1.0" },
            }),
        });

        // Stub tes_builder (node after vision_describe)
        reg.register({
            name: "tes_builder",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => {
                return {
                    output: {
                        tes_vector: Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
                        tes_dim: 512,
                        normalized: true,
                        backend: "hash_v2",
                        tes_version: "2.0",
                        input_anchor_tags: ["food"],
                        used_anchor_tags: ["food"],
                        fallback_used: false,
                        decision_trace: {
                            tes_builder: {
                                rule_id: "tes_builder_v1",
                                schema_version: "1.0",
                            },
                        },
                    },
                    trace: { rule_id: "tes_builder_v1", schema_version: "1.0" },
                };
            },
        });

        reg.register({
            name: "persist_memory",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async (input) => {
                assert.strictEqual(
                    input.vision_type,
                    "scenery",
                    "graph mapping should pass vision_describe.vision_type into persist_memory"
                );
                assert.strictEqual(input.sentiment_source, "missing_caption");
                return {
                    output: {
                        memory_write_status: "skipped",
                        memory_persisted: false,
                        attempts: 0,
                        decision_trace: {},
                    },
                    trace: { rule_id: "persist_memory_v1", schema_version: "1.0" },
                };
            },
        });

        // Stub remaining skills to complete pipeline
        reg.register({
            name: "fetch_recommendation",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    cz_ranked: [{ id: "r1" }],
                    ez_ranked: [{ id: "e1" }],
                    mix_policy: { ratio: "3:1" },
                    decision_trace: {},
                },
                trace: { rule_id: "fetch_v1" },
            }),
        });
        reg.register({
            name: "rerank",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: { cz_ranked: [{ id: "r1" }], ez_ranked: [{ id: "e1" }] },
                trace: { rule_id: "rerank_v1" },
            }),
        });
        reg.register({
            name: "mix_policy",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: { policy: { ratio: "3:1" }, upstream_trace: {} },
                trace: { rule_id: "mix_v1" },
            }),
        });
        reg.register({
            name: "build_cards",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    cards: [{ zone: "CZ", items: ["ramen"] }],
                    mix_policy: { ratio: "3:1" },
                    city: "london",
                    type: "food",
                    decision_trace: {},
                },
                trace: { rule_id: "cards_v1" },
            }),
        });
        reg.register({
            name: "explain_from_trace",
            inputSchema: { description: "", required: [] },
            outputSchema: { description: "", required: [] },
            execute: async () => ({
                output: {
                    explanation: "Test explanation.",
                    bullets: ["a", "b", "c"],
                    meta: { locale: "en", style: "concise" },
                },
                trace: { schema_version: "explain_v1" },
            }),
        });

        const orch = new Orchestrator(reg, RECOMMENDATION_GRAPH);
        const result = await orch.run({ text: "food in london" });

        assert.strictEqual(result.ok, true, "pipeline ok");

        // Check that decide_tag_budget trace is in decision_trace
        const budgetTrace = result.decision_trace.decide_tag_budget;
        assert.ok(budgetTrace, "decide_tag_budget in decision_trace");
        assert.strictEqual(budgetTrace.rule_id, "tag_budget_v1");
        assert.strictEqual(budgetTrace.schema_version, "1.0");
        assert.strictEqual(budgetTrace.budget, 7, "budget=7 for food with 2 seeds");
        assert.strictEqual(budgetTrace.hard_expand_limit, 2);
        assert.strictEqual(budgetTrace.type_bonus, 1);
        assert.ok(budgetTrace.thresholds, "thresholds in orchestrator trace");
        assert.ok(budgetTrace.features, "features in orchestrator trace");
        assert.ok(Array.isArray(budgetTrace.reasons), "reasons in orchestrator trace");
    });

    // =========================================================================
    // 10. Contract: thresholds, features, reasons
    // =========================================================================
    console.log("\n--- Contract: thresholds, features, reasons ---");

    await test("thresholds: min_confidence_soft=0.55 when budget<9", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food"],
            cz_seed: ["ramen_shop"],
            ez_seed: [],
            type: "food",
            raw_text: "food in london",
            confidence: 0.8,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        // budget=6 < 9
        assert.strictEqual(result.output.thresholds.min_confidence_soft, 0.55);
        assert.strictEqual(result.output.thresholds.min_confidence_hard, 0.55);
    });

    await test("thresholds: min_confidence_soft=0.65 when budget>=9", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food", "culture"],
            cz_seed: ["ramen_shop", "izakaya"],
            ez_seed: ["temple", "park"],
            type: "mixed",
            raw_text: "I want a quiet cozy place for food and culture in london",
            confidence: 0.9,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        // budget should be >= 9
        assert.ok(result.output.budget >= 9, `budget=${result.output.budget} >= 9`);
        assert.strictEqual(result.output.thresholds.min_confidence_soft, 0.65);
        assert.strictEqual(result.output.thresholds.min_confidence_hard, 0.55);
    });

    await test("features: token_count, hard_seed_count, soft_hint_count, type", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food"],
            cz_seed: ["ramen_shop", "izakaya"],
            ez_seed: [],
            type: "food",
            raw_text: "food in london",
            confidence: 0.8,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        assert.deepStrictEqual(result.output.features, {
            token_count: 3,
            hard_seed_count: 2,
            soft_hint_count: 0,
            type: "food",
        });
    });

    await test("reasons: deterministic array with stable ordering", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: ["food"],
            cz_seed: ["ramen_shop", "izakaya"],
            ez_seed: [],
            type: "food",
            raw_text: "food in london",
            confidence: 0.8,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        const r = result.output.reasons;

        assert.strictEqual(r.length, 6, "6 reasons");
        assert.strictEqual(r[0], "token_count=3");
        assert.strictEqual(r[1], "hard_seed_count=2");
        assert.strictEqual(r[2], "soft_hint_count=0");
        assert.strictEqual(r[3], "type=food");
        assert.strictEqual(r[4], "bonuses: type_bonus=1, length_bonus=0");
        assert.strictEqual(r[5], "budget=7 clamped_to=[4,10]");
    });

    await test("reasons: soft hints listed sorted alphabetically", async () => {
        const ctx = createExecutionContext({ text: "test" });
        const input = {
            tags: [],
            cz_seed: [],
            ez_seed: [],
            type: "unknown",
            raw_text: "I want a quiet cozy hidden place",
            confidence: 0.5,
        };
        const result = await decideTagBudgetSkill.execute(input, ctx);
        const softLine = result.output.reasons[2];
        // Keywords should be sorted: cozy, hidden, quiet
        assert.ok(
            softLine.includes("(keywords: cozy, hidden, quiet)"),
            `got: ${softLine}`
        );
    });

    // =========================================================================
    // 11. Determinism: deepStrictEqual on two identical calls
    // =========================================================================
    console.log("\n--- Determinism ---");

    await test("two identical calls produce deepStrictEqual output and trace", async () => {
        const input = {
            tags: ["food", "sushi"],
            cz_seed: ["ramen_shop", "izakaya"],
            ez_seed: ["temple"],
            type: "mixed",
            raw_text: "I want a quiet authentic ramen place in kyoto",
            confidence: 0.85,
        };

        const ctx1 = createExecutionContext({ text: "test" });
        const result1 = await decideTagBudgetSkill.execute(input, ctx1);

        const ctx2 = createExecutionContext({ text: "test" });
        const result2 = await decideTagBudgetSkill.execute(input, ctx2);

        // Deep equality on full output
        assert.deepStrictEqual(
            result1.output,
            result2.output,
            "output must be identical across calls"
        );

        // Deep equality on full trace (including schema_version)
        assert.deepStrictEqual(
            result1.trace,
            result2.trace,
            "trace must be identical across calls"
        );

        // Verify schema_version is present in both
        assert.strictEqual(result1.trace.schema_version, "1.0");
        assert.strictEqual(result2.trace.schema_version, "1.0");
    });

    // =========================================================================
    // Summary
    // =========================================================================
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log("FAIL");
        process.exit(1);
    } else {
        console.log("ALL DECIDE_TAG_BUDGET TESTS: PASS");
    }
}

runAll().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
