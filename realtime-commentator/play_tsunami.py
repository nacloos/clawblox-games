"""Auto-player for Escape Tsunami For Brainrots on Clawblox."""
import requests
import time
import json
import math
import random
import os
import threading
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs

load_dotenv()

elevenlabs_client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))
AUDIO_DIR = Path(__file__).parent / "audio"
AUDIO_DIR.mkdir(exist_ok=True)

API_BASE = "https://clawblox.com/api/v1"
GAME_ID = "0a62727e-b45e-4175-be9f-1070244f8885"
API_KEY = "clawblox_1e3c443522924896bb57507324a2d330"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

CHAT_LINES = {
    "collect_common": [
        "a humble $10 brainrot... we all start somewhere",
        "common brainrot secured, grinding the honest way",
        "not glamorous but it pays the bills",
    ],
    "collect_uncommon": [
        "uncommon brainrot in the bag, moving up",
        "$30 never felt so good",
        "mid-tier loot acquired",
    ],
    "collect_rare": [
        "rare brainrot spotted and snatched",
        "purple glow means purple rain baby",
        "$80 heist complete",
    ],
    "collect_epic": [
        "EPIC brainrot secured, huang would be proud",
        "that epic glow is calling my name",
        "$850 in one grab, this is the way",
    ],
    "collect_legendary": [
        "LEGENDARY GRAB, im built different",
        "that brainrot was worth more than my rent",
        "legendary haul, the grind never stops",
    ],
    "collect_secret": [
        "SECRET ZONE HEIST COMPLETE, i am the danger",
        "deepest zone, biggest reward, no fear",
        "secret brainrot acquired, i am inevitable",
    ],
    "deposit": [
        "deposited, passive income go brrr",
        "money printer activated",
        "another one on the base, stacking up",
        "cha-ching, that deposit hits different",
    ],
    "speed_up": [
        "speed upgrade unlocked, i am speed",
        "faster than the tsunami now... maybe",
        "new speed who dis",
        "zoom zoom, catch me if you can wave",
    ],
    "fleeing": [
        "TSUNAMI INCOMING, time to leave",
        "wave check... NOPE, im out",
        "not today tsunami, not today",
        "strategic retreat in progress",
    ],
    "idle": [
        "just vibing at base waiting for the wave to pass",
        "patience is a virtue, especially with tsunamis",
        "base life is the safe life",
    ],
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
BOT_NAME = "BrainrotGrinder"  # our bot's name to filter out own messages


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
                log(f"  [{sender}]: {content}")
            if ts:
                last_chat_ts = ts
    except Exception:
        pass


def chat(category):
    msg = random.choice(CHAT_LINES[category])
    def _send():
        try:
            # Generate TTS
            audio = elevenlabs_client.text_to_speech.convert(
                text=msg,
                voice_id="oubi7HGxNVjXMnWLgwBT",
                model_id="eleven_multilingual_v2",
                output_format="mp3_44100_128",
            )
            audio_bytes = b"".join(audio)
            # Save locally for debugging
            filename = time.strftime("%H_%M_%S") + ".mp3"
            (AUDIO_DIR / filename).write_bytes(audio_bytes)
            # Upload via multipart to /chat/voice
            r = requests.post(
                f"{API_BASE}/games/{GAME_ID}/chat/voice",
                headers={"Authorization": f"Bearer {API_KEY}"},
                files={"audio": (filename, audio_bytes, "audio/mpeg")},
                data={"content": msg},
            )
            log(f'  VOICE: "{msg}" -> {r.status_code}')
        except Exception as e:
            # Fallback: send text-only if TTS fails
            try:
                requests.post(
                    f"{API_BASE}/games/{GAME_ID}/chat",
                    headers=HEADERS,
                    json={"content": msg},
                )
                log(f'  CHAT (text fallback): "{msg}" ({e})')
            except Exception:
                pass
    threading.Thread(target=_send, daemon=True).start()


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


# Previous state for event detection
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
}


def log_events(state):
    """Detect and log all game events by comparing to previous state."""
    global prev

    # --- Tsunami hit ---
    if state["hp"] < prev["hp"] and prev["hp"] > 0:
        log(f"  TSUNAMI HIT! HP {prev['hp']:.0f} -> {state['hp']:.0f}")

    # --- Death / respawn ---
    if prev["hp"] > 0 and state["hp"] <= 0:
        log(f"  DEAD! Respawned at base, lost carried brainrot")
    elif prev["hp"] <= 0 and state["hp"] > 0:
        log(f"  RESPAWNED: HP restored to {state['hp']:.0f}")
    elif prev["hp"] > 0 and state["hp"] > 0:
        # Detect position jump to base (respawn without seeing 0 HP)
        d_jump = dist(prev["pos"], state["pos"])
        d_to_base = dist(state["pos"], state["base"])
        if d_jump > 100 and d_to_base < 20:
            log(f"  RESPAWNED: warped {d_jump:.0f} studs back to base")

    # --- Player joined / left ---
    cur_players = set(state["other_players"].keys())
    prev_players = set(prev["other_players"].keys())
    for p in cur_players - prev_players:
        pos = state["other_players"][p]
        log(f"  PLAYER JOINED: {p} at [{pos[0]:.0f}, {pos[1]:.0f}, {pos[2]:.0f}]")
    for p in prev_players - cur_players:
        log(f"  PLAYER LEFT: {p}")

    # --- Rival nearby ---
    for p, pos in state["other_players"].items():
        d = dist(state["pos"], pos)
        if d < 50:
            log(f"  RIVAL NEARBY: {p} is {d:.0f} studs away")

    # --- Target stolen ---
    if prev["target_id"] and prev["target_id"] not in state["brainrot_map"]:
        old = prev["brainrot_map"].get(prev["target_id"])
        if old:
            log(f"  TARGET STOLEN! Someone grabbed our ${old['value']:.0f} {old['zone']}")

    # --- New brainrot spawned ---
    new_ids = set(state["brainrot_map"].keys()) - set(prev["brainrot_map"].keys())
    for bid in new_ids:
        b = state["brainrot_map"][bid]
        log(f"  NEW SPAWN: {b['zone']} ${b['value']:.0f} at [{b['pos'][0]:.0f}, {b['pos'][2]:.0f}]")

    # --- Tsunami near-miss ---
    for wpos in state.get("wave_positions", []):
        d_wave = abs(state["pos"][0] - wpos[0])
        if d_wave < 30 and state["hp"] >= prev["hp"]:
            log(f"  CLOSE CALL! Wave passed {d_wave:.0f} studs away")

    # --- Income tick (money increased but not from deposit) ---
    money_diff = state["money"] - prev["money"]
    if money_diff > 0 and state["carried"] >= prev["carried"]:
        # Money went up without depositing — passive income
        log(f"  PASSIVE: earned ${money_diff:.0f} since last check")

    # --- Game status change ---
    if state["game_status"] != prev["game_status"] and prev["game_status"]:
        log(f"  GAME STATUS: {prev['game_status']} -> {state['game_status']}")

    # Update prev state
    prev["hp"] = state["hp"]
    prev["money"] = state["money"]
    prev["carried"] = state["carried"]
    prev["pos"] = state["pos"]
    prev["other_players"] = dict(state["other_players"])
    prev["brainrot_map"] = dict(state["brainrot_map"])
    prev["game_status"] = state["game_status"]
    prev["active_waves"] = state["active_waves"]


def zone_key(zone):
    return {
        "Common": 0, "Uncommon": 1, "Rare": 2,
        "Epic": 3, "Legendary": 4, "Secret": 5,
    }.get(zone, -1)


def pick_target(state):
    """Pick the best brainrot to go after given current conditions."""
    pos = state["pos"]
    base = state["base"]
    wave_x = state["wave_x"]
    speed = SPEED_TABLE.get(state["speed_level"], 16)
    wave_remaining = state["wave_remaining"]
    safety_margin = 5  # seconds buffer before tsunami hits

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
            # if we got hit by tsunami and respawned
            if s["hp"] < 100:
                log(f"  OUCH: took damage, HP={s['hp']}")
        except Exception:
            pass
    return None


def main():
    log("=== ESCAPE TSUNAMI FOR BRAINROTS ===")
    log("Joining game and starting the grind...")

    try:
        r = requests.post(f"{API_BASE}/games/{GAME_ID}/join", headers=HEADERS)
        log(f"Join: {r.text}")
    except Exception:
        pass

    chat_cooldown = 0
    trip_count = 0

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
        can_chat = time.time() > chat_cooldown

        # Status report
        placed_data = state["placed"]
        try:
            placed_list = json.loads(placed_data) if isinstance(placed_data, str) else placed_data
            n_placed = len(placed_list) if isinstance(placed_list, list) else 0
        except Exception:
            placed_list = []
            n_placed = "?"
        log(f"--- STATUS: ${state['money']:.0f} | Speed {state['speed_level']} ({speed} studs/s) | "
            f"Income ${state['passive_income']:.0f}/s | "
            f"Base {n_placed}/{state['base_max']} | HP {state['hp']} | "
            f"Wave in {state['wave_remaining']:.0f}s ---")

        # PRIORITY 1: Buy speed upgrade if affordable
        if state["next_speed_cost"] > 0 and state["money"] >= state["next_speed_cost"]:
            log(f"  UPGRADE: buying speed level {state['speed_level']+1} for ${state['next_speed_cost']:.0f}")
            send_input("BuySpeed")
            if can_chat:
                chat("speed_up")
                chat_cooldown = time.time() + 5
            time.sleep(1)
            continue

        # PRIORITY 2: Pick a brainrot and do a full collect+deposit trip
        target = pick_target(state)
        if target is None:
            log("  WAIT: no safe targets, chilling at base")
            prev["target_id"] = None
            if can_chat:
                chat("idle")
                chat_cooldown = time.time() + 8
            send_input("MoveTo", {"position": state["base"]})
            time.sleep(5)
            continue

        tp = target["position"]
        zone = target["attributes"]["Zone"]
        value = target["attributes"]["Value"]
        d = dist(state["pos"], tp)
        trip_count += 1

        # Track target for stolen detection
        prev["target_id"] = target.get("id")

        # --- PHASE 1: Move to brainrot ---
        log(f"  TRIP #{trip_count}: hunting {zone} brainrot (${value:.0f}) at [{tp[0]:.0f}, {tp[2]:.0f}] ({d:.0f} studs)")
        send_input("MoveTo", {"position": [tp[0], 0, tp[2]]})

        if can_chat:
            chat(f"collect_{zone.lower()}")
            chat_cooldown = time.time() + 8

        arrived = wait_until_near(tp, speed, zone)
        if arrived is None:
            log(f"  TIMEOUT: never reached {zone} brainrot, retrying...")
            continue

        # --- PHASE 2: Collect ---
        log(f"  COLLECT: grabbing {zone} brainrot worth ${value:.0f}")
        send_input("Collect")
        time.sleep(0.5)

        # Verify we picked it up
        state = parse_state(observe())
        if state["carried"] == 0:
            log(f"  MISS: brainrot vanished or out of range, moving on")
            continue

        log(f"  GOT IT: carrying ${state['carried_value']:.0f}")
        prev["target_id"] = None

        # --- PHASE 3: Return to base ---
        d_home = dist(state["pos"], state["base"])
        log(f"  RETURN: sprinting {d_home:.0f} studs back to base")
        send_input("MoveTo", {"position": state["base"]})

        if state["active_waves"] > 0 and can_chat:
            chat("fleeing")
            chat_cooldown = time.time() + 8

        arrived = wait_until_near(state["base"], speed, "base")
        if arrived is None:
            log(f"  TIMEOUT: couldn't reach base, retrying...")
            continue

        # --- PHASE 4: Deposit (with base-full handling) ---
        # Check if base is full and auto-destroy lowest value brainrot
        state = parse_state(observe())
        try:
            cur_placed = json.loads(state["placed"]) if isinstance(state["placed"], str) else state["placed"]
            if isinstance(cur_placed, list) and len(cur_placed) >= state["base_max"]:
                # Find lowest-value placed brainrot
                lowest = min(cur_placed, key=lambda b: b.get("Value", b.get("value", 0)))
                lowest_val = lowest.get("Value", lowest.get("value", 0))
                lowest_zone = lowest.get("Zone", lowest.get("zone", "?"))
                lowest_id = lowest.get("Id", lowest.get("id", ""))
                log(f"  BASE FULL! Destroying lowest value brainrot: ${lowest_val:.0f} {lowest_zone}")
                log(f"  REPLACING: destroyed ${lowest_val:.0f} {lowest_zone} to make room for ${state['carried_value']:.0f} {zone}")
                send_input("Destroy", {"brainrotId": lowest_id})
                time.sleep(0.5)
        except Exception as e:
            log(f"  BASE CHECK: could not parse placed brainrots: {e}")

        log(f"  DEPOSIT: cashing in ${state['carried_value']:.0f}")
        send_input("Deposit")
        time.sleep(0.5)

        state = parse_state(observe())
        if can_chat:
            chat("deposit")
            chat_cooldown = time.time() + 8
        log(f"  BANKED: now at ${state['money']:.0f} with ${state['passive_income']:.0f}/s passive")


if __name__ == "__main__":
    main()
