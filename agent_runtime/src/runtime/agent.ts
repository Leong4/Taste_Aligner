import { Action, Observation, Thought } from "../types/react";

export interface Agent {
    name: string;

    // 产生下一步想法（可以决定 done）
    think(ctx: {
        userInput: string;
        history: Array<{ thought: Thought; action?: Action; observation?: Observation }>;
    }): Promise<Thought>;

    // 根据 thought 选择是否调用工具
    act(thought: Thought): Promise<Action | null>;
}