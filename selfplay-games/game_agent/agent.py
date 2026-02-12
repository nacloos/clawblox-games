#!/usr/bin/env python3
"""Local Clawblox agent powered by Claude Opus 4.6.

Environment variables:
- ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY: required

Usage:
  uv run agent.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

import anthropic
from anthropic import Anthropic
from dotenv import load_dotenv

from audio import AgentAudioStreamer, AudioConfig


API_BASE = "http://localhost:8080"

BROWSER_LIKE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://clawblox.com/",
    "Origin": "https://clawblox.com",
}

SYSTEM_PROMPT = """
You are an expert real-time game bot controller.
You receive game observations and must output ONLY a JSON object.
No markdown, no prose.

On the first step you receive the full game state.
On subsequent steps you receive only what changed since the last observation.

IMPORTANT: The local /input endpoint requires this exact action schema:
{
  "type": "<ActionName>",
  "data": { ... }   // optional depending on action
}

Your full response must be:
{
  "action": {
    "type": "...",
    "data": { ... }
  },
  "reason": "<brief>"
}

For actions without parameters, either omit "data" or use "data": {}.
Never return an action object without "type".
""".strip()

CLAUDE_CODE_SYSTEM_PROMPT = """
You are Claude Code, Anthropic's official CLI for Claude.
""".strip()

SKILL_PROMPT_TEMPLATE = """
Game skill.md (read this first, then process the observation):

{skill_md}
""".strip()


def _rpos(pos: list) -> tuple:
    """Round position to 1 decimal to filter physics jitter."""
    return tuple(round(x, 1) for x in pos)


# Attributes that are camera/rendering internals — not useful for decision making
_IGNORED_ATTRIBUTES = frozenset({
    "ViewOriginX", "ViewOriginY", "ViewOriginZ",
    "ViewForwardX", "ViewForwardY", "ViewForwardZ",
    "ViewFovDeg",
    "RenderRole",
    "ModelUrl",
})

# Entity names that mirror player.position — skip to avoid duplicate diffs
_IGNORED_ENTITY_NAMES = frozenset({
    "HumanoidRootPart",
})


def _diff_attributes(
    prev_attrs: Dict[str, Any],
    curr_attrs: Dict[str, Any],
    label: str,
    changes: List[str],
) -> None:
    for key in sorted(set(prev_attrs) | set(curr_attrs)):
        if key in _IGNORED_ATTRIBUTES:
            continue
        pv = prev_attrs.get(key)
        cv = curr_attrs.get(key)
        if pv != cv:
            changes.append(f"{label} {key}: {pv} -> {cv}")


def _diff_player(
    prev: Dict[str, Any],
    curr: Dict[str, Any],
    label: str,
    changes: List[str],
) -> None:
    if not prev or not curr:
        return
    pp = _rpos(prev.get("position", [0, 0, 0]))
    cp = _rpos(curr.get("position", [0, 0, 0]))
    if pp != cp:
        changes.append(f"{label} position: {pp} -> {cp}")
    ph = prev.get("health")
    ch = curr.get("health")
    if ph is not None and ch is not None and round(ph, 1) != round(ch, 1):
        changes.append(f"{label} health: {ph} -> {ch}")
    _diff_attributes(
        prev.get("attributes", {}),
        curr.get("attributes", {}),
        label,
        changes,
    )


def _diff_entity(
    prev: Dict[str, Any],
    curr: Dict[str, Any],
    changes: List[str],
) -> None:
    name = curr.get("name", curr.get("id", "?"))
    pp = _rpos(prev.get("position", [0, 0, 0]))
    cp = _rpos(curr.get("position", [0, 0, 0]))
    if pp != cp:
        changes.append(f"{name} position: {pp} -> {cp}")
    prev_size = prev.get("size")
    curr_size = curr.get("size")
    if prev_size and curr_size and _rpos(prev_size) != _rpos(curr_size):
        changes.append(f"{name} size: {_rpos(prev_size)} -> {_rpos(curr_size)}")
    _diff_attributes(
        prev.get("attributes", {}),
        curr.get("attributes", {}),
        name,
        changes,
    )


def clean_observation(obs: Dict[str, Any]) -> Dict[str, Any]:
    """Strip noisy/internal fields from a full observation before sending to LLM."""
    import copy
    out = copy.deepcopy(obs)
    # Strip ignored attributes from player
    player = out.get("player", {})
    attrs = player.get("attributes", {})
    for key in list(attrs):
        if key in _IGNORED_ATTRIBUTES:
            del attrs[key]
    # Strip ignored attributes from other players
    for p in out.get("other_players", []):
        pa = p.get("attributes", {})
        for key in list(pa):
            if key in _IGNORED_ATTRIBUTES:
                del pa[key]
    # Strip ignored entities and ignored attributes from remaining entities
    entities = out.get("world", {}).get("entities", [])
    filtered = []
    for e in entities:
        if e.get("name") in _IGNORED_ENTITY_NAMES:
            continue
        ea = e.get("attributes", {})
        for key in list(ea):
            if key in _IGNORED_ATTRIBUTES:
                del ea[key]
        filtered.append(e)
    if "world" in out:
        out["world"]["entities"] = filtered
    # Strip tick (internal counter, not useful)
    out.pop("tick", None)
    return out


def diff_observations(prev: Dict[str, Any], curr: Dict[str, Any]) -> str:
    """Compute human-readable diff between two /observe snapshots."""
    changes: List[str] = []

    # Game status
    if prev.get("game_status") != curr.get("game_status"):
        changes.append(
            f"Game status: {prev.get('game_status')} -> {curr.get('game_status')}"
        )

    # Player
    _diff_player(prev.get("player", {}), curr.get("player", {}), "You", changes)

    # Other players (keyed by id)
    prev_others = {p["id"]: p for p in prev.get("other_players", [])}
    curr_others = {p["id"]: p for p in curr.get("other_players", [])}

    for pid in sorted(set(prev_others) - set(curr_others)):
        changes.append(f"Player {pid} left")
    for pid in sorted(set(curr_others) - set(prev_others)):
        p = curr_others[pid]
        pos = _rpos(p.get("position", [0, 0, 0]))
        changes.append(f"Player {pid} appeared at {pos}")
    for pid in sorted(set(prev_others) & set(curr_others)):
        _diff_player(prev_others[pid], curr_others[pid], f"Player {pid}", changes)

    # Entities
    prev_ents = {e["id"]: e for e in prev.get("world", {}).get("entities", [])}
    curr_ents = {e["id"]: e for e in curr.get("world", {}).get("entities", [])}

    for eid in sorted(set(prev_ents) - set(curr_ents), key=str):
        e = prev_ents[eid]
        if e.get("name") in _IGNORED_ENTITY_NAMES:
            continue
        changes.append(f"{e.get('name', eid)} removed")
    for eid in sorted(set(curr_ents) - set(prev_ents), key=str):
        e = curr_ents[eid]
        if e.get("name") in _IGNORED_ENTITY_NAMES:
            continue
        pos = _rpos(e.get("position", [0, 0, 0]))
        changes.append(f"{e.get('name', eid)} appeared at {pos}")
    for eid in sorted(set(prev_ents) & set(curr_ents), key=str):
        if curr_ents[eid].get("name") in _IGNORED_ENTITY_NAMES:
            continue
        _diff_entity(prev_ents[eid], curr_ents[eid], changes)

    # Events (ephemeral — forward all new ones)
    for event in curr.get("events", []):
        changes.append(f"Event: {event}")

    if not changes:
        return "No changes."
    return "State changes:\n" + "\n".join(f"- {c}" for c in changes)


class ClawbloxAPIError(RuntimeError):
    pass


class ClawbloxClient:
    def __init__(self, api_base: str = API_BASE, join_name: str = "ClaudeOpusBot"):
        self.api_base = api_base.rstrip("/")
        self.join_name = join_name
        self.session_token: Optional[str] = None

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = f"{self.api_base}{path}"
        data = None
        headers = dict(BROWSER_LIKE_HEADERS)
        headers["Content-Type"] = "application/json"
        if self.session_token:
            headers["X-Session"] = self.session_token

        if body is not None:
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url=url, method=method, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            raise ClawbloxAPIError(f"HTTP {e.code} {method} {path}: {err_body}") from e
        except urllib.error.URLError as e:
            raise ClawbloxAPIError(f"Network error {method} {path}: {e}") from e

        if not raw.strip():
            return {}

        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise ClawbloxAPIError(f"Invalid JSON from {method} {path}: {raw[:300]}") from e

    def get_skill_md(self) -> str:
        url = f"{self.api_base}/skill.md"
        req = urllib.request.Request(url=url, method="GET", headers=dict(BROWSER_LIKE_HEADERS))
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            raise ClawbloxAPIError(f"HTTP {e.code} GET /skill.md: {err_body}") from e

    def join(self) -> Dict[str, Any]:
        payload = self._request(
            "POST",
            f"/join?name={urllib.parse.quote(self.join_name)}",
            body=None,
        )
        token = payload.get("session")
        if not isinstance(token, str) or not token:
            raise ClawbloxAPIError(f"Join response missing session token: {payload}")
        self.session_token = token
        return payload

    def observe(self) -> Dict[str, Any]:
        if not self.session_token:
            raise ClawbloxAPIError("Missing session token; call join first")
        return self._request("GET", "/observe")

    def act(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.session_token:
            raise ClawbloxAPIError("Missing session token; call join first")
        return self._request("POST", "/input", body=payload)


def append_conversation_log(log_path: Path, section: str, content: str) -> None:
    with log_path.open("a", encoding="utf-8") as f:
        f.write(f"\n[{dt.datetime.now(dt.timezone.utc).isoformat()}] {section}\n")
        f.write(content.rstrip() + "\n")
        f.flush()


def get_text_from_anthropic_message(message: Any) -> str:
    parts: List[str] = []
    for block in getattr(message, "content", []):
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", ""))
    return "\n".join(parts).strip()


def extract_json_object(text: str) -> Dict[str, Any]:
    text = text.strip()

    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()

    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        obj = json.loads(match.group(0))
        if isinstance(obj, dict):
            return obj

    raise ValueError(f"Could not parse JSON object from Claude response: {text[:400]}")


def is_anthropic_setup_token(token: str) -> bool:
    return "sk-ant-oat" in token


def create_message_with_setup_token(
    token: str,
    model: str,
    system_prompt: str,
    skill_md: str,
    user_payload: Dict[str, Any],
) -> str:
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-beta": (
            "claude-code-20250219,"
            "oauth-2025-04-20,"
            "fine-grained-tool-streaming-2025-05-14,"
            "interleaved-thinking-2025-05-14"
        ),
        "user-agent": "claude-cli/1.0.56 (external, cli)",
        "x-app": "cli",
    }
    body = {
        "model": model,
        "max_tokens": 600,
        "system": [
            {"type": "text", "text": CLAUDE_CODE_SYSTEM_PROMPT},
            {"type": "text", "text": system_prompt},
        ],
        "messages": [
            {"role": "user", "content": SKILL_PROMPT_TEMPLATE.format(skill_md=skill_md)},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=True)},
        ],
    }
    req = urllib.request.Request(
        url=url,
        method="POST",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Anthropic HTTP {e.code}: {err_body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Anthropic network error: {e}") from e

    parsed = json.loads(raw)
    parts: List[str] = []
    for block in parsed.get("content", []):
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    text = "\n".join(parts).strip()
    if not text:
        raise RuntimeError(f"Anthropic setup-token response missing text content: {raw[:500]}")
    return text


def decide_action(
    claude: Optional[Anthropic],
    anthropic_token: str,
    model: str,
    system_prompt: str,
    skill_md: str,
    user_payload: Dict[str, Any],
) -> tuple[Dict[str, Any], str, Optional[str]]:
    if is_anthropic_setup_token(anthropic_token):
        text = create_message_with_setup_token(
            token=anthropic_token,
            model=model,
            system_prompt=system_prompt,
            skill_md=skill_md,
            user_payload=user_payload,
        )
    else:
        if claude is None:
            raise RuntimeError("Anthropic API-key mode selected but client is missing")
        message = claude.messages.create(
            model=model,
            max_tokens=600,
            system=system_prompt,
            messages=[
                {"role": "user", "content": SKILL_PROMPT_TEMPLATE.format(skill_md=skill_md)},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=True)},
            ],
        )
        text = get_text_from_anthropic_message(message)

    parsed = extract_json_object(text)
    action = parsed.get("action") if isinstance(parsed, dict) else None
    if not isinstance(action, dict):
        if isinstance(parsed, dict):
            action = parsed
        else:
            raise ValueError(f"Claude returned invalid action payload: {parsed}")

    if "type" not in action:
        raise ValueError(f"Action is missing required field 'type': {action}")

    reason = parsed.get("reason") if isinstance(parsed, dict) else None
    if not isinstance(reason, str):
        reason = None

    return action, text, reason


def review_observation_before_llm(step: int, log_path: Path) -> None:
    print(f"\n=== Breakpoint before LLM call (step {step}) ===")
    print(f"Conversation log: {log_path}")
    prompt = textwrap.dedent(
        """\
        Press Enter to call Claude.
        Type 'q' then Enter to stop the run.
        """
    )
    answer = input(prompt).strip().lower()
    if answer == "q":
        raise KeyboardInterrupt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Play local Clawblox runtime game with Claude Opus 4.6.")
    parser.add_argument("--api-base", default=API_BASE, help=f"Local runtime base URL (default: {API_BASE})")
    parser.add_argument("--name", default="ClaudeOpusBot", help="Local runtime join name")
    parser.add_argument("--model", default="claude-opus-4-6", help="Anthropic model name")
    parser.add_argument("--max-steps", type=int, default=300, help="Maximum observe/act iterations")
    parser.add_argument("--sleep", type=float, default=0.25, help="Seconds between actions")
    parser.add_argument("--verbose", action="store_true", help="Print extra runtime diagnostics")
    parser.add_argument("--audio", action="store_true", help="Enable streamed TTS playback for model reasons")
    parser.add_argument(
        "--no-breakpoint-before-llm",
        action="store_false",
        dest="breakpoint_before_llm",
        help="Disable the review pause before each Claude call",
    )
    parser.add_argument(
        "--conversation-log",
        default="conversation.log",
        help="Path to conversation log file (overwritten on each run)",
    )
    parser.set_defaults(breakpoint_before_llm=True)
    return parser.parse_args()


def run(args: argparse.Namespace) -> int:
    script_path = Path(__file__).resolve()
    repo_env = script_path.parents[2] / ".env"
    load_dotenv(repo_env)
    
    anthropic_token = (
        Path.home().joinpath(".claude", ".credentials.json").read_text(encoding="utf-8")
        if False
        else None
    )
    _ = anthropic_token
    anthropic_token = (
        __import__("os").environ.get("ANTHROPIC_OAUTH_TOKEN")
        or __import__("os").environ.get("ANTHROPIC_API_KEY")
    )
    if not anthropic_token:
        print("Missing ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY", file=sys.stderr)
        return 2

    api = ClawbloxClient(api_base=args.api_base, join_name=args.name)
    audio_streamer: Optional[AgentAudioStreamer] = None

    claude: Optional[Anthropic]
    auth_mode: str
    if is_anthropic_setup_token(anthropic_token):
        claude = None
        auth_mode = "setup-token (oauth)"
    else:
        claude = Anthropic(api_key=anthropic_token)
        auth_mode = "api-key"

    log_path = Path(args.conversation_log).expanduser().resolve()
    log_path.write_text("", encoding="utf-8")

    web_base = api.api_base.rstrip("/")
    print("Selected game: local runtime")
    print(f"Live URL: {web_base}/")
    print(f"Browse URL: {web_base}/browse")
    print(f"Anthropic auth mode: {auth_mode}")

    if args.audio:
        try:
            audio_streamer = AgentAudioStreamer(AudioConfig.from_env())
            audio_streamer.start()
            print("Audio: enabled")
        except Exception as exc:
            print(f"Audio: disabled ({exc})", file=sys.stderr)

    skill_md = api.get_skill_md()
    if not skill_md.strip():
        raise ClawbloxAPIError("No skill.md found: empty response from /skill.md")
    if skill_md.lstrip().lower().startswith("<!doctype html") or "<html" in skill_md[:300].lower():
        raise ClawbloxAPIError("No valid skill.md found: received HTML from /skill.md")

    append_conversation_log(log_path, "RUN_START", f"game=local model={args.model}")
    append_conversation_log(log_path, "ANTHROPIC_AUTH_MODE", auth_mode)
    append_conversation_log(log_path, "SKILL_SOURCE", f"api:{api.api_base}/skill.md")
    append_conversation_log(log_path, "SKILL_MD", skill_md)
    append_conversation_log(log_path, "SYSTEM_PROMPT", SYSTEM_PROMPT)

    api.join()
    print("Joined game")

    previous_action_error: Optional[str] = None
    previous_obs: Optional[Dict[str, Any]] = None
    try:
        for step in range(args.max_steps):
            obs = api.observe()
            status = str(obs.get("game_status", "")).lower()

            if args.verbose:
                print(f"step={step} status={status}")

            if status and status not in {"active", "running", "in_progress"}:
                print(f"Game ended with status: {status}")
                append_conversation_log(log_path, "GAME_STATUS", status)
                break

            if previous_obs is None:
                user_payload = {
                    "observation": clean_observation(obs),
                    "last_action_error": previous_action_error,
                    "instruction": "Return only the JSON object now.",
                }
            else:
                diff = diff_observations(previous_obs, obs)
                user_payload = {
                    "state_changes": diff,
                    "last_action_error": previous_action_error,
                    "instruction": "Return only the JSON object now.",
                }
            previous_obs = obs
            append_conversation_log(
                log_path,
                f"STEP_{step}_USER_OBSERVATION",
                json.dumps(user_payload, indent=2, ensure_ascii=True),
            )

            if args.breakpoint_before_llm:
                review_observation_before_llm(step, log_path)

            action_body, raw_text, reason = decide_action(
                claude=claude,
                anthropic_token=anthropic_token,
                model=args.model,
                system_prompt=SYSTEM_PROMPT,
                skill_md=skill_md,
                user_payload=user_payload,
            )

            print(f"\n[step {step}] Model response:")
            print(raw_text)
            print(f"[step {step}] Extracted action:")
            print(json.dumps(action_body, indent=2, ensure_ascii=True))

            append_conversation_log(log_path, f"STEP_{step}_ASSISTANT_RAW", raw_text)
            append_conversation_log(
                log_path,
                f"STEP_{step}_ASSISTANT_ACTION",
                json.dumps(action_body, indent=2, ensure_ascii=True),
            )
            if reason:
                append_conversation_log(log_path, f"STEP_{step}_ASSISTANT_REASON", reason)
                if audio_streamer:
                    audio_streamer.enqueue_text(reason)

            try:
                act_result = api.act(action_body)
                previous_action_error = None
                append_conversation_log(
                    log_path,
                    f"STEP_{step}_ACT_RESULT",
                    json.dumps(act_result, indent=2, ensure_ascii=True),
                )
            except Exception as e:
                previous_action_error = str(e)
                append_conversation_log(log_path, f"STEP_{step}_ACT_ERROR", previous_action_error)
                print(f"act_error={previous_action_error}", file=sys.stderr)

            time.sleep(args.sleep)
    finally:
        if audio_streamer:
            audio_streamer.close()

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run(parse_args()))
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        raise SystemExit(130)
    except anthropic.AuthenticationError as exc:
        print(
            "Fatal error: Anthropic authentication failed. "
            "If you use `claude setup-token`, set it in ANTHROPIC_OAUTH_TOKEN "
            "(or ANTHROPIC_API_KEY) and ensure it is still valid.",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:
        print(f"Fatal error: {exc}", file=sys.stderr)
        raise SystemExit(1)
