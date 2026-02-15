#!/usr/bin/env python3
"""Quick test: verify LLM streaming works with both auth paths."""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

script_path = Path(__file__).resolve()
load_dotenv(script_path.parents[2] / ".env")

token = os.environ.get("ANTHROPIC_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
if not token:
    print("Missing ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY", file=sys.stderr)
    sys.exit(2)

is_setup = "sk-ant-oat" in token
print(f"Auth: {'setup-token' if is_setup else 'api-key'}")

if is_setup:
    # Raw HTTP streaming with SSE
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
        "model": "claude-sonnet-4-5-20250929",
        "max_tokens": 256,
        "stream": True,
        "system": "Be concise.",
        "messages": [{"role": "user", "content": "Say hello in 10 words."}],
    }
    req = urllib.request.Request(
        url=url,
        method="POST",
        data=json.dumps(body).encode(),
        headers=headers,
    )
    print("Streaming (setup-token SSE):")
    with urllib.request.urlopen(req, timeout=60) as resp:
        for raw_line in resp:
            line = raw_line.decode("utf-8").rstrip("\n")
            if line.startswith("data: "):
                data = json.loads(line[6:])
                if data.get("type") == "content_block_delta":
                    delta = data.get("delta", {})
                    if delta.get("type") == "text_delta":
                        print(delta["text"], end="", flush=True)
                elif data.get("type") == "message_stop":
                    break
    print("\n\nDone.")

else:
    # SDK streaming
    from anthropic import Anthropic
    client = Anthropic(api_key=token)
    print("Streaming (SDK):")
    with client.messages.stream(
        model="claude-sonnet-4-5-20250929",
        max_tokens=256,
        system="Be concise.",
        messages=[{"role": "user", "content": "Say hello in 10 words."}],
    ) as stream:
        for text in stream.text_stream:
            print(text, end="", flush=True)
    print("\n\nDone.")
