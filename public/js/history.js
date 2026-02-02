const HistoryManager = {
  STORAGE_KEY: 'nano_image_history',
  MAX_ITEMS: 50,

  getAll() {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  add(item) {
    const history = this.getAll();
    
    const newItem = {
      id: item.id || Date.now().toString(),
      prompt: item.prompt,
      imageBase64: item.imageBase64 || null,
      videoUrl: item.videoUrl || null,
      type: item.type || 'generate',
      mediaType: item.mediaType || 'image',
      createdAt: item.createdAt || new Date().toISOString()
    };
    
    history.unshift(newItem);
    
    if (history.length > this.MAX_ITEMS) {
      history.splice(this.MAX_ITEMS);
    }
    
    this.save(history);
    return newItem;
  },

  remove(id) {
    const history = this.getAll();
    const filtered = history.filter(item => item.id !== id);
    this.save(filtered);
    return filtered;
  },

  clear() {
    localStorage.removeItem(this.STORAGE_KEY);
  },

  save(history) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
      console.error('保存历史记录失败:', e);
      if (e.name === 'QuotaExceededError') {
        const trimmed = history.slice(0, Math.floor(history.length / 2));
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(trimmed));
      }
    }
  },

  getById(id) {
    const history = this.getAll();
    return history.find(item => item.id === id);
  }
};

window.HistoryManager = HistoryManager;
