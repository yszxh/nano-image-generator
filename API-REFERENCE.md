# Gemini 图像生成 API 调用文档

## 概述

本文档记录了通过第三方代理 API（api.yyds168.net）调用 Gemini 图像生成模型的方式，支持文生图和图生图功能。

## API 基本信息

| 项目 | 值 |
|------|-----|
| **端点** | `https://api.yyds168.net/v1/chat/completions` |
| **协议** | HTTPS |
| **认证方式** | Bearer Token |
| **请求格式** | JSON |
| **响应格式** | Server-Sent Events (SSE) 流式响应 |

## 可用模型

### Gemini 2.5 Flash（快速）

| 模型名称 | 比例 | 说明 |
|----------|------|------|
| `gemini-2.5-flash-image-landscape` | 16:9 | 横屏 |
| `gemini-2.5-flash-image-portrait` | 9:16 | 竖屏 |

### Gemini 3.0 Pro（标准）

| 模型名称 | 比例 | 说明 |
|----------|------|------|
| `gemini-3.0-pro-image-landscape` | 16:9 | 横屏 |
| `gemini-3.0-pro-image-portrait` | 9:16 | 竖屏 |
| `gemini-3.0-pro-image-square` | 1:1 | 正方形 |
| `gemini-3.0-pro-image-four-three` | 4:3 | 横屏 |
| `gemini-3.0-pro-image-three-four` | 3:4 | 竖屏 |

### Gemini 3.0 Pro 2K（高清）

| 模型名称 | 比例 | 说明 |
|----------|------|------|
| `gemini-3.0-pro-image-landscape-2k` | 16:9 | 横屏 2K |
| `gemini-3.0-pro-image-portrait-2k` | 9:16 | 竖屏 2K |
| `gemini-3.0-pro-image-square-2k` | 1:1 | 正方形 2K |
| `gemini-3.0-pro-image-four-three-2k` | 4:3 | 横屏 2K |
| `gemini-3.0-pro-image-three-four-2k` | 3:4 | 竖屏 2K |

### Gemini 3.0 Pro 4K（超清）

| 模型名称 | 比例 | 说明 |
|----------|------|------|
| `gemini-3.0-pro-image-landscape-4k` | 16:9 | 横屏 4K |
| `gemini-3.0-pro-image-portrait-4k` | 9:16 | 竖屏 4K |
| `gemini-3.0-pro-image-square-4k` | 1:1 | 正方形 4K |
| `gemini-3.0-pro-image-four-three-4k` | 4:3 | 横屏 4K |
| `gemini-3.0-pro-image-three-four-4k` | 3:4 | 竖屏 4K |

### 模型命名规则

```
{版本}-image-{比例}[-分辨率]

版本: gemini-2.5-flash / gemini-3.0-pro
比例: portrait / landscape / square / four-three / three-four
分辨率: 空(标准) / 2k / 4k
```

### 模型兼容性矩阵

| 比例 | Flash | Pro 标准 | Pro 2K | Pro 4K |
|------|-------|----------|--------|--------|
| portrait (9:16) | ✓ | ✓ | ✓ | ✓ |
| landscape (16:9) | ✓ | ✓ | ✓ | ✓ |
| square (1:1) | ✗ | ✓ | ✓ | ✓ |
| four-three (4:3) | ✗ | ✓ | ✓ | ✓ |
| three-four (3:4) | ✗ | ✓ | ✓ | ✓ |

## 认证

在请求头中添加 `Authorization` 字段：

```
Authorization: Bearer YOUR_API_KEY
```

---

## 文生图（Text to Image）

### 请求

```http
POST https://api.yyds168.net/v1/chat/completions
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY
```

### 请求体

```json
{
  "model": "gemini-3.0-pro-image-landscape",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "一只可爱的橘猫在樱花树下睡觉，日系插画风格"
        }
      ]
    }
  ]
}
```

### 关键参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名称 |
| `stream` | boolean | **是** | **必须设置为 `true`**，否则 API 会返回错误 |
| `messages` | array | 是 | 消息数组 |
| `messages[].role` | string | 是 | 固定为 `"user"` |
| `messages[].content` | array | 是 | 内容数组，包含 text 和/或 image_url 对象 |

### JavaScript 示例

```javascript
async function generateImage(prompt, apiKey, model = 'gemini-3.0-pro-image-landscape') {
  const payload = {
    model,
    stream: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt }
        ]
      }
    ]
  };

  const response = await fetch('https://api.yyds168.net/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fullText += decoder.decode(value, { stream: true });
  }

  const imageUrl = extractImageUrl(fullText);
  return imageUrl;
}

function extractImageUrl(text) {
  const urlPattern = /https?:\/\/[^\s"\\)\]]+/g;
  const matches = text.match(urlPattern);
  if (matches) {
    for (const url of matches) {
      const cleanUrl = url.replace(/[\\"\s]+$/, '');
      if (cleanUrl.match(/\.(png|jpg|jpeg|webp|gif)/i) || 
          cleanUrl.includes('image') || 
          cleanUrl.includes('cdn') || 
          cleanUrl.includes('storage')) {
        return cleanUrl;
      }
    }
    return matches[0].replace(/[\\"\s]+$/, '');
  }
  return null;
}
```

---

## 图生图（Image to Image）

### 请求体

```json
{
  "model": "gemini-3.0-pro-image-landscape",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "把背景改成星空"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
          }
        }
      ]
    }
  ]
}
```

### 图片格式要求

图片必须以 Data URL 格式传递：

```
data:{mimeType};base64,{base64Data}
```

示例：
```
data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...
data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD...
```

### 支持的 MIME 类型

| 扩展名 | MIME 类型 |
|--------|-----------|
| `.jpg` / `.jpeg` | `image/jpeg` |
| `.png` | `image/png` |
| `.webp` | `image/webp` |
| `.gif` | `image/gif` |

### JavaScript 示例

```javascript
async function editImage(prompt, mainImageBase64, apiKey, model, referenceImages = []) {
  const contentParts = [
    { type: 'text', text: prompt }
  ];

  contentParts.push({
    type: 'image_url',
    image_url: { url: mainImageBase64 }
  });

  for (const refBase64 of referenceImages) {
    contentParts.push({
      type: 'image_url',
      image_url: { url: refBase64 }
    });
  }

  const payload = {
    model,
    stream: true,
    messages: [
      {
        role: 'user',
        content: contentParts
      }
    ]
  };

  const response = await fetch('https://api.yyds168.net/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  // ... 处理响应同文生图
}
```

### 文件转 Base64

```javascript
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
```

---

## 响应处理

### 流式响应格式

API 返回 Server-Sent Events (SSE) 格式的流式响应：

```
data: {"id": "chatcmpl-xxx", "object": "chat.completion.chunk", "choices": [{"delta": {"content": "..."}}]}

data: {"id": "chatcmpl-xxx", "object": "chat.completion.chunk", "choices": [{"delta": {"content": "https://storage.googleapis.com/..."}}]}

data: [DONE]
```

### 提取图片 URL

生成的图片 URL 会包含在响应流中，通常是 Google Cloud Storage 的 URL：

```
https://storage.googleapis.com/...
```

### CORS 问题

Google Storage 的图片 URL 有 CORS 限制，前端无法直接下载。解决方案：

1. **后端代理**（推荐）：通过后端代理请求图片

```javascript
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  const imageResponse = await fetch(url);
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  res.set('Content-Type', imageResponse.headers.get('content-type'));
  res.send(buffer);
});

const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
const imageResponse = await fetch(proxyUrl);
const blob = await imageResponse.blob();
```

2. **后端直接下载并返回 Base64**：在后端完成图片下载和转换

---

## 错误处理

### 常见错误

| 状态码 | 错误 | 说明 |
|--------|------|------|
| 400 | Bad Request | 请求参数错误，检查 `stream: true` 是否设置 |
| 401 | Unauthorized | API Key 无效或过期 |
| 429 | Too Many Requests | 请求频率过高，稍后重试 |
| 500 | Internal Server Error | 服务器内部错误 |

### 错误响应示例

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

---

## 完整示例：Node.js 后端

```javascript
import express from 'express';

const app = express();
const API_BASE_URL = 'https://api.yyds168.net/v1/chat/completions';

app.use(express.json({ limit: '50mb' }));

app.post('/api/generate', async (req, res) => {
  const { prompt, apiKey, model = 'gemini-3.0-pro-image-landscape' } = req.body;

  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: prompt }]
    }
  ];

  const response = await fetch(API_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, stream: true, messages })
  });

  const rawText = await response.text();
  const imageUrl = extractImageUrl(rawText);

  const imageResponse = await fetch(imageUrl);
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  const base64 = `data:image/png;base64,${buffer.toString('base64')}`;

  res.json({ success: true, imageBase64: base64, imageUrl });
});

app.post('/api/edit', async (req, res) => {
  const { prompt, apiKey, model, mainImageBase64, referenceImagesBase64 } = req.body;

  const contentParts = [{ type: 'text', text: prompt }];
  
  contentParts.push({
    type: 'image_url',
    image_url: { url: mainImageBase64 }
  });

  if (referenceImagesBase64) {
    for (const ref of referenceImagesBase64) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: ref }
      });
    }
  }

  const messages = [{ role: 'user', content: contentParts }];

  const response = await fetch(API_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, stream: true, messages })
  });

  // ... 同文生图处理
});

app.listen(3000);
```

---

## 注意事项

1. **`stream: true` 是必须的**：API 要求启用流式模式，否则会返回错误
2. **图片格式**：图生图时，图片必须是完整的 Data URL 格式（`data:image/xxx;base64,...`）
3. **CORS 限制**：返回的图片 URL 需要通过后端代理访问
4. **图片大小**：建议限制上传图片大小在 20MB 以内
5. **参考图片数量**：图生图最多支持 5 张参考图片
6. **Flash 模型限制**：Gemini 2.5 Flash 仅支持 portrait 和 landscape 两种比例

---

## 项目参考

本文档基于 NANO 图像生成器项目的实现：
- 项目目录：`nano-image-generator/`
- 前端 API 封装：`public/js/api.js`
- 后端服务器：`server.js`
- GitHub 仓库：`https://github.com/yszxh/nano-image-generator`
