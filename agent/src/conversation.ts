import { writeFileSync } from "node:fs";
import { SerialExecutor } from "./serial.js";
import type { ConversationMessage } from "./types.js";
import { Logger } from "./logger.js";

export class ConversationStore {
  private readonly serial = new SerialExecutor();
  private readonly seenHeard = new Set<string>();
  private messages: ConversationMessage[] = [];
  private version = 0;

  constructor(private readonly filePath: string, private readonly logger: Logger) {}

  snapshot() {
    return {
      version: this.version,
      messages: [...this.messages],
    };
  }

  async appendUserText(text: string, key?: string): Promise<number> {
    return this.serial.enqueue(async () => {
      if (key && this.seenHeard.has(key)) return this.version;
      if (key) this.seenHeard.add(key);
      this.messages.push({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
      this.version += 1;
      this.persist();
      return this.version;
    });
  }

  async appendAssistantText(text: string): Promise<number> {
    return this.serial.enqueue(async () => {
      this.messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
      this.version += 1;
      this.persist();
      return this.version;
    });
  }

  replaceMessages(next: ConversationMessage[]) {
    return this.serial.enqueue(async () => {
      this.messages = [...next];
      this.version += 1;
      this.persist();
      return this.version;
    });
  }

  private persist() {
    writeFileSync(this.filePath, JSON.stringify(this.messages, null, 2));
    this.logger.speech(`persisted conversation path=${this.filePath} messages=${this.messages.length} version=${this.version}`);
  }
}
