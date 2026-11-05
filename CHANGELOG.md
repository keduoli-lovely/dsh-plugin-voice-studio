# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [0.5.1] - 2026-11-05

### Added

- 设置页「Worker 进程」面板：检查 rvc-worker 进程、启动/重启/停止 RVC WebUI 与 MSST_WebUI。
- 新增宿主路由 `GET/POST /tts-studio/api/worker/process`（代理 worker 的 `/v1/process*`）。

## [0.5.0] - 2026-11-05

### Added

- **rvc-worker 集成**：独立的 RVC/MSST 执行器（Python 服务，默认 `0.0.0.0:7870`），
  插件新增 `workerUrl` / `workerToken`；配置后模型列表、换声、分离都走 worker，
  支持跨机器、任务队列与 SSE 进度、进程启停。没有 worker 时回退原来的 WebUI 直连。

### Fixed

- **设置页打开慢**：原先 `state()` 同步等待 RVC 探测（RVC 离线时 20~25 秒）。
  现在模型清单走本地缓存（`rvc-cache.json`）+ 后台刷新，设置页打开立即渲染（实测 25ms），
  远端超时压到 1.2s / 4s，失败也不再阻塞 UI。

## [0.4.0] - 2026-10-31

### Added

- **直接使用 RVC WebUI 的 Gradio API**：`rvcUrl` 现在可以填 WebUI 地址（例如 7897），插件自动识别后端：
  - 模型列表：`POST /run/infer_refresh`
  - 索引：`POST /run/infer_change_voice`
  - 换声：`POST /run/infer_convert`（base64 音频进、`/file=` 下载结果）
  - **换声不再需要任何附加服务**。
- 新增 `cover.separateUrl`：仅用于人声分离的 RVC API 地址（`server/rvc-api.py`）。

### Changed

- `server/rvc-api.py` 从「必需」降级为「可选」：只在需要自动分离、或不想用 MSST 时启动。
- 设置页翻唱页签：字段改为「RVC 地址」「分离服务地址」「MSST 地址」，并说明自动识别。

### Known

- RVC WebUI 的 `pymss_separate` 是 Gradio 流式生成器，该构建关闭了 `/queue/join`，HTTP 调用只能拿到第一帧，
  因此分离仍需要 MSST_WebUI 或 `server/rvc-api.py`。

## [0.3.1] - 2026-10-31

### Added

- `server/rvc-api.py` 增加 `GET /` 服务自述，方便在浏览器确认「这是 RVC API，不是 Gradio WebUI」。
- `server/start-rvc-api.bat`：在 RVC 根目录一键启动（默认 7866、绑定 0.0.0.0）。

### Changed

- 当 `rvcUrl` 指向的是 RVC **WebUI**（Gradio，含 `infer_convert` 接口）时，
  模型列表/转换/分离会返回明确诊断：「这是 WebUI 不是 RVC API，请运行 server/rvc-api.py（默认 7866）」。

## [0.3.0] - 2026-10-31

### Changed

- **翻唱改为纯 HTTP**：RVC 不再通过本地目录调用，新增 `server/rvc-api.py`
  （`/health`、`/models`、`/convert`、`/separate`）；插件只配置 `rvcUrl`，
  RVC 因此可以和 DSH 部署在不同机器上。
- 混音改为纯 Node（`lib/wav.js`）：WAV 编解码、重采样、RMS 对齐全部内置，
  不再需要本机 Python worker；ffmpeg 只用于可选的 loudnorm 与 MP3 输出。
- 歌曲只接受本机绝对路径：移除「音乐目录」「允许下载歌曲（链接）」「yt-dlp 路径」三项。

### Added

- `server/rvc-api.py`、`lib/rvc.js`、`lib/wav.js`。
- 设置页翻唱页签：RVC API 地址、F0 方法、ffmpeg 路径、模型错误提示。

### Removed

- `worker/*.py`（RVC 转换 / 分离 / 混音脚本）与 RVC 本地目录扫描。

## [0.2.1] - 2026-10-31

### Changed

- 翻唱的 `msstUrl` 默认改为**空**：不填即使用 RVC 内置 PyMSS 分离，避免默认指向 7860
  与 IndexTTS 抢端口造成误解。
- README：安装方式收敛为「从 GitHub 安装 / 本地目录安装」两种；移除开发章节里的实现细节约定。

## [0.2.0] - 2026-10-31

### Added

- **QQ 发送改为交给 qq-bridge**：生成音频后复制进 `<qq-bridge>/audio/voice-studio/`，
  再调用 `mcp__snowluma__qq_send_voice` 发送；不再由插件直连 OneBot（OneBot HTTP /
  shell 降级为可选旧通道）。
- **随机语音回复**：`voice_random_check` 工具 + 宿主端概率/冷却/每小时上限；
  命中时用语音代替文字，唱歌永不随机。
- **状态页**：
  - 按当前选择探测服务（选中 IndexTTS 就只测 IndexTTS；MSST 填了才测；QQ 启用才测 bridge）；
  - 服务签名校验（`gen_single` / `run_inference_single`），识别端口被别的服务占用；
  - 显示 DSH 地址与端口、qq-bridge 配置的 `dsh.baseUrl` 是否一致，可一键同步。
- **参考音色列表交互**：去掉每行「替换」按钮（改由导入冲突弹窗选择），播放按钮 + 时长替代
  原生音频控件（去掉音量条），行内重命名与两步删除，路径/目录导入改为页面内输入框
  （Electron 下 `window.prompt` 不可用）。
- 系统提示词段落：明确要求 QQ 会话里直接调用 `voice_generate`，不要先查语音库。
- `voice_generate` / `song_cover` 支持 `qq_key` / `qq_token`，可在一次调用内完成生成与发送。
- `boot.log` 诊断、`CHANGELOG.md`、`LICENSE`、打包脚本。

### Fixed

- 插件激活时 `cannot get property "webServer" without inject`（`inject` 未挂到插件对象）。
- 保存设置会重置未提及的配置段（音色库被清空）。
- RVC worker 的 `sys.argv` 被 RVC 自身 argparse 解析导致启动失败。
- worker 中文输出乱码（Windows cp936）与 numba 缓存目录不可写导致的长时间卡死。
- MSST 适配器读取 `/info` 默认值，避免传 null 模型。

## [0.1.0] - 2026-10-29

### Added

- 初始版本：6 个 TTS 提供商（indextts / gptsovits / siliconflow / minimax / mimo / openai）。
- 参考音色库（上传 / 路径导入 / 整目录导入 / 冲突替换或另存 / 删除 / 重命名）。
- RVC 歌曲翻唱流水线（找歌 → 分离 → 换声 → 混音母带），MSST 与 RVC 内置分离双通道。
- 情绪来源链（显式参数 → DSH 情绪插件 → 内置词典）与各引擎映射。
- 4 个 Agent 工具与 12 个 HTTP 路由；设置页 5 个标签页。
