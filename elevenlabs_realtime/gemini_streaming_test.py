import argparse
import os
import time
import threading

from dotenv import load_dotenv

from multi_agent_conversation import GeminiClient


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate Gemini streaming responses")
    parser.add_argument("--model", default=os.getenv("GEMINI_MODEL", "gemini-3-flash-preview"))
    parser.add_argument("--max-turn-chars", type=int, default=220)
    parser.add_argument("--timeout-seconds", type=int, default=12)
    parser.add_argument("--retries", type=int, default=1)
    parser.add_argument("--heartbeat-seconds", type=int, default=2)
    parser.add_argument("--prompt", default="Say one short sentence about testing realtime systems.")
    args = parser.parse_args()

    load_dotenv()
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("Missing GEMINI_API_KEY (or GOOGLE_API_KEY fallback)")

    print(f"Starting Gemini stream test | model={args.model} | timeout={args.timeout_seconds}s | retries={args.retries}", flush=True)

    client = GeminiClient(
        api_key=api_key,
        model=args.model,
        max_turn_chars=args.max_turn_chars,
        timeout_seconds=args.timeout_seconds,
        retries=args.retries,
    )

    transcript = [{"speaker": "SYSTEM", "text": args.prompt}]
    chunks: list[str] = []
    stop_heartbeat = threading.Event()

    def on_chunk(chunk: str) -> None:
        if not chunks:
            print("\n[first chunk received]", flush=True)
        print(chunk, end="", flush=True)
        chunks.append(chunk)

    def heartbeat() -> None:
        elapsed = 0
        while not stop_heartbeat.is_set():
            time.sleep(args.heartbeat_seconds)
            if stop_heartbeat.is_set():
                return
            elapsed += args.heartbeat_seconds
            if not chunks:
                print(f"\n[waiting for first chunk... {elapsed}s]", flush=True)
            else:
                print(f"\n[streaming... chunks={len(chunks)} elapsed={elapsed}s]", flush=True)

    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()

    start = time.perf_counter()
    try:
        text = client.generate_turn_streaming(
            transcript=transcript,
            speaker_name="Agent A",
            speaker_system="You are concise and direct.",
            on_chunk=on_chunk,
        )
    finally:
        stop_heartbeat.set()
        hb.join(timeout=1)
    elapsed = time.perf_counter() - start

    print("\n")
    print(f"chunks_received={len(chunks)}")
    print(f"final_chars={len(text)}")
    print(f"elapsed_seconds={elapsed:.2f}")

    if not chunks:
        raise RuntimeError("Streaming test failed: received zero chunks")
    if not text.strip():
        raise RuntimeError("Streaming test failed: final text is empty")

    print("Gemini streaming test passed.")


if __name__ == "__main__":
    main()
