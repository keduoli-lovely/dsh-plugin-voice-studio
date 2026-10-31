# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

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
