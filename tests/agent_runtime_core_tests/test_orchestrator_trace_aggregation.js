#!/usr/bin/env node
/**
 * Characterization tests for orchestrator trace aggregation.
 *
 * Ensures trace bundles are merged after EACH node execution, not only
 * from the last node output.
 */

const assert = require("assert");
const path = require("path");

let SkillRegistry;
let Orchestrator;

try {
  require("ts-node").register({
    project: path.join(__dirname, "../../agent_runtime/tsconfig.json"),
    transpileOnly: true,
  });
  const core = require("../../agent_runtime/src/core");
  SkillRegistry = core.SkillRegistry;
  Orchestrator = core.Orchestrator;
} catch (_e) {
  const core = require("../../agent_runtime/dist/core");
  SkillRegistry = core.SkillRegistry;
  Orchestrator = core.Orchestrator;
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  FAIL: ${name}`);
    console.error(`        ${e.message}`);
    failed += 1;
  }
}

function makeSkill(name, outputFactory, resultExtrasFactory) {
  return {
    name,
    inputSchema: { description: "", required: [] },
    outputSchema: { description: "", required: [] },
    execute: async () => {
      const extras = typeof resultExtrasFactory === "function" ? resultExtrasFactory() : {};
      return {
        output: outputFactory(),
        trace: {},
        ...extras,
      };
    },
  };
}

async function runAll() {
  console.log("\n--- orchestrator trace aggregation ---");

  await test("merges top-level result.decision_trace + result.decision_trace_bundle", async () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill("skill_a", () => ({
      city: "tokyo",
      type: "food",
    }), () => ({
      decision_trace: { a: { x: 1 } },
    })));
    reg.register(makeSkill("skill_b", () => ({
      cards: [],
      mix_policy: {},
    }), () => ({
      decision_trace_bundle: { planner: { compose: { ok: true } } },
    })));
    reg.register(makeSkill("skill_c", () => ({
      cards: [],
      mix_policy: {},
    })));

    const graph = {
      name: "trace_merge_case_1",
      version: "1.0",
      nodes: [
        { id: "a", skill: "skill_a", inputFrom: { text: "input.text" } },
        { id: "b", skill: "skill_b", inputFrom: { text: "input.text" } },
        { id: "c", skill: "skill_c", inputFrom: { text: "input.text" } },
      ],
    };

    const orch = new Orchestrator(reg, graph);
    const result = await orch.run({ text: "trace" });

    assert.strictEqual(result.decision_trace.a.x, 1, "missing decision_trace.a");
    assert.strictEqual(
      result.decision_trace.planner.compose.ok,
      true,
      "missing decision_trace_bundle.planner.compose.ok"
    );
  });

  await test("applies canonical conflict merge: incoming wins leaf + array concat/dedup", async () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill("skill_a", () => ({
      decision_trace: { shared: { v: 1, arr: [1] } },
    })));
    reg.register(makeSkill("skill_b", () => ({
      decision_trace: { shared: { v: 2, arr: [1, 2] } },
    })));
    reg.register(makeSkill("skill_c", () => ({
      cards: [],
      mix_policy: {},
    })));

    const graph = {
      name: "trace_merge_case_2",
      version: "1.0",
      nodes: [
        { id: "a", skill: "skill_a", inputFrom: { text: "input.text" } },
        { id: "b", skill: "skill_b", inputFrom: { text: "input.text" } },
        { id: "c", skill: "skill_c", inputFrom: { text: "input.text" } },
      ],
    };

    const orch = new Orchestrator(reg, graph);
    const result = await orch.run({ text: "trace" });

    assert.strictEqual(result.decision_trace.shared.v, 2, "incoming leaf should win");
    assert.deepStrictEqual(result.decision_trace.shared.arr, [1, 2], "array should concat and dedup");
  });

  await test("retains upstream trace when last node has no decision_trace", async () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill("skill_a", () => ({
      decision_trace: { upstream_only: { ok: true } },
    })));
    reg.register(makeSkill("skill_b", () => ({
      cards: [],
      mix_policy: {},
    })));

    const graph = {
      name: "trace_merge_case_3",
      version: "1.0",
      nodes: [
        { id: "a", skill: "skill_a", inputFrom: { text: "input.text" } },
        { id: "b", skill: "skill_b", inputFrom: { text: "input.text" } },
      ],
    };

    const orch = new Orchestrator(reg, graph);
    const result = await orch.run({ text: "trace" });

    assert.strictEqual(
      result.decision_trace.upstream_only.ok,
      true,
      "upstream trace should be preserved even if last node has no decision_trace"
    );
  });

  console.log("\n==================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("FAIL");
    process.exit(1);
  }
  console.log("ALL ORCHESTRATOR TRACE AGG TESTS: PASS");
}

runAll().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
