import type { SpeechEvent } from "./types.js";
import { ConversationStore } from "./conversation.js";
import { SpeechPipeline } from "./speech.js";
import { SpeechAgentRuntime } from "./llm.js";
import { Logger } from "./logger.js";
import { parseActionPayloads, type ActionPayload } from "./action-tags.js";

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

type ActionExecutionResult = { ok: boolean; actionType: string; summary: string };

export class TurnEngine {
  private busy = false;
  private lastServerSilenceEpochHandled = 0;
  private silenceCueSeq = 0;
  private silenceLoopTimer: NodeJS.Timeout | null = null;
  private silenceLoopEpoch = 0;
  private silenceLoopSilenceMs = 0;
  private readonly stallCueText = process.env.STALL_CUE_TEXT
    || "[scene cue]: Everyone stays silent for a moment. The pause turns awkward.";
  private readonly silenceRepeatMs = Number(process.env.SERVER_SILENCE_REPEAT_MS || "2000");

  constructor(
    private readonly store: ConversationStore,
    private readonly llm: SpeechAgentRuntime,
    private readonly speech: SpeechPipeline,
    private readonly logger: Logger,
    private readonly executeAction: (action: ActionPayload) => Promise<ActionExecutionResult>,
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
    this.stopSilenceLoop("heard_speech");
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
    const trigger = epoch > this.lastServerSilenceEpochHandled ? "new" : "repeat";
    if (epoch > this.lastServerSilenceEpochHandled) {
      this.lastServerSilenceEpochHandled = epoch;
    }
    this.silenceLoopEpoch = epoch;
    this.silenceLoopSilenceMs = silenceMs;
    await this.emitSilenceCue(trigger);
    this.ensureSilenceLoop();
  }

  private async onAssistantEnd(text: string) {
    await this.store.appendAssistantText(text);
    const parsedActions = parseActionPayloads(text);
    const actions = parsedActions.actions;
    for (const err of parsedActions.errors) {
      this.logger.warn(`action_tag_parse_error reason=${err.reason} raw=${err.raw}`);
    }
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      const result = await this.executeAction(action);
      const feedback = `[action_result] ${result.summary}`;
      const key = `action_result:${result.actionType}:${Date.now()}:${i}`;
      await this.store.appendUserText(feedback, key);
      this.llm.steerUser(feedback);
      this.logger.action(feedback);
      if (!result.ok) {
        this.logger.warn(`action_failed type=${result.actionType} summary=${result.summary}`);
      }
    }
    const segments = extractSpeakSegments(text);
    if (segments.length === 0) return;
    const expectedEpoch = this.speech.markHeardEpoch();
    let spoke = false;
    for (const seg of segments) {
      const didSpeak = await this.speech.speakText(seg, expectedEpoch);
      spoke = spoke || didSpeak;
    }
    if (spoke) {
      this.stopSilenceLoop("agent_spoke");
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

  private ensureSilenceLoop() {
    if (this.silenceLoopTimer) return;
    this.silenceLoopTimer = setInterval(() => {
      void this.emitSilenceCue("repeat");
    }, this.silenceRepeatMs);
  }

  private stopSilenceLoop(reason: string) {
    if (!this.silenceLoopTimer) return;
    clearInterval(this.silenceLoopTimer);
    this.silenceLoopTimer = null;
    this.logger.speech(`server_silence stop reason=${reason}`);
  }

  private async emitSilenceCue(trigger: "new" | "repeat") {
    if (this.silenceLoopEpoch <= 0) return;
    this.logger.speech(
      `server_silence epoch=${this.silenceLoopEpoch} silence_ms=${this.silenceLoopSilenceMs} trigger=${trigger}`,
    );
    if (trigger === "new") {
      this.silenceCueSeq += 1;
      const cueKey = `server_silence:${this.silenceLoopEpoch}:${this.silenceCueSeq}`;
      await this.store.appendUserText(this.stallCueText, cueKey);
    }
    this.llm.steerUser(this.stallCueText);
    this.speech.markHeardEpoch();
    if (!this.busy) {
      await this.runWithLock(async () => {
        this.logger.speech(`continue start source=server_silence_epoch:${this.silenceLoopEpoch}`);
        await this.llm.cont();
        this.logger.speech(`continue end source=server_silence_epoch:${this.silenceLoopEpoch}`);
      });
    }
  }
}
