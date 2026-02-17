import WebSocketClient from "ws";
import type { PlaybackDoneEvent, SpectateEvent, SpeechClaim, SpeechEvent } from "./types.js";

export type ObserveSnapshot = Record<string, unknown>;

export class WorldServerClient {
  private session = "";
  private agentId = "";
  private ws: any = null;

  constructor(private readonly baseUrl: string, private readonly agentName: string) {}

  getSession() {
    return this.session;
  }

  getAgentName() {
    return this.agentName;
  }

  async join() {
    const url = `${this.baseUrl}/join?name=${encodeURIComponent(this.agentName)}`;
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) throw new Error(`join failed: ${res.status} ${res.statusText}`);
    const json = await res.json() as { session?: string; agent_id?: string };
    if (!json.session) throw new Error("join response missing session");
    this.session = String(json.session);
    this.agentId = String(json.agent_id || "");
  }

  async observe(): Promise<ObserveSnapshot | null> {
    if (!this.session) return null;
    const res = await fetch(`${this.baseUrl}/observe`, { headers: { "X-Session": this.session } });
    if (!res.ok) throw new Error(`observe failed: ${res.status} ${res.statusText}`);
    return await res.json() as ObserveSnapshot;
  }

  async input(type: string, data: Record<string, unknown>): Promise<ObserveSnapshot> {
    const res = await fetch(`${this.baseUrl}/input`, {
      method: "POST",
      headers: { "X-Session": this.session, "Content-Type": "application/json" },
      body: JSON.stringify({ type, data }),
    });
    if (!res.ok) throw new Error(`input failed: ${res.status} ${res.statusText}`);
    return await res.json() as ObserveSnapshot;
  }

  async sendSpeechBus(op: string, payload: Record<string, unknown>): Promise<ObserveSnapshot> {
    return await this.input("RemoteEvent", {
      name: "SpeechBus",
      args: [{ op, ...payload }],
    });
  }

  getClaimFromObserve(observation: ObserveSnapshot | null, streamId: string): SpeechClaim {
    if (!observation) return { claimed: false, leaseId: null };
    const world = observation.world as { entities?: Array<{ name?: string; attributes?: Record<string, unknown> }> } | undefined;
    const entities = Array.isArray(world?.entities) ? world.entities : [];
    const gs = entities.find((e) => e?.name === "GameState");
    const currentSpeaker = String(gs?.attributes?.current_speaker || "").trim();

    const player = observation.player as { attributes?: Record<string, unknown> } | undefined;
    const attrs = player?.attributes || {};
    const speaking = attrs.IsSpeaking === true || currentSpeaker === this.agentName;
    if (!speaking) return { claimed: false, leaseId: null };
    const observedStreamId = String(attrs.SpeechStreamId || "").trim();
    const observedLeaseId = String(attrs.SpeechLeaseId || "").trim();
    if (!observedLeaseId) return { claimed: false, leaseId: null };
    if (observedStreamId && observedStreamId !== streamId) return { claimed: false, leaseId: null };
    return { claimed: true, leaseId: observedLeaseId };
  }

  connectSpectateWs(role: "actor" | "spectator", onEvent: (event: SpectateEvent) => void) {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/spectate/ws";
    url.search = `role=${role}`;

    this.ws = new WebSocketClient(url.toString(), { headers: { "X-Session": this.session } });
    this.ws.on("message", (raw: unknown) => {
      try {
        const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const parsed = JSON.parse(text) as SpectateEvent;
        onEvent(parsed);
      } catch {
        // ignore non-json payloads
      }
    });
  }

  closeWs() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export function isSpeechEvent(event: SpectateEvent): event is SpeechEvent {
  return event.type === "speech";
}

export function isPlaybackDoneEvent(event: SpectateEvent): event is PlaybackDoneEvent {
  return event.type === "playback_done";
}
