import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
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
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of imageCache) {
    if (now - entry.ts > IMAGE_CACHE_TTL_MS) {
      imageCache.delete(key);
    }
  }
}, IMAGE_CACHE_TTL_MS);

function cacheGeneratedImageBuffer(buffer, contentType) {
  const cacheKey = `generated:${uuidv4()}`;
  imageCacheSet(cacheKey, contentType, buffer);
  return `/api/generated-image/${encodeURIComponent(cacheKey)}`;
}
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const DEFAULT_VIDEO_MODELS = {
  text2video: {
    landscape: 'veo_3_1-4K',
    portrait: 'veo_3_1-4K'
  },
  frame2video: {
    landscape: 'veo_3_1-4K',
    portrait: 'veo_3_1-4K'
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
const OPENAI_IMAGE_SIZE_MAP = {
  portrait: '1024x1536',
  landscape: '1536x1024',
  square: '1024x1024',
  'four-three': '1536x1152',
  'three-four': '1152x1536'
};

const VIDEO_ASPECT_RATIO_MAP = {
  portrait: '9:16',
  landscape: '16:9'
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(compression());

const rateLimitPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE || 30);
if (rateLimitPerMinute > 0) {
  app.use('/api/', rateLimit({
    windowMs: 60 * 1000,
    max: rateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again later.', code: 'rate_limited' }
  }));
}
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
async function withRetry(fn, maxRetries = PROXY_MAX_RETRIES, retryState = null) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (retryState) {
        retryState.attempts = attempt + 1;
      }
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

function toDataUrlFromUpload(file) {
  const mimeType = file?.mimetype || getMimeType(file?.originalname || '');
  return `data:${mimeType};base64,${file.buffer.toString('base64')}`;
}

function logRequestTelemetry({ requestId, route, model, status, code = 'ok', retryable = false, retryCount = 0, totalMs, extra = {} }) {
  console.log('[Telemetry]', JSON.stringify({
    requestId,
    route,
    model,
    status,
    code,
    retryable,
    retryCount,
    totalMs,
    ...extra
  }));
}

function createAppError(message, { status = 500, code = 'internal_error', retryable = false, details } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  if (details) {
    error.details = details;
  }
  return error;
}

function sendAppError(res, error, fallbackMessage) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  res.status(status).json({
    success: false,
    error: error?.message || fallbackMessage,
    code: error?.code || 'internal_error',
    status,
    retryable: Boolean(error?.retryable)
  });
}

function getContentType(response) {
  return (response?.headers?.get('content-type') || '').toLowerCase();
}

function getContentLength(response) {
  const raw = response?.headers?.get('content-length');
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isJsonContentType(contentType) {
  return contentType.includes('application/json') || contentType.includes('+json');
}

function isHtmlContentType(contentType) {
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}

function isSseContentType(contentType) {
  return contentType.includes('text/event-stream') || contentType.includes('text/plain');
}

function isExpectedMediaContentType(contentType, defaultContentType) {
  if (!contentType) return true;
  if (defaultContentType.startsWith('image/')) {
    return contentType.startsWith('image/');
  }
  if (defaultContentType.startsWith('video/')) {
    return contentType.startsWith('video/') || contentType === 'application/octet-stream';
  }
  return true;
}

function resolveImageAspectRatio(ratio, model) {
  if (typeof ratio === 'string' && RATIO_MAP[ratio]) {
    return RATIO_MAP[ratio];
  }
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  const ratioMatch = normalizedModel.replace(/-(\d+k)$/i, '').match(/-(portrait|landscape|square|four-three|three-four)$/i);
  const ratioKey = ratioMatch ? ratioMatch[1].toLowerCase() : 'landscape';
  return RATIO_MAP[ratioKey] || '16:9';
}

function resolveOpenAiImageSize(ratio) {
  return OPENAI_IMAGE_SIZE_MAP[ratio] || OPENAI_IMAGE_SIZE_MAP.square;
}

function resolveVideoAspectRatio(ratio) {
  return VIDEO_ASPECT_RATIO_MAP[ratio] || VIDEO_ASPECT_RATIO_MAP.landscape;
}

function getFlow2ApiRestBaseUrl() {
  const url = new URL(FLOW2API_BASE_URL);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/i, '');
  return url.toString().replace(/\/$/, '');
}

function parseDataUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

function getImageMimeType(outputFormat = 'png') {
  const format = (outputFormat || 'png').toLowerCase();
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function getImageOutputFormatFromMime(mimeType = 'image/png') {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpeg';
  if (normalized.includes('webp')) return 'webp';
  return 'png';
}

function parseOpenAiImageResponse(json, outputFormat = 'png') {
  const item = json?.data?.[0];
  if (!item) {
    throw createAppError('OpenAI image API did not return any image data.', {
      status: 502,
      code: 'image_data_missing',
      retryable: true
    });
  }
  if (item.b64_json) {
    const contentType = getImageMimeType(outputFormat);
    const buffer = Buffer.from(item.b64_json, 'base64');
    return {
      imageBase64: null,
      imageUrl: cacheGeneratedImageBuffer(buffer, contentType),
      imageMimeType: contentType,
      imageOutputFormat: getImageOutputFormatFromMime(contentType),
      imageResponseFormat: 'b64_json',
      imageBytes: buffer.length,
      revisedPrompt: item.revised_prompt || null
    };
  }
  if (item.url) {
    let remoteHost = null;
    try {
      remoteHost = new URL(item.url).hostname;
    } catch {
      remoteHost = null;
    }
    return {
      imageBase64: null,
      imageUrl: `/api/proxy-image?url=${encodeURIComponent(item.url)}`,
      imageMimeType: getImageMimeType(outputFormat),
      imageOutputFormat: getImageOutputFormatFromMime(getImageMimeType(outputFormat)),
      imageResponseFormat: 'url',
      imageBytes: null,
      remoteHost,
      revisedPrompt: item.revised_prompt || null
    };
  }
  throw createAppError('OpenAI image API returned an image response without b64_json or url.', {
    status: 502,
    code: 'image_data_missing',
    retryable: true
  });
}

function classifyFlow2ApiError(status, model, errorText) {
  const parsed = parseUpstreamError(errorText);
  const rawMessage = parsed?.message || errorText || '';
  const errorCode = (parsed?.code || '').toLowerCase();
  const lowerMessage = rawMessage.toLowerCase();

  if (status === 401 || status === 403 || /invalid api key|invalid token|unauthorized|authentication|bearer/i.test(rawMessage)) {
    return {
      message: 'Flow2API key 无效或已过期，请重新填写。',
      code: 'invalid_api_key',
      retryable: false
    };
  }

  if (errorCode === 'model_not_found' || /no available channel for model|model_not_found|model not found/i.test(lowerMessage)) {
    return {
      message: `当前上游渠道不可用模型 ${model}。这通常是 API Key/渠道不匹配，或该渠道暂未开通这个模型。`,
      code: 'model_not_found',
      retryable: false
    };
  }

  if (status === 429 || /rate limit|too many requests|quota|credits/i.test(lowerMessage)) {
    return {
      message: 'Flow2API 当前已限流或额度不足，请稍后重试或检查账户额度。',
      code: 'upstream_rate_limited',
      retryable: true
    };
  }

  if (/unusual activity|recaptcha evaluation failed|captcha/i.test(lowerMessage)) {
    return {
      message: `Flow2API 将当前请求判定为异常活动：${rawMessage}`,
      code: 'upstream_unusual_activity',
      retryable: true
    };
  }

  if (status >= 500) {
    return {
      message: `Flow2API 上游暂时不可用 (${status})：${rawMessage || '请稍后重试。'}`,
      code: 'upstream_unavailable',
      retryable: true
    };
  }

  return {
    message: `Flow2API 请求失败 (${status})：${rawMessage || '未知错误。'}`,
    code: errorCode || 'upstream_request_failed',
    retryable: false
  };
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

function classifyGeminiError(status, errorJson) {
  const rawMessage = errorJson?.error?.message || errorJson?.error?.status || '未知错误。';
  const errorStatus = (errorJson?.error?.status || '').toLowerCase();
  const lowerMessage = rawMessage.toLowerCase();

  if (
    status === 401
    || status === 403
    || errorStatus === 'permission_denied'
    || /invalid api key|api key not valid|unauthorized|authentication|forbidden|permission denied/i.test(lowerMessage)
  ) {
    return {
      message: 'Gemini API key 无效或已过期，请重新填写。',
      code: 'invalid_api_key',
      retryable: false
    };
  }

  if (
    status === 404
    || errorStatus === 'not_found'
    || /model.*not found|not found/i.test(lowerMessage)
  ) {
    return {
      message: `Gemini API 模型或接口地址不可用 (${status})：${rawMessage}`,
      code: 'model_not_found',
      retryable: false
    };
  }

  if (
    status === 429
    || errorStatus === 'resource_exhausted'
    || /rate limit|too many requests|quota|credits|resource exhausted/i.test(lowerMessage)
  ) {
    return {
      message: 'Gemini API 当前已限流或额度不足，请稍后重试。',
      code: 'upstream_rate_limited',
      retryable: true
    };
  }

  if (/unusual activity|recaptcha evaluation failed|captcha/i.test(lowerMessage)) {
    return {
      message: `Gemini API 将当前请求判定为异常活动：${rawMessage}`,
      code: 'upstream_unusual_activity',
      retryable: true
    };
  }

  if (status >= 500) {
    return {
      message: `Gemini API 上游暂时不可用 (${status})：${rawMessage}`,
      code: 'upstream_unavailable',
      retryable: true
    };
  }

  return {
    message: `Gemini API 请求失败 (${status})：${rawMessage}`,
    code: errorStatus || 'upstream_request_failed',
    retryable: false
  };
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

  const imageConfig = {
    aspectRatio: aspectRatio || resolveImageAspectRatio(null, fullModel)
  };

  imageConfig.imageSize = imageSize || '1K';

  const isPreviewModel = fullModel === 'gemini-3.1-flash-image-preview';

  const requestContents = Array.isArray(contents) && contents.length
    ? contents
    : buildGeminiImageContents(prompt, imageSources);

  const payload = {
    contents: requestContents,
    generationConfig: {
      responseModalities: isPreviewModel ? ['IMAGE', 'TEXT'] : ['IMAGE'],
      imageConfig
    }
  };

  if (!isPreviewModel) {
    payload.systemInstruction = {
      parts: [{ text: 'Return an image only.' }]
    };
  } else {
    payload.generationConfig.thinkingConfig = {
      thinkingLevel: 'MINIMAL'
    };
  }

  let response;
  const retryState = { attempts: 0 };
  await withRetry(async () => {
    const { controller, timeoutId } = createAbortController();
    try {
      response = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${fullModel}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': resolvedApiKey,
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

      const classified = classifyGeminiError(response.status, errorJson);
      throw createAppError(classified.message, {
        status: response.status,
        code: classified.code,
        retryable: classified.retryable,
        details: { errorJson, retryCount: Math.max(0, retryState.attempts - 1) }
      });
    }
  }, PROXY_MAX_RETRIES, retryState);

  const responseContentType = getContentType(response);
  if (isHtmlContentType(responseContentType)) {
    const htmlText = await safeReadErrorText(response);
    throw createAppError('Gemini 接口返回了 HTML 页面而不是 JSON，通常表示上游网关返回了挑战页或错误页面。', {
      status: 502,
      code: 'html_response_instead_of_json',
      retryable: true,
      details: { snippet: htmlText, retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }
  if (!isJsonContentType(responseContentType)) {
    const bodyText = await safeReadErrorText(response);
    throw createAppError(`Gemini 接口返回了意外的内容类型：${responseContentType || 'unknown'}`, {
      status: 502,
      code: 'unexpected_content_type',
      retryable: true,
      details: { snippet: bodyText, retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new Error(`Gemini API returned invalid JSON: ${error.message}`);
  }

  console.log('[Gemini DEBUG] response JSON:', JSON.stringify(json).slice(0, 800));
  const parsed = parseGeminiImageResponse(json);

  if (parsed.type === 'base64') {
    return {
      imageBase64: `data:${parsed.mimeType};base64,${parsed.data}`,
      imageUrl: null,
      imageMimeType: parsed.mimeType,
      imageOutputFormat: getImageOutputFormatFromMime(parsed.mimeType),
      retryCount: Math.max(0, retryState.attempts - 1)
    };
  }

  return {
    imageBase64: null,
    imageUrl: `/api/proxy-image?url=${encodeURIComponent(parsed.url)}`,
    imageMimeType: 'image/png',
    imageOutputFormat: 'png',
    retryCount: Math.max(0, retryState.attempts - 1)
  };
}

function isOpenAiImageModel(model) {
  return model === 'gpt-image-2';
}

async function callOpenAiImageGenerate({ prompt, apiKey, model, size, quality, background, outputFormat }) {
  const resolvedApiKey = withResolvedApiKey(apiKey);
  if (!resolvedApiKey) {
    throw new Error('Missing API key for OpenAI image model.');
  }

  const timing = {
    operation: 'generate',
    model,
    size,
    quality: quality || null,
    background: background || null,
    outputFormat: outputFormat || null
  };
  const requestStartedAt = Date.now();

  const payload = {
    model,
    prompt,
    size
  };
  if (quality) payload.quality = quality;
  if (background) payload.background = background;
  if (outputFormat) payload.output_format = outputFormat;

  let response;
  const retryState = { attempts: 0 };
  await withRetry(async () => {
    const { controller, timeoutId } = createAbortController();
    try {
      const fetchStartedAt = Date.now();
      response = await fetch(`${getFlow2ApiRestBaseUrl()}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolvedApiKey}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      timing.upstreamHeadersMs = Date.now() - fetchStartedAt;
    } catch (error) {
      clearAbortTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('OpenAI image generation request timed out.');
      }
      throw new Error(`OpenAI image generation request failed: ${error.message}`);
    }
    clearAbortTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await safeReadErrorText(response);
      const classified = classifyFlow2ApiError(response.status, model, errorText);
      throw createAppError(classified.message, {
        status: response.status,
        code: classified.code,
        retryable: classified.retryable,
        details: { upstream: parseUpstreamError(errorText), retryCount: Math.max(0, retryState.attempts - 1) }
      });
    }
  }, PROXY_MAX_RETRIES, retryState);

  const responseContentType = getContentType(response);
  timing.responseContentType = responseContentType || null;
  timing.responseContentLength = getContentLength(response);
  if (isHtmlContentType(responseContentType)) {
    const htmlText = await safeReadErrorText(response);
    throw createAppError('OpenAI image API returned HTML instead of JSON.', {
      status: 502,
      code: 'html_response_instead_of_json',
      retryable: true,
      details: { snippet: htmlText, retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }
  if (!isJsonContentType(responseContentType)) {
    const bodyText = await safeReadErrorText(response);
    throw createAppError(`OpenAI image API returned unexpected content type: ${responseContentType || 'unknown'}`, {
      status: 502,
      code: 'unexpected_content_type',
      retryable: true,
      details: { snippet: bodyText, retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }

  let json;
  try {
    const bodyStartedAt = Date.now();
    json = await response.json();
    timing.upstreamBodyJsonMs = Date.now() - bodyStartedAt;
  } catch (error) {
    throw new Error(`OpenAI image API returned invalid JSON: ${error.message}`);
  }

  const parseStartedAt = Date.now();
  const parsed = parseOpenAiImageResponse(json, outputFormat);
  timing.parseImageMs = Date.now() - parseStartedAt;
  console.log('[OpenAI Image Timing]', JSON.stringify({
    ...timing,
    responseFormat: parsed.imageResponseFormat || null,
    imageBytes: parsed.imageBytes || null,
    remoteHost: parsed.remoteHost || null,
    totalMs: Date.now() - requestStartedAt,
    retryCount: Math.max(0, retryState.attempts - 1)
  }));

  return {
    ...parsed,
    retryCount: Math.max(0, retryState.attempts - 1)
  };
}

async function callOpenAiImageEdit({ prompt, apiKey, model, size, quality, background, outputFormat, imageSources }) {
  const resolvedApiKey = withResolvedApiKey(apiKey);
  if (!resolvedApiKey) {
    throw new Error('Missing API key for OpenAI image model.');
  }

  const timing = {
    operation: 'edit',
    model,
    size,
    quality: quality || null,
    background: background || null,
    outputFormat: outputFormat || null,
    inputImageCount: imageSources.length
  };
  const requestStartedAt = Date.now();

  const formData = new FormData();
  formData.append('model', model);
  formData.append('prompt', prompt);
  formData.append('size', size);
  if (quality) formData.append('quality', quality);
  if (background) formData.append('background', background);
  if (outputFormat) formData.append('output_format', outputFormat);
  for (const [index, imageSource] of imageSources.entries()) {
    const parsed = parseDataUrl(imageSource);
    if (!parsed) continue;
    formData.append('image[]', new Blob([parsed.buffer], { type: parsed.mimeType }), `image-${index + 1}.png`);
  }

  let response;
  const retryState = { attempts: 0 };
  await withRetry(async () => {
    const { controller, timeoutId } = createAbortController();
    try {
      const fetchStartedAt = Date.now();
      response = await fetch(`${getFlow2ApiRestBaseUrl()}/images/edits`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolvedApiKey}`
        },
        body: formData,
        signal: controller.signal
      });
      timing.upstreamHeadersMs = Date.now() - fetchStartedAt;
    } catch (error) {
      clearAbortTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('OpenAI image edit request timed out.');
      }
      throw new Error(`OpenAI image edit request failed: ${error.message}`);
    }
    clearAbortTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await safeReadErrorText(response);
      const classified = classifyFlow2ApiError(response.status, model, errorText);
      throw createAppError(classified.message, {
        status: response.status,
        code: classified.code,
        retryable: classified.retryable,
        details: { upstream: parseUpstreamError(errorText), retryCount: Math.max(0, retryState.attempts - 1) }
      });
    }
  }, PROXY_MAX_RETRIES, retryState);

  const responseContentType = getContentType(response);
  timing.responseContentType = responseContentType || null;
  timing.responseContentLength = getContentLength(response);
  if (isHtmlContentType(responseContentType)) {
    const htmlText = await safeReadErrorText(response);
    throw createAppError('OpenAI image API returned HTML instead of JSON.', {
      status: 502,
      code: 'html_response_instead_of_json',
      retryable: true,
      details: { snippet: htmlText, retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }
  if (!isJsonContentType(responseContentType)) {
    const bodyText = await safeReadErrorText(response);
    throw createAppError(`OpenAI image API returned unexpected content type: ${responseContentType || 'unknown'}`, {
      status: 502,
      code: 'unexpected_content_type',
      retryable: true,
      details: { snippet: bodyText, retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }

  let json;
  try {
    const bodyStartedAt = Date.now();
    json = await response.json();
    timing.upstreamBodyJsonMs = Date.now() - bodyStartedAt;
  } catch (error) {
    throw new Error(`OpenAI image API returned invalid JSON: ${error.message}`);
  }

  const parseStartedAt = Date.now();
  const parsed = parseOpenAiImageResponse(json, outputFormat);
  timing.parseImageMs = Date.now() - parseStartedAt;
  console.log('[OpenAI Image Timing]', JSON.stringify({
    ...timing,
    responseFormat: parsed.imageResponseFormat || null,
    imageBytes: parsed.imageBytes || null,
    remoteHost: parsed.remoteHost || null,
    totalMs: Date.now() - requestStartedAt,
    retryCount: Math.max(0, retryState.attempts - 1)
  }));

  return {
    ...parsed,
    retryCount: Math.max(0, retryState.attempts - 1)
  };
}

async function callFlow2Api({ messages, apiKey, model, type, parameters }) {
  const resolvedApiKey = withResolvedApiKey(apiKey);
  if (!resolvedApiKey) {
    throw new Error('Missing Flow2API key.');
  }

  const payload = {
    model,
    stream: true,
    messages
  };

  if (parameters && Object.keys(parameters).length > 0) {
    payload.parameters = parameters;
  }

  let response;
  const retryState = { attempts: 0 };
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
      const classified = classifyFlow2ApiError(response.status, model, errorText);
      throw createAppError(classified.message, {
        status: response.status,
        code: classified.code,
        retryable: classified.retryable,
        details: { upstream: parseUpstreamError(errorText), retryCount: Math.max(0, retryState.attempts - 1) }
      });
    }
  }, PROXY_MAX_RETRIES, retryState);

  const responseContentType = getContentType(response);
  if (isHtmlContentType(responseContentType)) {
    const htmlText = await safeReadErrorText(response);
    throw createAppError('Flow2API 返回了 HTML 页面而不是事件流，通常表示网关挑战页或前台页面被命中。', {
      status: 502,
      code: 'html_response_instead_of_sse',
      retryable: true,
      details: { snippet: htmlText, retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }
  if (!isSseContentType(responseContentType)) {
    const bodyText = await safeReadErrorText(response);
    throw createAppError(`Flow2API 返回了意外的内容类型：${responseContentType || 'unknown'}`, {
      status: 502,
      code: 'unexpected_content_type',
      retryable: true,
      details: { snippet: bodyText, retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }

  const rawText = await response.text();
  const parsed = parseSSEStream(rawText);

  if (parsed.errorMessage) {
    throw createAppError(parsed.errorMessage, {
      status: 502,
      code: 'upstream_sse_error',
      retryable: true,
      details: { retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }

  const mediaUrl = pickMediaUrl(parsed, type);
  if (!mediaUrl) {
    throw createAppError(`Unable to extract ${type} URL from Flow2API response.`, {
      status: 502,
      code: 'media_url_missing',
      retryable: true,
      details: { retryCount: Math.max(0, retryState.attempts - 1) }
    });
  }

  return {
    mediaUrl,
    rawText,
    parsed,
    retryCount: Math.max(0, retryState.attempts - 1)
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

async function proxyMediaRequest(req, res, url, defaultContentType, fileName, depth = 0) {
  const proxyStartedAt = Date.now();
  const proxyRequestId = uuidv4();
  const sanitizedUrl = sanitizeUrl(url);
  if (!sanitizedUrl || sanitizedUrl.startsWith('data:')) {
    return res.status(400).json({ error: 'Invalid media URL.' });
  }

  // SSRF 防护：仅允许白名单域名
  let targetInfo;
  try {
    const parsedUrl = new URL(sanitizedUrl);
    const parsedHost = parsedUrl.hostname.toLowerCase();
    if (!PROXY_ALLOWED_HOSTS.has(parsedHost)) {
      return res.status(403).json({ error: `Proxy target host not allowed: ${parsedHost}` });
    }
    targetInfo = {
      host: parsedHost,
      pathTail: parsedUrl.pathname.slice(-80) || '/'
    };
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
      console.log('[Proxy Media Timing]', JSON.stringify({
        requestId: proxyRequestId,
        mediaType: defaultContentType.startsWith('image/') ? 'image' : 'video',
        cache: 'HIT',
        targetHost: targetInfo.host,
        targetPathTail: targetInfo.pathTail,
        bytes: cached.buffer.length,
        totalMs: Date.now() - proxyStartedAt
      }));
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
    const upstreamStartedAt = Date.now();
    upstream = await fetch(sanitizedUrl, {
      signal: controller.signal,
      headers: upstreamHeaders,
      redirect: 'manual'
    });
    console.log('[Proxy Media Headers]', JSON.stringify({
      requestId: proxyRequestId,
      mediaType: defaultContentType.startsWith('image/') ? 'image' : 'video',
      targetHost: targetInfo.host,
      targetPathTail: targetInfo.pathTail,
      status: upstream.status,
      contentType: getContentType(upstream) || null,
      contentLength: getContentLength(upstream),
      headersMs: Date.now() - upstreamStartedAt
    }));
  } catch (error) {
    clearAbortTimeout(timeoutId);
    const message = error.name === 'AbortError' ? 'Media proxy timed out.' : `Media proxy failed: ${error.message}`;
    return res.status(502).json({ error: message });
  }

  clearAbortTimeout(timeoutId);

  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const location = upstream.headers.get('location');
    if (!location) {
      return res.status(502).json({ error: 'Upstream redirect without Location header.' });
    }
    if (depth >= 3) {
      return res.status(502).json({ error: 'Too many redirects.' });
    }
    try {
      const redirectHost = new URL(location).hostname.toLowerCase();
      if (!PROXY_ALLOWED_HOSTS.has(redirectHost)) {
        return res.status(403).json({ error: `Redirect target host not allowed: ${redirectHost}` });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid redirect URL.' });
    }
    return proxyMediaRequest(req, res, location, defaultContentType, fileName, depth + 1);
  }

  if (!upstream.ok) {
    const errorText = await safeReadErrorText(upstream);
    return res.status(upstream.status).json({ error: errorText });
  }

  const upstreamContentType = getContentType(upstream);
  if (!isExpectedMediaContentType(upstreamContentType, defaultContentType)) {
    const errorText = await safeReadErrorText(upstream);
    return res.status(502).json({
      error: `Unexpected upstream content type: ${upstreamContentType || 'unknown'}`,
      code: isHtmlContentType(upstreamContentType) ? 'html_response_instead_of_media' : 'unexpected_content_type',
      details: errorText
    });
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
      const bufferStartedAt = Date.now();
      const buffer = Buffer.from(await upstream.arrayBuffer());
      imageCacheSet(sanitizedUrl, contentType, buffer);
      res.set('X-Cache', 'MISS');
      console.log('[Proxy Media Timing]', JSON.stringify({
        requestId: proxyRequestId,
        mediaType: 'image',
        cache: 'MISS',
        targetHost: targetInfo.host,
        targetPathTail: targetInfo.pathTail,
        bytes: buffer.length,
        bodyBufferMs: Date.now() - bufferStartedAt,
        totalMs: Date.now() - proxyStartedAt
      }));
      return res.send(buffer);
    } catch (err) {
      console.error('[Proxy] Failed to buffer image:', err.message);
      return res.status(502).json({ error: 'Failed to buffer upstream image response.' });
    }
  }

  Readable.fromWeb(upstream.body).pipe(res);
}

app.get('/api/config/status', (req, res) => {
  const configuredKey = withResolvedApiKey('');
  res.json({
    hasServerKey: Boolean(configuredKey),
    message: configuredKey ? 'Server-side API key is configured.' : 'Configure an API key in the browser or server environment.'
  });
});

app.post('/api/generate', async (req, res) => {
  const requestId = uuidv4();
  const startedAt = Date.now();
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const model = req.body.model || DEFAULT_IMAGE_MODEL;
    const aspectRatio = resolveImageAspectRatio(req.body.ratio, model);
    const apiKey = withResolvedApiKey(req.body.apiKey, req);
    const quality = req.body.quality;
    const background = req.body.background;
    const outputFormat = req.body.outputFormat;

    if (!prompt) {
      return sendAppError(res, createAppError('Prompt is required.', { status: 400, code: 'prompt_required' }), 'Image generation failed.');
    }

    if (!apiKey) {
      return sendAppError(res, createAppError('API key is required.', { status: 400, code: 'api_key_required' }), 'Image generation failed.');
    }

    let result;
    if (isOpenAiImageModel(model)) {
      result = await callOpenAiImageGenerate({ prompt, apiKey, model, size: resolveOpenAiImageSize(req.body.ratio), quality, background, outputFormat });
    } else {
      result = await callGeminiGenerateContent({ prompt, imageSources: [], apiKey, model, aspectRatio });
    }

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      imageBase64: result.imageBase64 || null,
      imageUrl: result.imageUrl || null,
      imageMimeType: result.imageMimeType || null,
      imageOutputFormat: result.imageOutputFormat || null,
      createdAt: new Date().toISOString()
    });
    logRequestTelemetry({ requestId, route: '/api/generate', model, status: 200, retryCount: result.retryCount || 0, totalMs: Date.now() - startedAt });
  } catch (error) {
    console.error('Image generation failed:', error);
    logRequestTelemetry({ requestId, route: '/api/generate', model: req.body.model || DEFAULT_IMAGE_MODEL, status: error.status || 500, code: error.code || 'internal_error', retryable: Boolean(error.retryable), retryCount: error.details?.retryCount || 0, totalMs: Date.now() - startedAt });
    sendAppError(res, error, 'Image generation failed.');
  }
});

app.post('/api/edit', upload.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'referenceImages', maxCount: 5 }
]), async (req, res) => {
  const requestId = uuidv4();
  const startedAt = Date.now();
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const model = req.body.model || DEFAULT_IMAGE_MODEL;
    const aspectRatio = resolveImageAspectRatio(req.body.ratio, model);
    const apiKey = withResolvedApiKey(req.body.apiKey, req);
    const quality = req.body.quality;
    const background = req.body.background;
    const outputFormat = req.body.outputFormat;

    if (!prompt) {
      return sendAppError(res, createAppError('Prompt is required.', { status: 400, code: 'prompt_required' }), 'Image edit failed.');
    }

    if (!apiKey) {
      return sendAppError(res, createAppError('API key is required.', { status: 400, code: 'api_key_required' }), 'Image edit failed.');
    }

    const imageSources = [];

    if (req.body.mainImageBase64) {
      imageSources.push(req.body.mainImageBase64);
    } else if (req.files?.mainImage?.[0]) {
      imageSources.push(toDataUrlFromUpload(req.files.mainImage[0]));
    }

    if (imageSources.length === 0) {
      return sendAppError(res, createAppError('Main image is required.', { status: 400, code: 'main_image_required' }), 'Image edit failed.');
    }

    for (const refImage of req.files?.referenceImages || []) {
      imageSources.push(toDataUrlFromUpload(refImage));
    }

    for (const refBase64 of parseMaybeJsonArray(req.body.referenceImagesBase64)) {
      if (typeof refBase64 === 'string' && refBase64.startsWith('data:image/')) {
        imageSources.push(refBase64);
      }
    }

    let result;
    if (isOpenAiImageModel(model)) {
      result = await callOpenAiImageEdit({ prompt, apiKey, model, size: resolveOpenAiImageSize(req.body.ratio), quality, background, outputFormat, imageSources });
    } else {
      result = await callGeminiGenerateContent({ prompt, imageSources, apiKey, model, aspectRatio });
    }

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      imageBase64: result.imageBase64 || null,
      imageUrl: result.imageUrl || null,
      imageMimeType: result.imageMimeType || null,
      imageOutputFormat: result.imageOutputFormat || null,
      createdAt: new Date().toISOString()
    });
    logRequestTelemetry({ requestId, route: '/api/edit', model, status: 200, retryCount: result.retryCount || 0, totalMs: Date.now() - startedAt, extra: { inputImageCount: imageSources.length } });
  } catch (error) {
    console.error('Image edit failed:', error);
    logRequestTelemetry({ requestId, route: '/api/edit', model: req.body.model || DEFAULT_IMAGE_MODEL, status: error.status || 500, code: error.code || 'internal_error', retryable: Boolean(error.retryable), retryCount: error.details?.retryCount || 0, totalMs: Date.now() - startedAt });
    sendAppError(res, error, 'Image edit failed.');
  }
});

app.post('/api/generate-video', async (req, res) => {
  const requestId = uuidv4();
  const startedAt = Date.now();
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const ratio = req.body.ratio === 'portrait' ? 'portrait' : 'landscape';
    const model = req.body.model || DEFAULT_VIDEO_MODELS.text2video[ratio];
    const apiKey = withResolvedApiKey(req.body.apiKey, req);

    if (!prompt) {
      return sendAppError(res, createAppError('Prompt is required.', { status: 400, code: 'prompt_required' }), 'Text-to-video failed.');
    }

    if (!apiKey) {
      return sendAppError(res, createAppError('Flow2API key is required.', { status: 400, code: 'api_key_required' }), 'Text-to-video failed.');
    }

    const messages = [{ role: 'user', content: prompt }];
    const result = await callFlow2Api({
      messages,
      apiKey,
      model,
      type: 'video',
      parameters: { aspectRatio: resolveVideoAspectRatio(ratio) }
    });

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      videoUrl: result.mediaUrl,
      createdAt: new Date().toISOString()
    });
    logRequestTelemetry({ requestId, route: '/api/generate-video', model, status: 200, retryCount: result.retryCount || 0, totalMs: Date.now() - startedAt });
  } catch (error) {
    console.error('Text-to-video failed:', error);
    logRequestTelemetry({ requestId, route: '/api/generate-video', model: req.body.model || DEFAULT_VIDEO_MODELS.text2video[req.body.ratio === 'portrait' ? 'portrait' : 'landscape'], status: error.status || 500, code: error.code || 'internal_error', retryable: Boolean(error.retryable), retryCount: error.details?.retryCount || 0, totalMs: Date.now() - startedAt });
    sendAppError(res, error, 'Text-to-video failed.');
  }
});

app.post('/api/generate-video-from-frames', upload.fields([
  { name: 'startFrame', maxCount: 1 },
  { name: 'endFrame', maxCount: 1 }
]), async (req, res) => {
  const requestId = uuidv4();
  const startedAt = Date.now();
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const ratio = req.body.ratio === 'portrait' ? 'portrait' : 'landscape';
    const model = req.body.model || DEFAULT_VIDEO_MODELS.frame2video[ratio];
    const apiKey = withResolvedApiKey(req.body.apiKey, req);
    const startFrameBase64 = req.body.startFrameBase64 || (req.files?.startFrame?.[0] ? toDataUrlFromUpload(req.files.startFrame[0]) : null);
    const endFrameBase64 = req.body.endFrameBase64 || (req.files?.endFrame?.[0] ? toDataUrlFromUpload(req.files.endFrame[0]) : null);

    if (!prompt) {
      return sendAppError(res, createAppError('Prompt is required.', { status: 400, code: 'prompt_required' }), 'Frame-to-video failed.');
    }

    if (!apiKey) {
      return sendAppError(res, createAppError('Flow2API key is required.', { status: 400, code: 'api_key_required' }), 'Frame-to-video failed.');
    }

    if (!startFrameBase64) {
      return sendAppError(res, createAppError('Start frame is required.', { status: 400, code: 'start_frame_required' }), 'Frame-to-video failed.');
    }

    const messages = buildImageMessages(prompt, [startFrameBase64, endFrameBase64].filter(Boolean));
    const result = await callFlow2Api({
      messages,
      apiKey,
      model,
      type: 'video',
      parameters: { aspectRatio: resolveVideoAspectRatio(ratio) }
    });

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      videoUrl: result.mediaUrl,
      createdAt: new Date().toISOString()
    });
    logRequestTelemetry({ requestId, route: '/api/generate-video-from-frames', model, status: 200, retryCount: result.retryCount || 0, totalMs: Date.now() - startedAt, extra: { hasEndFrame: Boolean(endFrameBase64) } });
  } catch (error) {
    console.error('Frame-to-video failed:', error);
    logRequestTelemetry({ requestId, route: '/api/generate-video-from-frames', model: req.body.model || DEFAULT_VIDEO_MODELS.frame2video[req.body.ratio === 'portrait' ? 'portrait' : 'landscape'], status: error.status || 500, code: error.code || 'internal_error', retryable: Boolean(error.retryable), retryCount: error.details?.retryCount || 0, totalMs: Date.now() - startedAt });
    sendAppError(res, error, 'Frame-to-video failed.');
  }
});

app.post('/api/generate-video-from-references', upload.fields([
  { name: 'referenceImages', maxCount: 3 }
]), async (req, res) => {
  const requestId = uuidv4();
  const startedAt = Date.now();
  try {
    const prompt = ensurePrompt(req.body.prompt);
    const ratio = req.body.ratio === 'portrait' ? 'portrait' : 'landscape';
    const model = req.body.model || DEFAULT_VIDEO_MODELS.reference2video[ratio];
    const apiKey = withResolvedApiKey(req.body.apiKey, req);
    const referenceImages = parseMaybeJsonArray(req.body.referenceImagesBase64)
      .filter((item) => typeof item === 'string' && item.startsWith('data:image/'))
      .slice(0, 3);
    for (const refImage of req.files?.referenceImages || []) {
      if (referenceImages.length >= 3) break;
      referenceImages.push(toDataUrlFromUpload(refImage));
    }

    if (!prompt) {
      return sendAppError(res, createAppError('Prompt is required.', { status: 400, code: 'prompt_required' }), 'Reference-to-video failed.');
    }

    if (!apiKey) {
      return sendAppError(res, createAppError('Flow2API key is required.', { status: 400, code: 'api_key_required' }), 'Reference-to-video failed.');
    }

    if (referenceImages.length === 0) {
      return sendAppError(res, createAppError('At least one reference image is required.', { status: 400, code: 'reference_images_required' }), 'Reference-to-video failed.');
    }

    const messages = buildImageMessages(prompt, referenceImages);
    const result = await callFlow2Api({
      messages,
      apiKey,
      model,
      type: 'video',
      parameters: { aspectRatio: resolveVideoAspectRatio(ratio) }
    });

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      videoUrl: result.mediaUrl,
      createdAt: new Date().toISOString()
    });
    logRequestTelemetry({ requestId, route: '/api/generate-video-from-references', model, status: 200, retryCount: result.retryCount || 0, totalMs: Date.now() - startedAt, extra: { referenceCount: referenceImages.length } });
  } catch (error) {
    console.error('Reference-to-video failed:', error);
    logRequestTelemetry({ requestId, route: '/api/generate-video-from-references', model: req.body.model || DEFAULT_VIDEO_MODELS.reference2video[req.body.ratio === 'portrait' ? 'portrait' : 'landscape'], status: error.status || 500, code: error.code || 'internal_error', retryable: Boolean(error.retryable), retryCount: error.details?.retryCount || 0, totalMs: Date.now() - startedAt });
    sendAppError(res, error, 'Reference-to-video failed.');
  }
});

app.get('/api/proxy-image', async (req, res) => {
  return proxyMediaRequest(req, res, req.query.url, 'image/png');
});

app.get('/api/generated-image/:id', (req, res) => {
  const startedAt = Date.now();
  const cacheKey = req.params.id;
  const cached = imageCacheGet(cacheKey);
  if (!cached) {
    return res.status(404).json({ error: 'Generated image not found or expired.' });
  }
  res.set('Content-Type', cached.contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('X-Cache', 'HIT');
  console.log('[Generated Image Timing]', JSON.stringify({
    cache: 'HIT',
    contentType: cached.contentType,
    bytes: cached.buffer.length,
    totalMs: Date.now() - startedAt
  }));
  return res.send(cached.buffer);
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
