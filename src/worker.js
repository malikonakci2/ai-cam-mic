const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const SPEECH_MODEL = "@cf/openai/whisper";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function parseDataUrl(value, expectedPrefix) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(value || "");
  if (!match) {
    throw new Error("Expected a base64 data URL");
  }

  if (expectedPrefix && !match[1].toLowerCase().startsWith(expectedPrefix)) {
    throw new Error(`Expected ${expectedPrefix} data`);
  }

  return {
    mime: match[1],
    bytes: Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0))
  };
}

function flagsFromText(text) {
  return {
    person: /\b(person|people|human|man|woman|child)\b|PERSON_DETECTED/i.test(text),
    vehicle: /\b(vehicle|car|truck|van|bus|motorcycle|bicycle|bike)\b|VEHICLE_DETECTED/i.test(text),
    speech: Boolean(text.trim())
  };
}

async function handleAnalyze(request, env) {
  const started = Date.now();
  const body = await request.json();
  const image = parseDataUrl(body.image, "image/");

  if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
    return json({ error: "Image is too large. Lower capture quality or resolution." }, 413);
  }

  const prompt = String(body.prompt || "").trim() ||
    "Analyze this camera frame. Mention visible people, vehicles, safety concerns, and notable activity.";
  const transcript = String(body.transcript || "").trim();
  const userText = transcript
    ? `${prompt}\n\nMicrophone transcript from the same moment: ${transcript}`
    : prompt;

  const aiResponse = await env.AI.run(VISION_MODEL, {
    messages: [
      {
        role: "system",
        content: "You are an AI camera assistant. Be concise, factual, and avoid identifying private people."
      },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: body.image } }
        ]
      }
    ],
    max_tokens: 300
  });

  const responseText = String(aiResponse.response || aiResponse.result || "").trim();

  return json({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - started,
    model: VISION_MODEL,
    response: responseText,
    transcript,
    flags: flagsFromText(`${responseText} ${transcript}`)
  });
}

async function handleTranscribe(request, env) {
  const started = Date.now();
  const body = await request.json();
  const audio = parseDataUrl(body.audio, "audio/");

  if (audio.bytes.byteLength > MAX_AUDIO_BYTES) {
    return json({ error: "Audio is too large. Record a shorter clip." }, 413);
  }

  const aiResponse = await env.AI.run(SPEECH_MODEL, {
    audio: [...audio.bytes]
  });

  return json({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - started,
    model: SPEECH_MODEL,
    mime: audio.mime,
    text: String(aiResponse.text || aiResponse.transcription || "").trim()
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({
          ok: true,
          visionModel: VISION_MODEL,
          speechModel: SPEECH_MODEL
        });
      }

      if (request.method === "POST" && url.pathname === "/api/analyze") {
        return await handleAnalyze(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/transcribe") {
        return await handleTranscribe(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error.message || "Worker request failed" }, 500);
    }
  }
};
