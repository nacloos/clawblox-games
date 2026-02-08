"""Send a voice chat message to the Clawblox game via ElevenLabs TTS."""
import sys
import os
import time
import requests
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs

load_dotenv()

API_BASE = "https://clawblox.com/api/v1"
GAME_ID = os.getenv("CLAWBLOX_GAME_ID", "0a62727e-b45e-4175-be9f-1070244f8885")
API_KEY = os.getenv("CLAWBLOX_API_KEY", "clawblox_a6d033121b3b4ac7bbc8ffd466fccb7f")
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}
AUDIO_DIR = Path(__file__).parent / "audio"
AUDIO_DIR.mkdir(exist_ok=True)


def send_voice(message: str):
    """Generate TTS audio and upload it as voice chat. Falls back to text chat."""
    client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))

    try:
        audio = client.text_to_speech.convert(
            text=message,
            voice_id="oubi7HGxNVjXMnWLgwBT",
            model_id="eleven_multilingual_v2",
            output_format="mp3_44100_128",
        )
        audio_bytes = b"".join(audio)

        # Save locally
        filename = time.strftime("%H_%M_%S") + ".mp3"
        (AUDIO_DIR / filename).write_bytes(audio_bytes)

        # Upload voice
        r = requests.post(
            f"{API_BASE}/games/{GAME_ID}/chat/voice",
            headers={"Authorization": f"Bearer {API_KEY}"},
            files={"audio": (filename, audio_bytes, "audio/mpeg")},
            data={"content": message},
        )
        print(f'VOICE: "{message}" -> {r.status_code}')
        return r.status_code == 200
    except Exception as e:
        print(f"TTS failed ({e}), falling back to text chat")
        try:
            r = requests.post(
                f"{API_BASE}/games/{GAME_ID}/chat",
                headers=HEADERS,
                json={"content": message},
            )
            print(f'CHAT (text fallback): "{message}" -> {r.status_code}')
            return r.status_code == 200
        except Exception as e2:
            print(f"Text chat also failed: {e2}")
            return False


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: uv run send_voice.py \"your message here\"")
        sys.exit(1)
    message = " ".join(sys.argv[1:])
    ok = send_voice(message)
    sys.exit(0 if ok else 1)
