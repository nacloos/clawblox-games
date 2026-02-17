import { AudioUploader } from "./audio-uploader.js";
import { Logger } from "./logger.js";
import type { PlaybackMeta } from "./types.js";
import { WorldServerClient } from "./server.js";

export type TtsClient = {
  start(): Promise<void>;
  speak(streamId: string, text: string, onChunk: (chunkB64: string) => Promise<void>): Promise<PlaybackMeta>;
  close(): Promise<void>;
};

const CLAIM_RETRY_MS = Number(process.env.SPEECH_CLAIM_RETRY_DELAY_MS || "180");
const HEARTBEAT_INTERVAL_MS = Number(process.env.SPEECH_HEARTBEAT_INTERVAL_MS || "800");

export class SpeechPipeline {
  private waitingPlayback = new Map<string, (event: { stream_id: string }) => void>();
  private epoch = 0;

  constructor(
    private readonly server: WorldServerClient,
    private readonly tts: TtsClient,
    private readonly logger: Logger,
    private readonly noAudio: boolean,
  ) {}

  async start() {
    await this.tts.start();
  }

  markHeardEpoch() {
    this.epoch += 1;
    return this.epoch;
  }

  notifyPlaybackDone(streamId: string) {
    const waiter = this.waitingPlayback.get(streamId);
    if (waiter) {
      this.waitingPlayback.delete(streamId);
      waiter({ stream_id: streamId });
    }
  }

  async speakText(text: string, expectedEpoch: number): Promise<boolean> {
    const cleaned = text.trim();
    if (!cleaned) return false;
    const streamId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const claim = await this.claimWithRetry(streamId, () => expectedEpoch !== this.epoch);
    if (!claim.leaseId) {
      this.logger.speech(`claim rejected stream=${streamId}`);
      return false;
    }

    if (expectedEpoch !== this.epoch) {
      await this.server.sendSpeechBus("Cancel", { stream_id: streamId, lease_id: claim.leaseId });
      this.logger.speech(`stale claim cancelled stream=${streamId}`);
      return false;
    }

    let heartbeatSeq = 0;
    const heartbeatTimer = setInterval(() => {
      heartbeatSeq += 1;
      void this.server
        .sendSpeechBus("Heartbeat", {
          stream_id: streamId,
          lease_id: claim.leaseId,
          progress_seq: heartbeatSeq,
        })
        .catch((err) => {
          this.logger.speech(
            `heartbeat error stream=${streamId} err=${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }, HEARTBEAT_INTERVAL_MS);

    let progressSeq = 0;
    const sendProgress = async (progressText: string) => {
      progressSeq += 1;
      await this.server.sendSpeechBus("Progress", {
        stream_id: streamId,
        lease_id: claim.leaseId,
        progress_seq: progressSeq,
        text: progressText,
      });
    };

    let meta: PlaybackMeta = {
      totalAudioBytes: 0,
      sampleRateHz: 24000,
      channels: 1,
      bytesPerSample: 2,
      playbackSpeed: 1,
    };

    try {
      await sendProgress(cleaned);
      if (!this.noAudio) {
        const uploader = new AudioUploader(
          `${process.env.WORLD_BASE_URL || "http://localhost:8080"}/audio`,
          this.server.getSession(),
        );
        let seq = 0;
        meta = await this.tts.speak(streamId, cleaned, async (chunk) => {
          await uploader.enqueueChunk(streamId, seq, chunk, false);
          seq += 1;
        });
        await uploader.enqueueChunk(streamId, seq, "", true, cleaned, meta);
        await this.waitPlaybackDone(streamId);
      }

      await this.server.sendSpeechBus("Finalize", {
        stream_id: streamId,
        lease_id: claim.leaseId,
        speech_text: cleaned,
        total_audio_bytes: meta.totalAudioBytes,
        sample_rate_hz: meta.sampleRateHz,
        channels: meta.channels,
        bytes_per_sample: meta.bytesPerSample,
        playback_speed: meta.playbackSpeed,
      });
      this.logger.speech(`finalize stream=${streamId} lease=${claim.leaseId} textLen=${cleaned.length}`);
      return true;
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async claimWithRetry(streamId: string, shouldAbort: () => boolean): Promise<{ leaseId: string | null }> {
    while (true) {
      if (shouldAbort()) return { leaseId: null };
      try {
        const obs = await this.server.sendSpeechBus("Claim", { stream_id: streamId });
        const claim = this.server.getClaimFromObserve(obs, streamId);
        if (claim.claimed && claim.leaseId) return { leaseId: claim.leaseId };
      } catch (err) {
        this.logger.speech(`claim error stream=${streamId} err=${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_MS));
    }
  }

  private async waitPlaybackDone(streamId: string) {
    await new Promise<void>((resolve) => {
      this.waitingPlayback.set(streamId, () => resolve());
    });
  }
}
