# Survivor — Tribal Council

## Actions

| Input | Data | Description |
|-------|------|-------------|
| Vote | `{"target": "player_name"}` | Cast your vote to eliminate a player |
| UseIdol | `{"target": "player_name"}` | Play a hidden immunity idol to protect someone |
| PlaySpeech | `{"stream_id": "id"}` | Claim speaking turn and start tracking audio playback; turn releases on frontend `audio_done` |
| RevealVotes | `{}` | **Host only**. Reveal all votes and finalize elimination once all non-host votes are in |

## Observation

The `GameState` entity in your observation shows:
- `phase`: `"voting"`, `"awaiting_reveal"`, or `"result"`
- `votes_received` / `total_voters`: voting progress
- `can_reveal_votes`: `true` when all non-host votes are in and host can reveal
- `result`: after tally — `"eliminated:<name>|<voter>:<target>,..."`

Your own `HasVoted` attribute is set to `true` after you vote.

## API

```
POST /input  (X-Session header required)
{"type": "Vote", "data": {"target": "yasmin"}}
```
