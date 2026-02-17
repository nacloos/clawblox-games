import test from "node:test";
import assert from "node:assert/strict";
import { summarizeActionObservation } from "./action-result.js";

test("summarizeActionObservation includes key response fields", () => {
  const observation = {
    tick: 123,
    game_status: "playing",
    player: {
      attributes: {
        HasVoted: true,
        IsSpeaking: false,
      },
    },
    world: {
      entities: [
        { id: 1, name: "Ground" },
        {
          id: 2,
          name: "GameState",
          attributes: {
            phase: "awaiting_reveal",
            votes_received: 5,
            total_voters: 5,
          },
        },
      ],
    },
    recent_events: [
      { id: 10, name: "SpeechBus", payload: { op: "Released" } },
      { id: 11, name: "SpeechBus", payload: { op: "GlobalSilence" } },
    ],
  } as Record<string, unknown>;

  const summary = summarizeActionObservation("Vote", observation);
  assert.match(summary, /action=Vote/);
  assert.match(summary, /request_ok/);
  assert.match(summary, /tick=123/);
  assert.match(summary, /status=playing/);
  assert.match(summary, /player_attrs=\{.*HasVoted=true/);
  assert.match(summary, /entities_with_attrs=\[GameState\{/);
  assert.match(summary, /recent_events=\[SpeechBus\(op=Released\), SpeechBus\(op=GlobalSilence\)\]/);
});

test("summarizeActionObservation handles sparse observation shape", () => {
  const observation = {
    tick: "bad",
    game_status: 1,
  } as Record<string, unknown>;

  const summary = summarizeActionObservation("RevealVotes", observation);
  assert.match(summary, /action=RevealVotes/);
  assert.match(summary, /tick=unknown/);
  assert.match(summary, /status=unknown/);
  assert.match(summary, /player_attrs=\{\}/);
  assert.match(summary, /entities_with_attrs=\[\]/);
  assert.match(summary, /recent_events=\[\]/);
});

