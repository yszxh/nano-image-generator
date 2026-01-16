# NANO 图像生成器

基于 Gemini API 的 AI 图像生成应用，支持文生图和图生图功能。

## 功能特性

- 🎨 **文生图** - 根据文字描述生成图片
- 🖼️ **图生图** - 编辑现有图片
- 📚 **多参考图** - 支持上传多张参考图片辅助生成
- 📜 **历史记录** - 本地保存生成历史
- 🔄 **连续编辑** - 基于上一张图片继续修改
- 🎯 **提示词模板** - 预设多种风格模板
- 🌓 **主题切换** - 深色/浅色主题自由切换
- 💾 **一键下载** - 快速保存生成的图片

## 快速开始

### 本地运行

1. 安装依赖
```bash
npm install
```

2. 配置环境变量（可选）
```bash
cp .env.example .env
# 编辑 .env 文件，填入 API Key
```

3. 启动服务
```bash
npm start
```

4. 访问 http://localhost:3000

### Zeabur 部署

1. Fork 或推送代码到 GitHub 仓库
2. 在 [Zeabur](https://zeabur.com) 控制台导入项目
3. 设置环境变量 `GEMINI_API_KEY`（可选）
4. 等待自动部署完成
5. 绑定域名（可选）

## 环境变量

| 变量名 | 描述 | 必填 |
|--------|------|------|
| `GEMINI_API_KEY` | Gemini API 密钥 | 可选（可在前端配置） |
| `PORT` | 服务端口 | 自动设置 |

## 技术栈

- **前端**: HTML5 + CSS3 + JavaScript
- **后端**: Node.js + Express
- **API**: Gemini Image Generation API

## 项目结构

```
nano-image-generator/
├── package.json          # 项目配置
├── server.js             # Express 服务器
├── .env.example          # 环境变量示例
├── .gitignore            # Git 忽略文件
└── public/               # 静态文件
    ├── index.html        # 主页面
    ├── css/
    │   └── style.css     # 样式文件
    └── js/
        ├── api.js        # API 调用
        ├── history.js    # 历史记录
        ├── ui.js         # UI 工具
        └── app.js        # 主逻辑
```

## 使用说明

### API Key 配置

点击右上角「API 设置」按钮，输入你的 Gemini API Key。Key 仅保存在浏览器本地，不会上传到服务器。

### 文生图

1. 在提示词输入框中描述想要生成的图片
2. 可选择快捷模板添加风格描述
3. 点击「生成图片」按钮

### 图生图

1. 切换到「图生图」标签页
2. 上传要编辑的主图片
3. 可选上传参考图片（最多5张）
4. 输入编辑提示词
5. 点击「编辑图片」按钮

### 连续编辑

生成图片后，点击「继续编辑」按钮，可基于当前图片进行进一步修改。

## License

MIT
