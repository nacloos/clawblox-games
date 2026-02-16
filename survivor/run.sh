#!/usr/bin/env bash
# (Re)start the clawblox server and launch agents for Tribal Council.
# Usage: ./run.sh [--no-audio]

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
WORLD="$DIR/templates/world"
AGENT="$DIR/../agent/agent2.mjs"
LOGS="$DIR/logs"
PID_FILE="$DIR/.run.pid"
AGENTS_DIR="$DIR/templates/agents"

mkdir -p "$LOGS"

declare -a PIDS=()
SHUTTING_DOWN=0
declare -a AGENT_EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --no-audio)
      AGENT_EXTRA_ARGS+=("--no-audio")
      ;;
    -h|--help)
      echo "Usage: ./run.sh [--no-audio]"
      echo "  --no-audio   Disable audio generation/playback in agent2"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Usage: ./run.sh [--no-audio]"
      exit 1
      ;;
  esac
done

is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

terminate_pids() {
  local timeout_s="${1:-5}"
  shift || true
  local -a targets=("$@")
  if [ "${#targets[@]}" -eq 0 ]; then
    return 0
  fi

  local -a alive=()
  local pid
  for pid in "${targets[@]}"; do
    if is_alive "$pid"; then
      alive+=("$pid")
    fi
  done

  if [ "${#alive[@]}" -eq 0 ]; then
    return 0
  fi

  kill -TERM "${alive[@]}" 2>/dev/null || true

  local waited=0
  local step_ms=100
  local max_steps=$((timeout_s * 1000 / step_ms))
  while [ "$waited" -lt "$max_steps" ]; do
    local -a remaining=()
    for pid in "${alive[@]}"; do
      if is_alive "$pid"; then
        remaining+=("$pid")
      fi
    done
    if [ "${#remaining[@]}" -eq 0 ]; then
      return 0
    fi
    alive=("${remaining[@]}")
    sleep 0.1
    waited=$((waited + 1))
  done

  echo "Force killing remaining processes: ${alive[*]}"
  kill -KILL "${alive[@]}" 2>/dev/null || true
}

cleanup() {
  if [ "$SHUTTING_DOWN" -eq 1 ]; then
    return
  fi
  SHUTTING_DOWN=1

  echo ""
  echo "Shutting down..."
  terminate_pids 5 "${PIDS[@]}"
  wait "${PIDS[@]}" 2>/dev/null || true
  rm -f "$PID_FILE"
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# Kill previous run if still alive
if [ -f "$PID_FILE" ]; then
  mapfile -t OLD_PIDS < "$PID_FILE"
  if [ "${#OLD_PIDS[@]}" -eq 1 ]; then
    read -r -a OLD_PIDS <<< "${OLD_PIDS[0]}"
  fi
  if [ "${#OLD_PIDS[@]}" -gt 0 ]; then
    echo "Stopping previous run: ${OLD_PIDS[*]}"
    terminate_pids 5 "${OLD_PIDS[@]}"
  fi
  rm -f "$PID_FILE"
  sleep 1
fi

# Start server
: > "$LOGS/server.log"
echo "Starting clawblox server... (log: logs/server.log)"
clawblox run "$WORLD" >> "$LOGS/server.log" 2>&1 &
PIDS+=("$!")
sleep 3

if [ ! -d "$AGENTS_DIR" ]; then
  echo "Missing agents directory: $AGENTS_DIR"
  exit 1
fi

mapfile -t AGENTS < <(find "$AGENTS_DIR" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | sort)
if [ "${#AGENTS[@]}" -eq 0 ]; then
  echo "No agents found in: $AGENTS_DIR"
  exit 1
fi

# # Launch only host for debugging
# : > "$LOGS/host.log"
# echo "Launching host... (log: logs/host.log)"
# node "$AGENT" --name "host" --dir "$DIR" --no-action >> "$LOGS/host.log" 2>&1 &
# PIDS+=("$!")
# sleep 3

# Agent loop
for name in "${AGENTS[@]}"; do
  : > "$LOGS/$name.log"
  echo "Launching $name... (log: logs/$name.log)"
  node "$AGENT" --name "$name" --dir "$DIR" --no-action "${AGENT_EXTRA_ARGS[@]}" >> "$LOGS/$name.log" 2>&1 &
  PIDS+=("$!")
done
sleep 3

# Save PIDs for restart
printf "%s\n" "${PIDS[@]}" > "$PID_FILE"

echo ""
echo "Server + ${#AGENTS[@]} agents running. Open http://localhost:8080"
echo "Ctrl+C to stop all."

# If any child exits, shut everything down.
while true; do
  set +e
  wait -n "${PIDS[@]}"
  status=$?
  set -e

  if [ "$SHUTTING_DOWN" -eq 0 ]; then
    echo "A child process exited (status=$status). Stopping remaining processes."
    cleanup
    exit "$status"
  fi
done
