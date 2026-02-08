"""Auto-player for Escape Tsunami For Brainrots on Clawblox (silent - no chat)."""
import requests
import time
import json
import math
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

API_BASE = "https://clawblox.com/api/v1"
GAME_ID = os.getenv("CLAWBLOX_GAME_ID", "0a62727e-b45e-4175-be9f-1070244f8885")
API_KEY = "clawblox_a6d033121b3b4ac7bbc8ffd466fccb7f"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}


def dist(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2)


LOG_FILE = Path(__file__).parent / "gameplay.log"

def log(msg):
    t = time.strftime("%H:%M:%S")
    line = f"[{t}] {msg}"
    print(line)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")


def observe():
    r = requests.get(f"{API_BASE}/games/{GAME_ID}/observe", headers=HEADERS)
    return r.json()


def send_input(input_type, data=None):
    payload = {"type": input_type}
    if data:
        payload["data"] = data
    requests.post(f"{API_BASE}/games/{GAME_ID}/input", headers=HEADERS, json=payload)


last_chat_ts = ""
BOT_NAME = "BrainrotGrinder1770518509"  # filter out own messages


def poll_chat():
    """Poll chat messages and log messages from other players."""
    global last_chat_ts
    try:
        params = {"limit": 50}
        if last_chat_ts:
            params["after"] = last_chat_ts
        r = requests.get(
            f"{API_BASE}/games/{GAME_ID}/chat/messages",
            headers=HEADERS,
            params=params,
        )
        if r.status_code != 200:
            return
        messages = r.json()
        if not isinstance(messages, list):
            messages = messages.get("messages", [])
        for msg in messages:
            sender = msg.get("sender", msg.get("username", "???"))
            content = msg.get("content", msg.get("message", ""))
            ts = msg.get("timestamp", msg.get("created_at", ""))
            if sender != BOT_NAME and content:
                log(f"CHAT [{sender}]: {content}")
            if ts:
                last_chat_ts = ts
    except Exception:
        pass


def parse_state(obs):
    player = obs["player"]
    attrs = player["attributes"]
    entities = obs["world"]["entities"]

    gs = next(e for e in entities if e["name"] == "GameState")
    gs_attrs = gs["attributes"]

    brainrots = [
        e for e in entities
        if e["name"] == "Brainrot" and not e.get("attributes", {}).get("IsPlaced")
    ]

    waves = [e for e in entities if "Tsunami" in e["name"]]
    wave_x = waves[0]["position"][0] if waves else -999

    other_players = [
        e for e in entities
        if e["name"] == "OtherPlayer" or (e.get("type") == "player" and e.get("id") != player.get("id"))
    ]

    # Build brainrot lookup by id for event tracking
    brainrot_map = {}
    for b in brainrots:
        bid = b.get("id", id(b))
        brainrot_map[bid] = {
            "zone": b["attributes"]["Zone"],
            "value": b["attributes"]["Value"],
            "pos": b["position"],
        }

    return {
        "pos": player["position"],
        "money": attrs["Money"],
        "speed_level": int(attrs["SpeedLevel"]),
        "carried": int(attrs["CarriedCount"]),
        "carried_value": attrs["CarriedValue"],
        "passive_income": attrs["PassiveIncome"],
        "base": [attrs["BaseCenterX"], 0, attrs["BaseCenterZ"]],
        "next_speed_cost": attrs["NextSpeedCost"],
        "placed": attrs["PlacedBrainrots"],
        "base_max": int(attrs["BaseMaxBrainrots"]),
        "wave_remaining": gs_attrs["WaveTimeRemaining"],
        "active_waves": int(gs_attrs["ActiveWaveCount"]),
        "wave_x": wave_x,
        "wave_positions": [w["position"] for w in waves],
        "brainrots": brainrots,
        "brainrot_map": brainrot_map,
        "hp": player["health"],
        "other_players": {
            e.get("name", f"player_{i}"): e.get("position", [0, 0, 0])
            for i, e in enumerate(other_players)
        },
        "game_status": gs_attrs.get("GameStatus", ""),
    }


def zone_key(zone):
    return {
        "Common": 0, "Uncommon": 1, "Rare": 2,
        "Epic": 3, "Legendary": 4, "Secret": 5,
    }.get(zone, -1)


# ─── Commentator-friendly event tracking ─────────────────────────────────────

prev = {
    "hp": 100,
    "money": 0,
    "carried": 0,
    "pos": [0, 0, 0],
    "other_players": {},
    "brainrot_map": {},
    "game_status": "",
    "active_waves": 0,
    "target_id": None,
    "speed_level": 1,
}

# Narrative tracking
stats = {
    "streak": 0,           # consecutive successful collect+deposit trips
    "total_earned": 0,     # total money deposited this session
    "trips": 0,            # total trip attempts
    "deaths": 0,           # total deaths
    "last_money_milestone": 0,
    "rival_cooldown": {},  # player_name -> timestamp, avoid spamming
    "last_status_time": 0,
}

MONEY_MILESTONES = [1000, 5000, 10000, 25000, 50000, 100000]


def log_events(state):
    """Detect and log commentary-worthy game events."""
    global prev

    # --- Tsunami hit ---
    if state["hp"] < prev["hp"] and prev["hp"] > 0:
        dmg = prev["hp"] - state["hp"]
        log(f"TSUNAMI HIT! Took {dmg:.0f} damage, HP {prev['hp']:.0f} -> {state['hp']:.0f}")

    # --- Death / respawn ---
    if prev["hp"] > 0 and state["hp"] <= 0:
        stats["deaths"] += 1
        stats["streak"] = 0
        log(f"DIED! Death #{stats['deaths']} this session. Lost carried brainrot.")
    elif prev["hp"] <= 0 and state["hp"] > 0:
        log(f"RESPAWNED with {state['hp']:.0f} HP, back in the game")
    elif prev["hp"] > 0 and state["hp"] > 0:
        d_jump = dist(prev["pos"], state["pos"])
        d_to_base = dist(state["pos"], state["base"])
        if d_jump > 100 and d_to_base < 20:
            stats["deaths"] += 1
            stats["streak"] = 0
            log(f"DIED AND RESPAWNED! Warped {d_jump:.0f} studs back to base. Death #{stats['deaths']}")

    # --- Player joined / left ---
    cur_players = set(state["other_players"].keys())
    prev_players = set(prev["other_players"].keys())
    for p in cur_players - prev_players:
        log(f"PLAYER JOINED: {p} entered the game")
    for p in prev_players - cur_players:
        log(f"PLAYER LEFT: {p} disconnected")

    # --- Rival nearby (with cooldown to avoid spam) ---
    now = time.time()
    for p, pos in state["other_players"].items():
        d = dist(state["pos"], pos)
        if d < 50 and now > stats["rival_cooldown"].get(p, 0):
            log(f"RIVAL NEARBY: {p} is just {d:.0f} studs away, competition heating up")
            stats["rival_cooldown"][p] = now + 30  # 30s cooldown per player

    # --- Target stolen ---
    if prev["target_id"] and prev["target_id"] not in state["brainrot_map"]:
        old = prev["brainrot_map"].get(prev["target_id"])
        if old:
            log(f"TARGET STOLEN! Someone snatched the ${old['value']:.0f} {old['zone']} brainrot we were going for")

    # --- New brainrot spawns (batched summary) ---
    new_ids = set(state["brainrot_map"].keys()) - set(prev["brainrot_map"].keys())
    if new_ids:
        new_brainrots = [state["brainrot_map"][bid] for bid in new_ids]
        best = max(new_brainrots, key=lambda b: b["value"])
        zone_counts = {}
        for b in new_brainrots:
            zone_counts[b["zone"]] = zone_counts.get(b["zone"], 0) + 1
        summary = ", ".join(f"{c} {z}" for z, c in sorted(zone_counts.items(), key=lambda x: zone_key(x[0]), reverse=True))
        if len(new_ids) > 3:
            log(f"SPAWN WAVE: {len(new_ids)} new brainrots appeared ({summary}). Best: {best['zone']} ${best['value']:.0f}")
        elif any(zone_key(b["zone"]) >= 3 for b in new_brainrots):
            # Only log individual spawns if they're Epic+
            for b in new_brainrots:
                if zone_key(b["zone"]) >= 3:
                    log(f"HIGH-VALUE SPAWN: {b['zone']} ${b['value']:.0f} appeared on the map")

    # --- Tsunami near-miss ---
    for wpos in state.get("wave_positions", []):
        d_wave = abs(state["pos"][0] - wpos[0])
        if d_wave < 30 and state["hp"] >= prev["hp"]:
            log(f"CLOSE CALL! Tsunami passed just {d_wave:.0f} studs away, barely dodged it")

    # --- Money milestones ---
    for milestone in MONEY_MILESTONES:
        if state["money"] >= milestone and prev["money"] < milestone:
            log(f"MILESTONE: Just crossed ${milestone:,}!")

    # --- Game status change ---
    if state["game_status"] != prev["game_status"] and prev["game_status"]:
        log(f"GAME STATUS: {prev['game_status']} -> {state['game_status']}")

    # --- Speed level change ---
    if state["speed_level"] != prev["speed_level"]:
        speed_val = SPEED_TABLE.get(state["speed_level"], 16)
        log(f"SPEED UP! Now level {state['speed_level']} ({speed_val} studs/s)")

    # Update prev state
    prev["hp"] = state["hp"]
    prev["money"] = state["money"]
    prev["carried"] = state["carried"]
    prev["pos"] = state["pos"]
    prev["other_players"] = dict(state["other_players"])
    prev["brainrot_map"] = dict(state["brainrot_map"])
    prev["game_status"] = state["game_status"]
    prev["active_waves"] = state["active_waves"]
    prev["speed_level"] = state["speed_level"]


# ─── Game logic ───────────────────────────────────────────────────────────────

def pick_target(state):
    """Pick the best brainrot to go after given current conditions."""
    pos = state["pos"]
    base = state["base"]
    wave_x = state["wave_x"]
    speed = SPEED_TABLE.get(state["speed_level"], 16)
    wave_remaining = state["wave_remaining"]
    safety_margin = 5  # seconds buffer before tsunami hits

    # Bootstrap mode: when broke/slow, force short safe runs to get first deposits.
    bootstrap = state["money"] < max(100, state["next_speed_cost"])
    if bootstrap:
        close_candidates = sorted(
            state["brainrots"],
            key=lambda b: dist(pos, b["position"]),
        )
        nearest_safe = None
        nearest_wave_safe_any = None
        for b in close_candidates:
            bp = b["position"]
            dist_to_b = dist(pos, bp)
            dist_b_home = dist(bp, base)
            round_trip_time = (dist_to_b + dist_b_home) / max(speed, 1)

            # Never cross into wave danger.
            if state["active_waves"] > 0 and bp[0] < wave_x + 80:
                continue
            if nearest_wave_safe_any is None:
                nearest_wave_safe_any = b
            # Keep early game trips short and realistic at speed 1.
            if dist_to_b > 260:
                continue
            if nearest_safe is None:
                nearest_safe = b
            # Relaxed timing gate so we don't idle forever.
            if round_trip_time <= max(wave_remaining - 2, 8):
                return b
        # If nothing passed timing, still attempt the nearest safe pickup.
        if nearest_safe is not None:
            return nearest_safe
        if nearest_wave_safe_any is not None:
            return nearest_wave_safe_any

    best = None
    best_score = -1

    for b in state["brainrots"]:
        bp = b["position"]
        value = b["attributes"]["Value"]
        zone = b["attributes"]["Zone"]

        dist_to_b = dist(pos, bp)
        dist_b_home = dist(bp, base)
        round_trip_time = (dist_to_b + dist_b_home) / speed

        # skip if tsunami would catch us
        if state["active_waves"] > 0 and bp[0] < wave_x + 50:
            continue

        # reject targets whose full round-trip exceeds time before next wave
        if round_trip_time > wave_remaining - safety_margin:
            continue

        # value per second of round trip
        score = value / max(round_trip_time, 1)

        # bonus for higher rarity zones
        score *= 1 + zone_key(zone) * 0.3

        if score > best_score:
            best_score = score
            best = b

    return best


SPEED_TABLE = {1: 16, 2: 20, 3: 24, 4: 28, 5: 32, 6: 36, 7: 40, 8: 45, 9: 50, 10: 60}


def wait_until_near(target_pos, speed, label="target"):
    """Poll observe until we're within 8 studs of target or give up after timeout."""
    timeout = time.time() + 60
    while time.time() < timeout:
        time.sleep(1.5)
        try:
            s = parse_state(observe())
            d = dist(s["pos"], target_pos)
            if d < 8:
                return s
            if s["hp"] < 100:
                log(f"OUCH: took damage mid-run, HP={s['hp']:.0f}")
        except Exception:
            pass
    return None


def main():
    log("=== GAME START ===")

    try:
        r = requests.post(f"{API_BASE}/games/{GAME_ID}/join", headers=HEADERS)
        log(f"Joined game: {r.json().get('message', r.text)}")
    except Exception:
        pass

    trip_count = 0
    last_status_log = 0
    last_wait_reason = None  # track to avoid spamming wait logs

    while True:
        try:
            state = parse_state(observe())
        except Exception as e:
            log(f"Observe failed: {e}, retrying...")
            time.sleep(2)
            continue

        # Event logging and chat polling
        log_events(state)
        poll_chat()

        speed = SPEED_TABLE.get(state["speed_level"], 16)

        # Periodic status (every 30s, not every tick)
        now = time.time()
        if now - last_status_log >= 30:
            placed_data = state["placed"]
            try:
                placed_list = json.loads(placed_data) if isinstance(placed_data, str) else placed_data
                n_placed = len(placed_list) if isinstance(placed_list, list) else 0
            except Exception:
                n_placed = "?"
            log(f"STATUS: ${state['money']:.0f} cash | Speed {state['speed_level']} | "
                f"${state['passive_income']:.0f}/s passive | "
                f"Base {n_placed}/{state['base_max']} | "
                f"Session: {stats['trips']} trips, ${stats['total_earned']:.0f} earned, "
                f"{stats['deaths']} deaths, streak {stats['streak']}")
            last_status_log = now

        # PRIORITY 1: Buy speed upgrade if affordable
        if state["next_speed_cost"] > 0 and state["money"] >= state["next_speed_cost"]:
            log(f"BUYING UPGRADE: speed level {state['speed_level']+1} for ${state['next_speed_cost']:.0f}")
            send_input("BuySpeed")
            time.sleep(1)
            continue

        # PRIORITY 2: Pick a brainrot and do a full collect+deposit trip
        target = pick_target(state)
        if target is None:
            if state["active_waves"] > 0:
                reason = "sheltering"
            elif state["wave_remaining"] < 8:
                reason = "playing_safe"
            else:
                reason = "idle"
            # Only log when wait reason changes
            if reason != last_wait_reason:
                if reason == "sheltering":
                    log("SHELTERING: tsunami active, waiting it out at base")
                elif reason == "playing_safe":
                    log(f"PLAYING SAFE: wave in {state['wave_remaining']:.0f}s, staying at base")
                else:
                    log("IDLE: no good targets available, waiting for spawns")
                last_wait_reason = reason
            prev["target_id"] = None
            send_input("MoveTo", {"position": state["base"]})
            # React faster while bootstrapping from zero so we don't miss short windows.
            if state["money"] < max(100, state["next_speed_cost"]):
                time.sleep(2)
            else:
                time.sleep(5)
            continue

        last_wait_reason = None  # reset so next shelter gets logged

        tp = target["position"]
        zone = target["attributes"]["Zone"]
        value = target["attributes"]["Value"]
        d = dist(state["pos"], tp)
        trip_count += 1
        stats["trips"] = trip_count

        # Track target for stolen detection
        prev["target_id"] = target.get("id")

        # --- PHASE 1: Move to brainrot (with risk context) ---
        trip_time_est = d / speed
        risk = ""
        if state["wave_remaining"] < 15 and state["active_waves"] == 0:
            risk = f" RISKY: only {state['wave_remaining']:.0f}s before next wave!"
        elif zone_key(zone) >= 3:
            risk = f" HIGH VALUE TARGET!"

        log(f"TRIP #{trip_count}: going for {zone} brainrot (${value:.0f}), {d:.0f} studs away (~{trip_time_est:.0f}s travel).{risk}")
        send_input("MoveTo", {"position": [tp[0], 0, tp[2]]})

        arrived = wait_until_near(tp, speed, zone)
        if arrived is None:
            log(f"TIMEOUT: couldn't reach the {zone} brainrot, aborting trip")
            stats["streak"] = 0
            continue

        # --- PHASE 2: Collect ---
        send_input("Collect")
        time.sleep(0.5)

        state = parse_state(observe())
        if state["carried"] == 0:
            log(f"MISSED! The {zone} brainrot vanished before we could grab it")
            stats["streak"] = 0
            continue

        log(f"COLLECTED: grabbed {zone} brainrot worth ${state['carried_value']:.0f}")

        prev["target_id"] = None

        # --- PHASE 3: Return to base ---
        d_home = dist(state["pos"], state["base"])
        return_time = d_home / speed

        if state["active_waves"] > 0 or state["wave_remaining"] < return_time + 3:
            log(f"RACING HOME: {d_home:.0f} studs to base with ${state['carried_value']:.0f}, wave closing in!")
        else:
            log(f"HEADING BACK: {d_home:.0f} studs to base (~{return_time:.0f}s)")

        send_input("MoveTo", {"position": state["base"]})

        arrived = wait_until_near(state["base"], speed, "base")
        if arrived is None:
            log(f"TIMEOUT: couldn't make it back to base, trip failed")
            stats["streak"] = 0
            continue

        # --- PHASE 4: Deposit (with base-full handling) ---
        state = parse_state(observe())
        try:
            cur_placed = json.loads(state["placed"]) if isinstance(state["placed"], str) else state["placed"]
            if isinstance(cur_placed, list) and len(cur_placed) >= state["base_max"]:
                lowest = min(cur_placed, key=lambda b: b.get("Value", b.get("value", 0)))
                lowest_val = lowest.get("Value", lowest.get("value", 0))
                lowest_zone = lowest.get("Zone", lowest.get("zone", "?"))
                lowest_id = lowest.get("Id", lowest.get("id", ""))
                log(f"BASE FULL: replacing ${lowest_val:.0f} {lowest_zone} with ${state['carried_value']:.0f} {zone}")
                send_input("Destroy", {"brainrotId": lowest_id})
                time.sleep(0.5)
        except Exception as e:
            log(f"BASE CHECK ERROR: {e}")

        send_input("Deposit")
        time.sleep(0.5)

        state = parse_state(observe())
        stats["streak"] += 1
        stats["total_earned"] += value

        streak_note = ""
        if stats["streak"] >= 5:
            streak_note = f" {stats['streak']} in a row!"
        elif stats["streak"] >= 3:
            streak_note = f" Streak: {stats['streak']}!"

        log(f"DEPOSITED ${value:.0f} {zone}! Cash: ${state['money']:.0f}, passive: ${state['passive_income']:.0f}/s.{streak_note}")


if __name__ == "__main__":
    main()
