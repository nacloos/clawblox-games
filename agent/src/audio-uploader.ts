import type { PlaybackMeta } from "./types.js";

const AUDIO_SAMPLE_RATE_HZ = 24000;
const AUDIO_CHANNELS = 1;
const AUDIO_BYTES_PER_SAMPLE = 2;

export class AudioUploader {
  private chain = Promise.resolve();

  constructor(private readonly audioUrl: string, private readonly session: string) {}

  enqueueChunk(streamId: string, seq: number, dataB64: string, done: boolean, speechText = "", meta: Partial<PlaybackMeta> = {}) {
    this.chain = this.chain.then(async () => {
      const body: Record<string, unknown> = {
        stream_id: streamId,
        seq,
        data: dataB64,
        done,
        sample_rate_hz: meta.sampleRateHz || AUDIO_SAMPLE_RATE_HZ,
        channels: meta.channels || AUDIO_CHANNELS,
        bytes_per_sample: meta.bytesPerSample || AUDIO_BYTES_PER_SAMPLE,
        playback_speed: meta.playbackSpeed || 1,
      };
      if (done && speechText) body.speech_text = speechText;
      const res = await fetch(this.audioUrl, {
        method: "POST",
        headers: {
          "X-Session": this.session,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`audio upload failed: ${res.status} ${res.statusText}`);
      }
    });
    return this.chain;
  }
}
