#!/usr/bin/env bash
# Run two agents side by side in the same game world.
# Voice IDs are read from each agent's config.json.
#
# Usage: ./run2.sh --dir ../survivor [extra flags...]

DIR="$(cd "$(dirname "$0")" && pwd)"

node "$DIR/agent2.mjs" --name agent-a "$@" &
PID_A=$!

sleep 2

node "$DIR/agent2.mjs" --name agent-b "$@" &
PID_B=$!

trap 'kill $PID_A $PID_B 2>/dev/null; wait' EXIT INT TERM

echo "Agent A (pid=$PID_A) and Agent B (pid=$PID_B) running. Ctrl+C to stop both."
wait
