import argparse
import math
import shutil
import subprocess
import sys
import time

SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2
FRAME_MS = 20
SAMPLES_PER_FRAME = int(SAMPLE_RATE * (FRAME_MS / 1000.0))


def tone_frame(freq_hz: float, phase: float, gain: float = 0.2) -> tuple[bytes, float]:
    data = bytearray(SAMPLES_PER_FRAME * SAMPLE_WIDTH)
    for i in range(SAMPLES_PER_FRAME):
        t = (phase + i) / SAMPLE_RATE
        sample = int(32767 * gain * math.sin(2.0 * math.pi * freq_hz * t))
        off = i * 2
        data[off:off + 2] = sample.to_bytes(2, byteorder="little", signed=True)
    return bytes(data), phase + SAMPLES_PER_FRAME


def start_ffplay() -> subprocess.Popen:
    if shutil.which("ffplay") is None:
        raise RuntimeError("ffplay not found in PATH")

    base = [
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
    variants = [
        base + ["-ch_layout", "mono", "-i", "pipe:0"],
        base + ["-ac", "1", "-i", "pipe:0"],
        base + ["-i", "pipe:0"],
    ]

    for cmd in variants:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(0.2)
        if proc.poll() is None:
            return proc

    raise RuntimeError("Could not start ffplay with any supported argument variant")


def run(seconds: float) -> None:
    proc = start_ffplay()
    assert proc.stdin is not None

    total_frames = int((seconds * 1000) // FRAME_MS)
    phase_a = 0.0
    phase_b = 0.0

    try:
        for idx in range(total_frames):
            # Alternate/mix two tones so it's obvious playback is live.
            f1 = 440.0 if (idx // 25) % 2 == 0 else 554.37
            f2 = 659.25 if (idx // 20) % 2 == 0 else 783.99
            frame_a, phase_a = tone_frame(f1, phase_a, gain=0.16)
            frame_b, phase_b = tone_frame(f2, phase_b, gain=0.12)

            mixed = bytearray(len(frame_a))
            for i in range(0, len(frame_a), 2):
                a = int.from_bytes(frame_a[i:i + 2], "little", signed=True)
                b = int.from_bytes(frame_b[i:i + 2], "little", signed=True)
                v = max(-32768, min(32767, a + b))
                mixed[i:i + 2] = int(v).to_bytes(2, "little", signed=True)

            proc.stdin.write(mixed)
            proc.stdin.flush()
            time.sleep(FRAME_MS / 1000.0)
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # Some Windows ffplay builds linger briefly even after stdin closes.
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        except KeyboardInterrupt:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except Exception:
                proc.kill()


def main() -> None:
    parser = argparse.ArgumentParser(description="Standalone ffplay realtime playback test")
    parser.add_argument("--seconds", type=float, default=5.0, help="Playback duration")
    args = parser.parse_args()

    run(args.seconds)
    print("Playback test finished successfully.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nPlayback test cancelled.")
        sys.exit(130)
    except Exception as err:  # noqa: BLE001
        print(f"Playback test failed: {err}", file=sys.stderr)
        sys.exit(1)
