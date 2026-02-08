"""Generate commentary video for waitlist page."""

import os
import re
import subprocess
import time
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from pydub import AudioSegment

load_dotenv()

COMMENTARY_FILE = Path("waitlist/commentary.txt")
VIDEO_FILE = Path("waitlist/one.mov")
CLIPS_DIR = Path("waitlist/clips")
COMMENTARY_TRACK = Path("waitlist/commentary_track.mp3")
OUTPUT_VIDEO = Path("waitlist/waitlist_commentary.mp4")

VOICE_ID = "oubi7HGxNVjXMnWLgwBT"
MODEL_ID = "eleven_multilingual_v2"
OUTPUT_FORMAT = "mp3_44100_128"


def parse_timestamp(ts):
    ts = ts.strip().rstrip("ish+")
    parts = ts.split(":")
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    return int(parts[0])


def clean_text(text):
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(
        r"[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
        r"\U0001F900-\U0001F9FF\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF"
        r"\U00002702-\U000027B0\U0000FE00-\U0000FE0F\U0001F1E0-\U0001F1FF]+",
        "", text,
    )
    return re.sub(r"\s+", " ", text).strip()


def parse_commentary(path):
    content = path.read_text()
    segments = []
    for block in re.split(r"\n\n(?=\*\*\d)", content):
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
    return segments


def generate_clips(segments):
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
            text=text, voice_id=VOICE_ID, model_id=MODEL_ID, output_format=OUTPUT_FORMAT,
        )
        clip_path.write_bytes(b"".join(audio))
        if i < len(segments) - 1:
            time.sleep(1)
    return clips


def get_video_duration_ms(video_path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
        capture_output=True, text=True, check=True,
    )
    return int(float(result.stdout.strip()) * 1000)


def assemble_track(clips, duration_ms):
    track = AudioSegment.silent(duration=duration_ms)
    rows = []
    for idx, (ts, clip_path) in enumerate(clips):
        clip = AudioSegment.from_mp3(str(clip_path))
        clip_dur = len(clip) / 1000
        position_ms = ts * 1000
        if idx < len(clips) - 1:
            gap = clips[idx + 1][0] - ts
        else:
            gap = (duration_ms / 1000) - ts
        diff = clip_dur - gap
        rows.append((idx, ts, clip_dur, gap, diff))
        if position_ms < duration_ms:
            track = track.overlay(clip, position=position_ms)

    print(f"  {'#':>3}  {'start':>5}  {'audio':>6}  {'avail':>6}  {'diff'}")
    print(f"  {'---':>3}  {'-----':>5}  {'------':>6}  {'------':>6}  {'----'}")
    for idx, ts, clip_dur, gap, diff in rows:
        diff_str = f"+{diff:.1f}s OVERLAP" if diff > 0 else f"{diff:.1f}s"
        print(f"  {idx:>3}  {ts:>5}s  {clip_dur:>5.1f}s  {gap:>5.0f}s  {diff_str}")

    track.export(str(COMMENTARY_TRACK), format="mp3")
    print(f"\n  Exported: {COMMENTARY_TRACK}")


def mux_video():
    cmd = [
        "ffmpeg", "-y",
        "-i", str(VIDEO_FILE),
        "-i", str(COMMENTARY_TRACK),
        "-filter_complex",
        "[0:a]volume=0.0[g];[g][1:a]amix=inputs=2:duration=first:normalize=0[out]",
        "-map", "0:v", "-map", "[out]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        str(OUTPUT_VIDEO),
    ]
    print(f"  Running ffmpeg mux -> {OUTPUT_VIDEO}")
    subprocess.run(cmd, check=True)
    print(f"  Output: {OUTPUT_VIDEO}")


def main():
    print("Step 1: Parsing commentary...")
    segments = parse_commentary(COMMENTARY_FILE)
    print(f"  {len(segments)} segments")
    for ts, text in segments:
        print(f"    {ts:>4}s: {text[:70]}...")

    print("\nStep 2: Generating TTS clips...")
    clips = generate_clips(segments)

    print("\nStep 3: Assembling commentary track...")
    duration_ms = get_video_duration_ms(VIDEO_FILE)
    print(f"  Video duration: {duration_ms/1000:.1f}s")
    assemble_track(clips, duration_ms)

    print("\nStep 4: Muxing onto video...")
    mux_video()

    print("\nDone!")


if __name__ == "__main__":
    main()
