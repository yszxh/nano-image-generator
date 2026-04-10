const ImageAPI = {
  async dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    if (!response.ok) {
      throw new Error('Failed to convert image data.');
    }
    return response.blob();
  },

  async request(endpoint, body, onProgress, stageLabels) {
    let percent = 8;
    let stageIndex = 0;
    const stages = stageLabels || ['Connecting...', 'Generating...', 'Parsing response...', 'Completed'];

    const pushProgress = (value, labelIndex = stageIndex) => {
      percent = value;
      stageIndex = Math.min(labelIndex, stages.length - 1);
      onProgress?.({
        stage: stages[stageIndex],
        percent
      });
    };

    pushProgress(8, 0);

    const timer = window.setInterval(() => {
      if (percent >= 82) {
        return;
      }

      const nextPercent = Math.min(percent + 8, 82);
      if (nextPercent >= 55) {
        stageIndex = Math.min(1, stages.length - 1);
      }
      pushProgress(nextPercent, stageIndex);
    }, 700);

    let response;
    try {
      const isFormData = body instanceof FormData;
      response = await fetch(endpoint, {
        method: 'POST',
        headers: isFormData ? undefined : { 'Content-Type': 'application/json' },
        body: isFormData ? body : JSON.stringify(body)
      });
      pushProgress(88, 2);
    } finally {
      window.clearInterval(timer);
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

    pushProgress(100, 3);
    return result;
  },

  async generateImage(prompt, apiKey, model, ratio, onProgress) {
    return this.request(
      '/api/generate',
      { prompt, apiKey, model, ratio },
      onProgress,
      ['Connecting to Gemini...', 'Generating image...', 'Downloading image...', 'Image ready']
    );
  },

  async editImage({ prompt, apiKey, model, ratio, mainImageBase64, referenceImagesBase64, onProgress }) {
    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('apiKey', apiKey);
    formData.append('model', model);
    formData.append('ratio', ratio);
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
      ['Connecting to Gemini...', 'Editing image...', 'Downloading image...', 'Image ready']
    );
  },

  async generateVideo(prompt, apiKey, ratio, model, onProgress) {
    return this.request(
      '/api/generate-video',
      { prompt, apiKey, ratio, model },
      onProgress,
      ['Connecting to Flow2API...', 'Generating video...', 'Resolving video URL...', 'Video ready']
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
      ['Connecting to Flow2API...', 'Generating transition video...', 'Resolving video URL...', 'Video ready']
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
      ['Connecting to Flow2API...', 'Generating reference video...', 'Resolving video URL...', 'Video ready']
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
