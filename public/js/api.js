const ImageAPI = {
  async dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    if (!response.ok) {
      throw new Error('Failed to convert image data.');
    }
    return response.blob();
  },

  async request(endpoint, body, onProgress, stageLabels) {
    const stages = stageLabels || ['Preparing request...', 'Waiting for upstream...', 'Processing response...', 'Completed'];
    const pushProgress = (stage, percent, indeterminate = false) => {
      onProgress?.({ stage, percent, indeterminate });
    };

    pushProgress(stages[0], 10, false);

    let response;
    try {
      const isFormData = body instanceof FormData;
      pushProgress(stages[1], 35, true);
      response = await fetch(endpoint, {
        method: 'POST',
        headers: isFormData ? undefined : { 'Content-Type': 'application/json' },
        body: isFormData ? body : JSON.stringify(body)
      });
      pushProgress(stages[2], 78, false);
    } finally {
    }

    let result;
    let responseText = '';
    try {
      responseText = await response.text();
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      const snippet = responseText
        ? responseText.replace(/\s+/g, ' ').trim().slice(0, 160)
        : `HTTP ${response.status}`;
      throw new Error(`Server returned an invalid JSON response: ${snippet}`);
    }

    if (!response.ok || !result.success) {
      const error = new Error(result.error || `Request failed with status ${response.status}.`);
      error.status = result.status || response.status;
      error.code = result.code || 'request_failed';
      error.retryable = Boolean(result.retryable);
      throw error;
    }

    pushProgress(stages[3], 100, false);
    return result;
  },

  async generateImage(prompt, apiKey, model, ratio, imageOptions, onProgress) {
    return this.request(
      '/api/generate',
      { prompt, apiKey, model, ratio, ...imageOptions },
      onProgress,
      ['请求已发送', '正在等待上游生成', '正在处理图片结果', '图片已就绪']
    );
  },

  async editImage({ prompt, apiKey, model, ratio, quality, background, outputFormat, mainImageBase64, referenceImagesBase64, onProgress }) {
    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('apiKey', apiKey);
    formData.append('model', model);
    formData.append('ratio', ratio);
    if (quality) formData.append('quality', quality);
    if (background) formData.append('background', background);
    if (outputFormat) formData.append('outputFormat', outputFormat);
    if (mainImageBase64) {
      formData.append('mainImage', await this.dataUrlToBlob(mainImageBase64), 'main-image.png');
    }
    for (const [index, image] of (referenceImagesBase64 || []).entries()) {
      formData.append('referenceImages', await this.dataUrlToBlob(image), `reference-${index + 1}.png`);
    }
    return this.request(
      '/api/edit',
      formData,
      onProgress,
      ['请求已发送', '正在等待上游编辑', '正在处理图片结果', '图片已就绪']
    );
  },

  async generateVideo(prompt, apiKey, ratio, model, onProgress) {
    return this.request(
      '/api/generate-video',
      { prompt, apiKey, ratio, model },
      onProgress,
      ['请求已发送', '正在等待上游生成', '正在处理视频结果', '视频已就绪']
    );
  },

  async generateVideoFromFrames({ prompt, apiKey, ratio, model, startFrameBase64, endFrameBase64, onProgress }) {
    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('apiKey', apiKey);
    formData.append('ratio', ratio);
    formData.append('model', model);
    if (startFrameBase64) {
      formData.append('startFrame', await this.dataUrlToBlob(startFrameBase64), 'start-frame.png');
    }
    if (endFrameBase64) {
      formData.append('endFrame', await this.dataUrlToBlob(endFrameBase64), 'end-frame.png');
    }
    return this.request(
      '/api/generate-video-from-frames',
      formData,
      onProgress,
      ['请求已发送', '正在等待上游生成', '正在处理视频结果', '视频已就绪']
    );
  },

  async generateVideoFromReferences({ prompt, apiKey, ratio, model, referenceImagesBase64, onProgress }) {
    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('apiKey', apiKey);
    formData.append('ratio', ratio);
    formData.append('model', model);
    for (const [index, image] of (referenceImagesBase64 || []).entries()) {
      formData.append('referenceImages', await this.dataUrlToBlob(image), `reference-video-${index + 1}.png`);
    }
    return this.request(
      '/api/generate-video-from-references',
      formData,
      onProgress,
      ['请求已发送', '正在等待上游生成', '正在处理视频结果', '视频已就绪']
    );
  },

  async checkConfigStatus() {
    try {
      const response = await fetch('/api/config/status');
      if (!response.ok) {
        throw new Error();
      }
      return await response.json();
    } catch {
      return {
        hasServerKey: false,
        message: 'Unable to read server config.'
      };
    }
  }
};

window.ImageAPI = ImageAPI;
