import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadRuntimeConfig } from "./config.js";
import { Logger } from "./logger.js";
import { ConversationStore } from "./conversation.js";
import { WorldServerClient, isGlobalSilenceEvent, isPlaybackDoneEvent, isSpeechEvent } from "./server.js";
import { ElevenLabsClient } from "./elevenlabs-client.js";
import { NoopTtsClient } from "./noop-tts-client.js";
import { SpeechPipeline } from "./speech.js";
import { SpeechAgentRuntime } from "./llm.js";
import { TurnEngine } from "./turn.js";
import { summarizeActionObservation } from "./action-result.js";

function loadCodexAccessToken(scriptDir: string, logWarn: (msg: string) => void): string | undefined {
  const candidates = [path.join(process.cwd(), "auth.json"), path.join(scriptDir, "auth.json")];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const auth = JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
      const creds = auth?.["openai-codex"];
      if (creds && typeof creds.access === "string" && creds.access.length > 0) return creds.access;
    } catch (err) {
      logWarn(
        `codex_auth_parse_failed path=${p} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return undefined;
}

async function main() {
  const config = loadRuntimeConfig(process.argv.slice(2));
  const logger = new Logger(config.debugLogPath, ` [agent=${config.agentName} pid=${process.pid}]`);

  const server = new WorldServerClient(config.worldBaseUrl, config.agentName, (msg) => logger.warn(msg));
  await server.join();

  const codexAccessToken = loadCodexAccessToken(path.join(config.gameDir, "../agent"), (msg) => logger.warn(msg));
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  const speechAgent = new SpeechAgentRuntime(
    config.speechSystemPrompt,
    config.modelProvider,
    config.modelName,
    (provider) => {
      if (provider === "openai-codex") return codexAccessToken;
      if (provider === "anthropic") return anthropicApiKey;
      return undefined;
    },
  );

  const tts = config.noAudio
    ? new NoopTtsClient()
    : new ElevenLabsClient(
        String(process.env.ELEVENLABS_API_KEY || ""),
        String(config.agentConfig.voice_id || process.env.ELEVENLABS_VOICE_ID || ""),
        String(process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5"),
      );

  const speech = new SpeechPipeline(server, tts, logger, config.noAudio);
  await speech.start();

  const store = new ConversationStore(config.speechConversationPath, logger);
  speechAgent.replaceMessages(store.snapshot().messages);

  const turnEngine = new TurnEngine(
    store,
    speechAgent,
    speech,
    logger,
    async (action) => {
      if (config.noAction) {
        const summary = `action=${action.type} | skipped (--no-action)`;
        logger.action(summary);
        return { ok: false, actionType: action.type, summary };
      }
      try {
        const observation = await server.input(action.type, action.data);
        const summary = summarizeActionObservation(action.type, observation);
        logger.action(summary);
        return { ok: true, actionType: action.type, summary };
      } catch (err) {
        const summary = `action=${action.type} | request_failed err=${err instanceof Error ? err.message : String(err)}`;
        logger.action(summary);
        return { ok: false, actionType: action.type, summary };
      }
    },
  );

  server.connectSpectateWs("actor", (event) => {
    if (isSpeechEvent(event) && event.speaker !== config.agentName) {
      void turnEngine.onHeard(event);
      return;
    }
    if (isPlaybackDoneEvent(event) && event.speaker === config.agentName) {
      speech.notifyPlaybackDone(event.stream_id);
      return;
    }
    if (isGlobalSilenceEvent(event)) {
      void turnEngine.onGlobalSilence(event.epoch, event.silence_ms);
    }
  });

  logger.action(`World joined: ${config.worldBaseUrl} agent=${config.agentName}`);
  logger.speech(config.noAudio ? "Audio generation/playback disabled (--no-audio)." : "ElevenLabs audio enabled.");

  if (!config.noSpeech) {
    await turnEngine.startup(config.agentConfig.initial_prompt || "You have just woken up in the world.");
  }

  const shutdown = async (signal: string) => {
    logger.action(`shutdown signal=${signal}`);
    server.closeWs();
    await tts.close();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  });
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
