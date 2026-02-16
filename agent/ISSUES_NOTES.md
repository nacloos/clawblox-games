# Agent Speech/Turn Issues Notes

Updated: 2026-02-16

## 1) Early playback completion (heard audio still playing)

- Symptom: server/frontend reported stream complete before audible end.
- Root cause: `/audio` uploads from `agent2` were fire-and-forget; `done=true` could arrive before earlier chunks.
- Effect: server estimated stream duration from incomplete byte total, so completion timer fired too early.
- Fix implemented:
  - Per-stream upload serialization in `agent2` (`_queueSendChunk` chain).
  - `done=true` now cannot overtake prior chunks for same stream.

## 2) Frontend finalize was timer-only (not true playback end)

- Symptom: frontend `finalized stream` could drift from real end.
- Root cause: finalize used scheduled delay (`buffered + grace`) instead of actual node end.
- Fix implemented:
  - Frontend runtime now finalizes primarily on last `AudioBufferSourceNode.onended`.
  - Timer path kept only as guard fallback.

## 3) Sim-time vs wall-time silence confusion

- Symptom: silence threshold appeared wrong in real seconds.
- Root cause: silence timing used simulation clock (`tick`/`time`) instead of wall clock.
- Fix implemented:
  - World script switched to wall clock (`DateTime.now().UnixTimestampMillis`) for speech/silence timing.
  - Logs now print both `wall_ms` and `sim_ms` for debugging.

## 4) DateTime runtime missing caused Lua halt

- Symptom: `attempt to index nil with 'now'` when using `DateTime.now()` in Lua.
- Root cause: DateTime global not exposed in engine runtime.
- Fix implemented:
  - Added DateTime userdata/type registration in engine.
  - Added tests for `DateTime.now` and unix millis roundtrip.

## 5) “No one responds” due to host-only run

- Symptom: host speaks, then silence forever.
- Root cause: `run.sh` was temporarily set to launch only `host` for debugging.
- Resolution: run with full agent launch loop enabled when testing conversations.

## 6) Claim/cancel thrash after messages (latest major issue)

- Symptom:
  - repeated `claim rejected`,
  - `granted` followed by immediate `released ... reason=cancelled`,
  - `message_end: skipping TTS flush for unclaimed stream`,
  - then global silence.
- Root cause:
  - aggressive cancel-on-`heard_other` behavior combined with concurrent claim retries.
  - pending turn attempts were cancelled too often before stabilization.
- Partial fix in progress:
  - removed cancel-on-heard for unclaimed/pending attempts,
  - added speech event epoch guard so stale claim retries abort.
- Observed regression after partial fix:
  - to prevent "grant then immediate cancel", late-lease recovery was added.
  - this can resurrect stale queued drafts and let outdated turns speak.
- Goal:
  - preserve anti-stale behavior without destroying in-flight turn attempts.

## 7) Tradeoff bug: stale resurrection vs grant-cancel race

- Symptom A (old): immediate `granted -> released reason=cancelled`.
- Symptom B (new): stale draft speaks after newer message arrives.
- Why:
  - If we aggressively cancel pending attempts, we get A.
  - If we aggressively recover late grants, we get B.
- Current evidence for B:
  - debug logs show `sendSpeechClaimWithRetry: recovered granted lease for stale stream ...`
  - followed by speaking content that predates newer `heard:*` events.
- Required design direction:
  - keep server-authoritative lease safety,
  - but bind each generated draft to a conversation epoch and reject speaking if superseded.

## 8) Global silence cue side effects

- Symptom: host/silence cue could create extra contention and stale queue pressure.
- Change made:
  - server silence cue injection now disabled by default.
  - can be re-enabled with `ENABLE_SERVER_SILENCE_CUE=1`.

## Key log signatures

- Early completion suspicion:
  - `[audio] complete ...` long before audible end.
- Claim thrash:
  - `sendSpeechClaim: claim rejected ...` repeated many times.
  - `released ... reason=cancelled` immediately after grant.
  - `skipping TTS flush for unclaimed stream ...`.
- Stale resurrection:
  - `recovered granted lease for stale stream ...`
  - followed by speech that ignores newer `heard:*` context.
- Host-only run:
  - only one `agent2.mjs` process in `ps`.
  - server observations show only host joined.

## Current debugging priority

- Stabilize turn-attempt state machine under contention.
- Ensure one committed response survives after each heard message.
- Keep stale-response protection without global cancel storms.
