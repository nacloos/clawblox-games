import type { SpeechEvent } from "./types.js";
import { ConversationStore } from "./conversation.js";
import { SpeechPipeline } from "./speech.js";
import { SpeechAgentRuntime } from "./llm.js";
import { Logger } from "./logger.js";

function extractSpeakSegments(text: string): string[] {
  const out: string[] = [];
  const re = /<(?:speak|s)>([\s\S]*?)<\/(?:speak|s)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const segment = String(m[1] || "").trim();
    if (segment) out.push(segment);
  }
  return out;
}

export class TurnEngine {
  private busy = false;

  constructor(
    private readonly store: ConversationStore,
    private readonly llm: SpeechAgentRuntime,
    private readonly speech: SpeechPipeline,
    private readonly logger: Logger,
  ) {
    this.llm.subscribe((event) => {
      if (event.type === "assistant_end") {
        void this.onAssistantEnd(event.text);
      }
    });
  }

  async startup(initialPrompt: string) {
    await this.runWithLock(async () => {
      this.logger.speech(`prompt start source=startup_initial_prompt`);
      await this.llm.prompt(initialPrompt);
      this.logger.speech(`prompt end source=startup_initial_prompt`);
    });
  }

  async onHeard(event: SpeechEvent) {
    const key = `${event.speaker}:${event.seq}`;
    const text = `[${event.speaker} says]: ${event.text}`;
    await this.store.appendUserText(text, key);
    this.llm.steerUser(text);
    this.speech.markHeardEpoch();
    if (!this.busy) {
      await this.runWithLock(async () => {
        this.logger.speech(`continue start source=heard:${event.speaker}`);
        await this.llm.cont();
        this.logger.speech(`continue end source=heard:${event.speaker}`);
      });
    }
  }

  private async onAssistantEnd(text: string) {
    await this.store.appendAssistantText(text);
    const segments = extractSpeakSegments(text);
    if (segments.length === 0) return;
    const expectedEpoch = this.speech.markHeardEpoch();
    for (const seg of segments) {
      await this.speech.speakText(seg, expectedEpoch);
    }
  }

  private async runWithLock(fn: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
    } finally {
      this.busy = false;
    }
  }
}
