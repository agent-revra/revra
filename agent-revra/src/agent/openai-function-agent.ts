import { BaseLLMOutputParser } from "langchain/schema/output_parser";
import { MimirAgent, InternalAgentPlugin, MimirAIMessage } from "./base-agent.js";
import { AIMessage, AgentAction, AgentFinish, BaseMessage, ChainValues, ChatGeneration, FunctionMessage, Generation, HumanMessage } from "langchain/schema";

import { SystemMessagePromptTemplate } from "langchain/prompts";
import { AttributeDescriptor, ResponseFieldMapper } from "./instruction-mapper.js";

import { AgentActionOutputParser } from "langchain/agents";
import { AgentContext, MimirAgentArgs, MimirHumanReplyMessage, NextMessage } from "../schema.js";
import { DEFAULT_ATTRIBUTES, IDENTIFICATION } from "./prompt.js";
import { AiMessageSerializer, HumanMessageSerializer, TransformationalChatMessageHistory } from "../memory/transform-memory.js";
import { callJsonRepair } from "../utils/json.js";


type AIMessageType = {

    messageToSend?: string,
}
export class ChatConversationalAgentOutputParser extends AgentActionOutputParser {

    constructor(private responseFieldMapper: ResponseFieldMapper<AIMessageType>, private finishToolName: string, private talkToUserTool: string | undefined) {
        super();
    }

    lc_namespace = ["langchain", "agents", "output-parser"]

    async parse(input: string): Promise<AgentAction | AgentFinish> {
        const out1 = JSON.parse(input) as MimirAIMessage;

        let toolInput = '';
        try {
            toolInput = JSON.parse(out1.functionCall!.arguments);
        } catch (e) {
            toolInput = JSON.parse(callJsonRepair(out1.functionCall!.arguments));
        }
        const action = { tool: out1.functionCall!.name, toolInput: toolInput, log: input }
        if (action.tool === this.finishToolName) {
            return { returnValues: { output: action.toolInput, complete: true }, log: action.log };
        }
        //TODO HACK! as toolInput expects a string but actually wants a record
        return action as any as AgentAction;
    }

    getFormatInstructions(): string {
        return ""
    }
}


export class AIMessageLLMOutputParser extends BaseLLMOutputParser<MimirAIMessage> {
    async parseResult(generations: Generation[] | ChatGeneration[]): Promise<MimirAIMessage> {
        const generation = generations[0] as ChatGeneration;
        const functionCall: any = generation.message?.additional_kwargs?.function_call;
        let hasError = false;
        try {
            JSON.parse(callJsonRepair(functionCall?.arguments ?? undefined))
        } catch (e) {
            hasError = true;
        }
        const mimirMessage: MimirAIMessage = {
            functionCall: functionCall ? {
                name: functionCall?.name,
                arguments: (functionCall?.arguments),
            } : undefined,
            text: generation.text,
            error: hasError,
        }
        return mimirMessage;
    }
    lc_namespace: string[] = [];
}

const messageGenerator: (nextMessage: NextMessage) => Promise<{ message: BaseMessage, messageToSave: MimirHumanReplyMessage, }> = async (nextMessage: NextMessage) => {
    const messages = nextMessage.type === "USER_MESSAGE" ? ({
        type: "USER_MESSAGE",
        message: nextMessage.message,
    } as MimirHumanReplyMessage) : {
        type: "FUNCTION_REPLY",
        functionReply: {
            name: nextMessage.tool!,
            arguments: nextMessage.message,
        }
    } as MimirHumanReplyMessage;

    const message = nextMessage.type === "USER_MESSAGE" ? new HumanMessage(nextMessage.message) : new FunctionMessage(nextMessage.message, nextMessage.tool!);
    return {
        message: message,
        messageToSave: messages,
    };
};

export class FunctionCallAiMessageSerializer extends AiMessageSerializer {
    async deserialize(aiMessage: MimirAIMessage): Promise<BaseMessage> {
        const output = aiMessage as MimirAIMessage;
        const functionCall = output.functionCall ? {
            function_call: {
                name: output.functionCall?.name,
                arguments: output.functionCall?.arguments
            },
        } : {};
        const message = new AIMessage(output.text ?? "", {
            ...functionCall
        });
        return message;
    }
}

export class PlainTextHumanMessageSerializer extends HumanMessageSerializer {
    async deserialize(message: MimirHumanReplyMessage): Promise<BaseMessage> {
        if (message.type === "FUNCTION_REPLY") {
            return new FunctionMessage(message.functionReply?.arguments!, message.functionReply!.name);
        }
        return new HumanMessage(message.message!);
    }
}


const OPENAI_FUNCTION_AGENT_ATTRIBUTES: AttributeDescriptor[] = [

]


export function createOpenAiFunctionAgent(args: MimirAgentArgs) {

    if (args.llm._modelType() !== "base_chat_model" || args.llm._llmType() !== "openai") {
        throw new Error("This agent requires an OpenAI chat model");
    }

    const pluginAttributes = args.plugins.map(plugin => plugin.attributes()).flat();
    const formatManager = new ResponseFieldMapper([...DEFAULT_ATTRIBUTES, ...pluginAttributes, ...OPENAI_FUNCTION_AGENT_ATTRIBUTES]);

    const systemMessages = [
        SystemMessagePromptTemplate.fromTemplate(IDENTIFICATION(args.name, args.description)),
        SystemMessagePromptTemplate.fromTemplate(args.constitution),
        SystemMessagePromptTemplate.fromTemplate(formatManager.createFieldInstructions()),
        ...args.plugins.map(plugin => plugin.systemMessages()).flat(),
    ];
    const talkToUserTools = args.talkToUserTool ? [args.talkToUserTool] : [];

    const internalPlugins = args.plugins.map(plugin => {

        const agentPlugin: InternalAgentPlugin = {
            getInputs: (context) => plugin.getInputs(context),
            readResponse: async (context: AgentContext, response: MimirAIMessage) => {
                await plugin.readResponse(context, response, formatManager);
            },
            clear: async () => {
                await plugin.clear();
            },
            processMessage: async function (nextMessage: NextMessage, inputs: ChainValues): Promise<NextMessage | undefined> {
                return await plugin.processMessage(nextMessage, inputs);
            }
        }
        return agentPlugin;
    });

    const chatHistory = new TransformationalChatMessageHistory(args.chatMemory, new FunctionCallAiMessageSerializer(), new PlainTextHumanMessageSerializer());
    const finalMemory = args.memoryBuilder({
        messageHistory: chatHistory,
        plainText: false,
    });

    const agent = MimirAgent.fromLLMAndTools(args.llm, new AIMessageLLMOutputParser(), messageGenerator, {
        systemMessage: systemMessages,
        outputParser: new ChatConversationalAgentOutputParser(formatManager, args.taskCompleteCommandName, args.talkToUserTool?.name),
        taskCompleteCommandName: args.taskCompleteCommandName,
        memory: finalMemory,
        resetFunction: args.resetFunction,
        defaultInputs: {
            tools: [...args.plugins.map(plugin => plugin.tools()).flat(), ...talkToUserTools],
        },
        plugins: internalPlugins,
    });

    return agent;
}