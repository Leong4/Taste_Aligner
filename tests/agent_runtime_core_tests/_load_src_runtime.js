"use strict";

const path = require("path");
const { createRequire } = require("module");

const agentRuntimeDir = path.join(__dirname, "../../agent_runtime");
const agentRequire = createRequire(path.join(agentRuntimeDir, "package.json"));
const tsconfigPath = path.join(agentRuntimeDir, "tsconfig.json");

let registered = false;

function ensureTsNode() {
    if (registered) {
        return;
    }

    try {
        const tsNode = agentRequire("ts-node");
        tsNode.register({
            project: tsconfigPath,
            transpileOnly: true,
        });
        registered = true;
    } catch (error) {
        console.error(
            "[agent_runtime_core_tests] ts-node is required to run tests against agent_runtime/src."
        );
        console.error(
            "Install with: cd agent_runtime && npm i -D ts-node"
        );
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

function loadCore() {
    ensureTsNode();
    return agentRequire("./src/core");
}

function loadSkills() {
    ensureTsNode();
    return agentRequire("./src/skills");
}

function loadLLM() {
    ensureTsNode();
    return agentRequire("./src/llm");
}

module.exports = {
    ensureTsNode,
    loadCore,
    loadSkills,
    loadLLM,
};
