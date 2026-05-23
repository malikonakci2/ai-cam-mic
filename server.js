const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/generate";
const MODEL = process.env.OLLAMA_MODEL || "moondream";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const EVENTS_PATH = path.join(DATA_DIR, "events.jsonl");

fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseImageDataUrl(image) {
  const match = /^data:image\/(png|jpeg|jpg);base64,(.+)$/i.exec(image || "");
  if (!match) {
    throw new Error("Expected a PNG or JPEG data URL");
  }

  return {
    extension: match[1].toLowerCase() === "png" ? "png" : "jpg",
    base64: match[2]
  };
}

function appendEvent(event) {
  fs.appendFileSync(EVENTS_PATH, `${JSON.stringify(event)}\n`, "utf8");
}

function loadRecentEvents(limit = 50) {
  if (!fs.existsSync(EVENTS_PATH)) {
    return [];
  }

  const lines = fs.readFileSync(EVENTS_PATH, "utf8").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean).reverse();
}

async function askMoondream(imageBase64, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        images: [imageBase64],
        stream: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama returned ${response.status}: ${text.slice(0, 300)}`);
    }

    const json = await response.json();
    return String(json.response || "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function handleAnalyze(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const parsed = parseImageDataUrl(body.image);
    const transcript = String(body.transcript || "").trim();
    const basePrompt = String(body.prompt || "").trim() ||
      "Describe what this security camera frame shows. If a person is visible, include PERSON_DETECTED. If a vehicle is visible, include VEHICLE_DETECTED.";
    const prompt = transcript ? `${basePrompt}\n\nMicrophone transcript: ${transcript}` : basePrompt;

    const started = Date.now();
    const responseText = await askMoondream(parsed.base64, prompt);
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}.${parsed.extension}`;
    const filePath = path.join(SNAPSHOT_DIR, filename);
    fs.writeFileSync(filePath, Buffer.from(parsed.base64, "base64"));

    const event = {
      id: path.parse(filename).name,
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - started,
      model: MODEL,
      prompt,
      response: responseText,
      transcript,
      flags: {
        person: /PERSON_DETECTED|person|people|human/i.test(responseText),
        vehicle: /VEHICLE_DETECTED|car|vehicle|truck|motorcycle|bike/i.test(responseText),
        speech: Boolean(transcript)
      },
      snapshot: `/snapshots/${filename}`
    };

    appendEvent(event);
    sendJson(res, 200, event);
  } catch (error) {
    const hint = error.name === "AbortError"
      ? "Ollama did not answer within 45 seconds. Restart Ollama, close heavy apps, or try a smaller/faster vision model."
      : /model runner|resource|memory|stopped/i.test(error.message)
      ? "Ollama reported a model runner problem. Try closing other heavy apps, restarting Ollama, or using a smaller image/frame interval."
      : "Check that Ollama is running and that the moondream model is available.";

    sendJson(res, 500, {
      error: error.name === "AbortError" ? "Timed out waiting for Ollama after 45 seconds" : error.message,
      hint
    });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const baseDir = pathname.startsWith("/snapshots/") ? DATA_DIR : PUBLIC_DIR;
  const filePath = path.normalize(path.join(baseDir, pathname.replace(/^\/+/, "")));

  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": pathname.startsWith("/snapshots/") ? "private, max-age=3600" : "no-store"
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/api/events")) {
    sendJson(res, 200, { events: loadRecentEvents() });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/health")) {
    sendJson(res, 200, { ok: true, model: MODEL, ollamaUrl: OLLAMA_URL });
    return;
  }

  if (req.method === "POST" && req.url === "/api/analyze") {
    await handleAnalyze(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/transcribe") {
    sendJson(res, 501, {
      error: "Audio transcription is not available in the local Ollama Moondream server.",
      hint: "Analyze Scene now works without recording audio. Add a local speech-to-text service if you want microphone transcripts."
    });
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`AI camera dashboard: http://localhost:${PORT}`);
  console.log(`Ollama model: ${MODEL}`);
});
