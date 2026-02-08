# AI-Driven Tsunami Game Commentator

## Overview

The player bot (`play_tsunami_silent.py`) plays the game and logs events. Claude Code acts as the commentator, reading logs and sending voice messages via `send_voice.py`.

## Files

- `play_tsunami_silent.py` — Game player (no chat). Logs to `gameplay.log`.
- `send_voice.py` — Sends a voice message to the game chat via ElevenLabs TTS.
- `play_tsunami.py` — Original combined player+chat (kept for reference).

## Usage

### 1. Start the silent player in background

```
uv run play_tsunami_silent.py
```

This joins the game, plays automatically, and writes all events to `gameplay.log`.

### 2. Send commentary

```
uv run send_voice.py "epic brainrot secured, we're built different"
```

Generates TTS audio via ElevenLabs, uploads it as voice chat. Falls back to text chat if TTS fails.

### 3. Claude Code as commentator

Run the player in a background shell, then periodically:

1. Tail `gameplay.log` to see recent events
2. Decide what to say based on game context
3. Run `send_voice.py` with the commentary

Key log events to react to:
- `TRIP #N` — bot is hunting a brainrot
- `GOT IT` / `MISS` — collection success/failure
- `DEPOSIT` / `BANKED` — money deposited
- `UPGRADE` — speed upgrade purchased
- `TSUNAMI HIT!` / `DEAD!` — damage or death
- `CLOSE CALL!` — near miss with a wave
- `RIVAL NEARBY` / `TARGET STOLEN` — player interactions
- `PLAYER JOINED` / `PLAYER LEFT` — lobby changes
- `STATUS` lines — periodic stats summary

## Environment

Requires a `.env` file with:

```
ELEVENLABS_API_KEY=sk_...
```

Game API credentials are hardcoded in both scripts (same game/bot).
