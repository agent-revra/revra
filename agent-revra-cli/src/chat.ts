import chalk from 'chalk';
import { Agent, AgentResponse, AgentUserMessage, AgentUserMessageResponse, FILES_TO_SEND_FIELD, FunctionResponseCallBack } from "agent-mimir/schema";
import readline from 'readline';
import { Retry } from "./utils.js";
import path from "path";
import { AgentManager } from 'agent-mimir/agent-manager';


export async function chatWithAgent(continuousMode: boolean, assistant: Agent, agentManager: AgentManager) {
  const agentStack: Agent[] = [];
  let pendingMessage: PendingMessage | null = null;
  let executor = assistant!;
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let aiResponse: undefined | AgentResponse = undefined;
  console.log("Available commands:\n")
  console.log("/reset - resets all agents\n\n");

  const toolCallBack: FunctionResponseCallBack = async (calls) => {
    for (const call of calls) {
      const toolResponse = `Agent: \`${executor.name}\` called function: \`${call.name}\` \nInvoked with input: \n\`\`\`${call.input}\`\`\` \nResponded with: \n\`\`\`${call.response.substring(0, 3000)}\`\`\``;
      console.log(toolResponse)
    }
  };

  while (true) {
    if (aiResponse && aiResponse.type == "toolRequest") {

      let answers = await Promise.race([new Promise<{ message: string }>((resolve, reject) => {
        rl.question((chalk.blue("Should AI Continue? Type Y or click Enter to continue, otherwise type a message to the AI: ")), (answer) => {
          resolve({ message: answer });
        });
      })]);

      if (answers.message.toLowerCase() === "y" || answers.message === "") {
        aiResponse = await Retry(() => executor.call(null, {}, toolCallBack));
      } else {
        const parsedMessage = extractContentAndText(answers.message);
        if (parsedMessage.type === "command") {
          await handleCommands(parsedMessage.command!, assistant, agentManager);
          continue;
        }
        const files = parsedMessage.message?.responseFiles.map((file) => {
          const filename = path.basename(file);
          return { fileName: filename, url: file };
        });
        aiResponse = await Retry(() => executor.call(parsedMessage.message?.text!, { [FILES_TO_SEND_FIELD]: files }));
      }
    } else {

      let messageToAgent: PendingMessage | undefined = undefined;
      if (pendingMessage) {
        messageToAgent = pendingMessage;
        pendingMessage = null;
      } else {
        let answers = await Promise.race([new Promise<{ message: string }>((resolve, reject) => {
          rl.question((chalk.blue("Human: ")), (answer) => {
            resolve({ message: answer });
          });
        })]);

        const parsedMessage = extractContentAndText(answers.message);
        if (parsedMessage.type === "command") {
          await handleCommands(parsedMessage.command!, assistant, agentManager);
          continue;
        }
        messageToAgent = {
          message: parsedMessage.message?.text!,
          sharedFiles: parsedMessage.message?.responseFiles.map((file) => {
            const filename = path.basename(file);
            return { fileName: filename, url: file };
          }) ?? []
        };
      }


      aiResponse = await Retry(() => executor.call(messageToAgent!.message!, { [FILES_TO_SEND_FIELD]: messageToAgent?.sharedFiles ?? [] }));
    }

    if (aiResponse?.type == "toolRequest" && continuousMode) {
      while (aiResponse.type == "toolRequest") {
        aiResponse = await Retry(() => executor.call(null, {}, toolCallBack));
      }
    }

    if (aiResponse?.type == "toolRequest") {

      const response = aiResponse?.output;
      const toolList = response.toolRequests.map(t => {
        return `- Tool Name: "${t.toolName}"\n- Tool Input: ${t.toolArguments}`
      }).join("----\n");
      const responseMessage = `Agent: "${executor.name}" is requesting permission to use tools: \n${toolList}\n`
      console.log(chalk.red("AI Response: ", chalk.blue(responseMessage)));

    } else if (aiResponse?.type == "agentResponse") {
      const response: AgentUserMessage = aiResponse?.output;
      if (response.agentName) {
        const currentAgent = executor;
        const newAgent = agentManager.getAgent(response.agentName);
        if (!newAgent) {
          pendingMessage = {
            message: "No agent found with that name.",
            sharedFiles: []
          };
        } else {
          agentStack.push(currentAgent);
          pendingMessage = userAgentResponseToPendingMessage(aiResponse);
          executor = newAgent;
        }

      } else {
        if (agentStack.length === 0) {
          const responseMessage = `Files provided by AI: ${aiResponse.responseAttributes[FILES_TO_SEND_FIELD]?.map((f: any) => f.fileName).join(", ") || "None"}\n\n${response.message}`;
          console.log(chalk.red("AI Response: ", chalk.blue(responseMessage)));
        } else {
          pendingMessage = {
            message: `${executor.name} responded with: ${response.message}`,
            //sharedFiles: []
            sharedFiles: aiResponse.responseAttributes[FILES_TO_SEND_FIELD] ?? []
          } satisfies PendingMessage;
          executor = agentStack.pop()!;
        }
      }

    }
  }
}

function userAgentResponseToPendingMessage(msg: AgentUserMessageResponse): PendingMessage {
  return {
    message: msg.output.message,
    sharedFiles: msg.responseAttributes[FILES_TO_SEND_FIELD] ?? []
  }
}

async function handleCommands(command: string, assistant: Agent, agentManager: AgentManager) {
  if (command.trim() === "reset") {
    for (const agent of agentManager.getAllAgents()) {
      await agent.reset();
    }
    console.log(chalk.red(`Agents have been reset.`));
  } else {
    console.log(chalk.red(`Unknown command: ${command}`));
  }
}

type PendingMessage = {
  sharedFiles: {
    url: string;
    fileName: string;
  }[],
  message: string;
}

function extractContentAndText(str: string): {
  type: `command` | `message`,
  command?: string,
  message?: {
    responseFiles: string[];
    text: string;
  }
} {

  if (str.startsWith("/")) {
    return {
      type: 'command',
      command: str.slice(1)
    }
  }

  const regex = /^(?:\s*\(([^)]+)\)\s*)+/g;
  let matches = [];
  let match;

  while ((match = regex.exec(str)) !== null) {
    matches.push(match[1]);
  }

  // Get the unmatched portion of the string after the parentheses
  const remainingText = str.replace(regex, '');

  return {
    type: 'message',
    message: {
      responseFiles: matches,
      text: remainingText.trim()
    }
  };
}