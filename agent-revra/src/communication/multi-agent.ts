import { createAgent } from "../agent-manager/agent.js";
import { Agent, AgentResponse, AgentMessageToolRequest, AgentUserMessageResponse, ToolResponseInfo, InputAgentMessage, CreateAgentArgs } from "../agent-manager/index.js";
import { HelpersPluginFactory } from "../plugins/helpers.js";

type PendingMessage = {
    responseAttributes: Record<string, any>,
    content: InputAgentMessage;
}
export type AgentInvoke = (agent: Agent,) => AsyncGenerator<ToolResponseInfo, AgentResponse, unknown>;


export type IntermediateAgentResponse = ({
    type: "agentToAgentMessage",
} & AgentToAgentMessage) | {
    type: "toolResponse",
    agentName: string,
} & ToolResponseInfo;
export type AgentToAgentMessage = {
    sourceAgent: string,
    destinationAgent: string,
    content: InputAgentMessage,
    responseAttributes: Record<string, any>
}
export type HandleMessageResult = ({
    type: "agentResponse",

} & AgentUserMessage) | {
    type: "toolRequest",
} & AgentToolRequestTwo;

export type AgentToolRequestTwo = AgentMessageToolRequest & {
    callingAgent: string,
}

export type AgentUserMessage = {
    content: InputAgentMessage,
    responseAttributes: Record<string, any>
}

type MultiAgentDefinition = CreateAgentArgs & { communicationWhitelist?: string[] | boolean }

export class OrchestratorBuilder {
    public readonly agentManager: Map<string, Agent> = new Map();
    constructor() {

    }
    async createAgent(args: MultiAgentDefinition): Promise<Agent> {

        const canCommunicateWithAgents = args.communicationWhitelist ?? false;
        let communicationWhitelist = undefined;
        if (Array.isArray(canCommunicateWithAgents)) {
            communicationWhitelist = canCommunicateWithAgents
        }
        const helpersPlugin = new HelpersPluginFactory({
            name: args.name,
            helperSingleton: this.agentManager,
            communicationWhitelist: communicationWhitelist ?? null
        });


        const agent = await createAgent({
            name: args.name,
            description: args.description,
            profession: args.profession,
            model: args.model,
            visionSupport: args.visionSupport,
            constitution: args.constitution,
            plugins: [helpersPlugin, ...args.plugins ?? []],
            workspaceFactory: args.workspaceFactory,
        });

        this.agentManager.set(args.name, agent);
        return agent;
    }

    build(currentAgent: Agent) {
        return new MultiAgentCommunicationOrchestrator(this.agentManager, currentAgent);
    }
}

export class MultiAgentCommunicationOrchestrator {
    public currentAgent: Agent;
    private agentStack: Agent[] = [];

    constructor(private readonly agentManager: ReadonlyMap<string, Agent>, currentAgent: Agent) {
        this.currentAgent = currentAgent;

    }


    getCurrentAgent() {
        return this.currentAgent;
    }

    async reset() {
        for (const agent of this.agentManager.values()) {
            await agent.reset();
        }
    }

    async* handleMessage(msg: AgentInvoke): AsyncGenerator<IntermediateAgentResponse, HandleMessageResult, void> {

        const handleMessage = async (chainResponse: AgentUserMessageResponse, agentStack: Agent[]): Promise<{
            conversationComplete: boolean,
            currentAgent: Agent,
            pendingMessage: PendingMessage | undefined
        }> => {
            if (chainResponse.output.destinationAgent) {
                const newAgent = this.agentManager.get(chainResponse.output.destinationAgent);
                if (!newAgent) {
                    return {
                        conversationComplete: false,
                        currentAgent: this.currentAgent,
                        pendingMessage: {
                            content: {
                                content: [
                                    { type: "text", text: `Agent ${chainResponse.output.destinationAgent} does not exist.` }
                                ]
                            },
                            responseAttributes: {}
                        }
                    }
                }
                agentStack.push(this.currentAgent);
                return {
                    conversationComplete: false,
                    currentAgent: newAgent,
                    pendingMessage: {
                        content: chainResponse.output,
                        responseAttributes: chainResponse.responseAttributes
                    }
                }
            } else {
                const isFinalUser = agentStack.length === 0;
                return {
                    conversationComplete: isFinalUser,
                    currentAgent: isFinalUser ? this.currentAgent : agentStack.pop()!,
                    pendingMessage: {
                        content: chainResponse.output,
                        responseAttributes: chainResponse.responseAttributes
                    }
                }
            }
        }
        let pendingMessage: PendingMessage | undefined = undefined;
        while (true) {

            let generator = pendingMessage
                ? this.currentAgent.call({
                    message: pendingMessage.content,
                    requestAttributes: pendingMessage.responseAttributes,
                    noMessagesInTool: true
                })
                : msg(this.currentAgent);


            let result: IteratorResult<ToolResponseInfo, AgentResponse>;
            while (!(result = await generator.next()).done) {
                yield {
                    type: "toolResponse",
                    agentName: this.currentAgent.name,
                    ...result.value
                };
            }
            let chainResponse = result.value


            if (chainResponse.type == "agentResponse") {
                const sourceAgent = this.currentAgent.name;
                const routedMessage = await handleMessage(chainResponse, this.agentStack);
                this.currentAgent = routedMessage.currentAgent;
                if (routedMessage.conversationComplete) {
                    return {
                        type: "agentResponse",
                        content: chainResponse.output,
                        responseAttributes: chainResponse.responseAttributes
                    };
                } else {
                    pendingMessage = routedMessage.pendingMessage;
                    yield {
                        type: "agentToAgentMessage",
                        sourceAgent: sourceAgent!,
                        destinationAgent: this.currentAgent.name,
                        content: chainResponse.output,
                        responseAttributes: chainResponse.responseAttributes
                    }
                }
            } else {
                return {
                    type: "toolRequest",
                    callingAgent: this.currentAgent.name,
                    content: chainResponse.output.content,
                    toolCalls: chainResponse.output.toolCalls,
                }
            }
        }
    }
}