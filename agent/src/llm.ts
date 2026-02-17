import { Agent } from "/home/nacloos/Code/pi-mono/packages/agent/dist/index.js";
import { getModel } from "/home/nacloos/Code/pi-mono/packages/ai/dist/index.js";
import type { ConversationMessage } from "./types.js";

export type SpeechAgentUpdate = {
  type: "assistant_end";
  text: string;
};

export class SpeechAgentRuntime {
  private readonly agent: any;

  constructor(
    systemPrompt: string,
    provider: string,
    modelName: string,
    getApiKey: (provider: string) => string | undefined,
  ) {
    const model = getModel(provider as any, modelName);
    this.agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "off",
        tools: [],
      },
      getApiKey,
    });
    this.agent.setSteeringMode("all");
  }

  replaceMessages(messages: ConversationMessage[]) {
    this.agent.replaceMessages(messages);
  }

  steerUser(text: string) {
    this.agent.steer({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
  }

  async prompt(text: string) {
    await this.agent.prompt(text);
  }

  async cont() {
    await this.agent.continue();
  }

  subscribe(onUpdate: (event: SpeechAgentUpdate) => void) {
    this.agent.subscribe((event: any) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = Array.isArray(event.message?.content)
          ? event.message.content
              .map((c: { type?: string; text?: string }) => (c?.type === "text" ? c.text || "" : ""))
              .join("")
          : "";
        onUpdate({ type: "assistant_end", text });
      }
    });
  }
}
