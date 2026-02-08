from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
import os

load_dotenv()

elevenlabs = ElevenLabs(
  api_key=os.getenv("ELEVENLABS_API_KEY"),
)

audio = elevenlabs.text_to_speech.convert(
    text="The first move is what sets everything in motion.",
    # voice_id="JBFqnCBsd6RMkjVDRZzb",
    voice_id="oubi7HGxNVjXMnWLgwBT",
    model_id="eleven_multilingual_v2",
    output_format="mp3_44100_128",
)

with open("output.mp3", "wb") as f:
    for chunk in audio:
        f.write(chunk)

print("Audio saved to output.mp3")

