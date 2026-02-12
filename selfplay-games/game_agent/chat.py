#!/usr/bin/env python3
"""Interactive text chat with Claude, with optional audio feedback.

Reuses auth and audio from agent.py / audio.py.

Usage:
  uv run chat.py
  uv run chat.py --audio
  uv run chat.py --stt --audio
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

import anthropic
from anthropic import Anthropic
from dotenv import load_dotenv

from audio import AgentAudioStreamer, AudioConfig, MicSTTListener


SYSTEM_PROMPT = "You are a helpful assistant. Be concise."


def is_anthropic_setup_token(token: str) -> bool:
    return "sk-ant-oat" in token


def create_message_setup_token(
    token: str,
    model: str,
    system_prompt: str,
    messages: List[Dict[str, str]],
    max_tokens: int = 1024,
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
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": messages,
    }
    req = urllib.request.Request(
        url=url,
        method="POST",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode("utf-8")

    parsed = json.loads(raw)
    parts: List[str] = []
    for block in parsed.get("content", []):
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    return "\n".join(parts).strip()


def chat_turn(
    claude: Optional[Anthropic],
    anthropic_token: str,
    model: str,
    system_prompt: str,
    messages: List[Dict[str, str]],
) -> str:
    if is_anthropic_setup_token(anthropic_token):
        return create_message_setup_token(
            token=anthropic_token,
            model=model,
            system_prompt=system_prompt,
            messages=messages,
        )
    else:
        if claude is None:
            raise RuntimeError("Anthropic client is missing")
        resp = claude.messages.create(
            model=model,
            max_tokens=1024,
            system=system_prompt,
            messages=messages,
        )
        parts: List[str] = []
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                parts.append(getattr(block, "text", ""))
        return "\n".join(parts).strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Interactive chat with Claude.")
    parser.add_argument("--model", default="claude-opus-4-6", help="Anthropic model name")
    parser.add_argument("--system", default=SYSTEM_PROMPT, help="System prompt")
    parser.add_argument("--audio", action="store_true", help="Enable TTS audio feedback")
    parser.add_argument("--stt", action="store_true", help="Enable push-to-talk STT input")
    return parser.parse_args()


def run(args: argparse.Namespace) -> int:
    script_path = Path(__file__).resolve()
    repo_env = script_path.parents[2] / ".env"
    load_dotenv(repo_env)

    anthropic_token = (
        os.environ.get("ANTHROPIC_OAUTH_TOKEN")
        or os.environ.get("ANTHROPIC_API_KEY")
    )
    if not anthropic_token:
        print("Missing ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY", file=sys.stderr)
        return 2

    claude: Optional[Anthropic]
    if is_anthropic_setup_token(anthropic_token):
        claude = None
        print("Auth: setup-token (oauth)")
    else:
        claude = Anthropic(api_key=anthropic_token)
        print("Auth: api-key")

    audio_streamer: Optional[AgentAudioStreamer] = None
    if args.audio:
        try:
            audio_streamer = AgentAudioStreamer(AudioConfig.from_env())
            audio_streamer.start()
            print("Audio: enabled")
        except Exception as exc:
            print(f"Audio: disabled ({exc})", file=sys.stderr)

    stt_listener: Optional[MicSTTListener] = None
    if args.stt:
        el_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
        if not el_key:
            print("STT: disabled (missing ELEVENLABS_API_KEY)", file=sys.stderr)
        else:
            stt_listener = MicSTTListener(api_key=el_key)
            print("STT: enabled (press Enter to talk)")

    print(f"Model: {args.model}")
    if stt_listener:
        print("Press Enter to record, VAD auto-commits on silence. Ctrl+C or 'quit' to exit.\n")
    else:
        print("Type your message. Ctrl+C or 'quit' to exit.\n")

    messages: List[Dict[str, str]] = []

    try:
        while True:
            if stt_listener:
                try:
                    input("[Enter to speak] ")
                except EOFError:
                    break
                print("[Listening...]")
                try:
                    user_input = stt_listener.listen_once()
                except Exception as exc:
                    print(f"STT error: {exc}", file=sys.stderr)
                    continue
                if not user_input:
                    print("(nothing heard)")
                    continue
                print(f"You: {user_input}")
            else:
                try:
                    user_input = input("You: ").strip()
                except EOFError:
                    break

            if user_input.lower() in ("quit", "exit", "q"):
                break
            if not user_input:
                continue

            messages.append({"role": "user", "content": user_input})

            try:
                reply = chat_turn(
                    claude=claude,
                    anthropic_token=anthropic_token,
                    model=args.model,
                    system_prompt=args.system,
                    messages=messages,
                )
            except Exception as exc:
                print(f"Error: {exc}", file=sys.stderr)
                messages.pop()
                continue

            messages.append({"role": "assistant", "content": reply})
            print(f"\nClaude: {reply}\n")

            if audio_streamer:
                audio_streamer.enqueue_text(reply)

    except KeyboardInterrupt:
        print()
    finally:
        if audio_streamer:
            audio_streamer.close()

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run(parse_args()))
    except KeyboardInterrupt:
        raise SystemExit(130)
    except anthropic.AuthenticationError as exc:
        print(f"Auth error: {exc}", file=sys.stderr)
        raise SystemExit(1)
