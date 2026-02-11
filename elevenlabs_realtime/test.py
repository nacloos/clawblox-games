import os
import json
import asyncio
import base64
import websockets
from dotenv import load_dotenv

load_dotenv()
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
VOICE_ID = "oubi7HGxNVjXMnWLgwBT"
MODEL_ID = "eleven_flash_v2_5"

WEBSOCKET_URI = f"wss://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}/multi-stream-input?model_id={MODEL_ID}"

async def send_text_in_context(websocket, text, context_id, voice_settings=None):
    """Send text to be synthesized in the specified context."""
    message = {
        "text": text,
        "context_id": context_id,
    }

    # Only include voice_settings for the first message in a context
    if voice_settings:
        message["voice_settings"] = voice_settings

    await websocket.send(json.dumps(message))

async def continue_context(websocket, text, context_id):
    """Add more text to an existing context."""
    await websocket.send(json.dumps({
        "text": text,
        "context_id": context_id
    }))

async def flush_context(websocket, context_id):
    """Force generation of any buffered audio in the context."""
    await websocket.send(json.dumps({
        "context_id": context_id,
        "flush": True
    }))

async def handle_interruption(websocket, old_context_id, new_context_id, new_response):
    """Handle user interruption by closing current context and starting a new one."""
    # Close the existing context that was interrupted
    await websocket.send(json.dumps({
        "context_id": old_context_id,
        "close_context": True
    }))

    # Create a new context for the new response
    await send_text_in_context(websocket, new_response, new_context_id)

async def end_conversation(websocket):
    """End the conversation and close the WebSocket connection."""
    await websocket.send(json.dumps({
        "close_socket": True
    }))

async def receive_messages(websocket, output_dir="audio_output"):
    """Process incoming WebSocket messages and save audio to files."""
    os.makedirs(output_dir, exist_ok=True)
    context_audio = {}
    try:
        async for message in websocket:
            data = json.loads(message)
            context_id = data.get("contextId", "default")

            if data.get("audio"):
                if context_id not in context_audio:
                    context_audio[context_id] = []
                context_audio[context_id].append(base64.b64decode(data["audio"]))
                print(f"Received audio chunk for context '{context_id}'")

            if data.get("is_final"):
                if context_id in context_audio:
                    filepath = os.path.join(output_dir, f"{context_id}.mp3")
                    with open(filepath, "wb") as f:
                        for chunk in context_audio[context_id]:
                            f.write(chunk)
                    print(f"Saved audio to {filepath}")
                    del context_audio[context_id]
                print(f"Context '{context_id}' completed")
    except (websockets.exceptions.ConnectionClosed, asyncio.CancelledError):
        # Save any remaining audio
        for context_id, chunks in context_audio.items():
            filepath = os.path.join(output_dir, f"{context_id}.mp3")
            with open(filepath, "wb") as f:
                for chunk in chunks:
                    f.write(chunk)
            print(f"Saved audio to {filepath}")
        print("Message receiving stopped")

async def conversation_agent_demo():
    """Run a complete conversational agent demo."""
    # Connect with API key in headers
    async with websockets.connect(
        WEBSOCKET_URI,
        max_size=16 * 1024 * 1024,
        additional_headers={"xi-api-key": ELEVENLABS_API_KEY}
    ) as websocket:
        # Start receiving messages in background
        receive_task = asyncio.create_task(receive_messages(websocket))

        # Initial agent response
        await send_text_in_context(
            websocket,
            "Hello! I'm your virtual assistant. I can help you with a wide range of topics. What would you like to know about today?",
            "greeting"
        )

        # Wait a bit (simulating user listening)
        await asyncio.sleep(2)

        # Simulate user interruption
        print("USER INTERRUPTS: 'Can you tell me about the weather?'")

        # Handle the interruption by closing current context and starting new one
        await handle_interruption(
            websocket,
            "greeting",
            "weather_response",
            "I'd be happy to tell you about the weather. Currently in your area, it's 72 degrees and sunny with a slight chance of rain later this afternoon."
        )

        # Add more to the weather context
        await continue_context(
            websocket,
            " If you're planning to go outside, you might want to bring a light jacket just in case.",
            "weather_response"
        )

        # Flush at the end of this turn to ensure all audio is generated
        await flush_context(websocket, "weather_response")

        # Wait a bit (simulating user listening)
        await asyncio.sleep(3)

        # Simulate user asking another question
        print("USER: 'What about tomorrow?'")

        # Create a new context for this response
        await send_text_in_context(
            websocket,
            "Tomorrow's forecast shows temperatures around 75 degrees with partly cloudy skies. It should be a beautiful day overall!",
            "tomorrow_weather"
        )

        # Flush and close this context
        await flush_context(websocket, "tomorrow_weather")
        await websocket.send(json.dumps({
            "context_id": "tomorrow_weather",
            "close_context": True
        }))

        # End the conversation
        await asyncio.sleep(2)
        await end_conversation(websocket)

        # Cancel the receive task
        receive_task.cancel()
        try:
            await receive_task
        except asyncio.CancelledError:
            pass

if __name__ == "__main__":
    asyncio.run(conversation_agent_demo())
