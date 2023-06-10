import { BaseChain } from "langchain/chains";
import { BaseOutputParser } from "langchain/schema/output_parser";

export type AIMessageType = {
    thoughts?: string,
    reasoning?: string,
    saveToScratchPad?: string,
    currentPlanStep?: string,
    action: string,
    action_input: any,
    plan?: string[],
    mainGoal?: string,
}

export abstract class AIMessageSerializer extends BaseOutputParser<string> {
    abstract serialize(message: AIMessageType): Promise<string>;
    abstract deserialize(text: string): Promise<AIMessageType>;

    async parse(text: string): Promise<string> {
        return JSON.stringify(await this.deserialize(text));
    }
}


export type Agent = { name: string, description: string, agent: BaseChain }
