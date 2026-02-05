import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

// ES Module __dirname 兼容
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载环境变量
dotenvConfig();

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE_URL = 'https://vip.yyds168.net/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-3.0-pro-image-portrait';

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 文件上传配置
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB 限制
});

// 获取 MIME 类型
function getMimeType(filename) {
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

// 从流式响应中提取图片 URL
function extractImageUrl(text) {
  const urlPattern = /https?:\/\/[^\s"\\)\]>]+/g;
  const matches = text.match(urlPattern);
  if (matches) {
    for (const url of matches) {
      const cleanUrl = url.replace(/["'\\>]+$/, '');
      if (cleanUrl.match(/\.(png|jpg|jpeg|webp|gif)/i) || cleanUrl.includes('image') || cleanUrl.includes('cdn') || cleanUrl.includes('storage')) {
        return cleanUrl;
      }
    }
    return matches[0].replace(/["'\\>]+$/, '');
  }
  return null;
}

// 解析 SSE 流式响应
function parseSSEStream(rawText) {
  let fullContent = '';
  let reasoningContent = '';
  let hasError = false;
  let errorMessage = '';

  const lines = rawText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;

    const payloadStr = trimmed.slice(5).trim();
    if (payloadStr === '[DONE]') break;

    try {
      const data = JSON.parse(payloadStr);

      if (data.error) {
        hasError = true;
        errorMessage = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        break;
      }

      const choices = data.choices || [];
      if (choices.length === 0) continue;

      const delta = choices[0].delta || {};

      if (delta.content) {
        fullContent += delta.content;
      }
      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        if (['❌', '生成失败', '违规'].some(kw => delta.reasoning_content.includes(kw))) {
          hasError = true;
          errorMessage = delta.reasoning_content;
        }
      }
    } catch (e) {
      continue;
    }
  }

  return { fullContent, reasoningContent, hasError, errorMessage };
}

// 调用 API 生成图片
async function callImageApi(messages, apiKey, model = DEFAULT_MODEL) {
  const payload = {
    model,
    stream: true,
    messages
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);

  let response;
  try {
    response = await fetch(API_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error('请求超时，请重试');
    }
    throw new Error(`网络请求失败: ${e.message}`);
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  const rawText = await response.text();
  const { fullContent, reasoningContent, hasError, errorMessage } = parseSSEStream(rawText);

  if (hasError) {
    throw new Error(`生成失败: ${errorMessage}`);
  }

  const allContent = fullContent + ' ' + reasoningContent;
  const imageUrl = extractImageUrl(allContent);

  if (!imageUrl) {
    throw new Error('未能从响应中提取图片 URL');
  }

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`图片下载失败: ${imageUrl}`);
  }

  const arrayBuffer = await imageResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64 = buffer.toString('base64');

  return {
    imageUrl,
    imageBase64: `data:image/png;base64,${base64}`,
    rawResponse: rawText
  };
}

// API 路由：文生图
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, apiKey, model } = req.body;

    if (!prompt) {
      return res.status(400).json({ success: false, error: '请输入提示词' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: '请配置 API Key' });
    }

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt }
        ]
      }
    ];

    const result = await callImageApi(messages, apiKey, model);

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      imageBase64: result.imageBase64,
      imageUrl: result.imageUrl,
      createdAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('生成图片失败:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || '生成图片失败'
    });
  }
});

// API 路由：图生图
app.post('/api/edit', upload.fields([
  { name: 'mainImage', maxCount: 1 },
  { name: 'referenceImages', maxCount: 5 }
]), async (req, res) => {
  try {
    const { prompt, apiKey, model, mainImageBase64 } = req.body;

    if (!prompt) {
      return res.status(400).json({ success: false, error: '请输入编辑提示词' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: '请配置 API Key' });
    }

    const contentParts = [{ type: 'text', text: prompt }];

    // 处理主图片
    if (mainImageBase64) {
      // 从 base64 字符串获取图片
      contentParts.push({
        type: 'image_url',
        image_url: { url: mainImageBase64 }
      });
    } else if (req.files && req.files['mainImage']) {
      const mainImage = req.files['mainImage'][0];
      const mimeType = getMimeType(mainImage.originalname);
      const base64 = mainImage.buffer.toString('base64');
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${base64}` }
      });
    } else {
      return res.status(400).json({ success: false, error: '请上传要编辑的图片' });
    }

    // 处理参考图片
    if (req.files && req.files['referenceImages']) {
      for (const refImage of req.files['referenceImages']) {
        const mimeType = getMimeType(refImage.originalname);
        const base64 = refImage.buffer.toString('base64');
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}` }
        });
      }
    }

    // 处理 base64 格式的参考图片
    const referenceImagesBase64 = req.body.referenceImagesBase64;
    if (referenceImagesBase64) {
      const refImages = JSON.parse(referenceImagesBase64);
      for (const refBase64 of refImages) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: refBase64 }
        });
      }
    }

    const messages = [
      {
        role: 'user',
        content: contentParts
      }
    ];

    const result = await callImageApi(messages, apiKey, model);

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      imageBase64: result.imageBase64,
      imageUrl: result.imageUrl,
      createdAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('编辑图片失败:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || '编辑图片失败'
    });
  }
});

// API 路由：检查配置状态
app.get('/api/config/status', (req, res) => {
  const serverApiKey = process.env.GEMINI_API_KEY;
  res.json({
    hasServerKey: !!serverApiKey,
    message: serverApiKey ? '服务器已配置 API Key' : '请在前端配置 API Key'
  });
});

// 图片代理（绕过 CORS）
app.get('/api/proxy-image', async (req, res) => {
  console.log('Proxy image request:', req.query.url);
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: '缺少图片 URL' });
    }

    const imageResponse = await fetch(url);
    if (!imageResponse.ok) {
      return res.status(imageResponse.status).json({ error: '图片下载失败' });
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/png';
    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (error) {
    console.error('图片代理失败:', error);
    res.status(500).json({ error: '图片代理失败' });
  }
});

app.get('/api/proxy-video', async (req, res) => {
  try {
    const url = req.query.url;
    console.log('Proxy video request URL:', url);
    
    if (!url) {
      return res.status(400).json({ error: '缺少视频 URL' });
    }

    const videoResponse = await fetch(url);
    if (!videoResponse.ok) {
      const errorText = await videoResponse.text();
      console.error('Video fetch failed:', videoResponse.status, errorText);
      return res.status(videoResponse.status).json({ error: '视频下载失败' });
    }

    const contentType = videoResponse.headers.get('content-type') || 'video/mp4';
    const arrayBuffer = await videoResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', 'attachment; filename="nano-video.mp4"');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (error) {
    console.error('视频代理失败:', error);
    res.status(500).json({ error: '视频代理失败' });
  }
});

app.post('/api/proxy-video', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: '缺少视频 URL' });
    }

    const videoResponse = await fetch(url);
    
    if (!videoResponse.ok) {
      const errorText = await videoResponse.text();
      console.error('Video fetch failed:', videoResponse.status, errorText.substring(0, 200));
      return res.status(videoResponse.status).json({ error: '视频下载失败' });
    }

    const contentType = videoResponse.headers.get('content-type') || 'video/mp4';
    const arrayBuffer = await videoResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', 'attachment; filename="nano-video.mp4"');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (error) {
    console.error('视频代理失败:', error);
    res.status(500).json({ error: '视频代理失败' });
  }
});

const VIDEO_MODELS = {
  text2video: {
    landscape: 'veo_3_1_t2v_landscape',
    portrait: 'veo_3_1_t2v_portrait'
  },
  frame2video: {
    landscape: 'veo_3_1_i2v_s_landscape',
    portrait: 'veo_3_1_i2v_s_portrait'
  }
};

function extractVideoUrl(text) {
  const urlPattern = /https?:\/\/[^\s"\\)\]>']+/g;
  const matches = text.match(urlPattern);
  if (matches) {
    for (const url of matches) {
      const cleanUrl = url.replace(/["'\\>]+$/, '');
      if (cleanUrl.match(/\.(mp4|webm)/i) || cleanUrl.includes('video') || cleanUrl.includes('videofx')) {
        return cleanUrl;
      }
    }
    return matches[0].replace(/["'\\>]+$/, '');
  }
  return null;
}

async function callVideoApi(messages, apiKey, model) {
  const payload = {
    model,
    stream: true,
    messages
  };

  console.log('视频 API 完整 payload:');
  console.log('Model:', model);
  console.log('Messages structure:', JSON.stringify(messages[0].content.map(c => ({ type: c.type, urlPrefix: c.image_url?.url?.substring(0, 80) })), null, 2));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);

  let response;
  try {
    response = await fetch(API_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error('请求超时，请重试');
    }
    throw new Error(`网络请求失败: ${e.message}`);
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  const rawText = await response.text();
  console.log('视频 API 原始响应 (前1500字符):', rawText.substring(0, 1500));
  const { fullContent, reasoningContent, hasError, errorMessage } = parseSSEStream(rawText);

  if (hasError) {
    throw new Error(`生成失败: ${errorMessage}`);
  }

  const allContent = fullContent + ' ' + reasoningContent;
  const videoUrl = extractVideoUrl(allContent);

  if (!videoUrl) {
    throw new Error('未能从响应中提取视频 URL');
  }

  return { videoUrl };
}

app.post('/api/generate-video', async (req, res) => {
  try {
    const { prompt, apiKey, ratio } = req.body;

    if (!prompt) {
      return res.status(400).json({ success: false, error: '请输入提示词' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: '请配置 API Key' });
    }

    const model = VIDEO_MODELS.text2video[ratio] || VIDEO_MODELS.text2video.landscape;

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: prompt }]
    }];

    const result = await callVideoApi(messages, apiKey, model);

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      videoUrl: result.videoUrl,
      createdAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('生成视频失败:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || '生成视频失败'
    });
  }
});

app.post('/api/generate-video-from-frames', async (req, res) => {
  try {
    const { prompt, apiKey, ratio, startFrameBase64, endFrameBase64 } = req.body;

    const imageSizeKB = startFrameBase64 ? Math.round(startFrameBase64.length * 0.75 / 1024) : 0;
    console.log('图生视频请求:', {
      prompt,
      ratio,
      hasStartFrame: !!startFrameBase64,
      imageSizeKB: imageSizeKB + ' KB',
      startFramePrefix: startFrameBase64?.substring(0, 50),
      hasEndFrame: !!endFrameBase64
    });

    if (!prompt) {
      return res.status(400).json({ success: false, error: '请输入提示词' });
    }

    if (!apiKey) {
      return res.status(400).json({ success: false, error: '请配置 API Key' });
    }

    if (!startFrameBase64) {
      return res.status(400).json({ success: false, error: '请上传起始帧图片' });
    }

    const model = VIDEO_MODELS.frame2video[ratio] || VIDEO_MODELS.frame2video.landscape;
    console.log('使用模型:', model);

    const contentParts = [{ type: 'text', text: prompt }];
    
    contentParts.push({
      type: 'image_url',
      image_url: { url: startFrameBase64 }
    });
    
    // 暂时禁用结束帧，API 可能不支持
    // if (endFrameBase64) {
    //   contentParts.push({
    //     type: 'image_url',
    //     image_url: { url: endFrameBase64 }
    //   });
    // }

    const messages = [{
      role: 'user',
      content: contentParts
    }];

    const result = await callVideoApi(messages, apiKey, model);

    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      videoUrl: result.videoUrl,
      createdAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('图生视频失败:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || '图生视频失败'
    });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 静态文件（放在 API 路由之后）
app.use(express.static(path.join(__dirname, 'public')));

// 所有其他路由返回前端页面
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🎨 NANO 图像生成器已启动`);
  console.log(`📡 服务地址: http://localhost:${PORT}`);
  console.log(`🔑 服务器 API Key: ${process.env.GEMINI_API_KEY ? '已配置' : '未配置（需在前端配置）'}`);
});
