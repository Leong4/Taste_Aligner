"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReActRuntime = void 0;
class ReActRuntime {
    constructor(agent, toolClient, opts = { maxTurns: 5 }) {
        this.agent = agent;
        this.toolClient = toolClient;
        this.opts = opts;
    }
    async run(userInput) {
        const history = [];
        for (let turn = 1; turn <= this.opts.maxTurns; turn++) {
            const thought = await this.agent.think({ userInput, history });
            const action = await this.agent.act(thought);
            let observation;
            let terminated = false;
            if (action) {
                observation = await this.toolClient.call(action);
            }
            if (observation?.ok === true && observation.output) {
                thought.done = true;
            }
            terminated = thought.done === true;
            const step = { thought };
            if (action)
                step.action = action;
            if (observation)
                step.observation = observation;
            history.push(step);
            // 打印每一轮（方便你调试、写博客）
            console.log(`\n[turn ${turn}]`);
            console.log("thought:", thought);
            if (action)
                console.log("action:", action);
            if (observation)
                console.log("observation:", observation);
            console.log("tool:", action?.tool ?? "none");
            console.log("terminated:", terminated);
            if (thought.done)
                break;
        }
        return history;
    }
}
exports.ReActRuntime = ReActRuntime;
//# sourceMappingURL=reactRuntime.js.map