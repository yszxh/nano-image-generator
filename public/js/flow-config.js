const FlowConfig = {
  image: {
    defaultRatio: 'landscape',
    defaultVersion: 'gemini-3.1-flash-preview',
    ratios: {
      portrait: { label: 'Portrait', sublabel: '9:16' },
      landscape: { label: 'Landscape', sublabel: '16:9' },
      square: { label: 'Square', sublabel: '1:1' },
      'four-three': { label: '4:3', sublabel: '4:3' },
      'three-four': { label: '3:4', sublabel: '3:4' }
    },
    versions: {
      'gemini-3.1-flash-preview': {
        label: '（官方）gemini-3.1-flash-image-preview',
        hint: 'Official preview image model with arbitrary ratio support',
        prefix: 'gemini-3.1-flash-image-preview',
        suffix: '',
        exactModel: true,
        supportedRatios: ['portrait', 'landscape', 'square', 'four-three', 'three-four']
      },
      'gpt-image-2': {
        label: 'gpt-image-2',
        hint: 'OpenAI image API model',
        prefix: 'gpt-image-2',
        suffix: '',
        exactModel: true,
        supportedRatios: ['portrait', 'landscape', 'square', 'four-three', 'three-four']
      }
    }
  },

  video: {
    defaultRatio: 'landscape',
    defaultTextModel: 'veo-31-4k',
    defaultFrameModel: 'veo-31-4k',
    defaultReferenceModel: 'veo-31-r2v-fast',
    textModels: {
      'veo-31-4k': {
        label: 'Veo 3.1 4K',
        hint: '4K text-to-video generation',
        models: {
          landscape: 'veo_3_1-4K',
          portrait: 'veo_3_1-4K'
        }
      }
    },
    frameModels: {
      'veo-31-4k': {
        label: 'Veo 3.1 4K',
        hint: '4K image-to-video generation',
        models: {
          landscape: 'veo_3_1-4K',
          portrait: 'veo_3_1-4K'
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
    if (version.exactModel) {
      return version.prefix;
    }
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
