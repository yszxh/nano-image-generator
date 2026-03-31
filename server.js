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
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://vip.yyds168.net';
const REQUEST_TIMEOUT_MS = Number(process.env.FLOW2API_TIMEOUT_MS || 300000);
const PROXY_MAX_RETRIES = Number(process.env.PROXY_MAX_RETRIES || 2);

// 代理允许的上游域名白名单（防止 SSRF）
const PROXY_ALLOWED_HOSTS = new Set(
  (process.env.PROXY_ALLOWED_HOSTS || 'vip.yyds168.net,api.yyds168.net,storage.googleapis.com')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

// 图片代理内存缓存（最多 50 条，TTL 5 分钟）
const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const IMAGE_CACHE_MAX = 50;
const imageCache = new Map();
function imageCacheGet(key) {
  const entry = imageCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > IMAGE_CACHE_TTL_MS) {
    imageCache.delete(key);
    return null;
  }
  return entry;
}
function imageCacheSet(key, contentType, buffer) {
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    // 淘汰最旧的条目
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
  imageCache.set(key, { contentType, buffer, ts: Date.now() });
}
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
const RATIO_MAP = {
  portrait: '9:16',
  landscape: '16:9',
  square: '1:1',
  'four-three': '4:3',
  'three-four': '3:4'
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

/**
 * 对异步操作做指数退避重试。
 * 仅重试网络/超时类错误，业务错误（4xx、内容过滤）直接抛出。
 */
async function withRetry(fn, maxRetries = PROXY_MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable = (
        err.name === 'AbortError'
        || /timed out|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|other side closed|socket|fetch failed/i.test(err.message)
        || /did not return an image|upstream|502|503|504|Internal error|overloaded/i.test(err.message)
        || /rate limit|too many|quota|429/i.test(err.message)
        || (err.status >= 500 && err.status < 600)
      );
      const delay = /rate limit|too many|quota|429/i.test(err.message)
        ? 2000 * Math.pow(2, attempt)
        : 500 * Math.pow(2, attempt);
      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }
      console.warn(`[Retry] attempt ${attempt + 1}/${maxRetries} after ${delay}ms:`, err.message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function withResolvedApiKey(inputKey, req) {
  // 优先级：请求头 X-Api-Key > body/参数 > 环境变量
  const headerKey = req?.headers?.['x-api-key'];
  return headerKey || inputKey || process.env.FLOW2API_API_KEY || process.env.GEMINI_API_KEY || '';
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

function extractModelBase(model) {
  if (typeof model !== 'string') {
    return '';
  }

  const withoutSizeSuffix = model.trim().replace(/-(\d+k)$/i, '');
  return withoutSizeSuffix.replace(/-(portrait|landscape|square|four-three|three-four)$/i, '');
}

function buildGeminiImageContents(prompt, imageSources = []) {
  const parts = [{ text: ensurePrompt(prompt) }];

  for (const source of imageSources.filter(Boolean)) {
    if (typeof source !== 'string' || !source.startsWith('data:')) {
      throw new Error('Gemini image inputs must be base64 data URLs.');
    }

    const commaIndex = source.indexOf(',');
    if (commaIndex === -1) {
      throw new Error('Gemini image input is not a valid data URL.');
    }

    const header = source.slice(0, commaIndex);
    const data = source.slice(commaIndex + 1);
    const mimeTypeMatch = header.match(/^data:([^;]+);base64$/i);

    if (!mimeTypeMatch || !data) {
      throw new Error('Gemini image input is not a valid base64 data URL.');
    }

    parts.push({
      inlineData: {
        mimeType: mimeTypeMatch[1],
        data
      }
    });
  }

  return [{ role: 'user', parts }];
}

function parseGeminiImageResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    throw new Error('Gemini API did not return an image.');
  }

  // Format 1: inlineData base64 (official Gemini)
  const imagePart = parts.find((part) => {
    const inlineData = part?.inlineData;
    return inlineData?.data && typeof inlineData?.mimeType === 'string' && inlineData.mimeType.startsWith('image/');
  });

  if (imagePart) {
    return {
      type: 'base64',
      mimeType: imagePart.inlineData.mimeType,
      data: imagePart.inlineData.data
    };
  }

  // Format 2: URL inside markdown text (proxy gateway format)
  const textPart = parts.find((part) => typeof part?.text === 'string');
  if (textPart) {
    const mdMatch = textPart.text.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
    const urlMatch = mdMatch ? mdMatch[1] : textPart.text.match(/https?:\/\/\S+/)?.[0];
    if (urlMatch) {
      return { type: 'url', url: urlMatch };
    }
  }

  throw new Error('Gemini API did not return an image.');
}

function toFriendlyGeminiError(status, errorJson) {
  const rawMessage = errorJson?.error?.message || errorJson?.error?.status || '未知错误。';
  const errorStatus = (errorJson?.error?.status || '').toLowerCase();
  const lowerMessage = rawMessage.toLowerCase();

  if (
    status === 401
    || status === 403
    || errorStatus === 'permission_denied'
    || /invalid api key|api key not valid|unauthorized|authentication|forbidden|permission denied/i.test(lowerMessage)
  ) {
    return 'Gemini API key 无效或已过期，请重新填写。';
  }

  if (
    status === 404
    || errorStatus === 'not_found'
    || /model.*not found|not found/i.test(lowerMessage)
  ) {
    return `Gemini API 模型或接口地址不可用 (${status})：${rawMessage}`;
  }

  if (
    status === 429
    || errorStatus === 'resource_exhausted'
    || /rate limit|too many requests|quota|credits|resource exhausted/i.test(lowerMessage)
  ) {
    return 'Gemini API 当前已限流或额度不足，请稍后重试。';
  }

  if (status >= 500) {
    return `Gemini API 上游暂时不可用 (${status})：${rawMessage}`;
  }

  return `Gemini API 请求失败 (${status})：${rawMessage}`;
}

async function callGeminiGenerateContent({ contents, apiKey, model, aspectRatio, imageSize, prompt, imageSources = [] }) {
  const resolvedApiKey = withResolvedApiKey(apiKey);
  if (!resolvedApiKey) {
    throw new Error('Missing Gemini API key.');
  }

  const fullModel = typeof model === 'string' ? model.trim() : '';
  if (!fullModel) {
    throw new Error('Gemini model is required.');
  }

  const ratioMatch = fullModel.replace(/-(\d+k)$/i, '').match(/-(portrait|landscape|square|four-three|three-four)$/i);
  const ratioKey = ratioMatch ? ratioMatch[1].toLowerCase() : 'landscape';
  const imageConfig = {
    aspectRatio: aspectRatio || RATIO_MAP[ratioKey] || '16:9'
  };

  if (imageSize === '2K') {
    imageConfig.imageSize = '2K';
  }

  const requestContents = Array.isArray(contents) && contents.length
    ? contents
    : buildGeminiImageContents(prompt, imageSources);

  const payload = {
    systemInstruction: {
      parts: [{ text: 'Return an image only.' }]
    },
    contents: requestContents,
    generationConfig: {
      responseModalities: ['IMAGE']
    }
  };

  let response;
  await withRetry(async () => {
    const { controller, timeoutId } = createAbortController();
    try {
      response = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${fullModel}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resolvedApiKey}`,
          'Connection': 'close'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      clearAbortTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Gemini API request timed out.');
      }
      throw new Error(`Gemini API request failed: ${error.message}${error.cause ? ' | cause: ' + error.cause : ''}`);
    }
    clearAbortTimeout(timeoutId);

    if (!response.ok) {
      let errorText = '';
      try {
        errorText = await response.text();
      } catch {
        errorText = '';
      }
      console.log('[Gemini DEBUG] error status:', response.status, 'body:', errorText.slice(0, 800));

      let errorJson;
      try {
        errorJson = errorText ? JSON.parse(errorText) : {};
      } catch {
        errorJson = {
          error: {
            message: errorText || '未知错误。'
          }
        };
      }

      const error = new Error(toFriendlyGeminiError(response.status, errorJson));
      error.status = response.status;
      throw error;
    }
  });

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new Error(`Gemini API returned invalid JSON: ${error.message}`);
  }

  console.log('[Gemini DEBUG] response JSON:', JSON.stringify(json).slice(0, 800));
  const parsed = parseGeminiImageResponse(json);

  if (parsed.type === 'base64') {
    return { imageBase64: `data:${parsed.mimeType};base64,${parsed.data}` };
  }

  // type === 'url': download and convert to base64
  const { controller: dlController, timeoutId: dlTimeoutId } = createAbortController();
  let dlResponse;
  try {
    dlResponse = await fetch(parsed.url, { signal: dlController.signal, headers: { 'Connection': 'close' } });
  } catch (err) {
    clearAbortTimeout(dlTimeoutId);
    throw new Error(`Image download failed: ${err.message}`);
  }
  clearAbortTimeout(dlTimeoutId);
  if (!dlResponse.ok) {
    throw new Error(`Image download failed (${dlResponse.status})`);
  }
  const arrayBuffer = await dlResponse.arrayBuffer();
  const contentType = dlResponse.headers.get('content-type') || 'image/png';
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return { imageBase64: `data:${contentType};base64,${base64}` };
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

  let response;
  await withRetry(async () => {
    const { controller, timeoutId } = createAbortController();
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
      const error = new Error(toFriendlyFlow2ApiError(response.status, model, errorText));
      error.status = response.status;
      throw error;
    }
  });

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

  // SSRF 防护：仅允许白名单域名
  try {
    const parsedHost = new URL(sanitizedUrl).hostname.toLowerCase();
    if (!PROXY_ALLOWED_HOSTS.has(parsedHost)) {
      return res.status(403).json({ error: `Proxy target host not allowed: ${parsedHost}` });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid media URL.' });
  }

  // 图片代理内存缓存命中
  if (!fileName) {
    const cached = imageCacheGet(sanitizedUrl);
    if (cached) {
      res.set('Content-Type', cached.contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('X-Cache', 'HIT');
      return res.send(cached.buffer);
    }
  }

  const upstreamHeaders = {};
  if (req.headers.range) {
    upstreamHeaders.Range = req.headers.range;
  }

  const { controller, timeoutId } = createAbortController();
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

  // 图片代理：将响应 buffer 后写入缓存再发送
  if (!fileName) {
    const contentType = upstream.headers.get('content-type') || defaultContentType;
    try {
      const buffer = Buffer.from(await upstream.arrayBuffer());
      imageCacheSet(sanitizedUrl, contentType, buffer);
      res.set('X-Cache', 'MISS');
      return res.send(buffer);
    } catch {
      // buffer 失败则回退到流式
    }
  }

  Readable.fromWeb(upstream.body).pipe(res);
}

app.get('/api/config/status', (req, res) => {
  const configuredKey = withResolvedApiKey('');
  res.json({
    hasServerKey: Boolean(configuredKey),
    flow2apiBaseUrl: FLOW2API_BASE_URL,
    geminiBaseUrl: GEMINI_BASE_URL,
    message: configuredKey ? 'Server-side API key is configured.' : 'Configure an API key in the browser or server environment.'
  });
});

app.post('/api/generate', async (req, res) => {
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const model = req.body.model || DEFAULT_IMAGE_MODEL;
    const apiKey = withResolvedApiKey(req.body.apiKey, req);

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Gemini API key is required.' });
    }

    const result = await callGeminiGenerateContent({ prompt, imageSources: [], apiKey, model });

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      imageBase64: result.imageBase64,
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
    const apiKey = withResolvedApiKey(req.body.apiKey, req);

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required.' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Gemini API key is required.' });
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

    const result = await callGeminiGenerateContent({ prompt, imageSources, apiKey, model });

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      imageBase64: result.imageBase64,
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
    const apiKey = withResolvedApiKey(req.body.apiKey, req);

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
    const apiKey = withResolvedApiKey(req.body.apiKey, req);
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
    const apiKey = withResolvedApiKey(req.body.apiKey, req);
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
