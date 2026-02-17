import type { ObserveSnapshot } from "./server.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[len=${value.length}]`;
  if (typeof value === "object") {
    const rec = value as JsonRecord;
    return `{keys=${Object.keys(rec).length}}`;
  }
  return String(value);
}

function formatRecord(record: JsonRecord, maxPairs = 8): string {
  const pairs = Object.keys(record)
    .sort()
    .slice(0, maxPairs)
    .map((key) => `${key}=${formatValue(record[key])}`);
  if (pairs.length === 0) return "{}";
  const extra = Object.keys(record).length - pairs.length;
  return `{${pairs.join(", ")}${extra > 0 ? `, +${extra} more` : ""}}`;
}

function summarizeRecentEvents(snapshot: ObserveSnapshot): string {
  const recentEvents = snapshot.recent_events;
  if (!Array.isArray(recentEvents) || recentEvents.length === 0) return "[]";
  const tail = recentEvents.slice(-3);
  const parts = tail.map((event) => {
    const rec = asRecord(event);
    if (!rec) return "unknown";
    const name = typeof rec.name === "string" ? rec.name : "event";
    const payload = asRecord(rec.payload);
    const op = payload && typeof payload.op === "string" ? payload.op : "";
    return op ? `${name}(op=${op})` : name;
  });
  return `[${parts.join(", ")}]`;
}

function summarizeAttributedEntities(snapshot: ObserveSnapshot): string {
  const world = asRecord(snapshot.world);
  const entities = world?.entities;
  if (!Array.isArray(entities)) return "[]";
  const items: string[] = [];
  for (const entity of entities) {
    const rec = asRecord(entity);
    if (!rec) continue;
    const attrs = asRecord(rec.attributes);
    if (!attrs || Object.keys(attrs).length === 0) continue;
    const name = typeof rec.name === "string" ? rec.name : `entity_${String(rec.id ?? "?")}`;
    items.push(`${name}${formatRecord(attrs, 6)}`);
    if (items.length >= 3) break;
  }
  return items.length > 0 ? `[${items.join("; ")}]` : "[]";
}

export function summarizeActionObservation(actionType: string, snapshot: ObserveSnapshot): string {
  const tick = Number(snapshot.tick);
  const gameStatus = typeof snapshot.game_status === "string" ? snapshot.game_status : "unknown";

  const player = asRecord(snapshot.player);
  const playerAttrs = asRecord(player?.attributes) || {};

  return [
    `action=${actionType}`,
    "request_ok",
    Number.isFinite(tick) ? `tick=${Math.floor(tick)}` : "tick=unknown",
    `status=${gameStatus}`,
    `player_attrs=${formatRecord(playerAttrs, 8)}`,
    `entities_with_attrs=${summarizeAttributedEntities(snapshot)}`,
    `recent_events=${summarizeRecentEvents(snapshot)}`,
  ].join(" | ");
}

