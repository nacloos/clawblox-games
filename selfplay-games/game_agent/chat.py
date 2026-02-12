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
import select
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
_TTS_PUNCT = (".", "!", "?", "\n", ":", ";")
_TTS_MIN_SENTENCE_CHARS = 24
_TTS_MAX_BUFFER_CHARS = 80


def is_anthropic_setup_token(token: str) -> bool:
    return "sk-ant-oat" in token


from typing import Callable, Generator


def _stream_setup_token(
    token: str,
    model: str,
    system_prompt: str,
    messages: List[Dict[str, str]],
    max_tokens: int = 1024,
) -> Generator[str, None, None]:
    """Stream text deltas via raw SSE from the Anthropic API (setup-token auth)."""
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
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
        "stream": True,
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
        for raw_line in resp:
            line = raw_line.decode("utf-8").rstrip("\n")
            if not line.startswith("data: "):
                continue
            data = json.loads(line[6:])
            if data.get("type") == "content_block_delta":
                delta = data.get("delta", {})
                if delta.get("type") == "text_delta":
                    yield delta["text"]
            elif data.get("type") == "message_stop":
                return


def _stream_sdk(
    claude: Anthropic,
    model: str,
    system_prompt: str,
    messages: List[Dict[str, str]],
    max_tokens: int = 1024,
) -> Generator[str, None, None]:
    """Stream text deltas via the Anthropic Python SDK."""
    with claude.messages.stream(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt,
        messages=messages,
    ) as stream:
        for text in stream.text_stream:
            yield text


def chat_turn_stream(
    claude: Optional[Anthropic],
    anthropic_token: str,
    model: str,
    system_prompt: str,
    messages: List[Dict[str, str]],
) -> Generator[str, None, None]:
    """Yield text chunks as they arrive from the LLM."""
    if is_anthropic_setup_token(anthropic_token):
        yield from _stream_setup_token(
            token=anthropic_token,
            model=model,
            system_prompt=system_prompt,
            messages=messages,
        )
    else:
        if claude is None:
            raise RuntimeError("Anthropic client is missing")
        yield from _stream_sdk(
            claude=claude,
            model=model,
            system_prompt=system_prompt,
            messages=messages,
        )


def _pop_tts_emit_text(buffer: str) -> tuple[str, str]:
    """Pop text suitable for incremental TTS or return empty emit text."""
    last_boundary = -1
    for marker in _TTS_PUNCT:
        idx = buffer.rfind(marker)
        if idx > last_boundary:
            last_boundary = idx

    if last_boundary + 1 >= _TTS_MIN_SENTENCE_CHARS:
        return buffer[: last_boundary + 1], buffer[last_boundary + 1 :]

    if len(buffer) >= _TTS_MAX_BUFFER_CHARS:
        split_idx = buffer.rfind(" ", _TTS_MIN_SENTENCE_CHARS, _TTS_MAX_BUFFER_CHARS)
        if split_idx == -1:
            split_idx = _TTS_MAX_BUFFER_CHARS
        return buffer[:split_idx], buffer[split_idx:]

    return "", buffer


def _stdin_enter_pressed() -> bool:
    """Non-blocking check for Enter on stdin (TTY only)."""
    if not sys.stdin.isatty():
        return False
    try:
        ready, _, _ = select.select([sys.stdin], [], [], 0.0)
    except (OSError, ValueError):
        return False
    if not ready:
        return False
    line = sys.stdin.readline()
    return line.strip() == ""


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
        print("Press Enter to record, VAD auto-commits on silence.")
        print("If audio is speaking, Enter interrupts it; press Enter again to record.")
        print("During Claude response, press Enter to interrupt. Ctrl+C or 'quit' to exit.\n")
    else:
        print("Type your message.")
        print("During Claude response, press Enter to interrupt. Ctrl+C or 'quit' to exit.\n")

    messages: List[Dict[str, str]] = []

    try:
        while True:
            if stt_listener:
                try:
                    input("[Enter to speak] ")
                except EOFError:
                    break
                if audio_streamer and audio_streamer.is_speaking():
                    audio_streamer.interrupt()
                    print("[audio interrupted]")
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
                print("\nClaude: ", end="", flush=True)
                reply_parts: List[str] = []
                tts_buffer = ""
                interrupted = False
                for chunk in chat_turn_stream(
                    claude=claude,
                    anthropic_token=anthropic_token,
                    model=args.model,
                    system_prompt=args.system,
                    messages=messages,
                ):
                    if _stdin_enter_pressed():
                        interrupted = True
                        break
                    print(chunk, end="", flush=True)
                    reply_parts.append(chunk)
                    if audio_streamer:
                        tts_buffer += chunk
                        emit_text, tts_buffer = _pop_tts_emit_text(tts_buffer)
                        if emit_text.strip():
                            audio_streamer.send_text_chunk(emit_text.strip() + " ")
                print("\n")

                reply = "".join(reply_parts).strip()
                if audio_streamer:
                    if interrupted:
                        audio_streamer.interrupt()
                    else:
                        if tts_buffer.strip():
                            audio_streamer.send_text_chunk(tts_buffer.strip())
                        audio_streamer.flush_text()

                if interrupted:
                    print("[response interrupted]\n")
                    if not reply:
                        messages.pop()
                    continue
            except Exception as exc:
                print(f"\nError: {exc}", file=sys.stderr)
                messages.pop()
                continue

            messages.append({"role": "assistant", "content": reply})

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
