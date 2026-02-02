const ImageAPI = {
  API_BASE_URL: 'https://api.yyds168.net/v1/chat/completions',
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

    const response = await fetch(this.API_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败 (${response.status}): ${errorText.substring(0, 200)}`);
    }

    onProgress?.({ stage: '🎨 AI 正在创作...', percent: 15 });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let receivedBytes = 0;
    const estimatedTotalBytes = 5000;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      receivedBytes += value.length;
      
      const streamProgress = Math.min(15 + (receivedBytes / estimatedTotalBytes) * 55, 70);
      onProgress?.({ stage: '🎨 AI 正在创作...', percent: streamProgress });
    }

    onProgress?.({ stage: '🔍 解析响应...', percent: 75 });

    const imageUrl = this.extractImageUrl(fullText);
    
    if (!imageUrl) {
      console.error('Full response:', fullText);
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
    const contentParts = [{ type: 'text', text: prompt }];

    contentParts.push({
      type: 'image_url',
      image_url: { url: mainImageBase64 }
    });

    if (referenceImagesBase64 && referenceImagesBase64.length > 0) {
      for (const refBase64 of referenceImagesBase64) {
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

  async checkConfigStatus() {
    return { hasServerKey: false, message: '请在前端配置 API Key' };
  },

  extractVideoUrl(text) {
    const urlPattern = /https?:\/\/[^\s"\\)\]']+/g;
    const matches = text.match(urlPattern);
    if (matches) {
      for (const url of matches) {
        const cleanUrl = url.replace(/[\\"\\s']+$/, '');
        if (cleanUrl.match(/\.(mp4|webm|mov|avi)/i) || cleanUrl.includes('video')) {
          return cleanUrl;
        }
      }
      return matches[0].replace(/[\\"\\s']+$/, '');
    }
    return null;
  },

  async generateVideo(prompt, apiKey, ratio, onProgress) {
    const model = this.VIDEO_MODELS.text2video[ratio] || this.VIDEO_MODELS.text2video.landscape;
    
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: prompt }]
    }];

    onProgress?.({ stage: '🔗 连接服务器...', percent: 5 });

    const payload = {
      model,
      stream: true,
      messages
    };

    const response = await fetch(this.API_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败 (${response.status}): ${errorText.substring(0, 200)}`);
    }

    onProgress?.({ stage: '🎬 AI 正在创作视频...', percent: 15 });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let receivedBytes = 0;
    const estimatedTotalBytes = 5000;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      receivedBytes += value.length;
      
      const streamProgress = Math.min(15 + (receivedBytes / estimatedTotalBytes) * 55, 70);
      onProgress?.({ stage: '🎬 AI 正在创作视频...', percent: streamProgress });
    }

    onProgress?.({ stage: '🔍 解析响应...', percent: 75 });

    const videoUrl = this.extractVideoUrl(fullText);
    
    if (!videoUrl) {
      console.error('Full response:', fullText);
      throw new Error('未能从响应中提取视频 URL，请重试');
    }

    onProgress?.({ stage: '✅ 完成！', percent: 100 });

    return {
      success: true,
      id: Date.now().toString(),
      prompt,
      videoUrl,
      createdAt: new Date().toISOString()
    };
  },

  async generateVideoFromFrames({ prompt, apiKey, ratio, startFrameBase64, endFrameBase64, onProgress }) {
    const model = this.VIDEO_MODELS.frame2video[ratio] || this.VIDEO_MODELS.frame2video.landscape;
    
    const contentParts = [{ type: 'text', text: prompt }];
    
    contentParts.push({
      type: 'image_url',
      image_url: { url: startFrameBase64 }
    });
    
    if (endFrameBase64) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: endFrameBase64 }
      });
    }

    const messages = [{
      role: 'user',
      content: contentParts
    }];

    onProgress?.({ stage: '🔗 连接服务器...', percent: 5 });

    const payload = {
      model,
      stream: true,
      messages
    };

    const response = await fetch(this.API_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败 (${response.status}): ${errorText.substring(0, 200)}`);
    }

    onProgress?.({ stage: '🎬 AI 正在创作视频...', percent: 15 });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let receivedBytes = 0;
    const estimatedTotalBytes = 5000;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      receivedBytes += value.length;
      
      const streamProgress = Math.min(15 + (receivedBytes / estimatedTotalBytes) * 55, 70);
      onProgress?.({ stage: '🎬 AI 正在创作视频...', percent: streamProgress });
    }

    onProgress?.({ stage: '🔍 解析响应...', percent: 75 });

    const videoUrl = this.extractVideoUrl(fullText);
    
    if (!videoUrl) {
      console.error('Full response:', fullText);
      throw new Error('未能从响应中提取视频 URL，请重试');
    }

    onProgress?.({ stage: '✅ 完成！', percent: 100 });

    return {
      success: true,
      id: Date.now().toString(),
      prompt,
      videoUrl,
      createdAt: new Date().toISOString()
    };
  }
};

window.ImageAPI = ImageAPI;
