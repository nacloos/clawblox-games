#!/usr/bin/env bash
# (Re)start the clawblox server and launch agents for Tribal Council.
# Usage: ./run.sh [--no-audio]

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
WORLD="$DIR/templates/world"
AGENT_SRC_DIR="$DIR/../agent"
AGENT_ENTRY="$AGENT_SRC_DIR/dist/main.js"
LOGS="$DIR/logs"
PID_FILE="$DIR/.run.pid"
AGENTS_DIR="$DIR/templates/agents"
SERVER_LOG="$LOGS/server.log"
AUDIO_TIMING_LOG="$WORLD/.clawblox.log"
CLAWBLOX_BIN="${CLAWBLOX_BIN:-$HOME/.local/bin/clawblox}"
WORLD_BASE_URL="${WORLD_BASE_URL:-http://localhost:8080}"
SERVER_READY_TIMEOUT_S="${SERVER_READY_TIMEOUT_S:-300}"

mkdir -p "$LOGS"

if [ ! -x "$CLAWBLOX_BIN" ]; then
  echo "Missing clawblox binary: $CLAWBLOX_BIN"
  echo "Set CLAWBLOX_BIN=/path/to/clawblox or install to ~/.local/bin/clawblox"
  exit 1
fi

if [ ! -d "$AGENT_SRC_DIR" ]; then
  echo "Missing agent directory: $AGENT_SRC_DIR"
  exit 1
fi

echo "Building modular agent runtime..."
(
  cd "$AGENT_SRC_DIR"
  npm run build >/dev/null
)

if [ ! -f "$AGENT_ENTRY" ]; then
  echo "Missing built agent entry: $AGENT_ENTRY"
  exit 1
fi

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
: > "$SERVER_LOG"
: > "$AUDIO_TIMING_LOG"
printf "[%s] [run.sh] starting clawblox run path=%s\n" "$(date +%s%3N)" "$WORLD" >> "$AUDIO_TIMING_LOG"
echo "Starting clawblox server... (log: $SERVER_LOG)"
echo "Audio timing log: $AUDIO_TIMING_LOG"
echo "Using clawblox binary: $CLAWBLOX_BIN"
"$CLAWBLOX_BIN" run "$WORLD" >> "$SERVER_LOG" 2>&1 &
PIDS+=("$!")

echo "Waiting for server readiness at $WORLD_BASE_URL/spectate ..."
ready=0
max_checks=$((SERVER_READY_TIMEOUT_S * 4))
for _ in $(seq 1 "$max_checks"); do
  if ! is_alive "${PIDS[0]}"; then
    echo "Server process exited before readiness. Check $SERVER_LOG"
    exit 1
  fi
  if curl -fsS "$WORLD_BASE_URL/spectate" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  echo "Server did not become ready within ${SERVER_READY_TIMEOUT_S}s. Check $SERVER_LOG"
  exit 1
fi
echo "Server is ready."

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
  node "$AGENT_ENTRY" --name "$name" --dir "$DIR" --no-action "${AGENT_EXTRA_ARGS[@]}" >> "$LOGS/$name.log" 2>&1 &
  PIDS+=("$!")
done
sleep 3

# Save PIDs for restart
printf "%s\n" "${PIDS[@]}" > "$PID_FILE"

echo ""
echo "Server + ${#AGENTS[@]} agents running. Open http://localhost:8080"
echo "Audio timing lines: rg \"\\[audio\\] (estimate|complete)\" \"$AUDIO_TIMING_LOG\""
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
