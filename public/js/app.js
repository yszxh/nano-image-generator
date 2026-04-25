document.addEventListener('DOMContentLoaded', async () => {
  const state = {
    currentTab: 'text2img',
    mainImage: null,
    referenceImages: [],
    lastGeneratedImage: null,
    apiKey: localStorage.getItem('nano_api_key') || '',
    ratio: localStorage.getItem('nano_ratio') || FlowConfig.image.defaultRatio,
    modelVersion: localStorage.getItem('nano_model_version') || FlowConfig.image.defaultVersion,
    gptImageQuality: localStorage.getItem('nano_gpt_image_quality') || 'auto',
    gptImageBackground: localStorage.getItem('nano_gpt_image_background') || 'auto',
    gptImageOutputFormat: localStorage.getItem('nano_gpt_image_output_format') || 'png',
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
    lastVideoBlobUrl: null,
    modalImageItem: null,
    progressStartedAt: null,
    progressTimer: null,
    progressHintIndex: 0
  };

  const PROGRESS_HINTS = [
    '正在排队调用 OpenAI 图像模型',
    '模型正在理解提示词和画面比例',
    '正在生成主体、材质和光影细节',
    '正在整理输出图片，请保持页面打开',
    '生成任务仍在运行，没有卡死'
  ];

  const TaskManager = {
    MAX_TASKS: 6,
    MAX_RUNNING_IMAGE: 2,
    MAX_RUNNING_VIDEO: 1,
    tasks: JSON.parse(localStorage.getItem('nano_tasks') || '[]'),
    activeTaskId: null,
    getTaskKind(type) {
      return type === 'text2img' || type === 'img2img' ? 'image' : 'video';
    },
    getRunningLimit(type) {
      return this.getTaskKind(type) === 'image' ? this.MAX_RUNNING_IMAGE : this.MAX_RUNNING_VIDEO;
    },
    getRunningCount(type) {
      const kind = this.getTaskKind(type);
      return this.tasks.filter((task) => this.getTaskKind(task.type) === kind && task.status === 'running').length;
    },
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
        status: 'queued',
        progress: 0,
        result: null,
        createdAt: new Date().toISOString()
      };
      this.tasks.unshift(task);
      this.activeTaskId = this.activeTaskId || task.id;
      this.save();
      this.render();
      this.updateCount();
      return task;
    },
    startTask(task) {
      task.status = 'running';
      this.activeTaskId = task.id;
      if (this.getTaskKind(task.type) === 'image') {
        showProgressResult();
      } else {
        showVideoProgressResult();
      }
      this.save();
      this.render();
      this.updateCount();
    },
    async runTask(config, worker) {
      const task = this.addTask(config);
      if (!task) return null;
      return await new Promise((resolve, reject) => {
        task.worker = worker;
        task.resolve = resolve;
        task.reject = reject;
        this.pumpQueue();
      });
    },
    pumpQueue() {
      const queuedTasks = [...this.tasks]
        .filter((task) => task.status === 'queued' && typeof task.worker === 'function')
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      for (const task of queuedTasks) {
        if (this.getRunningCount(task.type) >= this.getRunningLimit(task.type)) {
          continue;
        }
        this.startTask(task);
        Promise.resolve()
          .then(() => task.worker(task))
          .then((result) => task.resolve?.(result))
          .catch((error) => task.reject?.(error))
          .finally(() => {
            delete task.worker;
            delete task.resolve;
            delete task.reject;
            this.save();
            this.render();
            this.updateCount();
            this.pumpQueue();
          });
      }
    },
    updateTask(id, updates) {
      const task = this.tasks.find((item) => item.id === id);
      if (!task) return;
      Object.assign(task, updates);
      this.save();
      this.render();
    },
    removeTask(id) {
      this.tasks = this.tasks.filter((item) => item.id !== id);
      if (this.activeTaskId === id) {
        this.activeTaskId = this.tasks[0]?.id || null;
      }
      this.save();
      this.render();
      this.updateCount();
    },
    save() {
      // 仅持久化基本信息，不持久化巨大的结果数据以节省 storage 空间
      const tasksToSave = this.tasks.map(t => ({
        ...t,
        result: t.status === 'completed' ? {
          ...t.result,
          imageBase64: null,
          imageUrl: t.result?.imageUrl || null,
          imageMimeType: t.result?.imageMimeType || null,
          imageOutputFormat: t.result?.imageOutputFormat || null
        } : t.result
      })).slice(0, 10);
      localStorage.setItem('nano_tasks', JSON.stringify(tasksToSave));
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
  const isGptImage2Selected = () => getImageModel() === 'gpt-image-2';
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
      queued: '排队中',
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
    updateGptImageAdvancedVisibility();
  }

  function updateGptImageAdvancedVisibility() {
    const group = document.getElementById('gptImageAdvancedGroup');
    if (!group) return;
    group.classList.toggle('hidden', !isGptImage2Selected());
  }

  function getImageRequestOptions() {
    if (!isGptImage2Selected()) {
      return {};
    }
    return {
      quality: state.gptImageQuality,
      background: state.gptImageBackground,
      outputFormat: state.gptImageOutputFormat
    };
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
    document.getElementById('gptImageQualitySelect').value = state.gptImageQuality;
    document.getElementById('gptImageBackgroundSelect').value = state.gptImageBackground;
    document.getElementById('gptImageFormatSelect').value = state.gptImageOutputFormat;
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
    document.getElementById('gptImageQualitySelect').addEventListener('change', (event) => {
      state.gptImageQuality = event.target.value;
      localStorage.setItem('nano_gpt_image_quality', state.gptImageQuality);
    });
    document.getElementById('gptImageBackgroundSelect').addEventListener('change', (event) => {
      state.gptImageBackground = event.target.value;
      localStorage.setItem('nano_gpt_image_background', state.gptImageBackground);
    });
    document.getElementById('gptImageFormatSelect').addEventListener('change', (event) => {
      state.gptImageOutputFormat = event.target.value;
      localStorage.setItem('nano_gpt_image_output_format', state.gptImageOutputFormat);
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

  function getImageSource(item) {
    return item?.imageUrl || item?.imageBase64 || '';
  }

  function getImageExtension(item) {
    const format = (item?.imageOutputFormat || '').toLowerCase();
    if (format === 'jpeg' || format === 'jpg') return 'jpg';
    if (format === 'webp') return 'webp';
    if (format === 'png') return 'png';

    const mimeType = (item?.imageMimeType || '').toLowerCase();
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('png')) return 'png';

    const source = getImageSource(item);
    const dataUrlMime = source.match(/^data:(image\/[^;]+);base64,/i)?.[1]?.toLowerCase();
    if (dataUrlMime?.includes('jpeg') || dataUrlMime?.includes('jpg')) return 'jpg';
    if (dataUrlMime?.includes('webp')) return 'webp';
    return 'png';
  }

  function getImageFilename(item) {
    return `nano-image-${Date.now()}.${getImageExtension(item)}`;
  }

  function openImageModal(item) {
    const imageSource = getImageSource(item);
    if (!imageSource) return;
    state.modalImageItem = item;
    document.getElementById('modalImage').src = imageSource;
    UI.showModal('imageModal');
  }

  async function urlToDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('图片加载失败。');
    }
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('图片读取失败。'));
      reader.readAsDataURL(blob);
    });
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
        const imageSource = getImageSource(item);
        if (imageSource) {
          onFiles([{ historyBase64: item.imageBase64 || null, historyUrl: item.imageUrl || null }]);
          return;
        }
      }
      const files = Array.from(event.dataTransfer.files || []).filter((file) => file.type.startsWith('image/'));
      if (files.length > 0) onFiles(files);
    });
  }

  async function fileOrHistoryToBase64(item) {
    if (item.historyBase64) return item.historyBase64;
    if (item.historyUrl) return urlToDataUrl(item.historyUrl);
    return UI.fileToBase64(item);
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

  function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function stopProgressHeartbeat() {
    if (state.progressTimer) {
      clearInterval(state.progressTimer);
      state.progressTimer = null;
    }
  }

  function startProgressHeartbeat() {
    stopProgressHeartbeat();
    state.progressStartedAt = Date.now();
    state.progressHintIndex = 0;
    const tick = () => {
      const elapsed = document.getElementById('progressElapsed');
      const hint = document.getElementById('progressHint');
      if (elapsed) elapsed.textContent = `已等待 ${formatElapsed(Date.now() - state.progressStartedAt)}`;
      if (hint) {
        const nextIndex = Math.floor((Date.now() - state.progressStartedAt) / 6500) % PROGRESS_HINTS.length;
        if (nextIndex !== state.progressHintIndex) {
          state.progressHintIndex = nextIndex;
          hint.textContent = PROGRESS_HINTS[nextIndex];
          hint.classList.remove('hint-pop');
          void hint.offsetWidth;
          hint.classList.add('hint-pop');
        }
      }
    };
    tick();
    state.progressTimer = setInterval(tick, 1000);
  }

  function renderProgressShell({ skeletonClass, title, detail, icon = 'AI' }) {
    return `
      <div class="generation-progress generation-progress-active">
        <div class="skeleton-image ${skeletonClass}">
          <div class="generation-canvas" aria-hidden="true">
            <span class="generation-ring generation-ring-one"></span>
            <span class="generation-ring generation-ring-two"></span>
            <span class="generation-core">${icon}</span>
            <span class="generation-spark spark-1"></span>
            <span class="generation-spark spark-2"></span>
            <span class="generation-spark spark-3"></span>
            <span class="generation-scan"></span>
          </div>
        </div>
        <div class="progress-copy">
          <p class="progress-title">${title}</p>
          <p class="progress-hint" id="progressHint">${detail}</p>
          <p class="progress-elapsed" id="progressElapsed">已等待 00:00</p>
        </div>
        <div class="progress-container">
          <div class="progress-bar" id="progressBar"><div class="progress-fill" id="progressFill" style="width: 0%"></div></div>
          <div class="progress-info">
            <span class="progress-stage" id="progressStage">Preparing...</span>
            <span class="progress-percent" id="progressPercent">0%</span>
          </div>
        </div>
      </div>
    `;
  }

  function showProgressResult() {
    document.getElementById('resultContent').innerHTML = renderProgressShell({
      skeletonClass: getSkeletonClass(),
      title: '正在生成图片',
      detail: PROGRESS_HINTS[0]
    });
    startProgressHeartbeat();
  }

  function showVideoProgressResult() {
    document.getElementById('resultContent').innerHTML = renderProgressShell({
      skeletonClass: state.videoRatio === 'portrait' ? 'skeleton-portrait' : 'skeleton-landscape',
      title: '正在生成视频',
      detail: '视频任务耗时更久，任务仍在后台运行',
      icon: '▶'
    });
    startProgressHeartbeat();
  }

  function updateProgress({ stage, percent, indeterminate = false }) {
    const bar = document.getElementById('progressBar');
    const fill = document.getElementById('progressFill');
    const label = document.getElementById('progressStage');
    const counter = document.getElementById('progressPercent');
    if (fill) fill.style.width = `${Math.round(percent)}%`;
    if (bar) bar.classList.toggle('indeterminate', indeterminate);
    if (fill) fill.classList.toggle('indeterminate', indeterminate);
    if (label) label.textContent = stage;
    if (counter) counter.textContent = indeterminate ? '进行中' : `${Math.round(percent)}%`;
  }

  function hideLoadingResult() {
    stopProgressHeartbeat();
    document.getElementById('resultContent').innerHTML = `
      <div class="result-placeholder">
        <span class="placeholder-icon">□</span>
        <p>生成结果会显示在这里</p>
      </div>
    `;
  }

  function showResult(result) {
    stopProgressHeartbeat();
    if (state.lastVideoBlobUrl) {
      URL.revokeObjectURL(state.lastVideoBlobUrl);
      state.lastVideoBlobUrl = null;
    }
    const imageSrc = getImageSource(result);
    document.getElementById('resultContent').innerHTML = `
      <div class="generation-progress" id="imageResultLoading">
        <div class="skeleton-image ${getSkeletonClass()}"></div>
        <div class="progress-container">
          <div class="progress-bar indeterminate" id="progressBar"><div class="progress-fill indeterminate" id="progressFill" style="width: 92%"></div></div>
          <div class="progress-info">
            <span class="progress-stage" id="progressStage">正在加载图片结果</span>
            <span class="progress-percent" id="progressPercent">进行中</span>
          </div>
        </div>
      </div>
    `;
    const image = new Image();
    image.className = 'result-image';
    image.alt = 'generated image';
    image.onload = () => {
      const resultContent = document.getElementById('resultContent');
      if (!resultContent) return;
      resultContent.innerHTML = '';
      resultContent.appendChild(image);
    };
    image.onerror = () => {
      const resultContent = document.getElementById('resultContent');
      if (!resultContent) return;
      resultContent.innerHTML = `
        <div class="result-placeholder">
          <span class="placeholder-icon">×</span>
          <p>图片加载失败。</p>
        </div>
      `;
    };
    image.src = imageSrc;
    document.getElementById('resultActions').classList.remove('hidden');
    document.getElementById('continueEditBtn').classList.remove('hidden');
    document.getElementById('generateVideoFromImageBtn').classList.remove('hidden');
    document.getElementById('resultInfo').classList.remove('hidden');
    document.getElementById('resultPrompt').textContent = result.prompt;
    document.getElementById('resultTime').textContent = UI.formatDate(result.createdAt);
  }

  function buildVideoProxyUrl(videoUrl) {
    return `/api/proxy-video?url=${encodeURIComponent(videoUrl)}`;
  }

  async function showVideoResult(result) {
    stopProgressHeartbeat();
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
      const proxyUrl = buildVideoProxyUrl(result.videoUrl);
      const response = { ok: true };
      const blobUrl = proxyUrl;
      if (!response.ok) throw new Error('视频加载失败。');
      document.getElementById('resultContent').innerHTML = `
        <video class="result-video" controls autoplay loop playsinline preload="metadata">
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
    UI.showToast('请先配置 API Key。', 'warning');
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
    await TaskManager.runTask({ type: 'text2img', prompt }, async (task) => {
      try {
        const result = await ImageAPI.generateImage(prompt, state.apiKey, getImageModel(), state.ratio, getImageRequestOptions(), (progress) => {
          TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
          if (TaskManager.activeTaskId === task.id) updateProgress(progress);
        });
        TaskManager.updateTask(task.id, { status: 'completed', result });
        state.lastGeneratedImage = result;
        state.lastGeneratedVideo = null;
        HistoryManager.add({ id: result.id, prompt: result.prompt, imageBase64: result.imageBase64, imageUrl: result.imageUrl, imageMimeType: result.imageMimeType, imageOutputFormat: result.imageOutputFormat, mediaType: 'image', type: 'generate', createdAt: result.createdAt });
        if (TaskManager.activeTaskId === task.id) showResult(result);
        renderHistory();
        UI.showToast('图片生成成功。', 'success');
        return result;
      } catch (error) {
        TaskManager.updateTask(task.id, { status: 'failed' });
        UI.showToast(error.message || '图片生成失败。', 'error');
        if (TaskManager.activeTaskId === task.id) hideLoadingResult();
        throw error;
      }
    }).catch(() => {});
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
    await TaskManager.runTask({ type: 'img2img', prompt }, async (task) => {
      try {
        const result = await ImageAPI.editImage({
          prompt,
          apiKey: state.apiKey,
          model: getImageModel(),
          ratio: state.ratio,
          ...getImageRequestOptions(),
          mainImageBase64: state.mainImage,
          referenceImagesBase64: state.referenceImages,
          onProgress: (progress) => {
            TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
            if (TaskManager.activeTaskId === task.id) updateProgress(progress);
          }
        });
        TaskManager.updateTask(task.id, { status: 'completed', result });
        state.lastGeneratedImage = result;
        state.lastGeneratedVideo = null;
        HistoryManager.add({ id: result.id, prompt: result.prompt, imageBase64: result.imageBase64, imageUrl: result.imageUrl, imageMimeType: result.imageMimeType, imageOutputFormat: result.imageOutputFormat, mediaType: 'image', type: 'edit', createdAt: result.createdAt });
        if (TaskManager.activeTaskId === task.id) showResult(result);
        renderHistory();
        UI.showToast('图片编辑成功。', 'success');
        return result;
      } catch (error) {
        TaskManager.updateTask(task.id, { status: 'failed' });
        UI.showToast(error.message || '图片编辑失败。', 'error');
        if (TaskManager.activeTaskId === task.id) hideLoadingResult();
        throw error;
      }
    }).catch(() => {});
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
    await TaskManager.runTask({ type: 'text2video', prompt }, async (task) => {
      UI.setLoading('generateVideoBtn', true);
      try {
        const result = await ImageAPI.generateVideo(prompt, state.apiKey, state.videoRatio, getTextVideoModel(), (progress) => {
          updateProgress(progress);
          TaskManager.updateTask(task.id, { progress: progress.percent || 0 });
        });
        TaskManager.updateTask(task.id, { status: 'completed', result });
        consumeVideoResult(result, 'video');
        UI.showToast('视频生成成功。', 'success');
        return result;
      } catch (error) {
        TaskManager.updateTask(task.id, { status: 'failed' });
        UI.showToast(error.message || '视频生成失败。', 'error');
        hideLoadingResult();
        throw error;
      } finally {
        UI.setLoading('generateVideoBtn', false);
      }
    }).catch(() => {});
  }

  async function handleGenerateVideoFromImages() {
    const prompt = document.getElementById('frameVideoPromptInput').value.trim();
    if (!prompt) {
      UI.showToast('请输入视频描述。', 'warning');
      return;
    }
    if (!ensureApiKey()) return;
    const taskType = state.videoInputMode === 'reference' ? 'reference2video' : 'frame2video';
    await TaskManager.runTask({ type: taskType, prompt }, async (task) => {
      UI.setLoading('generateFrameVideoBtn', true);
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
        return result;
      } catch (error) {
        TaskManager.updateTask(task.id, { status: 'failed' });
        UI.showToast(error.message || '视频生成失败。', 'error');
        hideLoadingResult();
        throw error;
      } finally {
        UI.setLoading('generateFrameVideoBtn', false);
      }
    }).catch(() => {});
  }

  async function handleDownload() {
    if (state.lastGeneratedImage?.imageUrl) {
      UI.downloadUrl(state.lastGeneratedImage.imageUrl, getImageFilename(state.lastGeneratedImage));
      return;
    }
    if (state.lastGeneratedImage?.imageBase64) {
      UI.downloadImage(state.lastGeneratedImage.imageBase64, getImageFilename(state.lastGeneratedImage));
      return;
    }
    const videoUrl = state.lastGeneratedVideo?.videoUrl;
    if (!videoUrl) return;
    try {
      const response = { ok: true };
      if (!response.ok) throw new Error('下载失败。');
      const blobUrl = buildVideoProxyUrl(videoUrl);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `nano-video-${Date.now()}.mp4`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      void blobUrl;
    } catch (error) {
      UI.showToast(error.message || '视频下载失败。', 'error');
    }
  }

  async function handleContinueEdit() {
    const imageSource = getImageSource(state.lastGeneratedImage);
    if (!imageSource) return;
    const base64 = state.lastGeneratedImage.imageBase64 || await urlToDataUrl(state.lastGeneratedImage.imageUrl);
    setImagePreview(base64, 'mainImagePreview', 'mainImageZone', 'removeMainImage', 'mainImage');
    document.querySelector('[data-tab="img2img"]').click();
    UI.showToast('已载入到图生图编辑区。', 'success');
  }

  function handleClearHistory() {
    if (!confirm('确定清空全部历史记录吗？')) return;
    HistoryManager.clear();
    renderHistory();
    UI.showToast('历史记录已清空。', 'success');
  }

  async function loadImageToVideoFlow(imageInput) {
    const imageBase64 = typeof imageInput === 'string' && imageInput.startsWith('data:image/')
      ? imageInput
      : await urlToDataUrl(imageInput);
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
      if (!modalImage.src) return;
      const modalItem = state.modalImageItem || { imageUrl: modalImage.src };
      if (modalImage.src.startsWith('data:image/')) {
        UI.downloadImage(modalImage.src, getImageFilename(modalItem));
      } else {
        UI.downloadUrl(modalImage.src, getImageFilename(modalItem));
      }
    });
    document.getElementById('modalEditBtn').addEventListener('click', () => {
      if (!modalImage.src) return;
      setImagePreview(modalImage.src, 'mainImagePreview', 'mainImageZone', 'removeMainImage', 'mainImage');
      document.querySelector('[data-tab="img2img"]').click();
      UI.hideModal('imageModal');
    });
    document.getElementById('modalGenerateVideoBtn').addEventListener('click', () => {
      if (!modalImage.src) return;
      void loadImageToVideoFlow(modalImage.src);
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
      const imageSource = getImageSource(state.lastGeneratedImage);
      if (imageSource) void loadImageToVideoFlow(imageSource);
    });
    document.getElementById('resultContent').addEventListener('click', (event) => {
      if (event.target.classList.contains('result-image')) {
        openImageModal(state.lastGeneratedImage || { imageUrl: event.target.src });
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
          <img src="${getImageSource(item)}" alt="${UI.truncateText(item.prompt, 16)}">
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
          openImageModal(item);
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
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const item = HistoryManager.getById(button.dataset.id);
        const imageSource = getImageSource(item);
        if (!imageSource) return;
        const base64 = item.imageBase64 || await urlToDataUrl(item.imageUrl);
        setImagePreview(base64, 'mainImagePreview', 'mainImageZone', 'removeMainImage', 'mainImage');
        document.querySelector('[data-tab="img2img"]').click();
      });
    });
    historyGrid.querySelectorAll('.history-video-btn').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const item = HistoryManager.getById(button.dataset.id);
        const imageSource = getImageSource(item);
        if (imageSource) await loadImageToVideoFlow(imageSource);
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
          openImageModal(historyItem);
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
