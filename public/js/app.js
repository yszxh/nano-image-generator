document.addEventListener('DOMContentLoaded', () => {
  const state = {
    currentTab: 'text2img',
    mainImage: null,
    referenceImages: [],
    lastGeneratedImage: null,
    apiKey: localStorage.getItem('nano_api_key') || '',
    model: localStorage.getItem('nano_model') || 'gemini-3.0-pro-image-portrait',
    theme: localStorage.getItem('nano_theme') || 'dark'
  };

  initTheme();
  initTabs();
  initRatioSelector();
  initTemplates();
  initUpload();
  initModals();
  initActions();
  renderHistory();

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

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        state.currentTab = tab;

        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        panels.forEach(p => {
          p.classList.toggle('active', p.id === `${tab}Panel`);
        });
      });
    });
  }

  function initRatioSelector() {
    const ratioCards = document.querySelectorAll('.ratio-card');
    const currentRatio = state.model.includes('landscape') ? 'landscape' : 'portrait';
    
    ratioCards.forEach(card => {
      if (card.dataset.ratio === currentRatio) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
      
      card.addEventListener('click', () => {
        ratioCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        
        state.model = card.dataset.model;
        localStorage.setItem('nano_model', state.model);
        
        const modelSelect = document.getElementById('modelSelect');
        if (modelSelect) {
          modelSelect.value = state.model;
        }
      });
    });
  }

  function updateRatioSelector() {
    const ratioCards = document.querySelectorAll('.ratio-card');
    const currentRatio = state.model.includes('landscape') ? 'landscape' : 'portrait';
    
    ratioCards.forEach(card => {
      if (card.dataset.ratio === currentRatio) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });
  }

  function initTemplates() {
    const templateTags = document.querySelectorAll('.template-tag');
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
    const modelSelect = document.getElementById('modelSelect');
    const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility');

    settingsBtn.addEventListener('click', () => {
      apiKeyInput.value = state.apiKey;
      modelSelect.value = state.model;
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
      state.model = modelSelect.value;
      localStorage.setItem('nano_api_key', state.apiKey);
      localStorage.setItem('nano_model', state.model);
      
      updateRatioSelector();
      
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

    generateBtn.addEventListener('click', handleGenerate);
    editBtn.addEventListener('click', handleEdit);
    downloadBtn.addEventListener('click', handleDownload);
    continueEditBtn.addEventListener('click', handleContinueEdit);
    clearHistoryBtn.addEventListener('click', handleClearHistory);

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

    UI.setLoading('generateBtn', true);
    showProgressResult();

    try {
      const result = await ImageAPI.generateImage(prompt, state.apiKey, state.model, updateProgress);
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

    UI.setLoading('editBtn', true);
    showProgressResult();

    try {
      const result = await ImageAPI.editImage({
        prompt,
        apiKey: state.apiKey,
        model: state.model,
        mainImageBase64: state.mainImage,
        referenceImagesBase64: state.referenceImages.length > 0 ? state.referenceImages : undefined,
        onProgress: updateProgress
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
      UI.showToast(error.message || '编辑失败，请重试', 'error');
      hideLoadingResult();
    } finally {
      UI.setLoading('editBtn', false);
    }
  }

  function handleDownload() {
    if (state.lastGeneratedImage?.imageBase64) {
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

  function showProgressResult() {
    const resultContent = document.getElementById('resultContent');
    const isLandscape = state.model.includes('landscape');
    const skeletonClass = isLandscape ? 'skeleton-landscape' : 'skeleton-portrait';
    
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

    resultContent.innerHTML = `<img class="result-image" src="${result.imageBase64}" alt="生成的图片">`;
    resultActions.classList.remove('hidden');
    resultInfo.classList.remove('hidden');
    resultPrompt.textContent = result.prompt;
    resultTime.textContent = UI.formatDate(result.createdAt);
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

    historyGrid.innerHTML = history.map(item => `
      <div class="history-item" data-id="${item.id}">
        <img src="${item.imageBase64}" alt="${UI.truncateText(item.prompt, 20)}">
        <div class="history-item-overlay">
          <div class="history-item-actions">
            <button class="history-view-btn" data-id="${item.id}">查看</button>
            <button class="history-edit-btn" data-id="${item.id}">编辑</button>
          </div>
        </div>
        <button class="history-item-delete" data-id="${item.id}">✕</button>
      </div>
    `).join('');

    historyGrid.querySelectorAll('.history-view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = HistoryManager.getById(btn.dataset.id);
        if (item) {
          document.getElementById('modalImage').src = item.imageBase64;
          UI.showModal('imageModal');
        }
      });
    });

    historyGrid.querySelectorAll('.history-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = HistoryManager.getById(btn.dataset.id);
        if (item) {
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
          document.getElementById('modalImage').src = historyItem.imageBase64;
          UI.showModal('imageModal');
        }
      });
    });
  }
});
