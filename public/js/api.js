const ImageAPI = {
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
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      pushProgress(88, 2);
    } finally {
      window.clearInterval(timer);
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('Server returned an invalid JSON response.');
    }

    if (!response.ok || !result.success) {
      throw new Error(result.error || `Request failed with status ${response.status}.`);
    }

    pushProgress(100, 3);
    return result;
  },

  async generateImage(prompt, apiKey, model, onProgress) {
    return this.request(
      '/api/generate',
      { prompt, apiKey, model },
      onProgress,
      ['Connecting to Flow2API...', 'Generating image...', 'Downloading image...', 'Image ready']
    );
  },

  async editImage({ prompt, apiKey, model, mainImageBase64, referenceImagesBase64, onProgress }) {
    return this.request(
      '/api/edit',
      {
        prompt,
        apiKey,
        model,
        mainImageBase64,
        referenceImagesBase64: referenceImagesBase64 ? JSON.stringify(referenceImagesBase64) : undefined
      },
      onProgress,
      ['Connecting to Flow2API...', 'Editing image...', 'Downloading image...', 'Image ready']
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
    return this.request(
      '/api/generate-video-from-frames',
      { prompt, apiKey, ratio, model, startFrameBase64, endFrameBase64 },
      onProgress,
      ['Connecting to Flow2API...', 'Generating transition video...', 'Resolving video URL...', 'Video ready']
    );
  },

  async generateVideoFromReferences({ prompt, apiKey, ratio, model, referenceImagesBase64, onProgress }) {
    return this.request(
      '/api/generate-video-from-references',
      {
        prompt,
        apiKey,
        ratio,
        model,
        referenceImagesBase64: JSON.stringify(referenceImagesBase64 || [])
      },
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
