const ImageAPI = {
  API_BASE_URL: 'https://vip.yyds168.net/v1/chat/completions',
  DEFAULT_MODEL: 'gemini-3.0-pro-image-portrait',

  VIDEO_MODELS: {
    text2video: {
      landscape: 'veo_3_1_t2v_landscape',
      portrait: 'veo_3_1_t2v_portrait'
    },
    frame2video: {
      landscape: 'veo_3_1_i2v_s_landscape',
      portrait: 'veo_3_1_i2v_s_portrait'
    }
  },

  extractImageUrl(text) {
    const urlPattern = /https?:\/\/[^\s"\\)\]]+/g;
    const matches = text.match(urlPattern);
    if (matches) {
      for (const url of matches) {
        const cleanUrl = url.replace(/[\\"\s]+$/, '');
        if (cleanUrl.match(/\.(png|jpg|jpeg|webp|gif)/i) || cleanUrl.includes('image') || cleanUrl.includes('cdn') || cleanUrl.includes('storage')) {
          return cleanUrl;
        }
      }
      return matches[0].replace(/[\\"\s]+$/, '');
    }
    return null;
  },

  async callApiStream(messages, apiKey, model, onProgress) {
    onProgress?.({ stage: '🔗 连接服务器...', percent: 5 });

    const payload = {
      model: model || this.DEFAULT_MODEL,
      stream: true,
      messages
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    let response;
    try {
      response = await fetch(this.API_BASE_URL, {
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
      throw new Error(`API 请求失败 (${response.status}): ${errorText.substring(0, 200)}`);
    }

    onProgress?.({ stage: '🎨 AI 正在创作...', percent: 15 });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rawText = '';
    let receivedBytes = 0;
    const estimatedTotalBytes = 5000;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      rawText += chunk;
      receivedBytes += value.length;
      
      const streamProgress = Math.min(15 + (receivedBytes / estimatedTotalBytes) * 55, 70);
      onProgress?.({ stage: '🎨 AI 正在创作...', percent: streamProgress });
    }

    onProgress?.({ stage: '🔍 解析响应...', percent: 75 });

    const { fullContent, reasoningContent, hasError, errorMessage } = this.parseSSEStream(rawText);
    
    if (hasError) {
      throw new Error(`生成失败: ${errorMessage}`);
    }

    const allContent = fullContent + ' ' + reasoningContent;
    const imageUrl = this.extractImageUrl(allContent);
    
    if (!imageUrl) {
      console.error('Full response:', rawText);
      throw new Error('未能从响应中提取图片 URL，请重试');
    }

    onProgress?.({ stage: '📥 下载图片中...', percent: 80 });

    const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
    const imageResponse = await fetch(proxyUrl);
    if (!imageResponse.ok) {
      throw new Error(`图片下载失败: ${imageUrl}`);
    }

    onProgress?.({ stage: '🖼️ 处理图片...', percent: 90 });

    const blob = await imageResponse.blob();
    const imageBase64 = await this.blobToBase64(blob);

    onProgress?.({ stage: '✅ 完成！', percent: 100 });

    return {
      imageUrl,
      imageBase64
    };
  },

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },

  async generateImage(prompt, apiKey, model, onProgress) {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt }
        ]
      }
    ];

    const result = await this.callApiStream(messages, apiKey, model, onProgress);

    return {
      success: true,
      id: Date.now().toString(),
      prompt,
      imageBase64: result.imageBase64,
      imageUrl: result.imageUrl,
      createdAt: new Date().toISOString()
    };
  },

  async editImage({ prompt, apiKey, model, mainImageBase64, referenceImagesBase64, onProgress }) {
    onProgress?.({ stage: '🔗 连接服务器...', percent: 5 });

    const body = {
      prompt,
      apiKey,
      model: model || this.DEFAULT_MODEL,
      mainImageBase64
    };

    if (referenceImagesBase64 && referenceImagesBase64.length > 0) {
      body.referenceImagesBase64 = JSON.stringify(referenceImagesBase64);
    }

    onProgress?.({ stage: '🎨 AI 正在创作...', percent: 15 });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    let response;
    try {
      response = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

    onProgress?.({ stage: '🔍 解析响应...', percent: 75 });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || '图片编辑失败');
    }

    onProgress?.({ stage: '✅ 完成！', percent: 100 });

    return {
      success: true,
      id: result.id,
      prompt,
      imageBase64: result.imageBase64,
      imageUrl: result.imageUrl,
      createdAt: result.createdAt
    };
  },

  async checkConfigStatus() {
    return { hasServerKey: false, message: '请在前端配置 API Key' };
  },

  extractVideoUrl(text) {
    const urlPattern = /https?:\/\/[^\s"\\)\]>']+/g;
    const matches = text.match(urlPattern);
    if (matches) {
      for (const url of matches) {
        // 清理 URL 末尾的引号、反斜杠等
        const cleanUrl = url.replace(/["'\\>]+$/, '');
        if (cleanUrl.match(/\.(mp4|webm)/i) || cleanUrl.includes('video') || cleanUrl.includes('videofx')) {
          return cleanUrl;
        }
      }
      return matches[0].replace(/["'\\>]+$/, '');
    }
    return null;
  },

  // 解析 SSE 流式响应（参照 i2v_example.py）
  parseSSEStream(rawText) {
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

        // 检查 API 错误
        if (data.error) {
          hasError = true;
          errorMessage = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
          break;
        }

        const choices = data.choices || [];
        if (choices.length === 0) continue;

        const delta = choices[0].delta || {};

        // 收集内容
        if (delta.content) {
          fullContent += delta.content;
        }
        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          // 检查生成错误（参照 i2v_example.py）
          if (['❌', '生成失败', '违规'].some(kw => delta.reasoning_content.includes(kw))) {
            hasError = true;
            errorMessage = delta.reasoning_content;
          }
        }
      } catch (e) {
        // JSON 解析失败，跳过
        continue;
      }
    }

    return { fullContent, reasoningContent, hasError, errorMessage };
  },

  async generateVideo(prompt, apiKey, ratio, onProgress) {
    onProgress?.({ stage: '🔗 连接服务器...', percent: 5 });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    let response;
    try {
      response = await fetch('/api/generate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, apiKey, ratio }),
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

    onProgress?.({ stage: '🔍 解析响应...', percent: 75 });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || '视频生成失败');
    }

    onProgress?.({ stage: '✅ 完成！', percent: 100 });

    return {
      success: true,
      id: result.id,
      prompt,
      videoUrl: result.videoUrl,
      createdAt: result.createdAt
    };
  },

  async generateVideoFromFrames({ prompt, apiKey, ratio, startFrameBase64, endFrameBase64, onProgress }) {
    onProgress?.({ stage: '🔗 连接服务器...', percent: 5 });

    const body = {
      prompt,
      apiKey,
      ratio,
      startFrameBase64
    };

    if (endFrameBase64) {
      body.endFrameBase64 = endFrameBase64;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    let response;
    try {
      response = await fetch('/api/generate-video-from-frames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

    onProgress?.({ stage: '🔍 解析响应...', percent: 75 });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || '图生视频失败');
    }

    onProgress?.({ stage: '✅ 完成！', percent: 100 });

    return {
      success: true,
      id: result.id,
      prompt,
      videoUrl: result.videoUrl,
      createdAt: result.createdAt
    };
  }
};

window.ImageAPI = ImageAPI;
