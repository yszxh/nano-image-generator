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
    defaultTextModel: 'sdas-mj-minimax-h3-2k',
    defaultFrameModel: 'sdas-mj-minimax-h3-2k',
    defaultReferenceModel: 'sdas-mj-minimax-h3-2k',
    textModels: {
      'sdas-mj-minimax-h3-2k': {
        label: 'Minimax H3 2K',
        hint: 'OpenAPI-compatible text-to-video generation',
        models: {
          landscape: 'sdas-mj-minimax-h3-2k',
          portrait: 'sdas-mj-minimax-h3-2k'
        }
      }
    },
    frameModels: {
      'sdas-mj-minimax-h3-2k': {
        label: 'Minimax H3 2K',
        hint: 'OpenAPI-compatible image-to-video generation',
        models: {
          landscape: 'sdas-mj-minimax-h3-2k',
          portrait: 'sdas-mj-minimax-h3-2k'
        }
      }
    },
    referenceModels: {
      'sdas-mj-minimax-h3-2k': {
        label: 'Minimax H3 2K',
        hint: 'OpenAPI-compatible reference-image video generation',
        models: {
          landscape: 'sdas-mj-minimax-h3-2k',
          portrait: 'sdas-mj-minimax-h3-2k'
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
