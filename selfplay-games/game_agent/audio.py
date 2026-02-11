from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import base64
from dataclasses import dataclass
from typing import Optional

import websockets.sync.client


ELEVENLABS_MODEL_ID = "eleven_flash_v2_5"
ELEVENLABS_OUTPUT_FORMAT = "pcm_16000"


@dataclass
class AudioConfig:
    api_key: str
    voice_id: str
    model_id: str = ELEVENLABS_MODEL_ID
    output_format: str = ELEVENLABS_OUTPUT_FORMAT

    @classmethod
    def from_env(cls) -> "AudioConfig":
        api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
        voice_id = (
            os.environ.get("AGENT_VOICE_ID", "").strip()
            or os.environ.get("AGENT_A_VOICE_ID", "").strip()
        )
        if not api_key:
            raise RuntimeError("Missing ELEVENLABS_API_KEY")
        if not voice_id:
            raise RuntimeError("Missing AGENT_VOICE_ID (or AGENT_A_VOICE_ID)")
        return cls(api_key=api_key, voice_id=voice_id)


class AgentAudioStreamer:
    """Background audio streamer for short TTS lines."""

    def __init__(self, config: AudioConfig):
        self.config = config
        self._queue: queue.Queue[Optional[str]] = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._had_error = False

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name="agent-audio")
        self._thread.start()

    def enqueue_text(self, text: str) -> None:
        cleaned = " ".join(text.split()).strip()
        if not cleaned:
            return
        self._queue.put(cleaned)

    def close(self) -> None:
        if self._thread is None:
            return
        self._queue.put(None)
        self._stop.set()
        self._thread.join(timeout=5)
        self._thread = None

    def _run(self) -> None:
        ffplay_cmd = [
            "ffplay",
            "-hide_banner",
            "-loglevel",
            "error",
            "-autoexit",
            "-nodisp",
            "-f",
            "s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-i",
            "pipe:0",
        ]
        try:
            ffplay = subprocess.Popen(  # noqa: S603
                ffplay_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as exc:  # noqa: BLE001
            self._had_error = True
            print(f"[WARN] Audio disabled: unable to start ffplay: {exc}")
            return

        try:
            while not self._stop.is_set():
                try:
                    text = self._queue.get(timeout=0.2)
                except queue.Empty:
                    continue
                if text is None:
                    break
                self._stream_once(text, ffplay)
        finally:
            if ffplay.stdin:
                ffplay.stdin.close()
            try:
                ffplay.wait(timeout=2)
            except Exception:  # noqa: BLE001
                ffplay.kill()

    def _stream_once(self, text: str, ffplay: subprocess.Popen[bytes]) -> None:
        uri = (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{self.config.voice_id}/multi-stream-input"
            f"?model_id={self.config.model_id}&output_format={self.config.output_format}"
        )
        context_id = f"agent_step_{threading.get_ident()}"
        try:
            with websockets.sync.client.connect(
                uri,
                additional_headers={"xi-api-key": self.config.api_key},
                max_size=16 * 1024 * 1024,
                open_timeout=20,
                close_timeout=10,
            ) as ws:
                for chunk in self._chunk_text(text):
                    ws.send(json.dumps({"context_id": context_id, "text": chunk}))
                ws.send(json.dumps({"context_id": context_id, "flush": True}))

                for raw_message in ws:
                    data = json.loads(raw_message)
                    audio = data.get("audio")
                    if audio and ffplay.stdin:
                        ffplay.stdin.write(base64.b64decode(audio))
                        ffplay.stdin.flush()
                    if data.get("is_final") or data.get("isFinal"):
                        return
        except Exception as exc:  # noqa: BLE001
            if not self._had_error:
                print(f"[WARN] Audio stream error: {exc}")
            self._had_error = True

    @staticmethod
    def _chunk_text(text: str) -> list[str]:
        words = text.split()
        chunks: list[str] = []
        current: list[str] = []
        current_len = 0
        for word in words:
            add_len = len(word) + (1 if current else 0)
            if current and (current_len + add_len) > 120:
                chunks.append(" ".join(current))
                current = [word]
                current_len = len(word)
            else:
                current.append(word)
                current_len += add_len
        if current:
            chunks.append(" ".join(current))
        return chunks
