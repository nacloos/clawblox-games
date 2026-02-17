export type ContentPart = { type: "text"; text: string };

export type ConversationMessage = {
  role: "user" | "assistant";
  content: ContentPart[];
  timestamp: number;
  api?: string;
  provider?: string;
  model?: string;
  usage?: unknown;
  stopReason?: string;
};

export type SpeechEvent = {
  type: "speech";
  seq: number;
  speaker: string;
  text: string;
};

export type PlaybackDoneEvent = {
  type: "playback_done";
  seq?: number;
  speaker: string;
  stream_id: string;
  reason?: string;
};

export type GlobalSilenceEvent = {
  type: "global_silence";
  epoch: number;
  silence_ms: number;
};

export type SpectateEvent =
  | SpeechEvent
  | PlaybackDoneEvent
  | GlobalSilenceEvent
  | Record<string, unknown>;

export type AgentConfig = {
  initial_prompt?: string;
  voice_id?: string;
};

export type SpeechClaim = { claimed: boolean; leaseId: string | null };

export type PlaybackMeta = {
  totalAudioBytes: number;
  sampleRateHz: number;
  channels: number;
  bytesPerSample: number;
  playbackSpeed: number;
};
