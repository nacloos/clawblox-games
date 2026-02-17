import WebSocketClient from "ws";
import type { PlaybackMeta } from "./types.js";

function base64DecodedLen(data: string): number {
  const len = data.length;
  if (len === 0 || len % 4 !== 0) return 0;
  let pad = 0;
  if (data.endsWith("==")) pad = 2;
  else if (data.endsWith("=")) pad = 1;
  return (len / 4) * 3 - pad;
}

export class ElevenLabsClient {
  private ws: any = null;
  private connected = false;

  constructor(private readonly apiKey: string, private readonly voiceId: string, private readonly modelId = "eleven_flash_v2_5") {}

  async start() {
    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/multi-stream-input?model_id=${encodeURIComponent(this.modelId)}&output_format=pcm_24000`;
      this.ws = new WebSocketClient(url, { headers: { "xi-api-key": this.apiKey } });
      this.ws.on("open", () => {
        this.connected = true;
        resolve();
      });
      this.ws.on("error", (err: unknown) => {
        if (!this.connected) reject(err);
      });
      this.ws.on("close", () => {
        this.connected = false;
      });
    });
  }

  async speak(streamId: string, text: string, onChunk: (chunkB64: string) => Promise<void>): Promise<PlaybackMeta> {
    if (!this.ws || !this.connected) throw new Error("elevenlabs ws not connected");

    let totalAudioBytes = 0;

    return await new Promise<PlaybackMeta>((resolve, reject) => {
      const handleMessage = async (raw: unknown) => {
        try {
          const str = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
          const msg = JSON.parse(str) as { context_id?: string; contextId?: string; audio?: string; is_final?: boolean; isFinal?: boolean; error?: string; message?: string };
          const contextId = String(msg.context_id || msg.contextId || "");
          if (contextId && contextId !== streamId) return;

          if (msg.audio) {
            totalAudioBytes += base64DecodedLen(msg.audio);
            await onChunk(msg.audio);
          }

          if (msg.is_final || msg.isFinal) {
            cleanup();
            resolve({
              totalAudioBytes,
              sampleRateHz: 24000,
              channels: 1,
              bytesPerSample: 2,
              playbackSpeed: 1,
            });
          }

          if (msg.error || msg.message) {
            cleanup();
            reject(new Error(String(msg.error || msg.message)));
          }
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      const cleanup = () => {
        this.ws?.off("message", handleMessage);
      };

      this.ws?.on("message", handleMessage);
      this.ws?.send(JSON.stringify({
        context_id: streamId,
        text: "",
        voice_settings: { stability: 0.45, similarity_boost: 0.8, use_speaker_boost: true, speed: 1 },
      }));
      this.ws?.send(JSON.stringify({ context_id: streamId, text }));
      this.ws?.send(JSON.stringify({ context_id: streamId, flush: true }));
      this.ws?.send(JSON.stringify({ context_id: streamId, close_context: true }));
    });
  }

  async close() {
    if (this.ws) {
      this.ws.send(JSON.stringify({ close_socket: true }));
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
