import { MimirAgentTypes } from "agent-mimir/agent";
import { AgentManager } from "agent-mimir/agent-manager"
import { MimirPluginFactory, WorkspaceManager } from "agent-mimir/schema";
import chalk from "chalk";
import { BaseChatModel } from 'langchain/chat_models';
import { BaseLanguageModel } from "langchain/base_language";
import { Tool } from "langchain/tools";
import { BaseChain } from "langchain/chains";
import { chatWithAgent } from "./chat.js";
import { promises as fs } from 'fs';
import os from 'os';
import path from "path";
import { AIMessage, BaseMessage, ChatMessage, ChatMessageFieldsWithRole, FunctionMessage, HumanMessage, StoredMessage, SystemMessage } from "langchain/schema";
import { ChatMessageHistory } from "langchain/memory";
import { FileSystemChatHistory } from "./fileMessageHistory.js";

const messages: StoredMessage[] = [

];

export type AgentDefinition = {
    mainAgent?: boolean;
    description: string;
    chain?: BaseChain;
    definition?: {
        profession: string;
        agentType?: MimirAgentTypes;
        chatModel: BaseChatModel;
        summaryModel: BaseChatModel;
        taskModel?: BaseLanguageModel;
        constitution?: string;
        plugins?: MimirPluginFactory[];
        chatHistory?: {
            maxChatHistoryWindow?: number,
            maxTaskHistoryWindow?: number,
        }
        tools?: Tool[];
        communicationWhitelist?: string[] | boolean;
    },

}
type AgentMimirConfig = {
    agents: Record<string, AgentDefinition>;
    workingDirectory?: string;
    continuousMode?: boolean;
}
const getConfig = async () => {
    if (process.env.MIMIR_CFG_PATH) {
        let cfgFile = path.join(process.env.MIMIR_CFG_PATH, 'mimir-cfg.js');
        const configFileExists = await fs.access(cfgFile, fs.constants.F_OK).then(() => true).catch(() => false);
        if (configFileExists) {
            console.log(chalk.green(`Loading configuration file`));
            const configFunction: Promise<AgentMimirConfig> | AgentMimirConfig = (await import(`file://${cfgFile}`)).default()
            return await Promise.resolve(configFunction);
        }
    }
    console.log(chalk.yellow("No config file found, using default ApenAI config"));
    return (await import("./default-config.js")).default();
};


class FileSystemWorkspaceManager implements WorkspaceManager {

    workingDirectory: string;
    
    constructor(agentRootDirectory: string) {
        this.workingDirectory = path.join(agentRootDirectory, "workspace");
    }

    async clearWorkspace(): Promise<void> {
        const files = await fs.readdir(this.workingDirectory);
        for (const file of files) {
            await fs.unlink(path.join(this.workingDirectory, file));
        }
    }

    async listFiles(): Promise<string[]> {
        const files = await fs.readdir(this.workingDirectory);
        return files;
    }
    async loadFileToWorkspace(fileName: string, url: string): Promise<void> {
        const destination = path.join(this.workingDirectory, fileName);
        await fs.copyFile(url, destination);
        console.debug(`Copied file ${url} to ${destination}`);
    }
    async getUrlForFile(fileName: string): Promise<string> {
        const file = path.join(this.workingDirectory, fileName);
        return file;
    }
}
export const run = async () => {

    const agentConfig: AgentMimirConfig = await getConfig();
    const workingDirectory = agentConfig.workingDirectory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'mimir-cli-'));
    await fs.mkdir(workingDirectory, { recursive: true });

    const agentManager = new AgentManager({
        workspaceManagerFactory: async (agent) => {
            // const tempDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mimir-cli-')), agent);
             const tempDir = path.join(workingDirectory, agent);
            await fs.mkdir(tempDir, { recursive: true });
            return new FileSystemWorkspaceManager(tempDir)!;
        }
    });

    const continousMode = agentConfig.continuousMode ?? false;
    const agents = await Promise.all(Object.entries(agentConfig.agents).map(async ([agentName, agentDefinition]) => {
        if (agentDefinition.definition) {
            const newAgent = {
                mainAgent: agentDefinition.mainAgent,
                name: agentName,
                agent: await agentManager.createAgent({
                    name: agentName,
                    messageHistory: new FileSystemChatHistory(path.join(workingDirectory, agentName, "chat-history.json")),
                  //  messageHistory: new ChatMessageHistory(),
                    description: agentDefinition.description,
                    profession: agentDefinition.definition.profession,
                    tools: agentDefinition.definition.tools ?? [],
                    model: agentDefinition.definition.chatModel,
                    summaryModel: agentDefinition.definition.summaryModel,
                    chatHistory: agentDefinition.definition.chatHistory,
                    communicationWhitelist: agentDefinition.definition.communicationWhitelist,
                    constitution: agentDefinition.definition.constitution,
                    agentType: agentDefinition.definition.agentType,
                    plugins: agentDefinition.definition.plugins
                })
            }
            console.log(chalk.green(`Created agent "${agentName}" with profession "${agentDefinition.definition.profession}" and description "${agentDefinition.description}"`));
            return newAgent;
        } else {
            throw new Error(`Agent "${agentName}" has no definition`);
        }

    }));

    const mainAgent = agents.length === 1 ? agents[0].agent : agents.find(a => a.mainAgent)?.agent;
    if (!mainAgent) {
        throw new Error("No main agent found");
    }

    console.log(chalk.green(`Using "${mainAgent.name}" as main agent`));
    await chatWithAgent(continousMode, mainAgent);
};

run();




export function mapStoredMessagesToChatMessages(
    messages: StoredMessage[]
): BaseMessage[] {
    return messages.map((message) => {
        const storedMessage = (message);
        switch (storedMessage.type) {
            case "human":
                return new HumanMessage(storedMessage.data);
            case "ai":
                return new AIMessage(storedMessage.data);
            case "system":
                return new SystemMessage(storedMessage.data);
            case "function":
                if (storedMessage.data.name === undefined) {
                    throw new Error("Name must be defined for function messages");
                }
                return new FunctionMessage(
                    storedMessage.data as any,
                    storedMessage.data.name
                );
            case "chat": {
                if (storedMessage.data.role === undefined) {
                    throw new Error("Role must be defined for chat messages");
                }
                return new ChatMessage(storedMessage.data as ChatMessageFieldsWithRole);
            }
            default:
                throw new Error(`Got unexpected type: ${storedMessage.type}`);
        }
    });
}
