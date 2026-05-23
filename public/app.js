const video = document.querySelector("#video");
const canvas = document.querySelector("#canvas");
const startMediaButton = document.querySelector("#startMedia");
const analyzeNowButton = document.querySelector("#analyzeNow");
const recordAudioButton = document.querySelector("#recordAudio");
const autoAnalyzeInput = document.querySelector("#autoAnalyze");
const intervalInput = document.querySelector("#interval");
const promptInput = document.querySelector("#prompt");
const statusEl = document.querySelector("#status");
const videoWrap = document.querySelector(".video-wrap");
const latestResponse = document.querySelector("#latestResponse");
const transcriptEl = document.querySelector("#transcript");
const latencyEl = document.querySelector("#latency");
const personBadge = document.querySelector("#personBadge");
const vehicleBadge = document.querySelector("#vehicleBadge");
const speechBadge = document.querySelector("#speechBadge");
const eventsEl = document.querySelector("#events");
const clearEventsButton = document.querySelector("#clearEvents");

const EVENT_KEY = "ai-camera-events";
let mediaStream = null;
let audioStream = null;
let autoTimer = null;
let analyzing = false;
let recording = false;
let latestTranscript = "";

function setStatus(text, mode = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${mode}`.trim();
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function readEvents() {
  try {
    return JSON.parse(localStorage.getItem(EVENT_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveEvent(event) {
  const events = [event, ...readEvents()].slice(0, 30);
  localStorage.setItem(EVENT_KEY, JSON.stringify(events));
  renderEvents(events);
}

async function startMedia() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "environment"
      },
      audio: false
    });

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      recordAudioButton.disabled = false;
    } catch {
      audioStream = null;
      transcriptEl.textContent = "Microphone unavailable. Camera analysis still works.";
    }

    video.srcObject = mediaStream;
    videoWrap.classList.add("has-video");
    analyzeNowButton.disabled = false;
    autoAnalyzeInput.disabled = false;
    setStatus("Live", "live");
  } catch (error) {
    setStatus("Camera error", "error");
    latestResponse.textContent = error.message;
  }
}

function captureFrame() {
  if (!mediaStream || video.readyState < 2) {
    throw new Error("Camera is not ready yet");
  }

  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 720;
  const maxEdge = 768;
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!contentType.includes("application/json")) {
    const preview = text.replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`Expected JSON from ${response.url}, but received ${contentType || "unknown content type"}: ${preview}`);
  }

  return JSON.parse(text);
}

async function recordAudioClip(seconds = 4) {
  if (!audioStream) {
    throw new Error("Microphone is not available");
  }

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "";
  const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
  const chunks = [];

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) {
      chunks.push(event.data);
    }
  });

  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  recorder.stop();
  await new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));

  return new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
}

async function transcribeAudio() {
  if (recording) {
    return latestTranscript;
  }

  recording = true;
  recordAudioButton.disabled = true;
  setStatus("Listening", "busy");

  try {
    const audioBlob = await recordAudioClip();
    const audio = await blobToDataUrl(audioBlob);
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio })
    });
    const payload = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.error || "Transcription failed");
    }

    latestTranscript = payload.text || "";
    transcriptEl.textContent = latestTranscript || "No speech detected.";
    setStatus("Live", "live");
    return latestTranscript;
  } catch (error) {
    transcriptEl.textContent = error.message;
    setStatus("Audio error", "error");
    return "";
  } finally {
    recording = false;
    recordAudioButton.disabled = !audioStream;
  }
}

function updateResult(event) {
  latestResponse.textContent = event.response || "No response text returned.";
  transcriptEl.textContent = event.transcript || latestTranscript || "No microphone transcript yet.";
  latencyEl.textContent = `${event.latencyMs} ms`;
  personBadge.classList.toggle("active", Boolean(event.flags?.person));
  vehicleBadge.classList.toggle("active", Boolean(event.flags?.vehicle));
  speechBadge.classList.toggle("active", Boolean(event.flags?.speech));
}

async function analyzeScene() {
  if (analyzing) {
    return;
  }

  analyzing = true;
  analyzeNowButton.disabled = true;
  setStatus("Analyzing", "busy");
  let image = "";

  try {
    image = captureFrame();
    const transcript = latestTranscript;
    latestResponse.textContent = "Sending frame to Moondream...";
    saveEvent({
      id: `pending-${Date.now()}`,
      timestamp: new Date().toISOString(),
      latencyMs: 0,
      response: "Frame sent to Moondream. Waiting for analysis...",
      transcript,
      flags: { person: false, vehicle: false, speech: Boolean(transcript) },
      snapshot: image,
      pending: true
    });

    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image,
        transcript,
        prompt: promptInput.value
      })
    });
    const payload = await readJsonResponse(response);

    if (!response.ok) {
      const message = [payload.error || "Analysis failed", payload.hint].filter(Boolean).join(" ");
      throw new Error(message);
    }

    const event = { ...payload, snapshot: image };
    updateResult(event);
    saveEvent(event);
    setStatus("Live", "live");
  } catch (error) {
    const event = {
      id: `error-${Date.now()}`,
      timestamp: new Date().toISOString(),
      latencyMs: 0,
      response: error.message,
      transcript: latestTranscript,
      flags: { person: false, vehicle: false, speech: Boolean(latestTranscript) },
      snapshot: image,
      failed: true
    };

    setStatus("Error", "error");
    latestResponse.textContent = error.message;
    saveEvent(event);
  } finally {
    analyzing = false;
    analyzeNowButton.disabled = !mediaStream;
  }
}

function startAutoAnalyze() {
  stopAutoAnalyze();
  const seconds = Math.max(5, Number(intervalInput.value) || 12);
  autoTimer = setInterval(() => {
    latestTranscript = "";
    analyzeScene();
  }, seconds * 1000);
  analyzeScene();
}

function stopAutoAnalyze() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

function renderEvents(events = readEvents()) {
  if (!events.length) {
    eventsEl.innerHTML = '<p class="empty">No events yet.</p>';
    return;
  }

  eventsEl.innerHTML = events.map((event) => {
    const time = new Date(event.timestamp).toLocaleString();
    const failed = event.failed ? " analysis failed" : "";
    const pending = event.pending ? " pending" : "";
    const snapshot = event.snapshot
      ? `<img src="${event.snapshot}" alt="Camera snapshot from ${escapeHtml(time)}">`
      : "";

    return `
      <article class="event${failed}${pending}">
        ${snapshot}
        <time>${escapeHtml(time)} - ${event.latencyMs} ms</time>
        <p>${escapeHtml(event.response)}</p>
        ${event.transcript ? `<blockquote>${escapeHtml(event.transcript)}</blockquote>` : ""}
      </article>
    `;
  }).join("");
}

startMediaButton.addEventListener("click", startMedia);
analyzeNowButton.addEventListener("click", analyzeScene);
recordAudioButton.addEventListener("click", transcribeAudio);
clearEventsButton.addEventListener("click", () => {
  localStorage.removeItem(EVENT_KEY);
  renderEvents([]);
});

autoAnalyzeInput.addEventListener("change", () => {
  if (autoAnalyzeInput.checked) {
    startAutoAnalyze();
  } else {
    stopAutoAnalyze();
  }
});

intervalInput.addEventListener("change", () => {
  if (autoAnalyzeInput.checked) {
    startAutoAnalyze();
  }
});

renderEvents();
