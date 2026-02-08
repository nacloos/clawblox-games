"""Generate commentary audio synced with gameplay video (v2).

Parses timestamped commentary from tsunami/grok1.txt and transition/commentary.txt,
generates TTS audio for each segment via ElevenLabs, trims and concatenates the
tsunami and transition videos, then overlays the commentary track.
"""

import argparse
import json
import os
import re
import subprocess
import tempfile
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
TSUNAMI_CUT_S = 550  # Cut tsunami at ~9:10

# Transition to Scuttle
TRANSITION_COMMENTARY = Path("transition/commentary.txt")
TRANSITION_VIDEO = Path("transition/final.mov")
TRANSITION_CLIPS_DIR = Path("transition/clips")

# Output
SEGMENTS_JSON = Path("tsunami/segments.json")
COMMENTARY_TRACK = Path("tsunami/commentary_track.mp3")
OUTPUT_VIDEO = Path("tsunami/tsunami_commentary.mp4")

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


def trim_video(input_path: Path, output_path: Path, end_s: float):
    cmd = [
        "ffmpeg", "-y",
        "-i", str(input_path),
        "-t", str(end_s),
        "-c", "copy",
        str(output_path),
    ]
    print(f"  Trimming {input_path.name} to {end_s}s -> {output_path.name}")
    subprocess.run(cmd, capture_output=True, check=True)


def concat_videos(video_paths: list[Path], output_path: Path):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        for p in video_paths:
            f.write(f"file '{p.resolve()}'\n")
        concat_list = f.name

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_list,
        "-c", "copy",
        str(output_path),
    ]
    print(f"  Concatenating {len(video_paths)} videos -> {output_path.name}")
    subprocess.run(cmd, capture_output=True, check=True)
    os.unlink(concat_list)


# -- Step 4: Assemble commentary audio track ------------------------------------

def assemble_track(clips: list[tuple[int, Path]], duration_ms: int) -> Path:
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

    track.export(str(COMMENTARY_TRACK), format="mp3")
    print(f"\n  Exported: {COMMENTARY_TRACK}")
    return COMMENTARY_TRACK


# -- Step 5: Mux onto video ----------------------------------------------------

def mux_video(video_path: Path, commentary_path: Path, output_path: Path):
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
    parser = argparse.ArgumentParser(description="Generate commentary video v2")
    parser.add_argument(
        "-t", "--time", type=int, default=None,
        help="Only process segments up to this many seconds",
    )
    args = parser.parse_args()

    # -- Step 1: Parse both commentary files --
    print("Step 1: Parsing commentary...")
    tsunami_segments = parse_commentary(TSUNAMI_COMMENTARY)
    if args.time is not None:
        tsunami_segments = [(ts, text) for ts, text in tsunami_segments if ts <= args.time]
        print(f"  Filtered tsunami segments <= {args.time}s")

    transition_segments = parse_commentary(TRANSITION_COMMENTARY)

    # Offset transition timestamps by the tsunami cut point
    transition_offset = TSUNAMI_CUT_S
    all_segments = list(tsunami_segments)
    for ts, text in transition_segments:
        all_segments.append((ts + transition_offset, text))

    print(f"  Tsunami: {len(tsunami_segments)} segments")
    print(f"  Transition: {len(transition_segments)} segments (offset +{transition_offset}s)")
    print(f"  Total: {len(all_segments)} segments")
    for ts, text in all_segments:
        print(f"    {ts:>4}s: {text[:70]}...")

    SEGMENTS_JSON.write_text(json.dumps(
        [{"timestamp": ts, "text": text} for ts, text in all_segments],
        indent=2,
    ))
    print(f"  Saved to {SEGMENTS_JSON}")

    # -- Step 2: Generate TTS clips --
    print("\nStep 2: Generating TTS clips...")
    print("  [tsunami]")
    tsunami_clips = generate_clips(tsunami_segments, TSUNAMI_CLIPS_DIR, "clip")
    print("  [transition]")
    transition_clips = generate_clips(transition_segments, TRANSITION_CLIPS_DIR, "trans")

    # Merge clip lists with offset timestamps
    all_clips = list(tsunami_clips)
    for ts, clip_path in transition_clips:
        all_clips.append((ts + transition_offset, clip_path))

    # -- Step 3: Trim and concatenate videos --
    print("\nStep 3: Preparing video...")
    trimmed_tsunami = Path("tsunami/tsunami_trimmed.mp4")
    trim_video(TSUNAMI_VIDEO, trimmed_tsunami, TSUNAMI_CUT_S)

    # Re-encode transition to match tsunami format for concat
    transition_compat = Path("transition/final_compat.mp4")
    print(f"  Re-encoding {TRANSITION_VIDEO.name} for compatibility...")
    subprocess.run([
        "ffmpeg", "-y",
        "-i", str(TRANSITION_VIDEO),
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "fast",
        "-vf", "scale=2494:1434:force_original_aspect_ratio=decrease,pad=2494:1434:-1:-1",
        "-r", "30",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-ac", "2",
        str(transition_compat),
    ], capture_output=True, check=True)

    concat_video = Path("tsunami/concat.mp4")
    concat_videos([trimmed_tsunami, transition_compat], concat_video)

    concat_duration_ms = get_video_duration_ms(concat_video)
    print(f"  Concatenated video: {concat_duration_ms/1000:.1f}s")

    # -- Step 4: Assemble commentary track --
    print("\nStep 4: Assembling commentary track...")
    assemble_track(all_clips, concat_duration_ms)

    # -- Step 5: Mux onto video --
    print("\nStep 5: Muxing onto video...")
    mux_video(concat_video, COMMENTARY_TRACK, OUTPUT_VIDEO)

    # Clean up temp files
    trimmed_tsunami.unlink(missing_ok=True)
    transition_compat.unlink(missing_ok=True)
    concat_video.unlink(missing_ok=True)

    print("\nDone!")


if __name__ == "__main__":
    main()
