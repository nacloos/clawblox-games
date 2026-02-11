import argparse
import asyncio
import base64
import json
import os
import shutil
import subprocess
import time
import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import websockets
from dotenv import load_dotenv
from google import genai

SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # int16
FRAME_MS = 20
FRAME_BYTES = int(SAMPLE_RATE * (FRAME_MS / 1000.0)) * SAMPLE_WIDTH
ELEVENLABS_MODEL_ID = "eleven_flash_v2_5"
DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview"


@dataclass
class Config:
    elevenlabs_api_key: str
    gemini_api_key: str
    agent_a_voice_id: str
    agent_b_voice_id: str
    gemini_model: str
    duration_seconds: int
    topic: str
    overlap_delay_ms: int
    max_turn_chars: int
    output_dir: Path
    save_transcript: bool
    agent_a_name: str
    agent_b_name: str
    agent_a_system: str
    agent_b_system: str
    playback: bool
    text_only: bool
    gemini_timeout_seconds: int
    gemini_retries: int
    turn_timeout_seconds: int


class GeminiClient:
    def __init__(self, api_key: str, model: str, max_turn_chars: int, timeout_seconds: int, retries: int):
        self.api_key = api_key
        self.model = model
        self.max_turn_chars = max_turn_chars
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        self.client = genai.Client(api_key=self.api_key)

    def _build_prompt(self, transcript: list[dict[str, Any]], speaker_name: str, speaker_system: str) -> str:
        if transcript:
            history_lines = [f"{item['speaker']}: {item['text']}" for item in transcript[-16:]]
            history = "\n".join(history_lines)
        else:
            history = "(No prior turns)"

        rules = (
            "You are in a natural spoken conversation. "
            "Return only what this speaker says next, as plain text. "
            "No markdown, no stage directions, no labels, no quotes, no emojis. "
            f"Keep it under {self.max_turn_chars} characters."
        )

        return (
            f"{speaker_system}\n\n"
            f"{rules}\n\n"
            f"Conversation so far:\n{history}\n\n"
            f"Generate the next spoken turn for {speaker_name}."
        )

    def generate_turn_streaming(
        self,
        transcript: list[dict[str, Any]],
        speaker_name: str,
        speaker_system: str,
        on_chunk: Callable[[str], None],
    ) -> str:
        prompt = self._build_prompt(transcript, speaker_name, speaker_system)

        last_error: Exception | None = None
        for attempt in range(self.retries):
            try:
                stream = self.client.models.generate_content_stream(
                    model=self.model,
                    contents=prompt,
                    config={"temperature": 0.9},
                )
                full_text = ""
                pending = ""
                stream_start = time.monotonic()
                last_content_at = stream_start

                for chunk in stream:
                    now = time.monotonic()
                    if (now - last_content_at) > self.timeout_seconds:
                        raise TimeoutError(
                            f"No streamed content for {self.timeout_seconds}s"
                        )
                    if (now - stream_start) > (self.timeout_seconds * 3):
                        raise TimeoutError(
                            f"Streaming exceeded {self.timeout_seconds * 3}s without completion"
                        )

                    delta = self._extract_delta_content(chunk)
                    if not delta:
                        continue
                    full_text += delta
                    pending += delta
                    last_content_at = now

                    # Emit reasonably sized, sentence-like chunks for TTS.
                    while len(pending) >= 40 or any(p in pending for p in ".!?;:,"):
                        cut_at = max(
                            pending.rfind("."),
                            pending.rfind("!"),
                            pending.rfind("?"),
                            pending.rfind(","),
                            pending.rfind(";"),
                            pending.rfind(":"),
                        )
                        if cut_at == -1:
                            cut_at = min(len(pending), 80) - 1
                        chunk_text = pending[: cut_at + 1].strip()
                        pending = pending[cut_at + 1 :]
                        if chunk_text:
                            on_chunk(chunk_text)

                if pending.strip():
                    on_chunk(pending.strip())

                text = self._sanitize_text(full_text)
                if text:
                    return text
                raise ValueError("Gemini streaming returned empty text")
            except Exception as err:  # noqa: BLE001
                last_error = err
                if attempt < self.retries - 1:
                    time.sleep(0.75 * (attempt + 1))

        raise RuntimeError(f"Gemini streaming generation failed: {last_error}")

    def _sanitize_text(self, text: str) -> str:
        cleaned = " ".join(text.replace("\n", " ").split())
        cleaned = cleaned.strip(" \t\"'")
        if len(cleaned) > self.max_turn_chars:
            cleaned = cleaned[: self.max_turn_chars].rsplit(" ", 1)[0].strip()
        return cleaned

    def _extract_delta_content(self, chunk: Any) -> str:
        direct_text = getattr(chunk, "text", None)
        if isinstance(direct_text, str) and direct_text:
            return direct_text

        candidates = getattr(chunk, "candidates", None)
        if candidates and isinstance(candidates, list):
            first = candidates[0]
            content = getattr(first, "content", None)
            parts = getattr(content, "parts", None)
            if parts and isinstance(parts, list):
                pieces: list[str] = []
                for part in parts:
                    text = getattr(part, "text", None)
                    if isinstance(text, str) and text:
                        pieces.append(text)
                if pieces:
                    return "".join(pieces)
        return ""


class ElevenLabsStreamer:
    def __init__(self, api_key: str, voice_id: str):
        self.api_key = api_key
        self.voice_id = voice_id

    async def stream_turn(self, text: str, context_id: str, output_queue: asyncio.Queue[bytes]) -> None:
        uri = (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/multi-stream-input"
            f"?model_id={ELEVENLABS_MODEL_ID}&output_format=pcm_16000"
        )

        last_error: Exception | None = None
        for attempt in range(3):
            try:
                async with websockets.connect(
                    uri,
                    additional_headers={"xi-api-key": self.api_key},
                    max_size=16 * 1024 * 1024,
                    open_timeout=20,
                    close_timeout=10,
                ) as ws:
                    await ws.send(json.dumps({"context_id": context_id, "text": text}))
                    await ws.send(json.dumps({"context_id": context_id, "flush": True}))

                    async for raw_message in ws:
                        data = json.loads(raw_message)
                        audio = data.get("audio")
                        if audio:
                            await output_queue.put(base64.b64decode(audio))

                        is_final = data.get("is_final") or data.get("isFinal")
                        if is_final:
                            return

                    return
            except Exception as err:  # noqa: BLE001
                last_error = err
                if attempt < 2:
                    await asyncio.sleep(0.75 * (attempt + 1))

        raise RuntimeError(f"ElevenLabs stream failed for {context_id}: {last_error}")

    async def stream_turn_from_queue(
        self,
        text_queue: asyncio.Queue[str | None],
        context_id: str,
        output_queue: asyncio.Queue[bytes],
    ) -> None:
        uri = (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/multi-stream-input"
            f"?model_id={ELEVENLABS_MODEL_ID}&output_format=pcm_16000"
        )

        async with websockets.connect(
            uri,
            additional_headers={"xi-api-key": self.api_key},
            max_size=16 * 1024 * 1024,
            open_timeout=20,
            close_timeout=10,
        ) as ws:
            done_sending = asyncio.Event()

            async def sender() -> None:
                while True:
                    chunk = await text_queue.get()
                    if chunk is None:
                        await ws.send(json.dumps({"context_id": context_id, "flush": True}))
                        done_sending.set()
                        return
                    await ws.send(json.dumps({"context_id": context_id, "text": chunk}))

            async def receiver() -> None:
                async for raw_message in ws:
                    data = json.loads(raw_message)
                    audio = data.get("audio")
                    if audio:
                        await output_queue.put(base64.b64decode(audio))
                    is_final = data.get("is_final") or data.get("isFinal")
                    if is_final and done_sending.is_set():
                        return

            await asyncio.gather(sender(), receiver())


def mix_frames(frame_list: list[bytes]) -> bytes:
    sample_count = FRAME_BYTES // SAMPLE_WIDTH
    mixed = bytearray(FRAME_BYTES)

    for i in range(sample_count):
        value = 0
        offset = i * SAMPLE_WIDTH
        for frame in frame_list:
            sample = int.from_bytes(frame[offset : offset + 2], byteorder="little", signed=True)
            value += sample

        if value > 32767:
            value = 32767
        elif value < -32768:
            value = -32768

        mixed[offset : offset + 2] = int(value).to_bytes(2, byteorder="little", signed=True)

    return bytes(mixed)


async def queue_to_frame(queue: asyncio.Queue[bytes], buffer: bytearray) -> bytes:
    while len(buffer) < FRAME_BYTES:
        try:
            chunk = queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        buffer.extend(chunk)

    if len(buffer) >= FRAME_BYTES:
        frame = bytes(buffer[:FRAME_BYTES])
        del buffer[:FRAME_BYTES]
        return frame

    return b"\x00" * FRAME_BYTES


async def mixer_loop(
    queue_a: asyncio.Queue[bytes],
    queue_b: asyncio.Queue[bytes],
    stop_event: asyncio.Event,
    wav_path: Path,
    playback: bool,
) -> None:
    ffplay_proc = None
    if playback:
        ffplay_base = [
            "ffplay",
            "-hide_banner",
            "-loglevel",
            "error",
            "-autoexit",
            "-nodisp",
            "-f",
            "s16le",
            "-ar",
            str(SAMPLE_RATE),
        ]
        # Probe multiple variants because Windows ffplay builds differ in supported option names.
        ffplay_variants = [
            ffplay_base + ["-ch_layout", "mono", "-i", "pipe:0"],
            ffplay_base + ["-ac", str(CHANNELS), "-i", "pipe:0"],
            ffplay_base + ["-i", "pipe:0"],
        ]
        for cmd in ffplay_variants:
            try:
                ffplay_proc = subprocess.Popen(  # noqa: S603
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                await asyncio.sleep(0.2)
                if ffplay_proc.poll() is not None:
                    ffplay_proc = None
                    continue
                break
            except Exception:  # noqa: BLE001
                ffplay_proc = None
        if ffplay_proc is None:
            print("[WARN] ffplay could not be started. Continuing without realtime playback.")

    buffer_a = bytearray()
    buffer_b = bytearray()

    with wave.open(str(wav_path), "wb") as wav_file:
        wav_file.setnchannels(CHANNELS)
        wav_file.setsampwidth(SAMPLE_WIDTH)
        wav_file.setframerate(SAMPLE_RATE)

        try:
            while True:
                frame_a = await queue_to_frame(queue_a, buffer_a)
                frame_b = await queue_to_frame(queue_b, buffer_b)
                mixed = mix_frames([frame_a, frame_b])

                wav_file.writeframesraw(mixed)
                if ffplay_proc and ffplay_proc.stdin:
                    ffplay_proc.stdin.write(mixed)
                    ffplay_proc.stdin.flush()

                should_stop = (
                    stop_event.is_set()
                    and queue_a.empty()
                    and queue_b.empty()
                    and len(buffer_a) == 0
                    and len(buffer_b) == 0
                )
                if should_stop:
                    break

                await asyncio.sleep(FRAME_MS / 1000.0)
        finally:
            if ffplay_proc and ffplay_proc.stdin:
                ffplay_proc.stdin.close()
            if ffplay_proc:
                try:
                    ffplay_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    ffplay_proc.terminate()
                    try:
                        ffplay_proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        ffplay_proc.kill()


def require_binary(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f"Required binary '{name}' was not found in PATH")


def build_config() -> Config:
    load_dotenv()

    parser = argparse.ArgumentParser(description="Realtime two-agent audio conversation")
    parser.add_argument("--duration-seconds", type=int, default=120)
    parser.add_argument("--topic", default="Should AI systems prioritize speed or caution?")
    parser.add_argument("--overlap-delay-ms", type=int, default=800)
    parser.add_argument("--max-turn-chars", type=int, default=280)
    parser.add_argument("--output-dir", default="audio_output")
    parser.add_argument("--save-transcript", action="store_true", default=True)
    parser.add_argument("--no-playback", action="store_true", help="Disable realtime audio playback")
    parser.add_argument("--text-only", action="store_true", help="Generate conversation text only (no TTS/audio files)")
    parser.add_argument("--gemini-timeout-seconds", type=int, default=12)
    parser.add_argument("--gemini-retries", type=int, default=1)
    parser.add_argument("--turn-timeout-seconds", type=int, default=30)
    parser.add_argument("--agent-a-name", default="Agent A")
    parser.add_argument("--agent-b-name", default="Agent B")
    parser.add_argument(
        "--agent-a-system",
        default="You are thoughtful and pragmatic. Keep spoken replies concise and direct.",
    )
    parser.add_argument(
        "--agent-b-system",
        default="You are curious and challenging. Keep spoken replies concise and natural.",
    )
    args = parser.parse_args()

    elevenlabs_api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    gemini_api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not gemini_api_key:
        gemini_api_key = os.getenv("GOOGLE_API_KEY", "").strip()

    agent_a_voice_id = os.getenv("AGENT_A_VOICE_ID", "").strip()
    agent_b_voice_id = os.getenv("AGENT_B_VOICE_ID", "").strip()
    gemini_model = os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()

    missing = []
    if not gemini_api_key:
        missing.append("GEMINI_API_KEY")
    if not args.text_only:
        if not elevenlabs_api_key:
            missing.append("ELEVENLABS_API_KEY")
        if not agent_a_voice_id:
            missing.append("AGENT_A_VOICE_ID")
        if not agent_b_voice_id:
            missing.append("AGENT_B_VOICE_ID")

    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

    return Config(
        elevenlabs_api_key=elevenlabs_api_key,
        gemini_api_key=gemini_api_key,
        agent_a_voice_id=agent_a_voice_id,
        agent_b_voice_id=agent_b_voice_id,
        gemini_model=gemini_model,
        duration_seconds=args.duration_seconds,
        topic=args.topic,
        overlap_delay_ms=args.overlap_delay_ms,
        max_turn_chars=args.max_turn_chars,
        output_dir=Path(args.output_dir),
        save_transcript=args.save_transcript,
        agent_a_name=args.agent_a_name,
        agent_b_name=args.agent_b_name,
        agent_a_system=args.agent_a_system,
        agent_b_system=args.agent_b_system,
        playback=not args.no_playback,
        text_only=args.text_only,
        gemini_timeout_seconds=args.gemini_timeout_seconds,
        gemini_retries=args.gemini_retries,
        turn_timeout_seconds=args.turn_timeout_seconds,
    )


async def run_conversation(config: Config) -> tuple[Path | None, Path | None]:
    if not config.text_only:
        require_binary("ffmpeg")
    if config.playback and not config.text_only:
        require_binary("ffplay")

    config.output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    wav_path = config.output_dir / f"conversation_{timestamp}.wav"
    mp3_path = config.output_dir / f"conversation_{timestamp}.mp3"
    transcript_path = config.output_dir / f"conversation_{timestamp}.json"

    llm_client = GeminiClient(
        api_key=config.gemini_api_key,
        model=config.gemini_model,
        max_turn_chars=config.max_turn_chars,
        timeout_seconds=config.gemini_timeout_seconds,
        retries=config.gemini_retries,
    )

    speaker_a_tts = ElevenLabsStreamer(config.elevenlabs_api_key, config.agent_a_voice_id) if not config.text_only else None
    speaker_b_tts = ElevenLabsStreamer(config.elevenlabs_api_key, config.agent_b_voice_id) if not config.text_only else None

    queue_a: asyncio.Queue[bytes] | None = asyncio.Queue() if not config.text_only else None
    queue_b: asyncio.Queue[bytes] | None = asyncio.Queue() if not config.text_only else None
    stop_event: asyncio.Event | None = asyncio.Event() if not config.text_only else None

    mixer_task = (
        asyncio.create_task(mixer_loop(queue_a, queue_b, stop_event, wav_path, config.playback))
        if not config.text_only and queue_a and queue_b and stop_event
        else None
    )

    transcript: list[dict[str, Any]] = []
    tts_tasks: list[asyncio.Task[None]] = []
    deadline = time.monotonic() + config.duration_seconds

    async def run_llm_with_progress(fn: Callable[..., str], *args: Any) -> str:
        start = time.monotonic()
        task = asyncio.create_task(asyncio.to_thread(fn, *args))
        while True:
            elapsed = time.monotonic() - start
            if elapsed > config.turn_timeout_seconds:
                task.cancel()
                raise TimeoutError(f"Turn timed out after {config.turn_timeout_seconds}s")
            try:
                return await asyncio.wait_for(asyncio.shield(task), timeout=2.0)
            except asyncio.TimeoutError:
                print(f"[INFO] Waiting on Gemini... {int(elapsed)}s", flush=True)
    print(
        f"[INFO] Starting conversation for {config.duration_seconds}s | "
        f"model={config.gemini_model} | playback={'on' if config.playback and not config.text_only else 'off'} | "
        f"text_only={'on' if config.text_only else 'off'}",
        flush=True,
    )

    seed = f"Let's discuss: {config.topic}. Start the conversation naturally."
    transcript.append(
        {
            "turn": 0,
            "speaker": "SYSTEM",
            "text": seed,
            "time_offset_sec": 0.0,
        }
    )

    turn = 1
    while time.monotonic() < deadline:
        if turn % 2 == 1:
            speaker_name = config.agent_a_name
            speaker_system = config.agent_a_system
            speaker_key = "A"
            streamer = speaker_a_tts
            queue = queue_a
        else:
            speaker_name = config.agent_b_name
            speaker_system = config.agent_b_system
            speaker_key = "B"
            streamer = speaker_b_tts
            queue = queue_b

        print(f"[INFO] Generating turn {turn} for {speaker_name}...", flush=True)

        if config.text_only:
            chunk_buf: list[str] = []

            def on_chunk_text_only(chunk: str) -> None:
                print(chunk, end="", flush=True)
                chunk_buf.append(chunk)

            try:
                text = await run_llm_with_progress(
                    llm_client.generate_turn_streaming,
                    transcript,
                    speaker_name,
                    speaker_system,
                    on_chunk_text_only,
                )
                print("", flush=True)
            except Exception as err:  # noqa: BLE001
                print("", flush=True)
                print(f"[WARN] LLM turn generation failed on turn {turn}: {err}", flush=True)
                await asyncio.sleep(config.overlap_delay_ms / 1000.0)
                continue
        else:
            assert streamer is not None
            assert queue is not None
            context_id = f"turn_{turn}_{speaker_key.lower()}"
            text_stream_queue: asyncio.Queue[str | None] = asyncio.Queue()
            tts_stream_task = asyncio.create_task(
                streamer.stream_turn_from_queue(text_stream_queue, context_id, queue)
            )

            loop = asyncio.get_running_loop()

            def emit_stream_chunk(chunk: str) -> None:
                print(chunk, end="", flush=True)
                text_stream_queue.put_nowait(chunk)

            def on_chunk(chunk: str) -> None:
                loop.call_soon_threadsafe(emit_stream_chunk, chunk)

            try:
                text = await run_llm_with_progress(
                    llm_client.generate_turn_streaming,
                    transcript,
                    speaker_name,
                    speaker_system,
                    on_chunk,
                )
                loop.call_soon_threadsafe(text_stream_queue.put_nowait, None)
                await tts_stream_task
                print("", flush=True)
            except Exception as err:  # noqa: BLE001
                loop.call_soon_threadsafe(text_stream_queue.put_nowait, None)
                try:
                    await tts_stream_task
                except Exception:  # noqa: BLE001
                    pass
                print("", flush=True)
                print(f"[WARN] LLM turn generation failed on turn {turn}: {err}", flush=True)
                await asyncio.sleep(config.overlap_delay_ms / 1000.0)
                continue

        time_offset = config.duration_seconds - max(0.0, deadline - time.monotonic())
        transcript.append(
            {
                "turn": turn,
                "speaker": speaker_name,
                "speaker_key": speaker_key,
                "text": text,
                "time_offset_sec": round(time_offset, 3),
            }
        )
        print(f"[{speaker_name}] {text}", flush=True)

        # Keep list populated for graceful drain compatibility.
        tts_tasks.append(asyncio.create_task(asyncio.sleep(0)))

        turn += 1
        await asyncio.sleep(config.overlap_delay_ms / 1000.0)

    if tts_tasks:
        await asyncio.wait(tts_tasks, timeout=20)

    if stop_event:
        stop_event.set()
    if mixer_task:
        await mixer_task

    if not config.text_only:
        convert_cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(wav_path),
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "3",
            str(mp3_path),
        ]
        result = subprocess.run(convert_cmd, capture_output=True, text=True)  # noqa: S603
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg conversion failed: {result.stderr.strip()}")
    else:
        mp3_path = None

    if config.save_transcript:
        transcript_path.write_text(json.dumps(transcript, indent=2), encoding="utf-8")
    else:
        transcript_path = None

    return mp3_path, transcript_path


def main() -> None:
    config = build_config()
    try:
        mp3_path, transcript_path = asyncio.run(run_conversation(config))
    except KeyboardInterrupt:
        print("\n[INFO] Conversation cancelled by user.", flush=True)
        return

    if mp3_path:
        print(f"Saved stitched conversation audio: {mp3_path}")
    if transcript_path:
        print(f"Saved transcript: {transcript_path}")


if __name__ == "__main__":
    main()
