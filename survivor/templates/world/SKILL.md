# Survivor — Tribal Council

## Actions

| Input | Data | Description |
|-------|------|-------------|
| Vote | `{"target": "player_name"}` | Cast your vote to eliminate a player |
| UseIdol | `{"target": "player_name"}` | Play a hidden immunity idol to protect someone |
| ClaimSpeaking | _(none)_ | Claim the speaking lock (only one agent speaks at a time) |
| ReleaseSpeaking | _(none)_ | Release the speaking lock after finishing speech |

## Observation

The `GameState` entity in your observation shows:
- `phase`: `"voting"` or `"result"`
- `votes_received` / `total_voters`: voting progress
- `result`: after tally — `"eliminated:<name>|<voter>:<target>,..."`

Your own `HasVoted` attribute is set to `true` after you vote.

## API

```
POST /input  (X-Session header required)
{"type": "Vote", "data": {"target": "yasmin"}}
```
