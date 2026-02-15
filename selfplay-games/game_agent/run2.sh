#!/usr/bin/env bash
# Run two agents side by side in the same game world.
# Uses AGENT_A_VOICE_ID and AGENT_B_VOICE_ID from .env.

DIR="$(cd "$(dirname "$0")" && pwd)"

WORLD_AGENT_NAME=agent-a AGENT_A_VOICE_ID="${AGENT_A_VOICE_ID}" node "$DIR/agent2.mjs" "$@" &
PID_A=$!

sleep 2

WORLD_AGENT_NAME=agent-b AGENT_A_VOICE_ID="${AGENT_B_VOICE_ID}" node "$DIR/agent2.mjs" "$@" &
PID_B=$!

trap 'kill $PID_A $PID_B 2>/dev/null; wait' EXIT INT TERM

echo "Agent A (pid=$PID_A) and Agent B (pid=$PID_B) running. Ctrl+C to stop both."
wait
