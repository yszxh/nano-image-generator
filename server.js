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
const API_BASE_URL = 'https://api.yyds168.net/v1/chat/completions';
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
  const urlPattern = /https?:\/\/[^\s"\\)]+(?<!")/g;
  const matches = text.match(urlPattern);
  if (matches) {
    // 过滤出图片 URL
    for (const url of matches) {
      if (url.match(/\.(png|jpg|jpeg|webp|gif)/i) || url.includes('image') || url.includes('cdn')) {
        return url;
      }
    }
    return matches[0];
  }
  return null;
}

// 调用 API 生成图片
async function callImageApi(messages, apiKey, model = DEFAULT_MODEL) {
  const payload = {
    model,
    stream: true,
    messages
  };

  const response = await fetch(API_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  const rawText = await response.text();
  const imageUrl = extractImageUrl(rawText);

  if (!imageUrl) {
    throw new Error('未能从响应中提取图片 URL');
  }

  // 下载图片
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
