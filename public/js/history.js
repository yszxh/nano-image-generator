const HistoryManager = {
  STORAGE_KEY: 'nano_image_history',
  MAX_ITEMS: 30,

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
    let itemsToSave = [...history];
    
    while (itemsToSave.length > 0) {
      try {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(itemsToSave));
        return;
      } catch (e) {
        if (e.name === 'QuotaExceededError') {
          itemsToSave = itemsToSave.slice(0, Math.max(1, Math.floor(itemsToSave.length * 0.7)));
          if (itemsToSave.length <= 1) {
            try {
              localStorage.removeItem(this.STORAGE_KEY);
              localStorage.setItem(this.STORAGE_KEY, JSON.stringify(itemsToSave));
              return;
            } catch {
              console.error('存储空间不足，无法保存历史记录');
              return;
            }
          }
        } else {
          console.error('保存历史记录失败:', e);
          return;
        }
      }
    }
  },

  getById(id) {
    const history = this.getAll();
    return history.find(item => item.id === id);
  }
};

window.HistoryManager = HistoryManager;
