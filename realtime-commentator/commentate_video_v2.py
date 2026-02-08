"""Generate commentary videos (v2).

Produces two separate outputs:
  1. tsunami/tsunami_commentary.mp4 — full tsunami video + grok1.txt TTS
  2. transition/final_commentary.mp4 — final.mov (muted) + transition TTS
"""

import json
import os
import re
import subprocess
import time
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from pydub import AudioSegment

load_dotenv()

# Tsunami game
TSUNAMI_COMMENTARY = Path("tsunami/grok1.txt")
TSUNAMI_VIDEO = Path("tsunami/tsunami.mp4")
TSUNAMI_CLIPS_DIR = Path("tsunami/clips")
TSUNAMI_TRACK = Path("tsunami/commentary_track.mp3")
TSUNAMI_OUTPUT = Path("tsunami/tsunami_commentary.mp4")
TSUNAMI_SEGMENTS = Path("tsunami/segments.json")

# Transition to Scuttle
TRANSITION_COMMENTARY = Path("transition/commentary.txt")
TRANSITION_VIDEO = Path("transition/final.mov")
TRANSITION_CLIPS_DIR = Path("transition/clips")
TRANSITION_TRACK = Path("transition/commentary_track.mp3")
TRANSITION_OUTPUT = Path("transition/final_commentary.mp4")

VOICE_ID = "oubi7HGxNVjXMnWLgwBT"
MODEL_ID = "eleven_multilingual_v2"
OUTPUT_FORMAT = "mp3_44100_128"


# -- Step 1: Parse commentary --------------------------------------------------

def parse_timestamp(ts: str) -> int:
    ts = ts.strip().rstrip("ish+")
    parts = ts.split(":")
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    return int(parts[0])


def clean_text(text: str) -> str:
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(
        r"[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
        r"\U0001F900-\U0001F9FF\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF"
        r"\U00002702-\U000027B0\U0000FE00-\U0000FE0F\U0001F1E0-\U0001F1FF]+",
        "",
        text,
    )
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_commentary(path: Path) -> list[tuple[int, str]]:
    content = path.read_text()
    segments = []
    blocks = re.split(r"\n\n(?=\*\*\d)", content)

    for block in blocks:
        block = block.strip()
        if not block:
            continue

        ts_match = re.match(r"\*\*(\d+:\d+\S*)\*\*\s*—\s*", block)
        if ts_match:
            ts = parse_timestamp(ts_match.group(1))
            rest = block[ts_match.end():]
            lines = rest.split("\n", 1)
            body = lines[1] if len(lines) > 1 else lines[0]
            text = clean_text(body)
            if text:
                segments.append((ts, text))
            continue

        ts_match = re.match(r"\*\*(\d+:\d+\S*)\s+[^*]*\*\*\s*\n?", block)
        if ts_match:
            ts = parse_timestamp(ts_match.group(1))
            body = block[ts_match.end():]
            text = clean_text(body)
            if text:
                segments.append((ts, text))

    return segments


# -- Step 2: Generate TTS clips ------------------------------------------------

def generate_clips(
    segments: list[tuple[int, str]], clips_dir: Path, prefix: str = "clip"
) -> list[tuple[int, Path]]:
    clips_dir.mkdir(parents=True, exist_ok=True)
    client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))

    clips = []
    for i, (ts, text) in enumerate(segments):
        clip_path = clips_dir / f"{prefix}_{i:02d}_{ts:03d}s.mp3"
        clips.append((ts, clip_path))

        if clip_path.exists():
            print(f"  [cached] {clip_path.name}")
            continue

        print(f"  [generating] {clip_path.name} ({ts}s): {text[:60]}...")
        audio = client.text_to_speech.convert(
            text=text,
            voice_id=VOICE_ID,
            model_id=MODEL_ID,
            output_format=OUTPUT_FORMAT,
        )
        audio_bytes = b"".join(audio)
        clip_path.write_bytes(audio_bytes)

        if i < len(segments) - 1:
            time.sleep(1)

    return clips


# -- Step 3: Video operations --------------------------------------------------

def get_video_duration_ms(video_path: Path) -> int:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True, text=True, check=True,
    )
    return int(float(result.stdout.strip()) * 1000)


# -- Step 4: Assemble commentary audio track ------------------------------------

def assemble_track(clips: list[tuple[int, Path]], duration_ms: int, track_path: Path) -> Path:
    track = AudioSegment.silent(duration=duration_ms)

    rows = []
    for idx, (ts, clip_path) in enumerate(clips):
        clip = AudioSegment.from_mp3(str(clip_path))
        clip_dur = len(clip) / 1000
        position_ms = ts * 1000

        if idx < len(clips) - 1:
            next_ts = clips[idx + 1][0]
            gap = next_ts - ts
            diff = clip_dur - gap
        else:
            gap = (duration_ms / 1000) - ts
            diff = clip_dur - gap

        rows.append((idx, ts, clip_dur, gap, diff, clip_path))

        if position_ms < duration_ms:
            track = track.overlay(clip, position=position_ms)

    print(f"  {'#':>3}  {'start':>5}  {'audio':>6}  {'avail':>6}  {'diff'}")
    print(f"  {'---':>3}  {'-----':>5}  {'------':>6}  {'------':>6}  {'----'}")
    for idx, ts, clip_dur, gap, diff, clip_path in rows:
        if diff > 0:
            diff_str = f"+{diff:.1f}s OVERLAP"
        else:
            diff_str = f"{diff:.1f}s"
        print(f"  {idx:>3}  {ts:>5}s  {clip_dur:>5.1f}s  {gap:>5.0f}s  {diff_str}")

    track.export(str(track_path), format="mp3")
    print(f"\n  Exported: {track_path}")
    return track_path


# -- Step 5: Mux onto video ----------------------------------------------------

def mux_video(video_path: Path, commentary_path: Path, output_path: Path, game_audio_vol: float = 0.3):
    """Combine video with game audio (at game_audio_vol) + commentary. Set game_audio_vol=0 to mute original."""
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-i", str(commentary_path),
        "-filter_complex",
        f"[0:a]volume={game_audio_vol}[g];[g][1:a]amix=inputs=2:duration=first:normalize=0[out]",
        "-map", "0:v",
        "-map", "[out]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        str(output_path),
    ]
    print(f"  Running ffmpeg mux -> {output_path}")
    subprocess.run(cmd, check=True)
    print(f"  Output: {output_path}")


# -- Main ----------------------------------------------------------------------

def process_video(label, segments, clips_dir, clip_prefix, video_path, track_path, output_path, game_audio_vol=0.3):
    """Process a single video: generate TTS, assemble track, mux."""
    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"{'='*60}")

    print(f"\n  Parsing: {len(segments)} segments")
    for ts, text in segments:
        print(f"    {ts:>4}s: {text[:70]}...")

    print(f"\n  Generating TTS clips...")
    clips = generate_clips(segments, clips_dir, clip_prefix)

    duration_ms = get_video_duration_ms(video_path)
    print(f"\n  Video duration: {duration_ms/1000:.1f}s")

    print(f"\n  Assembling commentary track...")
    assemble_track(clips, duration_ms, track_path)

    print(f"\n  Muxing onto video...")
    mux_video(video_path, track_path, output_path, game_audio_vol)


def main():
    # -- Parse commentary files --
    tsunami_segments = parse_commentary(TSUNAMI_COMMENTARY)
    transition_segments = parse_commentary(TRANSITION_COMMENTARY)

    # Save combined segments.json for reference
    all_segments = list(tsunami_segments)
    for ts, text in transition_segments:
        all_segments.append((ts, text))
    TSUNAMI_SEGMENTS.write_text(json.dumps(
        [{"timestamp": ts, "text": text} for ts, text in all_segments],
        indent=2,
    ))

    # -- Tsunami video --
    process_video(
        label="TSUNAMI",
        segments=tsunami_segments,
        clips_dir=TSUNAMI_CLIPS_DIR,
        clip_prefix="clip",
        video_path=TSUNAMI_VIDEO,
        track_path=TSUNAMI_TRACK,
        output_path=TSUNAMI_OUTPUT,
        game_audio_vol=0.3,
    )

    # -- Transition video (mute original audio) --
    process_video(
        label="TRANSITION",
        segments=transition_segments,
        clips_dir=TRANSITION_CLIPS_DIR,
        clip_prefix="trans",
        video_path=TRANSITION_VIDEO,
        track_path=TRANSITION_TRACK,
        output_path=TRANSITION_OUTPUT,
        game_audio_vol=0.0,
    )

    print("\nDone!")


if __name__ == "__main__":
    main()
