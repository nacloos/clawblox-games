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

type ActionPayload = { type: string; data: Record<string, unknown> };

function extractActionPayloads(text: string): ActionPayload[] {
  const out: ActionPayload[] = [];
  const re = /<action>([\s\S]*?)<\/action>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = String(m[1] || "").trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown };
      const type = typeof parsed?.type === "string" ? parsed.type.trim() : "";
      if (!type) continue;
      const data = (parsed?.data && typeof parsed.data === "object")
        ? (parsed.data as Record<string, unknown>)
        : {};
      out.push({ type, data });
    } catch {
      // Ignore malformed action tag payloads.
    }
  }
  return out;
}

export class TurnEngine {
  private busy = false;
  private lastServerSilenceEpochHandled = 0;
  private lastServerSilenceCueAt = 0;
  private readonly stallCueText = process.env.STALL_CUE_TEXT
    || "[scene cue]: Everyone stays silent for a moment. The pause turns awkward.";
  private readonly silenceRepeatMs = Number(process.env.SERVER_SILENCE_REPEAT_MS || "2000");

  constructor(
    private readonly store: ConversationStore,
    private readonly llm: SpeechAgentRuntime,
    private readonly speech: SpeechPipeline,
    private readonly logger: Logger,
    private readonly executeAction: (action: ActionPayload) => Promise<void>,
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

  async onGlobalSilence(epoch: number, silenceMs: number) {
    if (!Number.isFinite(epoch) || epoch <= 0) return;
    const nowMs = Date.now();
    const isNewEpoch = epoch > this.lastServerSilenceEpochHandled;
    const canRepeat = epoch === this.lastServerSilenceEpochHandled
      && nowMs - this.lastServerSilenceCueAt >= this.silenceRepeatMs;
    if (!isNewEpoch && !canRepeat) return;

    this.lastServerSilenceEpochHandled = epoch;
    this.lastServerSilenceCueAt = nowMs;
    this.logger.speech(`server_silence epoch=${epoch} silence_ms=${silenceMs} trigger=${isNewEpoch ? "new" : "repeat"}`);
    this.llm.steerUser(this.stallCueText);
    this.speech.markHeardEpoch();
    if (!this.busy) {
      await this.runWithLock(async () => {
        this.logger.speech(`continue start source=server_silence_epoch:${epoch}`);
        await this.llm.cont();
        this.logger.speech(`continue end source=server_silence_epoch:${epoch}`);
      });
    }
  }

  private async onAssistantEnd(text: string) {
    await this.store.appendAssistantText(text);
    const actions = extractActionPayloads(text);
    for (const action of actions) {
      await this.executeAction(action);
    }
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
