document.addEventListener('DOMContentLoaded', () => {
  const MODEL_CONFIG = {
    ratios: {
      'portrait': { suffix: 'portrait', flash: true, pro: true },
      'landscape': { suffix: 'landscape', flash: true, pro: true },
      'square': { suffix: 'square', flash: false, pro: true },
      'four-three': { suffix: 'four-three', flash: false, pro: true },
      'three-four': { suffix: 'three-four', flash: false, pro: true }
    },
    versions: {
      'gemini-2.5-flash': { prefix: 'gemini-2.5-flash-image', suffix: '', type: 'flash' },
      'gemini-3.0-pro': { prefix: 'gemini-3.0-pro-image', suffix: '', type: 'pro' },
      'gemini-3.0-pro-2k': { prefix: 'gemini-3.0-pro-image', suffix: '-2k', type: 'pro' },
      'gemini-3.0-pro-4k': { prefix: 'gemini-3.0-pro-image', suffix: '-4k', type: 'pro' }
    }
  };

  const state = {
    currentTab: 'text2img',
    mainImage: null,
    referenceImages: [],
    lastGeneratedImage: null,
    apiKey: localStorage.getItem('nano_api_key') || '',
    ratio: localStorage.getItem('nano_ratio') || 'landscape',
    modelVersion: localStorage.getItem('nano_model_version') || 'gemini-3.0-pro',
    theme: localStorage.getItem('nano_theme') || 'dark',
    videoRatio: localStorage.getItem('nano_video_ratio') || 'landscape',
    startFrame: null,
    endFrame: null,
    lastGeneratedVideo: null,
    lastVideoBlobUrl: null
  };

  const TaskManager = {
    MAX_TASKS: 3,
    tasks: [],
    activeTaskId: null,

    canAddTask() {
      return this.tasks.length < this.MAX_TASKS;
    },

    addTask(config) {
      if (!this.canAddTask()) {
        UI.showToast('任务队列已满，最多3个任务', 'warning');
        return null;
      }
      const task = {
        id: Date.now().toString(),
        type: config.type,
        prompt: config.prompt,
        status: 'running',
        progress: 0,
        result: null,
        createdAt: new Date().toISOString()
      };
      this.tasks.push(task);
      this.activeTaskId = task.id;
      this.render();
      this.updateCount();
      return task;
    },

    updateTask(id, updates) {
      const task = this.tasks.find(t => t.id === id);
      if (task) {
        Object.assign(task, updates);
        this.render();
      }
    },

    removeTask(id) {
      this.tasks = this.tasks.filter(t => t.id !== id);
      if (this.activeTaskId === id && this.tasks.length > 0) {
        this.activeTaskId = this.tasks[0].id;
      } else if (this.tasks.length === 0) {
        this.activeTaskId = null;
      }
      this.render();
      this.updateCount();
    },

    setActive(id) {
      this.activeTaskId = id;
      const task = this.tasks.find(t => t.id === id);
      if (task?.result) {
        if (task.type.includes('video')) {
          showVideoResult(task.result);
        } else {
          showResult(task.result);
        }
      }
      this.render();
    },

    render() {
      const taskList = document.getElementById('taskList');
      if (!taskList) return;

      if (this.tasks.length === 0) {
        taskList.innerHTML = `
          <div class="task-empty">
            <p>暂无任务</p>
            <p class="task-hint">点击生成按钮添加任务</p>
          </div>
        `;
        return;
      }

      taskList.innerHTML = this.tasks.map(task => {
        const typeLabels = {
          'text2img': '文生图',
          'img2img': '图生图',
          'text2video': '文生视频',
          'frame2video': '图生视频'
        };

        const statusLabels = {
          'running': '生成中',
          'completed': '已完成',
          'failed': '失败'
        };

        return `
          <div class="task-card ${task.status} ${task.id === this.activeTaskId ? 'active' : ''}" data-id="${task.id}">
            <div class="task-card-header">
              <span class="task-type">${typeLabels[task.type] || task.type}</span>
              <span class="task-status">${statusLabels[task.status]}</span>
            </div>
            <div class="task-prompt">${task.prompt}</div>
            ${task.status === 'running' ? `
              <div class="task-progress">
                <div class="task-progress-fill" style="width: ${task.progress}%"></div>
              </div>
            ` : ''}
            <button class="task-delete" data-id="${task.id}">✕</button>
          </div>
        `;
      }).join('');

      taskList.querySelectorAll('.task-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.classList.contains('task-delete')) return;
          this.setActive(card.dataset.id);
        });
      });

      taskList.querySelectorAll('.task-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeTask(btn.dataset.id);
        });
      });
    },

    updateCount() {
      const countEl = document.getElementById('taskCount');
      if (countEl) {
        countEl.textContent = `${this.tasks.length}/3`;
      }
    }
  };

  function buildModelName() {
    const versionConfig = MODEL_CONFIG.versions[state.modelVersion];
    const ratioConfig = MODEL_CONFIG.ratios[state.ratio];
    
    if (!versionConfig || !ratioConfig) {
      return 'gemini-3.0-pro-image-landscape';
    }
    
    return `${versionConfig.prefix}-${ratioConfig.suffix}${versionConfig.suffix}`;
  }

  function getModel() {
    return buildModelName();
  }

  function updateModelHint() {
    const hintEl = document.getElementById('modelHint');
    if (hintEl) {
      hintEl.textContent = `当前模型：${getModel()}`;
    }
  }

  function updateVersionOptions() {
    const versionSelect = document.getElementById('modelVersionSelect');
    const ratioConfig = MODEL_CONFIG.ratios[state.ratio];
    
    if (!versionSelect || !ratioConfig) return;
    
    Array.from(versionSelect.options).forEach(option => {
      const version = option.value;
      const versionConfig = MODEL_CONFIG.versions[version];
      
      let isSupported = true;
      if (versionConfig && versionConfig.type === 'flash' && !ratioConfig.flash) {
        isSupported = false;
      }
      
      option.disabled = !isSupported;
      
      if (!isSupported && versionSelect.value === version) {
        versionSelect.value = 'gemini-3.0-pro';
        state.modelVersion = 'gemini-3.0-pro';
        localStorage.setItem('nano_model_version', state.modelVersion);
      }
    });
  }

  initTheme();
  initTabs();
  initRatioSelector();
  initModelVersionSelector();
  initVideoRatioSelector();
  initTemplates();
  initUpload();
  initFrameUpload();
  initModals();
  initActions();
  renderHistory();
  updateModelHint();

  function initTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    updateThemeIcon();

    document.getElementById('themeToggle').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', state.theme);
      localStorage.setItem('nano_theme', state.theme);
      updateThemeIcon();
    });
  }

  function updateThemeIcon() {
    const icon = document.querySelector('.theme-icon');
    icon.textContent = state.theme === 'dark' ? '☀️' : '🌙';
  }

  function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');
    const imageSettings = document.querySelectorAll('.image-settings');

    function updateImageSettingsVisibility(tab) {
      const isVideoTab = tab === 'text2video' || tab === 'frame2video';
      imageSettings.forEach(el => {
        el.style.display = isVideoTab ? 'none' : 'block';
      });
    }

    updateImageSettingsVisibility(state.currentTab);

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        state.currentTab = tab;

        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        panels.forEach(p => {
          p.classList.toggle('active', p.id === `${tab}Panel`);
        });

        updateImageSettingsVisibility(tab);
      });
    });
  }

  function initRatioSelector() {
    const ratioCards = document.querySelectorAll('.ratio-card');
    
    ratioCards.forEach(card => {
      if (card.dataset.ratio === state.ratio) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
      
      card.addEventListener('click', () => {
        ratioCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        
        state.ratio = card.dataset.ratio;
        localStorage.setItem('nano_ratio', state.ratio);
        
        updateVersionOptions();
        updateModelHint();
      });
    });
    
    updateVersionOptions();
  }

  function initModelVersionSelector() {
    const versionSelect = document.getElementById('modelVersionSelect');
    
    if (!versionSelect) return;
    
    versionSelect.value = state.modelVersion;
    
    versionSelect.addEventListener('change', () => {
      state.modelVersion = versionSelect.value;
      localStorage.setItem('nano_model_version', state.modelVersion);
      updateModelHint();
    });
  }

  function initVideoRatioSelector() {
    const videoRatioCards = document.querySelectorAll('.video-ratio-selector:not(.frame-video-ratio) .video-ratio-card');
    const frameVideoRatioCards = document.querySelectorAll('.frame-video-ratio .video-ratio-card');
    
    const initCards = (cards) => {
      cards.forEach(card => {
        if (card.dataset.ratio === state.videoRatio) {
          card.classList.add('active');
        } else {
          card.classList.remove('active');
        }
        
        card.addEventListener('click', () => {
          cards.forEach(c => c.classList.remove('active'));
          card.classList.add('active');
          
          state.videoRatio = card.dataset.ratio;
          localStorage.setItem('nano_video_ratio', state.videoRatio);
        });
      });
    };
    
    initCards(videoRatioCards);
    initCards(frameVideoRatioCards);
  }

  function initTemplates() {
    const templateTags = document.querySelectorAll('.template-tag:not(.video-template)');
    const promptInput = document.getElementById('promptInput');

    templateTags.forEach(tag => {
      tag.addEventListener('click', () => {
        const template = tag.dataset.template;
        const currentText = promptInput.value.trim();
        
        if (currentText) {
          promptInput.value = `${currentText}, ${template}`;
        } else {
          promptInput.value = template;
        }
        promptInput.focus();
      });
    });

    const videoTemplateTags = document.querySelectorAll('.video-template');
    const videoPromptInput = document.getElementById('videoPromptInput');

    videoTemplateTags.forEach(tag => {
      tag.addEventListener('click', () => {
        const template = tag.dataset.template;
        const currentText = videoPromptInput.value.trim();
        
        if (currentText) {
          videoPromptInput.value = `${currentText}, ${template}`;
        } else {
          videoPromptInput.value = template;
        }
        videoPromptInput.focus();
      });
    });
  }

  function initUpload() {
    const mainImageZone = document.getElementById('mainImageZone');
    const mainImageInput = document.getElementById('mainImageInput');
    const mainImagePreview = document.getElementById('mainImagePreview');
    const removeMainImage = document.getElementById('removeMainImage');

    const refImageZone = document.getElementById('refImageZone');
    const refImageInput = document.getElementById('refImageInput');
    const referencePreviews = document.getElementById('referencePreviews');

    setupDropZone(mainImageZone, mainImageInput, async (files) => {
      if (files.length > 0) {
        const file = files[0];
        state.mainImage = await UI.fileToBase64(file);
        mainImagePreview.src = state.mainImage;
        mainImagePreview.classList.remove('hidden');
        mainImageZone.querySelector('.upload-placeholder').classList.add('hidden');
        removeMainImage.classList.remove('hidden');
      }
    });

    removeMainImage.addEventListener('click', (e) => {
      e.stopPropagation();
      state.mainImage = null;
      mainImagePreview.classList.add('hidden');
      mainImagePreview.src = '';
      mainImageZone.querySelector('.upload-placeholder').classList.remove('hidden');
      removeMainImage.classList.add('hidden');
      mainImageInput.value = '';
    });

    setupDropZone(refImageZone, refImageInput, async (files) => {
      for (const file of files) {
        if (state.referenceImages.length >= 5) {
          UI.showToast('最多只能添加5张参考图片', 'warning');
          break;
        }
        const base64 = await UI.fileToBase64(file);
        state.referenceImages.push(base64);
      }
      renderReferencePreviews();
    });

    function renderReferencePreviews() {
      referencePreviews.innerHTML = state.referenceImages.map((img, index) => `
        <div class="reference-preview-item" data-index="${index}">
          <img src="${img}" alt="参考图片 ${index + 1}">
          <button class="btn-remove" data-index="${index}">✕</button>
        </div>
      `).join('');

      referencePreviews.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const index = parseInt(btn.dataset.index);
          state.referenceImages.splice(index, 1);
          renderReferencePreviews();
        });
      });
    }
  }

  function initFrameUpload() {
    const startFrameZone = document.getElementById('startFrameZone');
    const startFrameInput = document.getElementById('startFrameInput');
    const startFramePreview = document.getElementById('startFramePreview');
    const removeStartFrame = document.getElementById('removeStartFrame');

    const endFrameZone = document.getElementById('endFrameZone');
    const endFrameInput = document.getElementById('endFrameInput');
    const endFramePreview = document.getElementById('endFramePreview');
    const removeEndFrame = document.getElementById('removeEndFrame');

    if (!startFrameZone) return;

    setupFrameDropZone(startFrameZone, startFrameInput, startFramePreview, removeStartFrame, 'startFrame');
    setupFrameDropZone(endFrameZone, endFrameInput, endFramePreview, removeEndFrame, 'endFrame');

    removeStartFrame.addEventListener('click', (e) => {
      e.stopPropagation();
      state.startFrame = null;
      startFramePreview.classList.add('hidden');
      startFramePreview.src = '';
      startFrameZone.querySelector('.upload-placeholder').classList.remove('hidden');
      removeStartFrame.classList.add('hidden');
      startFrameInput.value = '';
    });

    removeEndFrame.addEventListener('click', (e) => {
      e.stopPropagation();
      state.endFrame = null;
      endFramePreview.classList.add('hidden');
      endFramePreview.src = '';
      endFrameZone.querySelector('.upload-placeholder').classList.remove('hidden');
      removeEndFrame.classList.add('hidden');
      endFrameInput.value = '';
    });
  }

  function setupFrameDropZone(zone, input, preview, removeBtn, stateKey) {
    zone.addEventListener('click', () => input.click());
    
    input.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        const file = e.target.files[0];
        const base64 = await UI.fileToBase64(file);
        setFrameImage(zone, preview, removeBtn, stateKey, base64);
      }
    });

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('dragover');
    });

    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      
      const historyId = e.dataTransfer.getData('application/x-history-image');
      if (historyId) {
        const item = HistoryManager.getById(historyId);
        if (item && item.imageBase64) {
          setFrameImage(zone, preview, removeBtn, stateKey, item.imageBase64);
          return;
        }
      }
      
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      if (files.length > 0) {
        const base64 = await UI.fileToBase64(files[0]);
        setFrameImage(zone, preview, removeBtn, stateKey, base64);
      }
    });
  }

  function setFrameImage(zone, preview, removeBtn, stateKey, base64) {
    state[stateKey] = base64;
    preview.src = base64;
    preview.classList.remove('hidden');
    zone.querySelector('.upload-placeholder').classList.add('hidden');
    removeBtn.classList.remove('hidden');
  }

  function setupDropZone(zone, input, onFiles) {
    zone.addEventListener('click', () => input.click());
    
    input.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        onFiles(Array.from(e.target.files));
      }
    });

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('dragover');
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      if (files.length > 0) {
        onFiles(files);
      }
    });
  }

  function initModals() {
    const settingsModal = document.getElementById('settingsModal');
    const settingsBtn = document.getElementById('settingsBtn');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility');

    settingsBtn.addEventListener('click', () => {
      apiKeyInput.value = state.apiKey;
      UI.showModal('settingsModal');
    });

    closeSettingsBtn.addEventListener('click', () => UI.hideModal('settingsModal'));
    settingsModal.querySelector('.modal-backdrop').addEventListener('click', () => UI.hideModal('settingsModal'));

    toggleApiKeyVisibility.addEventListener('click', () => {
      const type = apiKeyInput.type === 'password' ? 'text' : 'password';
      apiKeyInput.type = type;
      toggleApiKeyVisibility.textContent = type === 'password' ? '👁️' : '🙈';
    });

    saveSettingsBtn.addEventListener('click', () => {
      state.apiKey = apiKeyInput.value.trim();
      localStorage.setItem('nano_api_key', state.apiKey);
      
      UI.hideModal('settingsModal');
      UI.showToast('设置已保存', 'success');
    });

    const imageModal = document.getElementById('imageModal');
    const closeImageModalBtn = document.getElementById('closeImageModalBtn');
    const modalDownloadBtn = document.getElementById('modalDownloadBtn');
    const modalEditBtn = document.getElementById('modalEditBtn');
    const modalImage = document.getElementById('modalImage');

    closeImageModalBtn.addEventListener('click', () => UI.hideModal('imageModal'));
    imageModal.querySelector('.modal-backdrop').addEventListener('click', () => UI.hideModal('imageModal'));

    modalDownloadBtn.addEventListener('click', () => {
      if (modalImage.src) {
        UI.downloadImage(modalImage.src, `nano-image-${Date.now()}.png`);
      }
    });

    modalEditBtn.addEventListener('click', () => {
      if (modalImage.src) {
        state.mainImage = modalImage.src;
        
        const mainImagePreview = document.getElementById('mainImagePreview');
        const mainImageZone = document.getElementById('mainImageZone');
        const removeMainImage = document.getElementById('removeMainImage');
        
        mainImagePreview.src = state.mainImage;
        mainImagePreview.classList.remove('hidden');
        mainImageZone.querySelector('.upload-placeholder').classList.add('hidden');
        removeMainImage.classList.remove('hidden');
        
        document.querySelector('[data-tab="img2img"]').click();
        UI.hideModal('imageModal');
        UI.showToast('已加载图片到编辑区', 'success');
      }
    });
  }

  function initActions() {
    const generateBtn = document.getElementById('generateBtn');
    const editBtn = document.getElementById('editBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const continueEditBtn = document.getElementById('continueEditBtn');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const generateVideoBtn = document.getElementById('generateVideoBtn');
    const generateFrameVideoBtn = document.getElementById('generateFrameVideoBtn');
    const generateVideoFromImageBtn = document.getElementById('generateVideoFromImageBtn');
    const modalGenerateVideoBtn = document.getElementById('modalGenerateVideoBtn');

    generateBtn.addEventListener('click', handleGenerate);
    editBtn.addEventListener('click', handleEdit);
    downloadBtn.addEventListener('click', handleDownload);
    continueEditBtn.addEventListener('click', handleContinueEdit);
    clearHistoryBtn.addEventListener('click', handleClearHistory);
    
    if (generateVideoBtn) {
      generateVideoBtn.addEventListener('click', handleGenerateVideo);
    }
    if (generateFrameVideoBtn) {
      generateFrameVideoBtn.addEventListener('click', handleGenerateVideoFromFrames);
    }
    if (generateVideoFromImageBtn) {
      generateVideoFromImageBtn.addEventListener('click', () => {
        if (state.lastGeneratedImage?.imageBase64) {
          loadImageToStartFrame(state.lastGeneratedImage.imageBase64);
        }
      });
    }
    if (modalGenerateVideoBtn) {
      modalGenerateVideoBtn.addEventListener('click', () => {
        const modalImage = document.getElementById('modalImage');
        if (modalImage.src) {
          UI.hideModal('imageModal');
          loadImageToStartFrame(modalImage.src);
        }
      });
    }

    document.getElementById('resultContent').addEventListener('click', (e) => {
      if (e.target.classList.contains('result-image')) {
        document.getElementById('modalImage').src = e.target.src;
        UI.showModal('imageModal');
      }
    });
  }

  async function handleGenerate() {
    const prompt = document.getElementById('promptInput').value.trim();
    
    if (!prompt) {
      UI.showToast('请输入提示词', 'warning');
      return;
    }

    if (!state.apiKey) {
      UI.showToast('请先配置 API Key', 'warning');
      document.getElementById('settingsBtn').click();
      return;
    }

    const task = TaskManager.addTask({
      type: 'text2img',
      prompt: prompt
    });
    if (!task) return;

    UI.setLoading('generateBtn', true);
    showProgressResult();

    try {
      const model = getModel();
      const result = await ImageAPI.generateImage(prompt, state.apiKey, model, (progress) => {
        updateProgress(progress);
        TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
      });
      
      TaskManager.updateTask(task.id, { 
        status: 'completed', 
        result: result 
      });
      
      state.lastGeneratedImage = result;
      
      HistoryManager.add({
        id: result.id,
        prompt: result.prompt,
        imageBase64: result.imageBase64,
        type: 'generate',
        createdAt: result.createdAt
      });

      showResult(result);
      renderHistory();
      UI.showToast('图片生成成功！', 'success');
    } catch (error) {
      TaskManager.updateTask(task.id, { status: 'failed' });
      
      UI.showToast(error.message || '生成失败，请重试', 'error');
      hideLoadingResult();
    } finally {
      UI.setLoading('generateBtn', false);
    }
  }

  async function handleEdit() {
    const prompt = document.getElementById('editPromptInput').value.trim();
    
    if (!prompt) {
      UI.showToast('请输入编辑提示词', 'warning');
      return;
    }

    if (!state.mainImage) {
      UI.showToast('请上传要编辑的图片', 'warning');
      return;
    }

    if (!state.apiKey) {
      UI.showToast('请先配置 API Key', 'warning');
      document.getElementById('settingsBtn').click();
      return;
    }

    const task = TaskManager.addTask({
      type: 'img2img',
      prompt: prompt
    });
    if (!task) return;

    UI.setLoading('editBtn', true);
    showProgressResult();

    try {
      const model = getModel();
      const result = await ImageAPI.editImage({
        prompt,
        apiKey: state.apiKey,
        model,
        mainImageBase64: state.mainImage,
        referenceImagesBase64: state.referenceImages.length > 0 ? state.referenceImages : undefined,
        onProgress: (progress) => {
          updateProgress(progress);
          TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
        }
      });

      TaskManager.updateTask(task.id, { 
        status: 'completed', 
        result: result 
      });

      state.lastGeneratedImage = result;
      
      HistoryManager.add({
        id: result.id,
        prompt: result.prompt,
        imageBase64: result.imageBase64,
        type: 'edit',
        createdAt: result.createdAt
      });

      showResult(result);
      renderHistory();
      UI.showToast('图片编辑成功！', 'success');
    } catch (error) {
      TaskManager.updateTask(task.id, { status: 'failed' });
      
      UI.showToast(error.message || '编辑失败，请重试', 'error');
      hideLoadingResult();
    } finally {
      UI.setLoading('editBtn', false);
    }
  }

  async function handleDownload() {
    if (state.lastVideoBlobUrl) {
      const a = document.createElement('a');
      a.href = state.lastVideoBlobUrl;
      a.download = `nano-video-${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      UI.showToast('下载开始', 'success');
    } else if (state.lastGeneratedVideo?.videoUrl) {
      UI.showToast('正在下载视频...', 'info');
      try {
        const response = await fetch('/api/proxy-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: state.lastGeneratedVideo.videoUrl })
        });
        if (!response.ok) throw new Error('下载失败');
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `nano-video-${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        UI.showToast('下载完成', 'success');
      } catch (error) {
        UI.showToast('视频下载失败: ' + error.message, 'error');
      }
    } else if (state.lastGeneratedImage?.imageBase64) {
      UI.downloadImage(state.lastGeneratedImage.imageBase64, `nano-image-${Date.now()}.png`);
      UI.showToast('下载开始', 'success');
    }
  }

  function handleContinueEdit() {
    if (state.lastGeneratedImage?.imageBase64) {
      state.mainImage = state.lastGeneratedImage.imageBase64;
      
      const mainImagePreview = document.getElementById('mainImagePreview');
      const mainImageZone = document.getElementById('mainImageZone');
      const removeMainImage = document.getElementById('removeMainImage');
      
      mainImagePreview.src = state.mainImage;
      mainImagePreview.classList.remove('hidden');
      mainImageZone.querySelector('.upload-placeholder').classList.add('hidden');
      removeMainImage.classList.remove('hidden');
      
      document.querySelector('[data-tab="img2img"]').click();
      UI.showToast('已加载到编辑区，请输入编辑提示词', 'success');
    }
  }

  function handleClearHistory() {
    if (confirm('确定要清空所有历史记录吗？')) {
      HistoryManager.clear();
      renderHistory();
      UI.showToast('历史记录已清空', 'success');
    }
  }

  async function handleGenerateVideo() {
    const prompt = document.getElementById('videoPromptInput').value.trim();
    
    if (!prompt) {
      UI.showToast('请输入视频描述', 'warning');
      return;
    }

    if (!state.apiKey) {
      UI.showToast('请先配置 API Key', 'warning');
      document.getElementById('settingsBtn').click();
      return;
    }

    const task = TaskManager.addTask({
      type: 'text2video',
      prompt: prompt
    });
    if (!task) return;

    UI.setLoading('generateVideoBtn', true);
    showVideoProgressResult();

    try {
      const result = await ImageAPI.generateVideo(prompt, state.apiKey, state.videoRatio, (progress) => {
        updateProgress(progress);
        TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
      });
      
      TaskManager.updateTask(task.id, { 
        status: 'completed', 
        result: result 
      });
      
      state.lastGeneratedVideo = result;
      state.lastGeneratedImage = null;
      
      HistoryManager.add({
        id: result.id,
        prompt: result.prompt,
        videoUrl: result.videoUrl,
        type: 'video',
        mediaType: 'video',
        createdAt: result.createdAt
      });

      showVideoResult(result);
      renderHistory();
      UI.showToast('视频生成成功！', 'success');
    } catch (error) {
      TaskManager.updateTask(task.id, { status: 'failed' });
      
      UI.showToast(error.message || '生成失败，请重试', 'error');
      hideLoadingResult();
    } finally {
      UI.setLoading('generateVideoBtn', false);
    }
  }

  async function handleGenerateVideoFromFrames() {
    const prompt = document.getElementById('frameVideoPromptInput').value.trim();
    
    if (!prompt) {
      UI.showToast('请输入视频描述', 'warning');
      return;
    }

    if (!state.startFrame) {
      UI.showToast('请上传首帧图片', 'warning');
      return;
    }

    if (state.videoRatio === 'portrait') {
      UI.showToast('由于官方升级，图生视频竖屏模式暂不可用，请选择横屏', 'warning');
      return;
    }

    if (!state.apiKey) {
      UI.showToast('请先配置 API Key', 'warning');
      document.getElementById('settingsBtn').click();
      return;
    }

    const task = TaskManager.addTask({
      type: 'frame2video',
      prompt: prompt
    });
    if (!task) return;

    UI.setLoading('generateFrameVideoBtn', true);
    showVideoProgressResult();

    try {
      const result = await ImageAPI.generateVideoFromFrames({
        prompt,
        apiKey: state.apiKey,
        ratio: state.videoRatio,
        startFrameBase64: state.startFrame,
        endFrameBase64: state.endFrame,
        onProgress: (progress) => {
          updateProgress(progress);
          TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
        }
      });
      
      TaskManager.updateTask(task.id, { 
        status: 'completed', 
        result: result 
      });
      
      state.lastGeneratedVideo = result;
      state.lastGeneratedImage = null;
      
      HistoryManager.add({
        id: result.id,
        prompt: result.prompt,
        videoUrl: result.videoUrl,
        type: 'video-frames',
        mediaType: 'video',
        createdAt: result.createdAt
      });

      showVideoResult(result);
      renderHistory();
      UI.showToast('视频生成成功！', 'success');
    } catch (error) {
      TaskManager.updateTask(task.id, { status: 'failed' });
      
      UI.showToast(error.message || '生成失败，请重试', 'error');
      hideLoadingResult();
    } finally {
      UI.setLoading('generateFrameVideoBtn', false);
    }
  }

  async function startImageToVideo(imageBase64, prompt = '') {
    if (!state.apiKey) {
      UI.showToast('请先配置 API Key', 'warning');
      document.getElementById('settingsBtn').click();
      return;
    }

    const videoPrompt = prompt || '将这张图片转换为动态视频，添加自然的运动效果';
    
    showVideoProgressResult();

    try {
      const result = await ImageAPI.generateVideoFromFrames({
        prompt: videoPrompt,
        apiKey: state.apiKey,
        ratio: state.videoRatio,
        startFrameBase64: imageBase64,
        endFrameBase64: null,
        onProgress: updateProgress
      });
      
      state.lastGeneratedVideo = result;
      state.lastGeneratedImage = null;
      
      HistoryManager.add({
        id: result.id,
        prompt: result.prompt,
        videoUrl: result.videoUrl,
        type: 'image-to-video',
        mediaType: 'video',
        createdAt: result.createdAt
      });

      showVideoResult(result);
      renderHistory();
      UI.showToast('视频生成成功！', 'success');
    } catch (error) {
      UI.showToast(error.message || '生成失败，请重试', 'error');
      hideLoadingResult();
    }
  }

  function loadImageToStartFrame(imageBase64) {
    state.startFrame = imageBase64;
    
    const startFramePreview = document.getElementById('startFramePreview');
    const startFrameZone = document.getElementById('startFrameZone');
    const removeStartFrame = document.getElementById('removeStartFrame');
    
    if (startFramePreview && startFrameZone && removeStartFrame) {
      startFramePreview.src = imageBase64;
      startFramePreview.classList.remove('hidden');
      startFrameZone.querySelector('.upload-placeholder').classList.add('hidden');
      removeStartFrame.classList.remove('hidden');
    }
    
    document.querySelector('[data-tab="frame2video"]').click();
    UI.showToast('已加载图片到首帧，请输入视频描述', 'success');
  }

  function showVideoProgressResult() {
    const resultContent = document.getElementById('resultContent');
    const skeletonClass = state.videoRatio === 'portrait' ? 'skeleton-portrait' : 'skeleton-landscape';
    
    resultContent.innerHTML = `
      <div class="generation-progress">
        <div class="skeleton-image ${skeletonClass}">
          <span class="skeleton-video-icon">🎬</span>
        </div>
        <div class="progress-container">
          <div class="progress-bar">
            <div class="progress-fill" id="progressFill" style="width: 0%"></div>
          </div>
          <div class="progress-info">
            <span class="progress-stage" id="progressStage">准备中...</span>
            <span class="progress-percent" id="progressPercent">0%</span>
          </div>
        </div>
      </div>
    `;
  }

  async function showVideoResult(result) {
    const resultContent = document.getElementById('resultContent');
    const resultActions = document.getElementById('resultActions');
    const resultInfo = document.getElementById('resultInfo');
    const resultPrompt = document.getElementById('resultPrompt');
    const resultTime = document.getElementById('resultTime');
    const continueEditBtn = document.getElementById('continueEditBtn');

    const videoUrl = result.videoUrl ? result.videoUrl.replace(/['"\\s]+$/, '') : null;

    if (!videoUrl) {
      resultContent.innerHTML = `
        <div class="result-placeholder">
          <span class="placeholder-icon">❌</span>
          <p>视频 URL 无效</p>
        </div>
      `;
      resultActions.classList.remove('hidden');
      continueEditBtn.classList.add('hidden');
      resultInfo.classList.remove('hidden');
      resultPrompt.textContent = result.prompt || '';
      resultTime.textContent = UI.formatDate(result.createdAt);
      return;
    }

    resultContent.innerHTML = `
      <div class="generation-progress">
        <div class="skeleton-image skeleton-landscape">
          <span class="skeleton-video-icon">🎬</span>
        </div>
        <div class="progress-container">
          <div class="progress-info">
            <span class="progress-stage">加载视频中...</span>
          </div>
        </div>
      </div>
    `;

    try {
      const response = await fetch('/api/proxy-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: videoUrl })
      });

      if (!response.ok) {
        throw new Error('视频加载失败');
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      state.lastVideoBlobUrl = blobUrl;

      resultContent.innerHTML = `
        <video class="result-video" controls autoplay loop>
          <source src="${blobUrl}" type="video/mp4">
          您的浏览器不支持视频播放
        </video>
      `;
    } catch (error) {
      console.error('Video load error:', error);
      resultContent.innerHTML = `
        <div class="result-placeholder">
          <span class="placeholder-icon">❌</span>
          <p>视频加载失败: ${error.message}</p>
        </div>
      `;
    }
    
    resultActions.classList.remove('hidden');
    continueEditBtn.classList.add('hidden');
    const generateVideoFromImageBtn = document.getElementById('generateVideoFromImageBtn');
    if (generateVideoFromImageBtn) {
      generateVideoFromImageBtn.classList.add('hidden');
    }
    resultInfo.classList.remove('hidden');
    resultPrompt.textContent = result.prompt;
    resultTime.textContent = UI.formatDate(result.createdAt);
  }

  function getSkeletonClass() {
    const ratioMap = {
      'portrait': 'skeleton-portrait',
      'landscape': 'skeleton-landscape',
      'square': 'skeleton-square',
      'four-three': 'skeleton-four-three',
      'three-four': 'skeleton-three-four'
    };
    return ratioMap[state.ratio] || 'skeleton-landscape';
  }

  function showProgressResult() {
    const resultContent = document.getElementById('resultContent');
    const skeletonClass = getSkeletonClass();
    
    resultContent.innerHTML = `
      <div class="generation-progress">
        <div class="skeleton-image ${skeletonClass}"></div>
        <div class="progress-container">
          <div class="progress-bar">
            <div class="progress-fill" id="progressFill" style="width: 0%"></div>
          </div>
          <div class="progress-info">
            <span class="progress-stage" id="progressStage">准备中...</span>
            <span class="progress-percent" id="progressPercent">0%</span>
          </div>
        </div>
      </div>
    `;
  }

  function updateProgress({ stage, percent }) {
    const fillEl = document.getElementById('progressFill');
    const stageEl = document.getElementById('progressStage');
    const percentEl = document.getElementById('progressPercent');
    
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (stageEl) stageEl.textContent = stage;
    if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
  }

  function hideLoadingResult() {
    const resultContent = document.getElementById('resultContent');
    resultContent.innerHTML = `
      <div class="result-placeholder">
        <span class="placeholder-icon">🖼️</span>
        <p>生成的图片将显示在这里</p>
      </div>
    `;
  }

  function showResult(result) {
    const resultContent = document.getElementById('resultContent');
    const resultActions = document.getElementById('resultActions');
    const resultInfo = document.getElementById('resultInfo');
    const resultPrompt = document.getElementById('resultPrompt');
    const resultTime = document.getElementById('resultTime');
    const continueEditBtn = document.getElementById('continueEditBtn');
    const generateVideoFromImageBtn = document.getElementById('generateVideoFromImageBtn');

    resultContent.innerHTML = `<img class="result-image" src="${result.imageBase64}" alt="生成的图片">`;
    resultActions.classList.remove('hidden');
    continueEditBtn.classList.remove('hidden');
    if (generateVideoFromImageBtn) {
      generateVideoFromImageBtn.classList.remove('hidden');
    }
    resultInfo.classList.remove('hidden');
    resultPrompt.textContent = result.prompt;
    resultTime.textContent = UI.formatDate(result.createdAt);
    
    state.lastGeneratedVideo = null;
  }

  function renderHistory() {
    const historyGrid = document.getElementById('historyGrid');
    const history = HistoryManager.getAll();

    if (history.length === 0) {
      historyGrid.innerHTML = `
        <div class="history-empty">
          <p>暂无历史记录</p>
        </div>
      `;
      return;
    }

    historyGrid.innerHTML = history.map(item => {
      const isVideo = item.mediaType === 'video';
      if (isVideo) {
        return `
          <div class="history-item history-item-video" data-id="${item.id}">
            <div class="history-video-thumb">
              <span class="video-icon">🎬</span>
            </div>
            <div class="history-item-overlay">
              <div class="history-item-actions">
                <button class="history-view-btn" data-id="${item.id}">播放</button>
                <button class="history-download-btn" data-id="${item.id}">下载</button>
              </div>
            </div>
            <button class="history-item-delete" data-id="${item.id}">✕</button>
          </div>
        `;
      }
      return `
        <div class="history-item" data-id="${item.id}" draggable="true">
          <img src="${item.imageBase64}" alt="${UI.truncateText(item.prompt, 20)}">
          <div class="history-item-overlay">
            <div class="history-item-actions">
              <button class="history-view-btn" data-id="${item.id}">查看</button>
              <button class="history-edit-btn" data-id="${item.id}">编辑</button>
              <button class="history-video-btn" data-id="${item.id}">视频</button>
            </div>
          </div>
          <button class="history-item-delete" data-id="${item.id}">✕</button>
        </div>
      `;
    }).join('');

    historyGrid.querySelectorAll('.history-view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = HistoryManager.getById(btn.dataset.id);
        if (item) {
          if (item.mediaType === 'video') {
            state.lastGeneratedVideo = { videoUrl: item.videoUrl, prompt: item.prompt, createdAt: item.createdAt };
            state.lastGeneratedImage = null;
            showVideoResult(state.lastGeneratedVideo);
          } else {
            document.getElementById('modalImage').src = item.imageBase64;
            UI.showModal('imageModal');
          }
        }
      });
    });

    historyGrid.querySelectorAll('.history-download-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = HistoryManager.getById(btn.dataset.id);
        if (item && item.videoUrl) {
          UI.showToast('正在下载视频...', 'info');
          try {
            const response = await fetch('/api/proxy-video', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: item.videoUrl })
            });
            if (!response.ok) throw new Error('下载失败');
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `nano-video-${Date.now()}.mp4`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
            UI.showToast('下载完成', 'success');
          } catch (error) {
            UI.showToast('视频下载失败: ' + error.message, 'error');
          }
        }
      });
    });

    historyGrid.querySelectorAll('.history-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = HistoryManager.getById(btn.dataset.id);
        if (item && item.imageBase64) {
          state.mainImage = item.imageBase64;
          
          const mainImagePreview = document.getElementById('mainImagePreview');
          const mainImageZone = document.getElementById('mainImageZone');
          const removeMainImage = document.getElementById('removeMainImage');
          
          mainImagePreview.src = state.mainImage;
          mainImagePreview.classList.remove('hidden');
          mainImageZone.querySelector('.upload-placeholder').classList.add('hidden');
          removeMainImage.classList.remove('hidden');
          
          document.querySelector('[data-tab="img2img"]').click();
          UI.showToast('已加载到编辑区', 'success');
        }
      });
    });

    historyGrid.querySelectorAll('.history-video-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = HistoryManager.getById(btn.dataset.id);
        if (item && item.imageBase64) {
          loadImageToStartFrame(item.imageBase64);
        }
      });
    });

    historyGrid.querySelectorAll('.history-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        HistoryManager.remove(btn.dataset.id);
        renderHistory();
        UI.showToast('已删除', 'success');
      });
    });

    historyGrid.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        const historyItem = HistoryManager.getById(item.dataset.id);
        if (historyItem) {
          if (historyItem.mediaType === 'video') {
            state.lastGeneratedVideo = { videoUrl: historyItem.videoUrl, prompt: historyItem.prompt, createdAt: historyItem.createdAt };
            state.lastGeneratedImage = null;
            showVideoResult(state.lastGeneratedVideo);
          } else {
            document.getElementById('modalImage').src = historyItem.imageBase64;
            UI.showModal('imageModal');
          }
        }
      });

      item.addEventListener('dragstart', (e) => {
        const historyItem = HistoryManager.getById(item.dataset.id);
        if (historyItem && historyItem.imageBase64) {
          e.dataTransfer.setData('text/plain', historyItem.imageBase64);
          e.dataTransfer.setData('application/x-history-image', historyItem.id);
          item.classList.add('dragging');
        }
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
      });
    });
  }
});
