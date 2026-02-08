"""Generate commentary audio synced with gameplay video.

Parses timestamped commentary from tsunami/grok1.txt, generates TTS audio
for each segment via ElevenLabs, and overlays it onto tsunami/tsunami.mp4.
"""

import argparse
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

COMMENTARY_FILE = Path("tsunami/grok1.txt")
VIDEO_FILE = Path("tsunami/tsunami.mp4")
CLIPS_DIR = Path("tsunami/clips")
SEGMENTS_JSON = Path("tsunami/segments.json")
COMMENTARY_TRACK = Path("tsunami/commentary_track.mp3")
OUTPUT_VIDEO = Path("tsunami/tsunami_commentary.mp4")

VOICE_ID = "oubi7HGxNVjXMnWLgwBT"
MODEL_ID = "eleven_multilingual_v2"
OUTPUT_FORMAT = "mp3_44100_128"


# -- Step 1: Parse commentary --------------------------------------------------

def parse_timestamp(ts: str) -> int:
    """Convert a timestamp string like '1:23', '9:00ish', '10:00+' to seconds."""
    ts = ts.strip().rstrip("ish+")
    parts = ts.split(":")
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    return int(parts[0])


def clean_text(text: str) -> str:
    """Strip markdown bold, emoji, and extra whitespace from commentary text."""
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    # Remove emoji (Unicode emoji ranges)
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
    """Parse commentary file into (timestamp_seconds, text) pairs."""
    content = path.read_text()
    # Match entries starting with **timestamp** — Title\nBody...
    # The last entry has a different format: **10:00+ DEATH MONTAGE...**
    pattern = r"\*\*(\d+:\d+\S*)\*\*\s*—\s*(.*?)(?=\n\n\*\*\d+:\d+|\Z)"
    # Also handle the special last entry without —
    alt_pattern = r"\*\*(\d+:\d+\S*)\s+([^*]+)\*\*"

    segments = []
    # Split on double newlines to get blocks
    blocks = re.split(r"\n\n(?=\*\*\d)", content)

    for block in blocks:
        block = block.strip()
        if not block:
            continue

        # Try to extract timestamp
        ts_match = re.match(r"\*\*(\d+:\d+\S*)\*\*\s*—\s*", block)
        if ts_match:
            ts = parse_timestamp(ts_match.group(1))
            rest = block[ts_match.end():]
            # First line is the title, body starts after first newline
            lines = rest.split("\n", 1)
            body = lines[1] if len(lines) > 1 else lines[0]
            text = clean_text(body)
            if text:
                segments.append((ts, text))
            continue

        # Handle special format like **10:00+ DEATH MONTAGE & FINAL LEGENDARY**
        ts_match = re.match(r"\*\*(\d+:\d+\S*)\s+[^*]*\*\*\s*\n?", block)
        if ts_match:
            ts = parse_timestamp(ts_match.group(1))
            body = block[ts_match.end():]
            text = clean_text(body)
            if text:
                segments.append((ts, text))

    return segments


# -- Step 2: Generate TTS clips ------------------------------------------------

def generate_clips(segments: list[tuple[int, str]]) -> list[tuple[int, Path]]:
    """Generate TTS audio clips for each segment, with caching."""
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))

    clips = []
    for i, (ts, text) in enumerate(segments):
        clip_path = CLIPS_DIR / f"clip_{i:02d}_{ts:03d}s.mp3"
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

        # Rate limit
        if i < len(segments) - 1:
            time.sleep(1)

    return clips


# -- Step 3: Assemble commentary audio track ------------------------------------

def get_video_duration_ms(video_path: Path) -> int:
    """Get video duration in milliseconds using ffprobe."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return int(float(result.stdout.strip()) * 1000)


def assemble_track(clips: list[tuple[int, Path]], duration_ms: int) -> Path:
    """Overlay all clips onto a silent track at their timestamps."""
    track = AudioSegment.silent(duration=duration_ms)

    # Build info for summary table
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

    # Print summary table
    # audio = TTS clip duration
    # avail = time until next segment starts (video segment duration)
    # diff  = audio - avail (positive = overlap, negative = dead air)
    print(f"  {'#':>3}  {'start':>5}  {'audio':>6}  {'avail':>6}  {'diff'}")
    print(f"  {'---':>3}  {'-----':>5}  {'------':>6}  {'------':>6}  {'----'}")
    for idx, ts, clip_dur, gap, diff, clip_path in rows:
        if diff > 0:
            diff_str = f"+{diff:.1f}s OVERLAP"
        else:
            diff_str = f"{diff:.1f}s"
        print(f"  {idx:>3}  {ts:>5}s  {clip_dur:>5.1f}s  {gap:>5.0f}s  {diff_str}")

    track.export(str(COMMENTARY_TRACK), format="mp3")
    print(f"\n  Exported: {COMMENTARY_TRACK}")
    return COMMENTARY_TRACK


# -- Step 4: Mux onto video ----------------------------------------------------

def mux_video(video_path: Path, commentary_path: Path, output_path: Path):
    """Combine video with mixed game audio (30%) + commentary."""
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-i", str(commentary_path),
        "-filter_complex",
        "[0:a]volume=0.3[g];[g][1:a]amix=inputs=2:duration=first:normalize=0[out]",
        "-map", "0:v",
        "-map", "[out]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        str(output_path),
    ]
    print(f"  Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    print(f"  Output: {output_path}")


# -- Main ----------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Generate commentary video")
    parser.add_argument(
        "-t", "--time", type=int, default=None,
        help="Only process segments up to this many seconds (e.g. -t 120 for first 2 min)",
    )
    args = parser.parse_args()

    print("Step 1: Parsing commentary...")
    segments = parse_commentary(COMMENTARY_FILE)
    if args.time is not None:
        segments = [(ts, text) for ts, text in segments if ts <= args.time]
        print(f"  Filtered to segments <= {args.time}s")
    print(f"  Found {len(segments)} segments")
    for ts, text in segments:
        print(f"    {ts:>4}s: {text[:70]}...")

    SEGMENTS_JSON.write_text(json.dumps(
        [{"timestamp": ts, "text": text} for ts, text in segments],
        indent=2,
    ))
    print(f"  Saved to {SEGMENTS_JSON}")

    print("\nStep 2: Generating TTS clips...")
    clips = generate_clips(segments)

    print("\nStep 3: Assembling commentary track...")
    duration_ms = get_video_duration_ms(VIDEO_FILE)
    print(f"  Video duration: {duration_ms/1000:.1f}s")
    assemble_track(clips, duration_ms)

    print("\nStep 4: Muxing onto video...")
    mux_video(VIDEO_FILE, COMMENTARY_TRACK, OUTPUT_VIDEO)

    print("\nDone!")


if __name__ == "__main__":
    main()
