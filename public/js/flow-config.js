const FlowConfig = {
  image: {
    defaultRatio: 'landscape',
    defaultVersion: 'gemini-3.1-flash',
    ratios: {
      portrait: { label: 'Portrait', sublabel: '9:16' },
      landscape: { label: 'Landscape', sublabel: '16:9' },
      square: { label: 'Square', sublabel: '1:1' },
      'four-three': { label: '4:3', sublabel: '4:3' },
      'three-four': { label: '3:4', sublabel: '3:4' }
    },
    versions: {
      'gemini-3.1-flash': {
        label: 'Gemini 3.1 Flash',
        hint: 'Latest fast image model',
        prefix: 'gemini-3.1-flash-image',
        suffix: '',
        supportedRatios: ['portrait', 'landscape', 'square', 'four-three', 'three-four']
      },
      'gemini-3.0-pro': {
        label: 'Gemini 3.0 Pro',
        hint: 'Balanced quality model',
        prefix: 'gemini-3.0-pro-image',
        suffix: '',
        supportedRatios: ['portrait', 'landscape', 'square', 'four-three', 'three-four']
      },
      'gemini-3.0-pro-2k': {
        label: 'Gemini 3.0 Pro 2K',
        hint: 'Higher resolution output',
        prefix: 'gemini-3.0-pro-image',
        suffix: '-2k',
        supportedRatios: ['portrait', 'landscape', 'square', 'four-three', 'three-four']
      },
      'gemini-3.0-pro-4k': {
        label: 'Gemini 3.0 Pro 4K',
        hint: 'Highest resolution output',
        prefix: 'gemini-3.0-pro-image',
        suffix: '-4k',
        supportedRatios: ['portrait', 'landscape', 'square', 'four-three', 'three-four']
      },
      'imagen-4.0-preview': {
        label: 'Imagen 4 Preview',
        hint: 'Preview model for landscape and portrait',
        prefix: 'imagen-4.0-generate-preview',
        suffix: '',
        supportedRatios: ['portrait', 'landscape']
      }
    }
  },

  video: {
    defaultRatio: 'landscape',
    defaultTextModel: 'veo-31-fast',
    defaultFrameModel: 'veo-31-i2v-fast',
    defaultReferenceModel: 'veo-31-r2v-fast',
    textModels: {
      'veo-31-fast': {
        label: 'Veo 3.1 Fast',
        hint: 'Recommended for first-pass generation',
        models: {
          landscape: 'veo_3_1_t2v_fast_landscape',
          portrait: 'veo_3_1_t2v_fast_portrait'
        }
      },
      'veo-31-quality': {
        label: 'Veo 3.1 Quality',
        hint: 'Slower but more polished',
        models: {
          landscape: 'veo_3_1_t2v_landscape',
          portrait: 'veo_3_1_t2v_portrait'
        }
      }
    },
    frameModels: {
      'veo-31-i2v-fast': {
        label: 'Veo 3.1 I2V Fast',
        hint: 'Single frame or start/end frames',
        models: {
          landscape: 'veo_3_1_i2v_s_fast_fl',
          portrait: 'veo_3_1_i2v_s_fast_portrait_fl'
        }
      },
      'veo-31-i2v-quality': {
        label: 'Veo 3.1 I2V Quality',
        hint: 'Better detail for transitions',
        models: {
          landscape: 'veo_3_1_i2v_s_landscape',
          portrait: 'veo_3_1_i2v_s_portrait'
        }
      }
    },
    referenceModels: {
      'veo-31-r2v-fast': {
        label: 'Veo 3.1 R2V Fast',
        hint: 'Reference-image video, up to 3 images',
        models: {
          landscape: 'veo_3_1_r2v_fast',
          portrait: 'veo_3_1_r2v_fast_portrait'
        }
      },
      'veo-31-r2v-ultra': {
        label: 'Veo 3.1 R2V Ultra',
        hint: 'Higher quality reference video',
        models: {
          landscape: 'veo_3_1_r2v_fast_ultra',
          portrait: 'veo_3_1_r2v_fast_portrait_ultra'
        }
      }
    }
  },

  buildImageModel(versionId, ratio) {
    const version = this.image.versions[versionId] || this.image.versions[this.image.defaultVersion];
    const finalRatio = version.supportedRatios.includes(ratio) ? ratio : version.supportedRatios[0];
    return `${version.prefix}-${finalRatio}${version.suffix}`;
  },

  getVideoModel(group, modelId, ratio) {
    const collection = this.video[group];
    const fallbackId = group === 'textModels'
      ? this.video.defaultTextModel
      : group === 'frameModels'
        ? this.video.defaultFrameModel
        : this.video.defaultReferenceModel;
    const config = collection[modelId] || collection[fallbackId];
    return config.models[ratio] || config.models.landscape;
  }
};

window.FlowConfig = FlowConfig;
