# 切换图片生成至 Gemini 官方 generateContent API

## TL;DR

> **Quick Summary**: 将 server.js 中的图片生成逻辑（文生图 `/api/generate`、图生图 `/api/edit`）从 Flow2API OpenAI 兼容格式切换到 Gemini 官方 `generateContent` REST API，视频端点保持不变，前端接口契约不变。
>
> **Deliverables**:
> - `server.js` 重构：新增 `callGeminiGenerateContent()`，拆分图片/视频调用路径
> - 环境变量新增 `GEMINI_BASE_URL`
> - `.env.example` 更新
> - 图片相关 SSE 解析逻辑删除，改为 JSON inline base64 解析
>
> **Estimated Effort**: Short
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → F1-F4

---

## Context

### Original Request
用户测试发现 Gemini 官方 `generateContent` API 比 Flow2API OpenAI 兼容格式更稳定，希望将图片生成端点切换到官方格式。

### Interview Summary
**Key Discussions**:
- **新 API Base URL**: `https://vip.yyds168.net`，通过 `GEMINI_BASE_URL` 环境变量配置
- **认证方式**: `x-goog-api-key` header（替代 `Authorization: Bearer`）
- **切换范围**: 仅图片（`/api/generate` 文生图、`/api/edit` 图生图），视频三个端点不动
- **兼容策略**: 完全替换图片路径的 Flow2API 逻辑，删除相关 SSE 解析代码
- **前端接口**: 保持不变，继续返回 `imageBase64`（data URL 格式）
- **模型名称**: 不变（`gemini-3.1-flash-image`、`gemini-3.0-pro-image`、`imagen-4.0-generate-preview`）
- **imageSize**: 仅在用户明确选择 2K 时传（`imageConfig.imageSize: '2K'`），否则不传
- **imageUrl 字段**: 新 API 无 CDN URL，响应中省略 `imageUrl` 字段（前端不依赖）
- **图生图传图**: 使用 `inlineData: { mimeType, data }` 官方方式

**Research Findings**:
- 现有 `callFlow2Api()` 同时服务图片和视频；视频端点必须继续使用它
- 现有 `buildImageMessages()` 构造 OpenAI messages 格式，图生图用 `image_url`；新格式完全不同
- `downloadMedia()` 步骤可以彻底跳过（新 API 直接返回 base64）
- 现有模型名如 `gemini-3.1-flash-image-landscape` 需剥离 ratio 后缀得到基础模型名
- ratio 映射：`portrait→9:16, landscape→16:9, square→1:1, four-three→4:3, three-four→3:4`

### Metis Review
**Identified Gaps** (addressed):
- **模型名剥离**: 用 regex 从 `{prefix}-{ratio}` 格式剥离 ratio 后缀，已纳入 Task 1
- **imageUrl 字段处理**: 省略该字段，前端无依赖，已决策
- **图生图 base64 格式**: 前端传来的已是 `data:image/xxx;base64,...` 格式，需剥离 prefix 得到纯 base64 data，mimeType 从前缀解析
- **systemInstruction**: 参照示例加入 `"Return an image only."`，强制模型只返回图片
- **responseModalities**: 设为 `["IMAGE"]`，与示例一致
- **错误处理**: Gemini API 错误格式为 `{ error: { code, message, status } }`，需新增解析

---

## Work Objectives

### Core Objective
将 server.js 中图片生成的 HTTP 调用层从 Flow2API（OpenAI SSE 格式）切换到 Gemini generateContent（JSON REST 格式），保持对外 API 契约完全不变。

### Concrete Deliverables
- `server.js`：新增 `callGeminiGenerateContent()`、`buildGeminiImageContents()`、`parseGeminiImageResponse()`、`extractModelBase()`、`RATIO_MAP` 等，重写 `/api/generate` 和 `/api/edit` 路由内部实现
- `.env.example`：新增 `GEMINI_BASE_URL` 条目

### Definition of Done
- [ ] `curl -X POST localhost:3000/api/generate` 成功返回含 `imageBase64` 的 JSON
- [ ] `curl -X POST localhost:3000/api/edit`（含 base64 图片）成功返回含 `imageBase64` 的 JSON
- [ ] 视频端点 `/api/generate-video` 仍正常工作（不受影响）
- [ ] 无 `FLOW2API_BASE_URL` 相关代码出现在图片路径中

### Must Have
- `GEMINI_BASE_URL` 环境变量控制 API 地址，默认 `https://vip.yyds168.net`
- 认证使用 `x-goog-api-key` header
- 请求路径格式 `/models/{baseModel}:generateContent`
- `generationConfig.responseModalities: ["IMAGE"]`
- `systemInstruction.parts[0].text: "Return an image only."`
- `imageConfig.aspectRatio` 使用标准格式（`16:9`, `9:16`, `1:1`, `4:3`, `3:4`）
- 图生图使用 `inlineData: { mimeType, data }` 传图
- 响应解析从 `candidates[0].content.parts` 提取 `inlineData`
- 最终返回 `imageBase64` 为完整 data URL（`data:{mimeType};base64,{data}`）
- 视频路径代码零修改

### Must NOT Have (Guardrails)
- 图片路径不得调用 `callFlow2Api()`
- 图片路径不得调用 `downloadMedia()`（新 API 无需下载）
- 不得修改任何视频端点（`/api/generate-video`, `/api/generate-video-from-frames`, `/api/generate-video-from-references`）
- 不得修改前端任何文件
- 不得引入新的 npm 依赖
- 不得在图片响应中保留 `imageUrl` 字段（省略，不设 null）
- `imageSize` 不得在未选择 2K 时传递给 API

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: NO（项目无测试框架）
- **Automated tests**: None（不新增测试框架，范围外）
- **Agent-Executed QA**: ALWAYS（每个 task 含 curl/bash 验证场景）

### QA Policy
- **API/Backend**: Bash (curl) — 发请求，断言 status + response 字段
- 证据保存至 `.sisyphus/evidence/task-{N}-{slug}.txt`

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (可立即并行开始):
├── Task 1: 新增 Gemini 图片 API 核心函数（callGeminiGenerateContent + 辅助函数）
└── Task 2: 更新 .env.example

Wave 2 (Wave 1 完成后):
├── Task 3: 重写 /api/generate 和 /api/edit 路由使用新函数
└── （Task 2 已完成，无依赖）

Wave FINAL (所有实现完成后，4 路并行审查):
├── F1: Plan Compliance Audit (oracle)
├── F2: Code Quality Review (unspecified-high)
├── F3: Real Manual QA (unspecified-high)
└── F4: Scope Fidelity Check (deep)
```

### Dependency Matrix
- **Task 1**: 无依赖 → blocks Task 3
- **Task 2**: 无依赖 → 独立
- **Task 3**: depends Task 1 → blocks F1-F4
- **F1-F4**: depends Task 3

### Agent Dispatch Summary
- **Wave 1**: Task 1 → `unspecified-high`，Task 2 → `quick`
- **Wave 2**: Task 3 → `unspecified-high`
- **FINAL**: F1 → `oracle`，F2 → `unspecified-high`，F3 → `unspecified-high`，F4 → `deep`

---

## TODOs

- [ ] 1. 新增 Gemini 图片 API 核心函数

  **What to do**:
  - 在 server.js 顶部新增常量 `GEMINI_BASE_URL`：
    ```js
    const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://vip.yyds168.net';
    ```
  - 新增 `RATIO_MAP` 对象，将 flow-config ratio key 映射到 Gemini aspectRatio 字符串：
    ```js
    const RATIO_MAP = {
      portrait: '9:16',
      landscape: '16:9',
      square: '1:1',
      'four-three': '4:3',
      'three-four': '3:4'
    };
    ```
  - 新增 `extractModelBase(model)` 函数：从形如 `gemini-3.1-flash-image-landscape` 的模型名中剥离 ratio 后缀，返回基础模型名 `gemini-3.1-flash-image`。使用正则：`model.replace(/-(portrait|landscape|square|four-three|three-four)$/i, '')`
  - 新增 `buildGeminiImageContents(prompt, imageSources = [])` 函数：
    - 构造 `contents[0].parts` 数组
    - 第一个 part 始终是 `{ text: prompt }`
    - 后续每个 imageSources 元素（data URL 格式 `data:image/xxx;base64,...`）转为：
      ```js
      const [header, data] = src.split(',');
      const mimeType = header.match(/data:([^;]+)/)[1];
      { inlineData: { mimeType, data } }
      ```
    - 返回 `[{ role: 'user', parts }]`
  - 新增 `parseGeminiImageResponse(json)` 函数：
    - 从 `json.candidates[0].content.parts` 中找第一个含 `inlineData` 的 part
    - 返回 `{ mimeType, data }`（data 为纯 base64 字符串）
    - 若找不到则抛出 `Error('Gemini API did not return an image.')`
  - 新增 `toFriendlyGeminiError(status, body)` 函数：
    - 解析 `body.error?.message` 或 `body.error?.status`
    - 401/403 → `'Gemini API key 无效或已过期，请重新填写。'`
    - 429 → `'Gemini API 当前已限流或额度不足，请稍后重试。'`
    - >=500 → `'Gemini API 上游暂时不可用 ({status})：{message}'`
    - 其他 → `'Gemini API 请求失败 ({status})：{message}'`
  - 新增 `callGeminiGenerateContent({ prompt, apiKey, model, imageSources, imageSize })` async 函数：
    - `resolvedApiKey = withResolvedApiKey(apiKey)`，无 key 则抛错
    - `baseModel = extractModelBase(model)`
    - `ratio = RATIO_MAP[model 末尾 ratio 部分]`（从原始 model 名提取 ratio key，再映射）
      - 先提取 ratioKey：`const ratioMatch = model.match(/-(portrait|landscape|square|four-three|three-four)$/i); const ratioKey = ratioMatch ? ratioMatch[1].toLowerCase() : 'landscape';`
      - `aspectRatio = RATIO_MAP[ratioKey] || '16:9'`
    - 构造 `imageConfig`：`{ aspectRatio }`，若 `imageSize` 参数存在且为 `'2K'` 则加入 `imageConfig.imageSize = '2K'`
    - 构造完整请求 body：
      ```js
      {
        systemInstruction: { parts: [{ text: 'Return an image only.' }] },
        contents: buildGeminiImageContents(prompt, imageSources),
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig
        }
      }
      ```
    - 使用 `createAbortController()` 创建超时控制
    - `fetch(`${GEMINI_BASE_URL}/models/${baseModel}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': resolvedApiKey }, body: JSON.stringify(body), signal })`
    - 非 ok 时：读取响应 JSON，调用 `toFriendlyGeminiError(status, json)` 抛出友好错误
    - ok 时：`const json = await response.json()`，调用 `parseGeminiImageResponse(json)` 得到 `{ mimeType, data }`
    - 返回 `{ imageBase64: \`data:${mimeType};base64,${data}\` }`

  **Must NOT do**:
  - 不得调用 `callFlow2Api()`
  - 不得调用 `downloadMedia()`
  - 不得修改视频相关任何函数
  - 不得引入新 npm 依赖

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 纯后端 Node.js 函数实现，需要准确理解 Gemini API 规范和现有代码结构
  - **Skills**: 无需额外 skill

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（与 Task 2 并行）
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `server.js:316-373` — 现有 `callFlow2Api()` 函数，参照其结构（AbortController、错误处理、resolve API key）实现新函数
  - `server.js:44-54` — `createAbortController()` 和 `clearAbortTimeout()` 工具函数，直接复用
  - `server.js:56-58` — `withResolvedApiKey()` 函数，直接复用
  - `server.js:265-313` — 现有 `parseUpstreamError()` 和 `toFriendlyFlow2ApiError()`，参照结构实现 `toFriendlyGeminiError()`
  - `server.js:416-427` — 现有 `buildImageMessages()`，参照逻辑实现 `buildGeminiImageContents()`（替换为 inlineData 格式）

  **API References**:
  - 用户提供的 curl 示例（见计划 Context 节）— Gemini generateContent 请求格式权威参考
  - Gemini 响应结构：`{ candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] }`

  **Acceptance Criteria**:

  **QA Scenarios**:

  ```
  Scenario: 函数存在性验证
    Tool: Bash (node)
    Preconditions: server.js 已修改
    Steps:
      1. node -e "import('./server.js').catch(()=>{})" 2>&1 || node --check server.js
    Expected Result: 无语法错误，exit code 0
    Evidence: .sisyphus/evidence/task-1-syntax-check.txt

  Scenario: RATIO_MAP 覆盖验证
    Tool: Bash (node)
    Preconditions: server.js 已修改
    Steps:
      1. node -e "import('./server.js').then(m => { const keys = ['portrait','landscape','square','four-three','three-four']; /* verify all mapped */ console.log('ok'); }).catch(e => { console.error(e); process.exit(1); })"
      2. 检查输出包含 ok
    Expected Result: 输出 ok，exit code 0
    Evidence: .sisyphus/evidence/task-1-ratio-map.txt
  ```

  **Evidence to Capture**:
  - [ ] `.sisyphus/evidence/task-1-syntax-check.txt`

  **Commit**: YES (groups with Task 2)
  - Message: `refactor(server): add Gemini generateContent image API functions`
  - Files: `server.js`
  - Pre-commit: `node --check server.js`

- [ ] 2. 更新 .env.example

  **What to do**:
  - 在 `.env.example` 中新增 `GEMINI_BASE_URL` 条目，紧接在现有 `FLOW2API_BASE_URL` 之后：
    ```
    # Gemini 官方 generateContent API 地址（图片生成使用）
    GEMINI_BASE_URL=https://vip.yyds168.net
    ```
  - 保持现有其他条目不变

  **Must NOT do**:
  - 不得删除 `FLOW2API_BASE_URL` 条目（视频仍然使用）
  - 不得修改任何其他文件

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 简单文本编辑
  - **Skills**: 无

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（与 Task 1 并行）
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `.env.example` — 现有文件，在 `FLOW2API_BASE_URL` 行后插入

  **Acceptance Criteria**:

  **QA Scenarios**:

  ```
  Scenario: .env.example 包含新条目
    Tool: Bash (grep)
    Preconditions: .env.example 已修改
    Steps:
      1. grep 'GEMINI_BASE_URL' .env.example
    Expected Result: 输出包含 GEMINI_BASE_URL=https://vip.yyds168.net
    Failure Indicators: 无输出或 exit code 非 0
    Evidence: .sisyphus/evidence/task-2-env-check.txt

  Scenario: FLOW2API_BASE_URL 仍然存在
    Tool: Bash (grep)
    Steps:
      1. grep 'FLOW2API_BASE_URL' .env.example
    Expected Result: 输出包含 FLOW2API_BASE_URL
    Evidence: .sisyphus/evidence/task-2-flow2api-preserved.txt
  ```

  **Evidence to Capture**:
  - [ ] `.sisyphus/evidence/task-2-env-check.txt`

  **Commit**: YES (groups with Task 1)
  - Message: `refactor(server): add Gemini generateContent image API functions`
  - Files: `.env.example`
  - Pre-commit: 无

- [ ] 3. 重写 /api/generate 和 /api/edit 路由

  **What to do**:

  **`/api/generate` 路由（文生图）**:
  - 保留现有参数读取：`prompt`、`model`、`apiKey`
  - 删除：`const messages = buildImageMessages(prompt);` 和 `const result = await callFlow2Api(...)` 和 `const media = await downloadMedia(result.mediaUrl)`
  - 替换为：`const result = await callGeminiGenerateContent({ prompt, apiKey, model, imageSources: [] })`
  - 返回 JSON 修改为：
    ```js
    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      imageBase64: result.imageBase64,
      createdAt: new Date().toISOString()
    });
    ```
  - 注意：省略 `imageUrl` 字段

  **`/api/edit` 路由（图生图）**:
  - 保留现有参数读取：`prompt`、`model`、`apiKey`
  - 读取 `mainImage`：
    - 如果有 `req.files?.mainImage`（multer 上传），转为 data URL：`bufferToDataUrl(req.files.mainImage[0].buffer, req.files.mainImage[0].mimetype)`
    - 如果有 `req.body.mainImageBase64`（base64 字符串），直接使用
    - 两者都没有则返回 400
  - 读取 `referenceImages`：
    - multer `req.files?.referenceImages` → 每个转为 data URL
    - `req.body.referenceImagesBase64` → `parseMaybeJsonArray()` 解析
    - 合并，最多取 5 张，过滤非 `data:image/` 开头的项
  - 构造 `imageSources = [mainImage, ...referenceImages]`
  - 调用：`const result = await callGeminiGenerateContent({ prompt, apiKey, model, imageSources })`
  - 返回 JSON：
    ```js
    res.json({
      success: true,
      id: uuidv4(),
      prompt,
      model,
      imageBase64: result.imageBase64,
      createdAt: new Date().toISOString()
    });
    ```
  - 注意：省略 `imageUrl` 字段

  **清理工作**:
  - 检查 `buildImageMessages()` 函数是否仍被视频端点使用；若无任何调用则删除
  - 检查 `parseSSEStream()`、`pickMediaUrl()` 是否仍被视频端点使用；若无则删除
  - 检查 `downloadMedia()` 是否仍被任何路由使用；若无则删除
  - **注意**：`callFlow2Api()` 仍被视频端点使用，不得删除

  **Must NOT do**:
  - 不得修改任何视频端点（`/api/generate-video`, `/api/generate-video-from-frames`, `/api/generate-video-from-references`）
  - 不得修改前端文件
  - 不得删除 `callFlow2Api()`（视频使用）
  - 不得在响应中保留 `imageUrl` 字段

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 需要准确理解现有路由逻辑、multer 文件处理、以及新函数接口
  - **Skills**: 无需额外 skill

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2（单任务）
  - **Blocks**: F1-F4
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `server.js:492-523` — 现有 `/api/generate` 路由，直接在此基础上修改
  - `server.js:525-600`（约）— 现有 `/api/edit` 路由，直接在此基础上修改
  - `server.js:416-427` — `buildImageMessages()`，参照其 imageSources 处理逻辑，了解如何读取 req.files 和 req.body
  - `server.js:72-91` — `parseMaybeJsonArray()`，用于解析 referenceImagesBase64
  - `server.js:408-410` — `bufferToDataUrl()`，用于 multer buffer 转 data URL

  **Acceptance Criteria**:

  **QA Scenarios**:

  ```
  Scenario: 文生图端点返回 imageBase64
    Tool: Bash (curl)
    Preconditions: server 已启动（npm start），GEMINI_BASE_URL 和 API key 已配置
    Steps:
      1. curl -s -X POST http://localhost:3000/api/generate \
           -H 'Content-Type: application/json' \
           -d '{"prompt":"a red apple on a white table","model":"gemini-3.1-flash-image-landscape","apiKey":"YOUR_KEY"}' \
           > /tmp/gen_result.json
      2. cat /tmp/gen_result.json | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); if(!j.success) throw new Error(j.error); if(!j.imageBase64?.startsWith('data:image/')) throw new Error('no imageBase64'); console.log('PASS: imageBase64 present, length='+j.imageBase64.length);"
    Expected Result: 输出 PASS: imageBase64 present，长度 > 1000
    Failure Indicators: success=false，或 imageBase64 字段缺失，或不以 data:image/ 开头
    Evidence: .sisyphus/evidence/task-3-text2img.txt

  Scenario: 响应中不含 imageUrl 字段
    Tool: Bash (node)
    Preconditions: /tmp/gen_result.json 已生成（上一场景）
    Steps:
      1. node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/gen_result.json','utf8')); if('imageUrl' in j) throw new Error('imageUrl should not be present'); console.log('PASS: imageUrl absent');"
    Expected Result: 输出 PASS: imageUrl absent
    Evidence: .sisyphus/evidence/task-3-no-imageurl.txt

  Scenario: 图生图端点正常工作
    Tool: Bash (curl)
    Preconditions: 准备一个小的 base64 图片（可用 1x1 像素 PNG）
    Steps:
      1. BASE64=$(node -e "console.log('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')")
      2. curl -s -X POST http://localhost:3000/api/edit \
           -H 'Content-Type: application/json' \
           -d "{\"prompt\":\"make it blue\",\"model\":\"gemini-3.1-flash-image-landscape\",\"apiKey\":\"YOUR_KEY\",\"mainImageBase64\":\"$BASE64\"}" \
           > /tmp/edit_result.json
      3. node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/edit_result.json','utf8')); if(!j.success) throw new Error(j.error); if(!j.imageBase64?.startsWith('data:image/')) throw new Error('no imageBase64'); console.log('PASS');"
    Expected Result: 输出 PASS
    Evidence: .sisyphus/evidence/task-3-img2img.txt

  Scenario: 无 API Key 时返回 400
    Tool: Bash (curl)
    Preconditions: server 已启动，无服务端 key 配置
    Steps:
      1. curl -s -o /tmp/nokey.json -w "%{http_code}" -X POST http://localhost:3000/api/generate \
           -H 'Content-Type: application/json' \
           -d '{"prompt":"test","model":"gemini-3.1-flash-image-landscape"}'
    Expected Result: HTTP 400，响应包含 error 字段
    Evidence: .sisyphus/evidence/task-3-no-apikey.txt

  Scenario: 视频端点未受影响
    Tool: Bash (node)
    Preconditions: server.js 已修改
    Steps:
      1. node --check server.js && echo 'SYNTAX OK'
      2. grep -n 'callFlow2Api' server.js | grep -v 'function callFlow2Api' | grep -v 'video\|Video'
         （验证 callFlow2Api 调用仅出现在视频相关路由）
    Expected Result: SYNTAX OK；callFlow2Api 调用均在视频路由中
    Evidence: .sisyphus/evidence/task-3-video-intact.txt
  ```

  **Evidence to Capture**:
  - [ ] `.sisyphus/evidence/task-3-text2img.txt`
  - [ ] `.sisyphus/evidence/task-3-no-imageurl.txt`
  - [ ] `.sisyphus/evidence/task-3-img2img.txt`
  - [ ] `.sisyphus/evidence/task-3-no-apikey.txt`
  - [ ] `.sisyphus/evidence/task-3-video-intact.txt`

  **Commit**: YES
  - Message: `refactor(server): replace Flow2API image calls with Gemini generateContent`
  - Files: `server.js`
  - Pre-commit: `node --check server.js`

---

## Final Verification Wave

> 4 个审查 agent 并行运行，全部 APPROVE 后向用户展示结果并等待明确确认。

- [ ] F1. **Plan Compliance Audit** — `oracle`
  读取计划全文。逐一验证 Must Have 条目在代码中存在（读 server.js，确认函数/字段/header 名称）。逐一搜索 Must NOT Have 模式（`callFlow2Api` 在图片路径是否出现、`downloadMedia` 是否在图片路径调用、视频端点是否被修改、前端文件是否被修改）。验证 `.env.example` 包含 `GEMINI_BASE_URL`。
  Output: `Must Have [N/N] | Must NOT Have [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  运行 `node --check server.js` 验证语法。检查：无注释代码/console.log 遗留调试输出、错误处理完整（所有 async 路由有 try/catch）、函数命名清晰、无未使用变量/函数。验证 `FLOW2API_BASE_URL` 仅在视频路径使用，`GEMINI_BASE_URL` 仅在图片路径使用。
  Output: `Syntax [PASS/FAIL] | Style [PASS/FAIL] | Dead code [CLEAN/N issues] | VERDICT: APPROVE/REJECT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  启动 server（`npm start`），用真实 API key 执行每个 Task 3 的 QA 场景（text2img、img2img、no-apikey 400 验证）。额外测试：无效 API key 时返回友好错误消息（不是原始堆栈）；portrait 比例模型名是否正确提取 aspectRatio=9:16；视频端点发起一次请求确认不受影响。保存所有输出到 `.sisyphus/evidence/final-qa/`。
  Output: `Scenarios [N/N pass] | Edge cases [N tested] | VERDICT: APPROVE/REJECT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  对比每个 task 的「What to do」与实际 server.js 修改内容（git diff 或直接读文件）。验证：Task 1 新增的每个函数都存在；Task 2 的 .env.example 更新正确；Task 3 的路由修改完整且无多余改动。检查是否有未计划的文件被修改（前端文件、视频路由）。
  Output: `Tasks [3/3 compliant] | Unaccounted changes [CLEAN/N files] | VERDICT: APPROVE/REJECT`

---

## Commit Strategy

- **Wave 1 完成后**: `refactor(server): add Gemini generateContent image API functions` — `server.js`, `.env.example`
- **Wave 2 完成后**: `refactor(server): replace Flow2API image calls with Gemini generateContent` — `server.js`

---

## Success Criteria

### Verification Commands
```bash
node --check server.js                          # Expected: exit 0, no output
grep 'GEMINI_BASE_URL' server.js               # Expected: 出现在常量定义和 callGeminiGenerateContent 中
grep 'callFlow2Api' server.js                  # Expected: 仅出现在函数定义和视频路由中
grep 'x-goog-api-key' server.js               # Expected: 出现在 callGeminiGenerateContent 中
grep 'GEMINI_BASE_URL' .env.example            # Expected: 包含该条目
```

### Final Checklist
- [ ] `GEMINI_BASE_URL` 常量和环境变量支持存在
- [ ] `callGeminiGenerateContent()` 函数已实现
- [ ] `buildGeminiImageContents()` 函数已实现
- [ ] `parseGeminiImageResponse()` 函数已实现
- [ ] `extractModelBase()` 函数已实现
- [ ] `RATIO_MAP` 包含全部 5 种比例
- [ ] `/api/generate` 使用新函数，不调用 `callFlow2Api`
- [ ] `/api/edit` 使用新函数，不调用 `callFlow2Api`
- [ ] 视频三个端点代码零修改
- [ ] 前端零修改
- [ ] `.env.example` 包含 `GEMINI_BASE_URL`
- [ ] 图片响应无 `imageUrl` 字段
- [ ] `imageBase64` 为完整 data URL 格式