# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run production server
npm start

# Run development server with auto-reload
npm run dev
```

Server runs on `http://localhost:3000` by default. No build step — the frontend is plain HTML/CSS/JS served as static files.

## Environment Variables

Create a `.env` file (see `.env.example`):

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Fallback API key if user doesn't supply one in the UI |
| `FLOW2API_API_KEY` | Alternative key name (takes precedence order: request body → `FLOW2API_API_KEY` → `GEMINI_API_KEY`) |
| `FLOW2API_BASE_URL` | Override the proxy endpoint (default: `https://vip.yyds168.net/v1/chat/completions`) |
| `GEMINI_BASE_URL` | Base URL for image proxy fetching (default: `https://vip.yyds168.net`) |
| `FLOW2API_TIMEOUT_MS` | Request timeout in ms (default: 300000) |
| `PORT` | Server port (default: 3000) |

## Architecture

### Backend (`server.js`)

Single Express server using ES modules (`type: "module"` in package.json). All API routes are under `/api/`:

- `POST /api/generate` — text-to-image
- `POST /api/edit` — image-to-image (with optional reference images)
- `POST /api/generate-video` — text-to-video
- `POST /api/generate-frame-video` — image/frame-to-video
- `POST /api/generate-transition-video` — start+end frame transition video
- `POST /api/generate-video-from-references` — reference-image-to-video
- `GET /api/image-proxy` — proxies external image URLs back to the client (needed due to CORS)
- `GET /api/config/status` — reports whether a server-side API key is configured
- `GET *` — serves `public/index.html` (SPA fallback)

The server calls a third-party Flow2API proxy (`vip.yyds168.net`) using the OpenAI-compatible chat completions endpoint with `stream: true`. SSE responses are parsed server-side to extract base64 image data or video URLs, which are then returned as JSON to the frontend.

Multer handles multipart uploads (stored in memory, 20 MB limit per file). The `express.json` body limit is 50 MB to accommodate base64-encoded images in JSON.

### Frontend (`public/`)

Vanilla JS, no framework or bundler. Scripts are loaded in order via `<script>` tags:

1. **`flow-config.js`** — `window.FlowConfig`: model/ratio configuration registry. `buildImageModel(versionId, ratio)` constructs the model string sent to the API. `getVideoModel(group, modelId, ratio)` does the same for video.
2. **`api.js`** — `window.ImageAPI`: thin fetch wrapper around the backend `/api/*` routes. Simulates progress with a polling timer. All methods return `result` from the JSON response.
3. **`ui.js`** — `window.UI`: shared UI helpers (toasts, modals, theme toggling).
4. **`history.js`** — `window.History`: localStorage-based persistence of generated images/videos (`nano_history` key, capped at 50 entries).
5. **`app.js`** — main entry point. Manages a `state` object and a `TaskManager` (max 6 concurrent tasks). Wires all UI events and calls `ImageAPI` methods.

### State & localStorage keys

User preferences persisted in `localStorage`:
- `nano_api_key`, `nano_ratio`, `nano_model_version`, `nano_theme`
- `nano_video_ratio`, `nano_text_video_model`, `nano_frame_video_model`, `nano_reference_video_model`, `nano_video_input_mode`
- `nano_history` (array of history entries)

### Model naming convention

Image models follow: `{prefix}-{ratio}` e.g. `gemini-3.1-flash-image-landscape`. The `FlowConfig.buildImageModel()` function handles construction and falls back to the first supported ratio if the selected one is unsupported by the chosen version. Gemini 2.5 Flash only supports `portrait` and `landscape`.
