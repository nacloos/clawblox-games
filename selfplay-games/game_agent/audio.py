from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
import base64
from dataclasses import dataclass
from typing import Optional

import websockets.sync.client


ELEVENLABS_MODEL_ID = "eleven_flash_v2_5"
ELEVENLABS_OUTPUT_FORMAT = "pcm_16000"
ELEVENLABS_STT_MODEL_ID = "scribe_v2_realtime"
ELEVENLABS_STT_SAMPLE_RATE = 16000

# Timeout waiting for audio chunks after flush (seconds).
# If ElevenLabs doesn't send more data within this window, assume utterance is done.
_RECV_TIMEOUT = 3.0


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
    """Background audio streamer with persistent ElevenLabs WebSocket.

    Architecture:
    - One worker thread owns the WebSocket and ffplay subprocess.
    - start() connects both and blocks until ready.
    - enqueue_text() is non-blocking; worker processes utterances sequentially.
    - The WebSocket persists across utterances (no per-message connect overhead).
    - On WS failure, reconnects automatically before the next utterance.
    """

    def __init__(self, config: AudioConfig):
        self.config = config
        self._queue: queue.Queue[Optional[str]] = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._start_error: Optional[str] = None
        self._context_counter = 0

    def start(self) -> None:
        """Start worker thread, block until WS + ffplay are ready."""
        if self._thread is not None:
            return
        self._ready.clear()
        self._start_error = None
        self._thread = threading.Thread(target=self._run, daemon=True, name="agent-audio")
        self._thread.start()
        # Wait for worker to signal ready (or fail)
        self._ready.wait(timeout=15)
        if self._start_error:
            raise RuntimeError(self._start_error)

    def enqueue_text(self, text: str) -> None:
        cleaned = " ".join(text.split()).strip()
        if not cleaned:
            return
        print(f"[audio] enqueue ({len(cleaned)} chars): {cleaned[:80]}{'...' if len(cleaned) > 80 else ''}")
        self._queue.put(cleaned)

    def close(self) -> None:
        if self._thread is None:
            return
        self._queue.put(None)
        self._stop.set()
        self._thread.join(timeout=5)
        self._thread = None

    def _next_context_id(self) -> str:
        self._context_counter += 1
        return f"ctx_{self._context_counter}"

    def _ws_uri(self) -> str:
        return (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{self.config.voice_id}"
            f"/multi-stream-input"
            f"?model_id={self.config.model_id}&output_format={self.config.output_format}"
        )

    def _connect_ws(self) -> websockets.sync.client.ClientConnection:
        t0 = time.monotonic()
        ws = websockets.sync.client.connect(
            self._ws_uri(),
            additional_headers={"xi-api-key": self.config.api_key},
            max_size=16 * 1024 * 1024,
            open_timeout=15,
            close_timeout=3,
        )
        print(f"[audio] ws connected in {time.monotonic() - t0:.2f}s")
        return ws

    def _start_ffplay(self) -> subprocess.Popen:
        cmd = [
            "ffplay",
            "-hide_banner", "-loglevel", "error",
            "-autoexit", "-nodisp",
            "-probesize", "32",
            "-analyzeduration", "0",
            "-fflags", "nobuffer",
            "-flags", "low_delay",
            "-f", "s16le", "-ar", "16000", "-ac", "1",
            "-i", "pipe:0",
        ]
        return subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )

    def _run(self) -> None:
        # Start ffplay
        try:
            ffplay = self._start_ffplay()
        except Exception as exc:
            self._start_error = f"unable to start ffplay: {exc}"
            self._ready.set()
            return

        # Connect WebSocket
        ws: Optional[websockets.sync.client.ClientConnection] = None
        try:
            ws = self._connect_ws()
        except Exception as exc:
            self._start_error = f"unable to connect ElevenLabs WS: {exc}"
            self._ready.set()
            ffplay.kill()
            return

        # Signal ready
        print("[audio] ready")
        self._ready.set()

        try:
            while not self._stop.is_set():
                # Dequeue next utterance
                try:
                    text = self._queue.get(timeout=0.2)
                except queue.Empty:
                    continue
                if text is None:
                    break

                print(f"[audio] dequeue ({len(text)} chars)")
                t0 = time.monotonic()

                # Ensure WS is alive; reconnect if needed
                if ws is None:
                    try:
                        ws = self._connect_ws()
                    except Exception as exc:
                        print(f"[audio] reconnect failed: {exc}")
                        continue

                try:
                    self._stream_utterance(text, ws, ffplay)
                except Exception as exc:
                    print(f"[audio] stream error: {exc}, will reconnect")
                    try:
                        ws.close()
                    except Exception:
                        pass
                    ws = None
                    continue

                print(f"[audio] done in {time.monotonic() - t0:.2f}s")

        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
            if ffplay.stdin:
                ffplay.stdin.close()
            try:
                ffplay.wait(timeout=2)
            except Exception:
                ffplay.kill()

    def _stream_utterance(
        self,
        text: str,
        ws: websockets.sync.client.ClientConnection,
        ffplay: subprocess.Popen,
    ) -> None:
        context_id = self._next_context_id()
        chunks = self._chunk_text(text)

        # Send text + flush
        t_send = time.monotonic()
        for chunk in chunks:
            ws.send(json.dumps({"context_id": context_id, "text": chunk}))
        ws.send(json.dumps({"context_id": context_id, "flush": True}))

        # Receive audio (filter by context_id to skip stale messages)
        t_first_audio = None
        audio_bytes = 0
        msg_count = 0

        while True:
            try:
                raw = ws.recv(timeout=_RECV_TIMEOUT)
            except TimeoutError:
                break

            data = json.loads(raw)

            # Skip messages from previous contexts
            msg_ctx = data.get("context_id")
            if msg_ctx and msg_ctx != context_id:
                continue

            msg_count += 1
            audio = data.get("audio")

            if audio and ffplay.stdin:
                decoded = base64.b64decode(audio)
                audio_bytes += len(decoded)
                if t_first_audio is None:
                    t_first_audio = time.monotonic()
                    latency = t_first_audio - t_send
                    print(f"[audio] first chunk in {latency:.2f}s ({len(decoded)} bytes)")
                ffplay.stdin.write(decoded)
                ffplay.stdin.flush()

            if data.get("is_final") or data.get("isFinal"):
                break

        print(f"[audio] {msg_count} msgs, {audio_bytes} bytes, "
              f"total {time.monotonic() - t_send:.2f}s")

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


class MicSTTListener:
    """Push-to-talk STT via ElevenLabs Scribe v2 Realtime.

    Call listen_once() to open the mic, stream audio to ElevenLabs,
    and return the committed transcript when VAD detects silence.
    """

    def __init__(self, api_key: str):
        self.api_key = api_key

    def _stt_ws_uri(self) -> str:
        return (
            "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
            f"?model_id={ELEVENLABS_STT_MODEL_ID}"
            f"&audio_format=pcm_{ELEVENLABS_STT_SAMPLE_RATE}"
            "&commit_strategy=vad"
            "&vad_silence_threshold_secs=1.5"
        )

    def listen_once(self) -> str:
        """Open mic, stream to ElevenLabs STT, return transcript on VAD commit."""
        import sounddevice as sd

        sample_rate = ELEVENLABS_STT_SAMPLE_RATE
        chunk_samples = int(sample_rate * 0.25)  # 250ms chunks

        ws = websockets.sync.client.connect(
            self._stt_ws_uri(),
            additional_headers={"xi-api-key": self.api_key},
            open_timeout=10,
            close_timeout=3,
        )

        try:
            # Wait for session_started
            init = json.loads(ws.recv(timeout=10))
            if init.get("message_type") != "session_started":
                raise RuntimeError(f"Unexpected STT init message: {init}")

            stop = threading.Event()
            last_partial = ""

            def _sender():
                """Record mic and send PCM chunks to WS."""
                stream = sd.InputStream(
                    samplerate=sample_rate,
                    channels=1,
                    dtype="int16",
                    blocksize=chunk_samples,
                )
                stream.start()
                try:
                    while not stop.is_set():
                        data, _ = stream.read(chunk_samples)
                        audio_b64 = base64.b64encode(data.tobytes()).decode()
                        ws.send(json.dumps({
                            "message_type": "input_audio_chunk",
                            "audio_base_64": audio_b64,
                        }))
                except Exception:
                    pass
                finally:
                    stream.stop()
                    stream.close()

            sender_thread = threading.Thread(target=_sender, daemon=True)
            sender_thread.start()

            # Receive loop: show partials, return on commit
            transcript = ""
            while True:
                try:
                    raw = ws.recv(timeout=30)
                except TimeoutError:
                    break
                msg = json.loads(raw)
                msg_type = msg.get("message_type", "")

                if msg_type == "partial_transcript":
                    partial = msg.get("text", "").strip()
                    if partial and partial != last_partial:
                        last_partial = partial
                        print(f"\r  \x1b[2m{partial}\x1b[0m", end="", flush=True)

                elif msg_type in (
                    "committed_transcript",
                    "committed_transcript_with_timestamps",
                ):
                    transcript = msg.get("text", "").strip()
                    stop.set()
                    break

            # Clear partial line
            print("\r\x1b[2K", end="", flush=True)

            sender_thread.join(timeout=2)
            return transcript

        finally:
            try:
                ws.close()
            except Exception:
                pass
