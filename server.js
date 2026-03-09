import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenvConfig();

const app = express();
const PORT = process.env.PORT || 3000;
const FLOW2API_BASE_URL = process.env.FLOW2API_BASE_URL || 'https://vip.yyds168.net/v1/chat/completions';
const REQUEST_TIMEOUT_MS = Number(process.env.FLOW2API_TIMEOUT_MS || 300000);
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image-landscape';
const DEFAULT_VIDEO_MODELS = {
  text2video: {
    landscape: 'veo_3_1_t2v_fast_landscape',
    portrait: 'veo_3_1_t2v_fast_portrait'
  },
  frame2video: {
    landscape: 'veo_3_1_i2v_s_fast_fl',
    portrait: 'veo_3_1_i2v_s_fast_portrait_fl'
  },
  reference2video: {
    landscape: 'veo_3_1_r2v_fast',
    portrait: 'veo_3_1_r2v_fast_portrait'
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

function createAbortController(timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeoutId };
}

function clearAbortTimeout(timeoutId) {
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
}

function withResolvedApiKey(inputKey) {
  return inputKey || process.env.FLOW2API_API_KEY || process.env.GEMINI_API_KEY || '';
}

function getMimeType(filename = '') {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  };
  return mimeTypes[ext] || 'image/jpeg';
}

function parseMaybeJsonArray(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeUrl(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const cleaned = value.replace(/["'\\>\])]+$/g, '').trim();

  try {
    const parsed = new URL(cleaned);
    if (!['http:', 'https:', 'data:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return cleaned.startsWith('data:') ? cleaned : null;
  }
}

function collectUrls(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const matches = text.match(/https?:\/\/[^\s"'\\)\]>]+/g) || [];
  return matches
    .map((match) => match.replace(/["'\\>\])]+$/g, ''))
    .filter(Boolean);
}

function normalizeContent(content) {
  if (!content) {
    return { textParts: [], urls: [] };
  }

  if (typeof content === 'string') {
    return { textParts: [content], urls: collectUrls(content) };
  }

  if (Array.isArray(content)) {
    return content.reduce(
      (acc, item) => {
        const normalized = normalizeContent(item);
        acc.textParts.push(...normalized.textParts);
        acc.urls.push(...normalized.urls);
        return acc;
      },
      { textParts: [], urls: [] }
    );
  }

  if (typeof content === 'object') {
    const textParts = [];
    const urls = [];

    if (typeof content.text === 'string') {
      textParts.push(content.text);
      urls.push(...collectUrls(content.text));
    }

    if (typeof content.content === 'string') {
      textParts.push(content.content);
      urls.push(...collectUrls(content.content));
    }

    if (typeof content.reasoning_content === 'string') {
      textParts.push(content.reasoning_content);
      urls.push(...collectUrls(content.reasoning_content));
    }

    const mediaUrl = sanitizeUrl(content?.image_url?.url || content?.video_url?.url || content?.url);
    if (mediaUrl) {
      urls.push(mediaUrl);
    }

    return { textParts, urls };
  }

  return { textParts: [], urls: [] };
}

function parseSSEStream(rawText) {
  const contentParts = [];
  const reasoningParts = [];
  const urls = [];
  const errors = [];

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) {
      continue;
    }

    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }

    try {
      const parsed = JSON.parse(payload);
      if (parsed.error) {
        errors.push(typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error));
        continue;
      }

      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (const choice of choices) {
        const chunks = [
          choice?.delta?.content,
          choice?.delta?.reasoning_content,
          choice?.message?.content,
          choice?.message?.reasoning_content
        ];

        for (const chunk of chunks) {
          const normalized = normalizeContent(chunk);
          if (chunk === choice?.delta?.reasoning_content || chunk === choice?.message?.reasoning_content) {
            reasoningParts.push(...normalized.textParts);
          } else {
            contentParts.push(...normalized.textParts);
          }
          urls.push(...normalized.urls);
        }

        if (choice?.finish_reason === 'content_filter') {
          errors.push('Flow2API rejected this request because it was filtered upstream.');
        }
      }
    } catch {
      continue;
    }
  }

  const reasoningText = reasoningParts.join(' ').trim();
  const errorMessage = errors[0]
    || (/(生成失败|违规|blocked|safety|forbidden|denied)/i.test(reasoningText) ? reasoningText : '');

  return {
    contentText: contentParts.join(' ').trim(),
    reasoningText,
    urls: [...new Set(urls)],
    errorMessage
  };
}

function pickMediaUrl(parsed, type) {
  const extensions = type === 'video'
    ? ['.mp4', '.webm', '.mov']
    : ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  const keywords = type === 'video'
    ? ['video', 'videofx']
    : ['image', 'img', 'cdn', 'storage'];

  const candidates = parsed.urls || [];
  for (const url of candidates) {
    const lower = url.toLowerCase();
    if (extensions.some((ext) => lower.includes(ext)) || keywords.some((keyword) => lower.includes(keyword))) {
      return url;
    }
  }

  return candidates[0] || null;
}

async function safeReadErrorText(response) {
  try {
    const text = await response.text();
    return text.slice(0, 600);
  } catch {
    return 'Failed to read upstream error body.';
  }
}

function parseUpstreamError(errorText) {
  if (!errorText) {
    return null;
  }

  try {
    const parsed = JSON.parse(errorText);
    if (parsed?.error) {
      if (typeof parsed.error === 'string') {
        return { message: parsed.error, code: '' };
      }
      return {
        message: parsed.error.message || JSON.stringify(parsed.error),
        code: parsed.error.code || parsed.error.type || ''
      };
    }
  } catch {
    return {
      message: errorText,
      code: ''
    };
  }

  return null;
}

function toFriendlyFlow2ApiError(status, model, errorText) {
  const parsed = parseUpstreamError(errorText);
  const rawMessage = parsed?.message || errorText || '';
  const errorCode = (parsed?.code || '').toLowerCase();
  const lowerMessage = rawMessage.toLowerCase();

  if (status === 401 || status === 403 || /invalid api key|invalid token|unauthorized|authentication|bearer/i.test(rawMessage)) {
    return 'Flow2API key 无效或已过期，请重新填写。';
  }

  if (errorCode === 'model_not_found' || /no available channel for model|model_not_found|model not found/i.test(lowerMessage)) {
    return `当前上游渠道不可用模型 ${model}。这通常是 API Key/渠道不匹配，或该渠道暂未开通这个模型。`;
  }

  if (status === 429 || /rate limit|too many requests|quota|credits/i.test(lowerMessage)) {
    return 'Flow2API 当前已限流或额度不足，请稍后重试或检查账户额度。';
  }

  if (status >= 500) {
    return `Flow2API 上游暂时不可用 (${status})：${rawMessage || '请稍后重试。'}`;
  }

  return `Flow2API 请求失败 (${status})：${rawMessage || '未知错误。'}`;
}

async function callFlow2Api({ messages, apiKey, model, type }) {
  const resolvedApiKey = withResolvedApiKey(apiKey);
  if (!resolvedApiKey) {
    throw new Error('Missing Flow2API key.');
  }

  const payload = {
    model,
    stream: true,
    messages
  };

  const { controller, timeoutId } = createAbortController();

  let response;
  try {
    response = await fetch(FLOW2API_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolvedApiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    clearAbortTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Flow2API request timed out.');
    }
    throw new Error(`Flow2API request failed: ${error.message}`);
  }

  clearAbortTimeout(timeoutId);

  if (!response.ok) {
    const errorText = await safeReadErrorText(response);
    throw new Error(toFriendlyFlow2ApiError(response.status, model, errorText));
  }

  const rawText = await response.text();
  const parsed = parseSSEStream(rawText);

  if (parsed.errorMessage) {
    throw new Error(parsed.errorMessage);
  }

  const mediaUrl = pickMediaUrl(parsed, type);
  if (!mediaUrl) {
    throw new Error(`Unable to extract ${type} URL from Flow2API response.`);
  }

  return {
    mediaUrl,
    rawText,
    parsed
  };
}

async function downloadMedia(url) {
  const sanitizedUrl = sanitizeUrl(url);
  if (!sanitizedUrl || sanitizedUrl.startsWith('data:')) {
    throw new Error('Invalid remote media URL.');
  }

  const { controller, timeoutId } = createAbortController();

  let response;
  try {
    response = await fetch(sanitizedUrl, { signal: controller.signal });
  } catch (error) {
    clearAbortTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Media download timed out.');
    }
    throw new Error(`Media download failed: ${error.message}`);
  }

  clearAbortTimeout(timeoutId);

  if (!response.ok) {
    const errorText = await safeReadErrorText(response);
    throw new Error(`Media download failed (${response.status}): ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') || 'application/octet-stream'
  };
}

function bufferToDataUrl(buffer, contentType) {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

function ensurePrompt(prompt) {
  return typeof prompt === 'string' ? prompt.trim() : '';
}

function buildImageMessages(prompt, imageSources = []) {
  const content = [{ type: 'text', text: prompt }];

  for (const source of imageSources.filter(Boolean)) {
    content.push({
      type: 'image_url',
      image_url: { url: source }
    });
  }

  return [{ role: 'user', content }];
}

async function proxyMediaRequest(req, res, url, defaultContentType, fileName) {
  const sanitizedUrl = sanitizeUrl(url);
  if (!sanitizedUrl || sanitizedUrl.startsWith('data:')) {
    return res.status(400).json({ error: 'Invalid media URL.' });
  }

  const { controller, timeoutId } = createAbortController();
  const upstreamHeaders = {};
  if (req.headers.range) {
    upstreamHeaders.Range = req.headers.range;
  }

  let upstream;
  try {
    upstream = await fetch(sanitizedUrl, {
      signal: controller.signal,
      headers: upstreamHeaders
    });
  } catch (error) {
    clearAbortTimeout(timeoutId);
    const message = error.name === 'AbortError' ? 'Media proxy timed out.' : `Media proxy failed: ${error.message}`;
    return res.status(502).json({ error: message });
  }

  clearAbortTimeout(timeoutId);

  if (!upstream.ok) {
    const errorText = await safeReadErrorText(upstream);
    return res.status(upstream.status).json({ error: errorText });
  }

  res.status(upstream.status);
  res.set('Content-Type', upstream.headers.get('content-type') || defaultContentType);
  res.set('Cache-Control', upstream.headers.get('cache-control') || 'public, max-age=86400');
  if (upstream.headers.get('content-length')) {
    res.set('Content-Length', upstream.headers.get('content-length'));
  }
  if (upstream.headers.get('accept-ranges')) {
    res.set('Accept-Ranges', upstream.headers.get('accept-ranges'));
  }
  if (upstream.headers.get('content-range')) {
    res.set('Content-Range', upstream.headers.get('content-range'));
  }
  if (fileName) {
    res.set('Content-Disposition', `attachment; filename="${fileName}"`);
  }

  if (!upstream.body) {
    return res.status(502).json({ error: 'Upstream response body is empty.' });
  }

  Readable.fromWeb(upstream.body).pipe(res);
}

app.get('/api/config/status', (req, res) => {
  const configuredKey = withResolvedApiKey('');
  res.json({
    hasServerKey: Boolean(configuredKey),
    flow2apiBaseUrl: FLOW2API_BASE_URL,
    message: configuredKey ? 'Server-side Flow2API key is configured.' : 'Configure Flow2API key in the browser or server environment.'
  });
});

app.post('/api/generate', async (req, res) => {
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const model = req.body.model || DEFAULT_IMAGE_MODEL;
    const apiKey = withResolvedApiKey(req.body.apiKey);

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Flow2API key is required.' });
    }

    const messages = buildImageMessages(prompt);
    const result = await callFlow2Api({ messages, apiKey, model, type: 'image' });
    const media = await downloadMedia(result.mediaUrl);

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      imageUrl: result.mediaUrl,
      imageBase64: bufferToDataUrl(media.buffer, media.contentType),
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Image generation failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Image generation failed.' });
  }
});

app.post('/api/edit', upload.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'referenceImages', maxCount: 5 }
]), async (req, res) => {
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const model = req.body.model || DEFAULT_IMAGE_MODEL;
    const apiKey = withResolvedApiKey(req.body.apiKey);

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Flow2API key is required.' });
    }

    const imageSources = [];

    if (req.body.mainImageBase64) {
      imageSources.push(req.body.mainImageBase64);
    } else if (req.files?.mainImage?.[0]) {
      const mainImage = req.files.mainImage[0];
      imageSources.push(`data:${getMimeType(mainImage.originalname)};base64,${mainImage.buffer.toString('base64')}`);
    }

    if (imageSources.length === 0) {
      return res.status(400).json({ success: false, error: 'Main image is required.' });
    }

    for (const refImage of req.files?.referenceImages || []) {
      imageSources.push(`data:${getMimeType(refImage.originalname)};base64,${refImage.buffer.toString('base64')}`);
    }

    for (const refBase64 of parseMaybeJsonArray(req.body.referenceImagesBase64)) {
      if (typeof refBase64 === 'string' && refBase64.startsWith('data:image/')) {
        imageSources.push(refBase64);
      }
    }

    const messages = buildImageMessages(prompt, imageSources);
    const result = await callFlow2Api({ messages, apiKey, model, type: 'image' });
    const media = await downloadMedia(result.mediaUrl);

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      imageUrl: result.mediaUrl,
      imageBase64: bufferToDataUrl(media.buffer, media.contentType),
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Image edit failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Image edit failed.' });
  }
});

app.post('/api/generate-video', async (req, res) => {
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const ratio = req.body.ratio === 'portrait' ? 'portrait' : 'landscape';
    const model = req.body.model || DEFAULT_VIDEO_MODELS.text2video[ratio];
    const apiKey = withResolvedApiKey(req.body.apiKey);

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Flow2API key is required.' });
    }

    const messages = [{ role: 'user', content: prompt }];
    const result = await callFlow2Api({ messages, apiKey, model, type: 'video' });

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      videoUrl: result.mediaUrl,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Text-to-video failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Text-to-video failed.' });
  }
});

app.post('/api/generate-video-from-frames', async (req, res) => {
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const ratio = req.body.ratio === 'portrait' ? 'portrait' : 'landscape';
    const model = req.body.model || DEFAULT_VIDEO_MODELS.frame2video[ratio];
    const apiKey = withResolvedApiKey(req.body.apiKey);
    const startFrameBase64 = req.body.startFrameBase64;
    const endFrameBase64 = req.body.endFrameBase64;

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Flow2API key is required.' });
    }

    if (!startFrameBase64) {
      return res.status(400).json({ success: false, error: 'Start frame is required.' });
    }

    const messages = buildImageMessages(prompt, [startFrameBase64, endFrameBase64].filter(Boolean));
    const result = await callFlow2Api({ messages, apiKey, model, type: 'video' });

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      videoUrl: result.mediaUrl,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Frame-to-video failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Frame-to-video failed.' });
  }
});

app.post('/api/generate-video-from-references', async (req, res) => {
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const ratio = req.body.ratio === 'portrait' ? 'portrait' : 'landscape';
    const model = req.body.model || DEFAULT_VIDEO_MODELS.reference2video[ratio];
    const apiKey = withResolvedApiKey(req.body.apiKey);
    const referenceImages = parseMaybeJsonArray(req.body.referenceImagesBase64)
      .filter((item) => typeof item === 'string' && item.startsWith('data:image/'))
      .slice(0, 3);

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Flow2API key is required.' });
    }

    if (referenceImages.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one reference image is required.' });
    }

    const messages = buildImageMessages(prompt, referenceImages);
    const result = await callFlow2Api({ messages, apiKey, model, type: 'video' });

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      videoUrl: result.mediaUrl,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Reference-to-video failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Reference-to-video failed.' });
  }
});

app.get('/api/proxy-image', async (req, res) => {
  return proxyMediaRequest(req, res, req.query.url, 'image/png');
});

app.get('/api/proxy-video', async (req, res) => {
  return proxyMediaRequest(req, res, req.query.url, 'video/mp4', 'nano-video.mp4');
});

app.post('/api/proxy-video', async (req, res) => {
  return proxyMediaRequest(req, res, req.body.url, 'video/mp4', 'nano-video.mp4');
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    flow2apiBaseUrl: FLOW2API_BASE_URL
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);

  if (res.headersSent) {
    return next(error);
  }

  const message = error?.message || 'Internal server error.';
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ success: false, error: message });
  }

  return res.status(500).type('text/plain').send(message);
});

app.listen(PORT, () => {
  console.log(`NANO server listening on http://localhost:${PORT}`);
  console.log(`Flow2API endpoint: ${FLOW2API_BASE_URL}`);
  console.log(`Server API key: ${withResolvedApiKey('') ? 'configured' : 'not configured'}`);
});
