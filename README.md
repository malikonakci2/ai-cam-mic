# AI Camera + Microphone System

Public web app for camera and microphone analysis with Cloudflare Workers AI.

The browser captures:

- A camera frame as a JPEG data URL
- A short microphone clip with `MediaRecorder`
- An optional user prompt

The Cloudflare Worker sends:

- Images to `@cf/meta/llama-3.2-11b-vision-instruct`
- Audio to `@cf/openai/whisper`

## Requirements

- Cloudflare account with Workers AI enabled
- Node.js 18 or newer
- Wrangler CLI, installed through this project with `npm install`

## Cloudflare Setup

Install dependencies:

```powershell
npm install
```

Log in:

```powershell
npx wrangler login
```

Accept the Meta model license once:

```powershell
npm run cf:license
```

Run locally with Cloudflare bindings:

```powershell
npm run dev
```

Deploy:

```powershell
npm run deploy
```

## Public Use Notes

Camera and microphone access require HTTPS in real browsers. A deployed Cloudflare Worker provides HTTPS automatically.

This project does not store server-side images or audio. The visible event log is saved only in the user's browser local storage.

## API

`POST /api/transcribe`

```json
{
  "audio": "data:audio/webm;base64,..."
}
```

`POST /api/analyze`

```json
{
  "image": "data:image/jpeg;base64,...",
  "transcript": "optional microphone transcript",
  "prompt": "optional analysis prompt"
}
```

## Local Ollama Prototype

The earlier local Ollama server file is still in this folder for reference:

```powershell
npm start
```

The camera+microphone public workflow is the Cloudflare path: use `npm run dev` while building and `npm run deploy` for public access.
