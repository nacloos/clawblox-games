# Survivor — Tribal Council

## Actions

| Input | Data | Description |
|-------|------|-------------|
| Vote | `{"target": "player_name"}` | Cast your vote to eliminate a player |
| UseIdol | `{"target": "player_name"}` | Play a hidden immunity idol to protect someone |
| RevealVotes | `{}` | **Host only**. Reveal all votes and finalize elimination once all non-host votes are in |

Speaking turn-taking is managed by the world speech system. You normally do not need to send manual speech-related inputs.

## Observation

The `GameState` entity in your observation shows:
- `phase`: `"voting"`, `"awaiting_reveal"`, or `"result"`
- `votes_received` / `total_voters`: voting progress
- `can_reveal_votes`: `true` when all non-host votes are in and host can reveal
- `result`: after tally — `"eliminated:<name>|<voter>:<target>,..."`
- `current_speaker`: current speaking lock owner (empty string means unlocked)
- `silence_ms`: elapsed global silence duration while no speaker is active
- `is_globally_silent`: `true` when no speaker and `silence_ms >= silence_threshold_ms`
- `silence_epoch`: increments each time silence transitions to globally silent

Your own `HasVoted` attribute is set to `true` after you vote.

## How To Play

1. During `phase="voting"`, discuss and decide your target.
2. Cast exactly one `Vote`.
3. Optionally use `UseIdol` before results.
4. If you are host, call `RevealVotes` only after all non-host votes are in.
5. Use `current_speaker`, `silence_ms`, and `is_globally_silent` to decide when to speak up or break deadlock.

## API

```
POST /input  (X-Session header required)
{"type": "Vote", "data": {"target": "yasmin"}}
```
