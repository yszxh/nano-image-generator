document.addEventListener('DOMContentLoaded', async () => {
  const state = {
    currentTab: 'text2img',
    mainImage: null,
    referenceImages: [],
    lastGeneratedImage: null,
    apiKey: localStorage.getItem('nano_api_key') || '',
    ratio: localStorage.getItem('nano_ratio') || FlowConfig.image.defaultRatio,
    modelVersion: localStorage.getItem('nano_model_version') || FlowConfig.image.defaultVersion,
    theme: localStorage.getItem('nano_theme') || 'dark',
    videoRatio: localStorage.getItem('nano_video_ratio') || FlowConfig.video.defaultRatio,
    textVideoModel: localStorage.getItem('nano_text_video_model') || FlowConfig.video.defaultTextModel,
    frameVideoModel: localStorage.getItem('nano_frame_video_model') || FlowConfig.video.defaultFrameModel,
    referenceVideoModel: localStorage.getItem('nano_reference_video_model') || FlowConfig.video.defaultReferenceModel,
    videoInputMode: localStorage.getItem('nano_video_input_mode') || 'single',
    startFrame: null,
    transitionStartFrame: null,
    endFrame: null,
    videoReferenceImages: [],
    lastGeneratedVideo: null,
    lastVideoBlobUrl: null
  };

  const TaskManager = {
    MAX_TASKS: 6,
    tasks: [],
    activeTaskId: null,
    canAddTask() {
      return this.tasks.length < this.MAX_TASKS;
    },
    addTask(config) {
      if (!this.canAddTask()) {
        UI.showToast('任务队列已满，请先清理已完成任务。', 'warning');
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
      this.tasks.unshift(task);
      this.activeTaskId = task.id;
      this.render();
      this.updateCount();
      return task;
    },
    updateTask(id, updates) {
      const task = this.tasks.find((item) => item.id === id);
      if (!task) return;
      Object.assign(task, updates);
      this.render();
    },
    removeTask(id) {
      this.tasks = this.tasks.filter((item) => item.id !== id);
      if (this.activeTaskId === id) {
        this.activeTaskId = this.tasks[0]?.id || null;
      }
      this.render();
      this.updateCount();
    },
    setActive(id) {
      this.activeTaskId = id;
      const task = this.tasks.find((item) => item.id === id);
      if (task?.result) {
        if (task.result.videoUrl) {
          showVideoResult(task.result);
        } else {
          showResult(task.result);
        }
      }
      this.render();
    },
    render() {},
    updateCount() {}
  };

  const getImageModel = () => FlowConfig.buildImageModel(state.modelVersion, state.ratio);
  const getTextVideoModel = () => FlowConfig.getVideoModel('textModels', state.textVideoModel, state.videoRatio);
  const getFrameVideoModel = () => FlowConfig.getVideoModel('frameModels', state.frameVideoModel, state.videoRatio);
  const getReferenceVideoModel = () => FlowConfig.getVideoModel('referenceModels', state.referenceVideoModel, state.videoRatio);
  const currentFrameSource = () => state.videoInputMode === 'transition' ? state.transitionStartFrame : state.startFrame;

  TaskManager.render = function renderTaskList() {
    const taskList = document.getElementById('taskList');
    if (!taskList) return;
    if (this.tasks.length === 0) {
      taskList.innerHTML = `
        <div class="task-empty">
          <p>暂无任务</p>
          <p class="task-hint">发起生成后会显示在这里</p>
        </div>
      `;
      return;
    }
    const typeLabels = {
      text2img: '文生图',
      img2img: '图生图',
      text2video: '文生视频',
      frame2video: '图生视频',
      reference2video: '多图视频'
    };
    const statusLabels = {
      running: '进行中',
      completed: '已完成',
      failed: '失败'
    };
    taskList.innerHTML = this.tasks.map((task) => `
      <div class="task-card ${task.status} ${task.id === this.activeTaskId ? 'active' : ''}" data-id="${task.id}">
        <div class="task-card-header">
          <span class="task-type">${typeLabels[task.type] || task.type}</span>
          <span class="task-status">${statusLabels[task.status] || task.status}</span>
        </div>
        <div class="task-prompt">${task.prompt}</div>
        ${task.status === 'running' ? `<div class="task-progress"><div class="task-progress-fill" style="width: ${task.progress}%"></div></div>` : ''}
        <button class="task-delete" data-id="${task.id}">×</button>
      </div>
    `).join('');
    taskList.querySelectorAll('.task-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        if (event.target.classList.contains('task-delete')) return;
        this.setActive(card.dataset.id);
      });
    });
    taskList.querySelectorAll('.task-delete').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.removeTask(button.dataset.id);
      });
    });
  };

  TaskManager.updateCount = function updateTaskCount() {
    const countEl = document.getElementById('taskCount');
    if (countEl) {
      countEl.textContent = `${this.tasks.length}/${this.MAX_TASKS}`;
    }
  };

  function syncRatioCards(selector, ratio) {
    document.querySelectorAll(selector).forEach((card) => {
      card.classList.toggle('active', card.dataset.ratio === ratio);
    });
  }

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
    if (icon) {
      icon.textContent = state.theme === 'dark' ? '☀' : '☾';
    }
  }

  function initTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');
    const imageSettings = document.querySelectorAll('.image-settings');
    const updateImageSettingsVisibility = (tab) => {
      const showImageSettings = tab === 'text2img' || tab === 'img2img';
      imageSettings.forEach((element) => {
        element.style.display = showImageSettings ? 'block' : 'none';
      });
    };
    updateImageSettingsVisibility(state.currentTab);
    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        state.currentTab = button.dataset.tab;
        tabButtons.forEach((item) => item.classList.remove('active'));
        panels.forEach((panel) => panel.classList.remove('active'));
        button.classList.add('active');
        document.getElementById(`${state.currentTab}Panel`).classList.add('active');
        updateImageSettingsVisibility(state.currentTab);
      });
    });
  }

  function updateImageVersionOptions() {
    const select = document.getElementById('modelVersionSelect');
    select.innerHTML = Object.entries(FlowConfig.image.versions).map(([id, config]) => `<option value="${id}">${config.label}</option>`).join('');
    const currentVersion = FlowConfig.image.versions[state.modelVersion] ? state.modelVersion : FlowConfig.image.defaultVersion;
    const versionConfig = FlowConfig.image.versions[currentVersion];
    const ratio = versionConfig.supportedRatios.includes(state.ratio) ? state.ratio : versionConfig.supportedRatios[0];
    if (ratio !== state.ratio) {
      state.ratio = ratio;
      localStorage.setItem('nano_ratio', state.ratio);
      syncRatioCards('.ratio-card', state.ratio);
    }
    state.modelVersion = currentVersion;
    localStorage.setItem('nano_model_version', state.modelVersion);
    select.value = currentVersion;
    document.getElementById('modelHint').textContent = `${versionConfig.hint} | ${getImageModel()}`;
  }

  function populateVideoModelSelect(selectId, hintId, entries, selectedId) {
    const select = document.getElementById(selectId);
    const hint = document.getElementById(hintId);
    select.innerHTML = Object.entries(entries).map(([id, config]) => `<option value="${id}">${config.label}</option>`).join('');
    select.value = entries[selectedId] ? selectedId : Object.keys(entries)[0];
    const activeConfig = entries[select.value];
    hint.textContent = `${activeConfig.hint} | ${activeConfig.models[state.videoRatio] || activeConfig.models.landscape}`;
  }

  function refreshVideoModelSelectors() {
    populateVideoModelSelect('videoModelSelect', 'videoModelHint', FlowConfig.video.textModels, state.textVideoModel);
    if (state.videoInputMode === 'reference') {
      populateVideoModelSelect('frameVideoModelSelect', 'frameVideoModelHint', FlowConfig.video.referenceModels, state.referenceVideoModel);
    } else {
      populateVideoModelSelect('frameVideoModelSelect', 'frameVideoModelHint', FlowConfig.video.frameModels, state.frameVideoModel);
    }
  }

  function initImageControls() {
    syncRatioCards('.ratio-card', state.ratio);
    document.querySelectorAll('.ratio-card').forEach((card) => {
      card.addEventListener('click', () => {
        state.ratio = card.dataset.ratio;
        localStorage.setItem('nano_ratio', state.ratio);
        syncRatioCards('.ratio-card', state.ratio);
        updateImageVersionOptions();
      });
    });
    const select = document.getElementById('modelVersionSelect');
    updateImageVersionOptions();
    select.addEventListener('change', () => {
      state.modelVersion = select.value;
      localStorage.setItem('nano_model_version', state.modelVersion);
      updateImageVersionOptions();
    });
  }

  function initVideoControls() {
    syncRatioCards('.text-video-ratio .video-ratio-card', state.videoRatio);
    syncRatioCards('.frame-video-ratio .video-ratio-card', state.videoRatio);
    document.querySelectorAll('.video-ratio-card').forEach((card) => {
      card.addEventListener('click', () => {
        state.videoRatio = card.dataset.ratio;
        localStorage.setItem('nano_video_ratio', state.videoRatio);
        syncRatioCards('.text-video-ratio .video-ratio-card', state.videoRatio);
        syncRatioCards('.frame-video-ratio .video-ratio-card', state.videoRatio);
        refreshVideoModelSelectors();
      });
    });
    document.getElementById('videoModelSelect').addEventListener('change', (event) => {
      state.textVideoModel = event.target.value;
      localStorage.setItem('nano_text_video_model', state.textVideoModel);
      refreshVideoModelSelectors();
    });
    document.getElementById('frameVideoModelSelect').addEventListener('change', (event) => {
      if (state.videoInputMode === 'reference') {
        state.referenceVideoModel = event.target.value;
        localStorage.setItem('nano_reference_video_model', state.referenceVideoModel);
      } else {
        state.frameVideoModel = event.target.value;
        localStorage.setItem('nano_frame_video_model', state.frameVideoModel);
      }
      refreshVideoModelSelectors();
    });
    document.querySelectorAll('.video-mode-card').forEach((card) => {
      card.addEventListener('click', () => {
        state.videoInputMode = card.dataset.mode;
        localStorage.setItem('nano_video_input_mode', state.videoInputMode);
        updateVideoModeUI();
      });
    });
    updateVideoModeUI();
  }

  function updateVideoModeUI() {
    document.querySelectorAll('.video-mode-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.mode === state.videoInputMode);
    });
    document.querySelectorAll('.video-subpanel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === state.videoInputMode);
    });
    refreshVideoModelSelectors();
  }

  function initTemplates() {
    document.querySelectorAll('.template-tag:not(.video-template)').forEach((button) => {
      button.addEventListener('click', () => {
        const input = document.getElementById('promptInput');
        input.value = input.value.trim() ? `${input.value.trim()}, ${button.dataset.template}` : button.dataset.template;
      });
    });
    document.querySelectorAll('.video-template').forEach((button) => {
      button.addEventListener('click', () => {
        const input = document.getElementById('videoPromptInput');
        input.value = input.value.trim() ? `${input.value.trim()}, ${button.dataset.template}` : button.dataset.template;
      });
    });
  }

  // UI_INIT
  function setImagePreview(base64, previewId, zoneId, removeId, stateKey) {
    state[stateKey] = base64;
    const preview = document.getElementById(previewId);
    preview.src = base64;
    preview.classList.remove('hidden');
    document.getElementById(zoneId).querySelector('.upload-placeholder').classList.add('hidden');
    document.getElementById(removeId).classList.remove('hidden');
  }

  function clearImagePreview(previewId, zoneId, removeId, stateKey, inputId) {
    state[stateKey] = null;
    const preview = document.getElementById(previewId);
    preview.src = '';
    preview.classList.add('hidden');
    document.getElementById(zoneId).querySelector('.upload-placeholder').classList.remove('hidden');
    document.getElementById(removeId).classList.add('hidden');
    const input = document.getElementById(inputId);
    if (input) input.value = '';
  }

  function setupDropZone(zone, input, onFiles) {
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', (event) => {
      const files = Array.from(event.target.files || []);
      if (files.length > 0) onFiles(files);
    });
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('dragover');
      const historyId = event.dataTransfer.getData('application/x-history-image');
      if (historyId) {
        const item = HistoryManager.getById(historyId);
        if (item?.imageBase64) {
          onFiles([{ historyBase64: item.imageBase64 }]);
          return;
        }
      }
      const files = Array.from(event.dataTransfer.files || []).filter((file) => file.type.startsWith('image/'));
      if (files.length > 0) onFiles(files);
    });
  }

  async function fileOrHistoryToBase64(item) {
    return item.historyBase64 || UI.fileToBase64(item);
  }

  function renderReferencePreviews(containerId, images, onRemove) {
    const container = document.getElementById(containerId);
    container.innerHTML = images.map((image, index) => `
      <div class="reference-preview-item" data-index="${index}">
        <img src="${image}" alt="reference-${index + 1}">
        <button class="btn-remove" data-index="${index}">×</button>
      </div>
    `).join('');
    container.querySelectorAll('.btn-remove').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        onRemove(Number(button.dataset.index));
      });
    });
  }

  function refreshImageReferencePreviews() {
    renderReferencePreviews('referencePreviews', state.referenceImages, (index) => {
      state.referenceImages.splice(index, 1);
      refreshImageReferencePreviews();
    });
  }

  function refreshVideoReferencePreviews() {
    renderReferencePreviews('videoReferencePreviews', state.videoReferenceImages, (index) => {
      state.videoReferenceImages.splice(index, 1);
      refreshVideoReferencePreviews();
    });
  }

  function initUploads() {
    setupDropZone(document.getElementById('mainImageZone'), document.getElementById('mainImageInput'), async (items) => {
      const base64 = await fileOrHistoryToBase64(items[0]);
      setImagePreview(base64, 'mainImagePreview', 'mainImageZone', 'removeMainImage', 'mainImage');
    });
    document.getElementById('removeMainImage').addEventListener('click', (event) => {
      event.stopPropagation();
      clearImagePreview('mainImagePreview', 'mainImageZone', 'removeMainImage', 'mainImage', 'mainImageInput');
    });
    setupDropZone(document.getElementById('refImageZone'), document.getElementById('refImageInput'), async (items) => {
      for (const item of items) {
        if (state.referenceImages.length >= 5) {
          UI.showToast('参考图最多支持 5 张。', 'warning');
          break;
        }
        state.referenceImages.push(await fileOrHistoryToBase64(item));
      }
      refreshImageReferencePreviews();
    });

    const frameConfigs = [
      ['startFrameZone', 'startFrameInput', 'startFramePreview', 'removeStartFrame', 'startFrame'],
      ['transitionStartFrameZone', 'transitionStartFrameInput', 'transitionStartFramePreview', 'removeTransitionStartFrame', 'transitionStartFrame'],
      ['endFrameZone', 'endFrameInput', 'endFramePreview', 'removeEndFrame', 'endFrame']
    ];
    frameConfigs.forEach(([zoneId, inputId, previewId, removeId, stateKey]) => {
      setupDropZone(document.getElementById(zoneId), document.getElementById(inputId), async (items) => {
        const base64 = await fileOrHistoryToBase64(items[0]);
        setImagePreview(base64, previewId, zoneId, removeId, stateKey);
      });
      document.getElementById(removeId).addEventListener('click', (event) => {
        event.stopPropagation();
        clearImagePreview(previewId, zoneId, removeId, stateKey, inputId);
      });
    });
    setupDropZone(document.getElementById('videoReferenceZone'), document.getElementById('videoReferenceInput'), async (items) => {
      for (const item of items) {
        if (state.videoReferenceImages.length >= 3) {
          UI.showToast('R2V 最多支持 3 张参考图。', 'warning');
          break;
        }
        state.videoReferenceImages.push(await fileOrHistoryToBase64(item));
      }
      refreshVideoReferencePreviews();
    });
  }

  function getSkeletonClass() {
    return {
      portrait: 'skeleton-portrait',
      landscape: 'skeleton-landscape',
      square: 'skeleton-square',
      'four-three': 'skeleton-four-three',
      'three-four': 'skeleton-three-four'
    }[state.ratio] || 'skeleton-landscape';
  }

  function showProgressResult() {
    document.getElementById('resultContent').innerHTML = `
      <div class="generation-progress">
        <div class="skeleton-image ${getSkeletonClass()}"></div>
        <div class="progress-container">
          <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width: 0%"></div></div>
          <div class="progress-info">
            <span class="progress-stage" id="progressStage">Preparing...</span>
            <span class="progress-percent" id="progressPercent">0%</span>
          </div>
        </div>
      </div>
    `;
  }

  function showVideoProgressResult() {
    document.getElementById('resultContent').innerHTML = `
      <div class="generation-progress">
        <div class="skeleton-image ${state.videoRatio === 'portrait' ? 'skeleton-portrait' : 'skeleton-landscape'}"><span class="skeleton-video-icon">▶</span></div>
        <div class="progress-container">
          <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width: 0%"></div></div>
          <div class="progress-info">
            <span class="progress-stage" id="progressStage">Preparing...</span>
            <span class="progress-percent" id="progressPercent">0%</span>
          </div>
        </div>
      </div>
    `;
  }

  function updateProgress({ stage, percent }) {
    const fill = document.getElementById('progressFill');
    const label = document.getElementById('progressStage');
    const counter = document.getElementById('progressPercent');
    if (fill) fill.style.width = `${Math.round(percent)}%`;
    if (label) label.textContent = stage;
    if (counter) counter.textContent = `${Math.round(percent)}%`;
  }

  function hideLoadingResult() {
    document.getElementById('resultContent').innerHTML = `
      <div class="result-placeholder">
        <span class="placeholder-icon">□</span>
        <p>生成结果会显示在这里</p>
      </div>
    `;
  }

  function showResult(result) {
    if (state.lastVideoBlobUrl) {
      URL.revokeObjectURL(state.lastVideoBlobUrl);
      state.lastVideoBlobUrl = null;
    }
    document.getElementById('resultContent').innerHTML = `<img class="result-image" src="${result.imageBase64}" alt="generated image">`;
    document.getElementById('resultActions').classList.remove('hidden');
    document.getElementById('continueEditBtn').classList.remove('hidden');
    document.getElementById('generateVideoFromImageBtn').classList.remove('hidden');
    document.getElementById('resultInfo').classList.remove('hidden');
    document.getElementById('resultPrompt').textContent = result.prompt;
    document.getElementById('resultTime').textContent = UI.formatDate(result.createdAt);
  }

  async function showVideoResult(result) {
    document.getElementById('resultActions').classList.remove('hidden');
    document.getElementById('continueEditBtn').classList.add('hidden');
    document.getElementById('generateVideoFromImageBtn').classList.add('hidden');
    document.getElementById('resultInfo').classList.remove('hidden');
    document.getElementById('resultPrompt').textContent = result.prompt;
    document.getElementById('resultTime').textContent = UI.formatDate(result.createdAt);
    document.getElementById('resultContent').innerHTML = `
      <div class="generation-progress">
        <div class="skeleton-image skeleton-landscape"><span class="skeleton-video-icon">▶</span></div>
        <div class="progress-container"><div class="progress-info"><span class="progress-stage">Loading video...</span></div></div>
      </div>
    `;
    try {
      if (state.lastVideoBlobUrl) {
        URL.revokeObjectURL(state.lastVideoBlobUrl);
        state.lastVideoBlobUrl = null;
      }
      const response = await fetch('/api/proxy-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: result.videoUrl })
      });
      if (!response.ok) throw new Error('视频加载失败。');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      state.lastVideoBlobUrl = blobUrl;
      document.getElementById('resultContent').innerHTML = `
        <video class="result-video" controls autoplay loop>
          <source src="${blobUrl}" type="video/mp4">
          当前浏览器不支持视频播放。
        </video>
      `;
    } catch (error) {
      document.getElementById('resultContent').innerHTML = `
        <div class="result-placeholder">
          <span class="placeholder-icon">×</span>
          <p>${error.message}</p>
        </div>
      `;
    }
  }

  // RESULT_RENDER
  function ensureApiKey() {
    if (state.apiKey) return true;
    UI.showToast('请先配置 Flow2API Key。', 'warning');
    document.getElementById('settingsBtn').click();
    return false;
  }

  async function handleGenerate() {
    const prompt = document.getElementById('promptInput').value.trim();
    if (!prompt) {
      UI.showToast('请输入提示词。', 'warning');
      return;
    }
    if (!ensureApiKey()) return;
    const task = TaskManager.addTask({ type: 'text2img', prompt });
    if (!task) return;
    UI.setLoading('generateBtn', true);
    showProgressResult();
    try {
      const result = await ImageAPI.generateImage(prompt, state.apiKey, getImageModel(), (progress) => {
        updateProgress(progress);
        TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
      });
      TaskManager.updateTask(task.id, { status: 'completed', result });
      state.lastGeneratedImage = result;
      state.lastGeneratedVideo = null;
      HistoryManager.add({ id: result.id, prompt: result.prompt, imageBase64: result.imageBase64, mediaType: 'image', type: 'generate', createdAt: result.createdAt });
      showResult(result);
      renderHistory();
      UI.showToast('图片生成成功。', 'success');
    } catch (error) {
      TaskManager.updateTask(task.id, { status: 'failed' });
      UI.showToast(error.message || '图片生成失败。', 'error');
      hideLoadingResult();
    } finally {
      UI.setLoading('generateBtn', false);
    }
  }

  async function handleEdit() {
    const prompt = document.getElementById('editPromptInput').value.trim();
    if (!prompt) {
      UI.showToast('请输入编辑提示词。', 'warning');
      return;
    }
    if (!state.mainImage) {
      UI.showToast('请先上传主图。', 'warning');
      return;
    }
    if (!ensureApiKey()) return;
    const task = TaskManager.addTask({ type: 'img2img', prompt });
    if (!task) return;
    UI.setLoading('editBtn', true);
    showProgressResult();
    try {
      const result = await ImageAPI.editImage({
        prompt,
        apiKey: state.apiKey,
        model: getImageModel(),
        mainImageBase64: state.mainImage,
        referenceImagesBase64: state.referenceImages,
        onProgress: (progress) => {
          updateProgress(progress);
          TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
        }
      });
      TaskManager.updateTask(task.id, { status: 'completed', result });
      state.lastGeneratedImage = result;
      state.lastGeneratedVideo = null;
      HistoryManager.add({ id: result.id, prompt: result.prompt, imageBase64: result.imageBase64, mediaType: 'image', type: 'edit', createdAt: result.createdAt });
      showResult(result);
      renderHistory();
      UI.showToast('图片编辑成功。', 'success');
    } catch (error) {
      TaskManager.updateTask(task.id, { status: 'failed' });
      UI.showToast(error.message || '图片编辑失败。', 'error');
      hideLoadingResult();
    } finally {
      UI.setLoading('editBtn', false);
    }
  }

  function consumeVideoResult(result, type) {
    state.lastGeneratedVideo = result;
    state.lastGeneratedImage = null;
    HistoryManager.add({ id: result.id, prompt: result.prompt, videoUrl: result.videoUrl, mediaType: 'video', type, createdAt: result.createdAt });
    showVideoResult(result);
    renderHistory();
  }

  async function handleGenerateVideo() {
    const prompt = document.getElementById('videoPromptInput').value.trim();
    if (!prompt) {
      UI.showToast('请输入视频描述。', 'warning');
      return;
    }
    if (!ensureApiKey()) return;
    const task = TaskManager.addTask({ type: 'text2video', prompt });
    if (!task) return;
    UI.setLoading('generateVideoBtn', true);
    showVideoProgressResult();
    try {
      const result = await ImageAPI.generateVideo(prompt, state.apiKey, state.videoRatio, getTextVideoModel(), (progress) => {
        updateProgress(progress);
        TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
      });
      TaskManager.updateTask(task.id, { status: 'completed', result });
      consumeVideoResult(result, 'video');
      UI.showToast('视频生成成功。', 'success');
    } catch (error) {
      TaskManager.updateTask(task.id, { status: 'failed' });
      UI.showToast(error.message || '视频生成失败。', 'error');
      hideLoadingResult();
    } finally {
      UI.setLoading('generateVideoBtn', false);
    }
  }

  async function handleGenerateVideoFromImages() {
    const prompt = document.getElementById('frameVideoPromptInput').value.trim();
    if (!prompt) {
      UI.showToast('请输入视频描述。', 'warning');
      return;
    }
    if (!ensureApiKey()) return;
    const taskType = state.videoInputMode === 'reference' ? 'reference2video' : 'frame2video';
    const task = TaskManager.addTask({ type: taskType, prompt });
    if (!task) return;
    UI.setLoading('generateFrameVideoBtn', true);
    showVideoProgressResult();
    try {
      let result;
      if (state.videoInputMode === 'reference') {
        if (state.videoReferenceImages.length === 0) {
          throw new Error('请至少上传 1 张参考图。');
        }
        result = await ImageAPI.generateVideoFromReferences({
          prompt,
          apiKey: state.apiKey,
          ratio: state.videoRatio,
          model: getReferenceVideoModel(),
          referenceImagesBase64: state.videoReferenceImages,
          onProgress: (progress) => {
            updateProgress(progress);
            TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
          }
        });
      } else {
        const startFrameBase64 = currentFrameSource();
        if (!startFrameBase64) {
          throw new Error('请先上传首帧。');
        }
        result = await ImageAPI.generateVideoFromFrames({
          prompt,
          apiKey: state.apiKey,
          ratio: state.videoRatio,
          model: getFrameVideoModel(),
          startFrameBase64,
          endFrameBase64: state.videoInputMode === 'transition' ? state.endFrame : null,
          onProgress: (progress) => {
            updateProgress(progress);
            TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
          }
        });
      }
      TaskManager.updateTask(task.id, { status: 'completed', result });
      consumeVideoResult(result, state.videoInputMode === 'reference' ? 'reference-video' : 'video-frames');
      UI.showToast('视频生成成功。', 'success');
    } catch (error) {
      TaskManager.updateTask(task.id, { status: 'failed' });
      UI.showToast(error.message || '视频生成失败。', 'error');
      hideLoadingResult();
    } finally {
      UI.setLoading('generateFrameVideoBtn', false);
    }
  }

  async function handleDownload() {
    if (state.lastGeneratedImage?.imageBase64) {
      UI.downloadImage(state.lastGeneratedImage.imageBase64, `nano-image-${Date.now()}.png`);
      return;
    }
    const videoUrl = state.lastGeneratedVideo?.videoUrl;
    if (!videoUrl) return;
    try {
      const response = await fetch('/api/proxy-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: videoUrl })
      });
      if (!response.ok) throw new Error('下载失败。');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `nano-video-${Date.now()}.mp4`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      UI.showToast(error.message || '视频下载失败。', 'error');
    }
  }

  function handleContinueEdit() {
    if (!state.lastGeneratedImage?.imageBase64) return;
    setImagePreview(state.lastGeneratedImage.imageBase64, 'mainImagePreview', 'mainImageZone', 'removeMainImage', 'mainImage');
    document.querySelector('[data-tab="img2img"]').click();
    UI.showToast('已载入到图生图编辑区。', 'success');
  }

  function handleClearHistory() {
    if (!confirm('确定清空全部历史记录吗？')) return;
    HistoryManager.clear();
    renderHistory();
    UI.showToast('历史记录已清空。', 'success');
  }

  function loadImageToVideoFlow(imageBase64) {
    state.videoInputMode = 'single';
    localStorage.setItem('nano_video_input_mode', state.videoInputMode);
    updateVideoModeUI();
    setImagePreview(imageBase64, 'startFramePreview', 'startFrameZone', 'removeStartFrame', 'startFrame');
    document.querySelector('[data-tab="frame2video"]').click();
    UI.showToast('已将图片载入图生视频。', 'success');
  }

  async function initModals() {
    const settingsModal = document.getElementById('settingsModal');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const configStatus = await ImageAPI.checkConfigStatus();
    document.getElementById('configStatusHint').textContent = configStatus.message || 'API Key 默认仅保存在当前浏览器。';
    document.getElementById('settingsBtn').addEventListener('click', () => {
      apiKeyInput.value = state.apiKey;
      UI.showModal('settingsModal');
    });
    document.getElementById('closeSettingsBtn').addEventListener('click', () => UI.hideModal('settingsModal'));
    settingsModal.querySelector('.modal-backdrop').addEventListener('click', () => UI.hideModal('settingsModal'));
    document.getElementById('toggleApiKeyVisibility').addEventListener('click', () => {
      apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('saveSettingsBtn').addEventListener('click', () => {
      state.apiKey = apiKeyInput.value.trim();
      localStorage.setItem('nano_api_key', state.apiKey);
      UI.hideModal('settingsModal');
      UI.showToast('API 设置已保存。', 'success');
    });
    const imageModal = document.getElementById('imageModal');
    const modalImage = document.getElementById('modalImage');
    document.getElementById('closeImageModalBtn').addEventListener('click', () => UI.hideModal('imageModal'));
    imageModal.querySelector('.modal-backdrop').addEventListener('click', () => UI.hideModal('imageModal'));
    document.getElementById('modalDownloadBtn').addEventListener('click', () => {
      if (modalImage.src) UI.downloadImage(modalImage.src, `nano-image-${Date.now()}.png`);
    });
    document.getElementById('modalEditBtn').addEventListener('click', () => {
      if (!modalImage.src) return;
      setImagePreview(modalImage.src, 'mainImagePreview', 'mainImageZone', 'removeMainImage', 'mainImage');
      document.querySelector('[data-tab="img2img"]').click();
      UI.hideModal('imageModal');
    });
    document.getElementById('modalGenerateVideoBtn').addEventListener('click', () => {
      if (!modalImage.src) return;
      loadImageToVideoFlow(modalImage.src);
      UI.hideModal('imageModal');
    });
  }

  function initActions() {
    document.getElementById('generateBtn').addEventListener('click', handleGenerate);
    document.getElementById('editBtn').addEventListener('click', handleEdit);
    document.getElementById('downloadBtn').addEventListener('click', handleDownload);
    document.getElementById('continueEditBtn').addEventListener('click', handleContinueEdit);
    document.getElementById('clearHistoryBtn').addEventListener('click', handleClearHistory);
    document.getElementById('generateVideoBtn').addEventListener('click', handleGenerateVideo);
    document.getElementById('generateFrameVideoBtn').addEventListener('click', handleGenerateVideoFromImages);
    document.getElementById('generateVideoFromImageBtn').addEventListener('click', () => {
      if (state.lastGeneratedImage?.imageBase64) loadImageToVideoFlow(state.lastGeneratedImage.imageBase64);
    });
    document.getElementById('resultContent').addEventListener('click', (event) => {
      if (event.target.classList.contains('result-image')) {
        document.getElementById('modalImage').src = event.target.src;
        UI.showModal('imageModal');
      }
    });
  }

  function renderHistory() {
    const historyGrid = document.getElementById('historyGrid');
    const history = HistoryManager.getAll();
    if (history.length === 0) {
      historyGrid.innerHTML = `<div class="history-empty"><p>暂无历史记录</p></div>`;
      return;
    }
    historyGrid.innerHTML = history.map((item) => {
      if (item.mediaType === 'video') {
        return `
          <div class="history-item history-item-video" data-id="${item.id}">
            <div class="history-video-thumb"><span class="video-icon">▶</span></div>
            <div class="history-item-overlay">
              <div class="history-item-actions">
                <button class="history-view-btn" data-id="${item.id}">播放</button>
                <button class="history-download-btn" data-id="${item.id}">下载</button>
              </div>
            </div>
            <button class="history-item-delete" data-id="${item.id}">×</button>
          </div>
        `;
      }
      return `
        <div class="history-item" data-id="${item.id}" draggable="true">
          <img src="${item.imageBase64}" alt="${UI.truncateText(item.prompt, 16)}">
          <div class="history-item-overlay">
            <div class="history-item-actions">
              <button class="history-view-btn" data-id="${item.id}">查看</button>
              <button class="history-edit-btn" data-id="${item.id}">编辑</button>
              <button class="history-video-btn" data-id="${item.id}">视频</button>
            </div>
          </div>
          <button class="history-item-delete" data-id="${item.id}">×</button>
        </div>
      `;
    }).join('');
    historyGrid.querySelectorAll('.history-view-btn').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const item = HistoryManager.getById(button.dataset.id);
        if (!item) return;
        if (item.mediaType === 'video') {
          state.lastGeneratedVideo = { videoUrl: item.videoUrl, prompt: item.prompt, createdAt: item.createdAt };
          showVideoResult(state.lastGeneratedVideo);
        } else {
          document.getElementById('modalImage').src = item.imageBase64;
          UI.showModal('imageModal');
        }
      });
    });
    historyGrid.querySelectorAll('.history-download-btn').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const item = HistoryManager.getById(button.dataset.id);
        if (!item?.videoUrl) return;
        state.lastGeneratedVideo = item;
        await handleDownload();
      });
    });
    historyGrid.querySelectorAll('.history-edit-btn').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const item = HistoryManager.getById(button.dataset.id);
        if (!item?.imageBase64) return;
        setImagePreview(item.imageBase64, 'mainImagePreview', 'mainImageZone', 'removeMainImage', 'mainImage');
        document.querySelector('[data-tab="img2img"]').click();
      });
    });
    historyGrid.querySelectorAll('.history-video-btn').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const item = HistoryManager.getById(button.dataset.id);
        if (item?.imageBase64) loadImageToVideoFlow(item.imageBase64);
      });
    });
    historyGrid.querySelectorAll('.history-item-delete').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        HistoryManager.remove(button.dataset.id);
        renderHistory();
      });
    });
    historyGrid.querySelectorAll('.history-item[draggable="true"]').forEach((item) => {
      item.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('application/x-history-image', item.dataset.id);
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
    });
    historyGrid.querySelectorAll('.history-item').forEach((item) => {
      item.addEventListener('click', () => {
        const historyItem = HistoryManager.getById(item.dataset.id);
        if (!historyItem) return;
        if (historyItem.mediaType === 'video') {
          state.lastGeneratedVideo = historyItem;
          showVideoResult(historyItem);
        } else {
          document.getElementById('modalImage').src = historyItem.imageBase64;
          UI.showModal('imageModal');
        }
      });
    });
  }

  initTheme();
  initTabs();
  initImageControls();
  initVideoControls();
  initTemplates();
  initUploads();
  await initModals();
  initActions();
  renderHistory();
  TaskManager.render();
  TaskManager.updateCount();
  refreshImageReferencePreviews();
  refreshVideoReferencePreviews();
});
