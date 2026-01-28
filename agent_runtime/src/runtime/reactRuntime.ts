import { Agent } from "./agent";
import { ToolClient } from "../tools/toolClient";
import { Action, Observation, Thought } from "../types/react";

export class ReActRuntime {
    constructor(
        private agent: Agent,
        private toolClient: ToolClient,
        private opts: { maxTurns: number } = { maxTurns: 5 }
    ) { }

    async run(userInput: string) {
        const history: Array<{ thought: Thought; action?: Action; observation?: Observation }> = [];

        for (let turn = 1; turn <= this.opts.maxTurns; turn++) {
            const thought = await this.agent.think({ userInput, history });
            const action = await this.agent.act(thought);

            let observation: Observation | undefined;
            let terminated = false;

            if (action) {
                observation = await this.toolClient.call(action);
            }

            if (observation?.ok === true && observation.output) {
                thought.done = true;
            }
            terminated = thought.done === true;

            const step: { thought: Thought; action?: Action; observation?: Observation } = { thought };
            if (action) step.action = action;
            if (observation) step.observation = observation;
            history.push(step);

            // 打印每一轮（方便你调试、写博客）
            console.log(`\n[turn ${turn}]`);
            console.log("thought:", thought);
            if (action) console.log("action:", action);
            if (observation) console.log("observation:", observation);
            console.log("tool:", action?.tool ?? "none");
            console.log("terminated:", terminated);

            if (thought.done) break;
        }

        return history;
    }
}
