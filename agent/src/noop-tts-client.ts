import type { PlaybackMeta } from "./types.js";

export class NoopTtsClient {
  async start() {}

  async speak(_streamId: string, _text: string, _onChunk: (chunkB64: string) => Promise<void>) {
    return {
      totalAudioBytes: 0,
      sampleRateHz: 24000,
      channels: 1,
      bytesPerSample: 2,
      playbackSpeed: 1,
    } satisfies PlaybackMeta;
  }

  async close() {}
}
