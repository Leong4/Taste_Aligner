"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MVPAgent = void 0;
class MVPAgent {
    constructor() {
        this.name = "mvp-agent";
    }
    async think(ctx) {
        // MVP: minimal rule-based intent extraction (English only for now)
        const text = ctx.userInput.toLowerCase();
        const city = text.includes("london") ? "london" : "unknown";
        return {
            text: `I should call planner.compose for city=${city}`,
            done: false,
            state: { city },
        };
    }
    async act(thought) {
        const city = thought.state?.city ?? "unknown";
        return {
            tool: "planner.compose",
            input: { city, cz: ["ramen_shop", "izakaya"], ez: ["temple", "park"], user_id: "u001" },
        };
    }
}
exports.MVPAgent = MVPAgent;
//# sourceMappingURL=mvpAgent.js.map