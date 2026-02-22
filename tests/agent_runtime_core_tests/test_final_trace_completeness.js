#!/usr/bin/env node
/**
 * Ensures /run-facing orchestrator result uses FULL aggregated trace
 * (ctx.decision_trace), not just whichever node output came last.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

let SkillRegistry;
let Orchestrator;
const repoRoot = path.join(__dirname, "../..");
const agentRuntimeDir = path.join(repoRoot, "agent_runtime");

function loadDistCore() {
  const distCoreDir = path.join(agentRuntimeDir, "dist/core");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(distCoreDir)) {
      delete require.cache[key];
    }
  }
  const distCorePath = path.join(agentRuntimeDir, "dist/core/index.js");
  return require(distCorePath);
}

try {
  require("ts-node").register({
    project: path.join(__dirname, "../../agent_runtime/tsconfig.json"),
    transpileOnly: true,
  });
  const core = require("../../agent_runtime/src/core/index.ts");
  SkillRegistry = core.SkillRegistry;
  Orchestrator = core.Orchestrator;
} catch (_e) {
  try {
    const ts = require("typescript");
    const projectPath = path.join(__dirname, "../../agent_runtime/tsconfig.json");
    const compilerOptions = ts.readConfigFile(projectPath, ts.sys.readFile).config?.compilerOptions || {};
    require.extensions[".ts"] = function registerTs(module, filename) {
      const source = fs.readFileSync(filename, "utf8");
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          ...compilerOptions,
        },
        fileName: filename,
      });
      module._compile(transpiled.outputText, filename);
    };
    const core = require("../../agent_runtime/src/core/index.ts");
    SkillRegistry = core.SkillRegistry;
    Orchestrator = core.Orchestrator;
  } catch (_e2) {
    const core = loadDistCore();
    SkillRegistry = core.SkillRegistry;
    Orchestrator = core.Orchestrator;
  }
}

if (!Orchestrator || typeof Orchestrator.prototype.runWithTrace !== "function") {
  execSync("npm run build", { cwd: agentRuntimeDir, stdio: "ignore" });
  const core = loadDistCore();
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

function makeSkill(name, executeFn) {
  return {
    name,
    inputSchema: { description: "", required: [] },
    outputSchema: { description: "", required: [] },
    execute: executeFn,
  };
}

async function runAll() {
  console.log("\n--- final trace completeness ---");

  await test("runWithTrace keeps decision_trace + decision_trace_bundle when last node is silent", async () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill("skill_a", async () => ({
      output: { city: "tokyo", type: "food" },
      trace: {},
      decision_trace: { a: { x: 1 } },
    })));
    reg.register(makeSkill("skill_b", async () => ({
      output: {},
      trace: {},
      decision_trace_bundle: { recommendation: { recall: { n: 3 } } },
    })));
    reg.register(makeSkill("skill_c", async () => ({
      output: { cards: [], mix_policy: {} },
      trace: {},
    })));

    const graph = {
      name: "final_trace_case_1",
      version: "1.0",
      nodes: [
        { id: "a", skill: "skill_a", inputFrom: { text: "input.text" } },
        { id: "b", skill: "skill_b", inputFrom: { text: "input.text" } },
        { id: "c", skill: "skill_c", inputFrom: { text: "input.text" } },
      ],
    };

    const orchestrator = new Orchestrator(reg, graph);
    const result = await orchestrator.runWithTrace({ text: "hello" });

    assert.strictEqual(result.decision_trace.a.x, 1, "missing decision_trace.a.x");
    assert.strictEqual(
      result.decision_trace.recommendation.recall.n,
      3,
      "missing decision_trace_bundle.recommendation.recall.n"
    );
  });

  await test("runWithTrace merges final-node trace without overwriting upstream namespaces", async () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill("skill_a", async () => ({
      output: { city: "tokyo", type: "food" },
      trace: {},
      decision_trace: { a: { x: 1 } },
    })));
    reg.register(makeSkill("skill_b", async () => ({
      output: {},
      trace: {},
      decision_trace_bundle: { recommendation: { recall: { n: 3 } } },
    })));
    reg.register(makeSkill("skill_c", async () => ({
      output: { cards: [], mix_policy: {} },
      trace: {},
      decision_trace: { c: { y: 2 } },
    })));

    const graph = {
      name: "final_trace_case_2",
      version: "1.0",
      nodes: [
        { id: "a", skill: "skill_a", inputFrom: { text: "input.text" } },
        { id: "b", skill: "skill_b", inputFrom: { text: "input.text" } },
        { id: "c", skill: "skill_c", inputFrom: { text: "input.text" } },
      ],
    };

    const orchestrator = new Orchestrator(reg, graph);
    const result = await orchestrator.runWithTrace({ text: "hello" });

    assert.strictEqual(result.decision_trace.a.x, 1, "upstream a trace lost");
    assert.strictEqual(result.decision_trace.recommendation.recall.n, 3, "bundle trace lost");
    assert.strictEqual(result.decision_trace.c.y, 2, "final node trace missing");
  });

  console.log("\n==================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("FAIL");
    process.exit(1);
  }
  console.log("ALL FINAL TRACE COMPLETENESS TESTS: PASS");
}

runAll().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
