# 语音工坊 · dsh-plugin-voice-studio

[![License: MIT](https://img.shields.io/badge/License-MIT-2786cb.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-5fa04e.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E6%8F%92%E4%BB%B6-4f8cff.svg)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![Release](https://img.shields.io/badge/release-v0.2.0-2ea043.svg)](https://github.com/keduoli-lovely/dsh-plugin-voice-studio/releases)

把「**说话**、**唱歌**、**换音色**、**发到 QQ**」做成一件事的 DeepSeek Harness 插件。

- **语音合成**：本地 IndexTTS / GPT-SoVITS，在线硅基流动 / MiniMax / 小米 MiMo / OpenAI 兼容
- **参考音色库**：上传、路径导入、整目录导入；文件复制进插件目录，同名可替换或另存
- **歌曲翻唱**：找歌 → 人声分离 → RVC 换声 → 混音母带，全自动
- **情绪控制**：接入 DSH 情绪插件，没有也能用内置词典
- **QQ 发送**：生成后交给 `qq-bridge` 的 `qq_send_voice` 发出，不接管 QQ 连接
- **随机语音**：偶尔用语音代替文字回复（唱歌不走随机）

> 设置页在 **设置 → 语音工坊**；Agent 通过 `voice_generate` / `song_cover` / `voice_studio_info` / `voice_random_check` 四个工具使用同一套配置。

---

## 目录

- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [语音合成](#语音合成)
- [参考音色库](#参考音色库)
- [情绪系统](#情绪系统)
- [歌曲翻唱](#歌曲翻唱)
- [QQ 发送：交给 qq-bridge](#qq-发送交给-qq-bridge)
- [随机语音回复](#随机语音回复)
- [状态页](#状态页)
- [Agent 工具参考](#agent-工具参考)
- [HTTP API](#http-api)
- [数据目录](#数据目录)
- [开发](#开发)
- [故障排查](#故障排查)
- [已知限制](#已知限制)
- [许可证](#许可证)

---

## 功能特性

| 能力 | 说明 |
|---|---|
| 多提供商 TTS | 6 个内置适配器，配置统一为 `baseUrl / apiKey / model / voice`（本地提供商使用 `refAudioId`） |
| 参考音色库 | 音频复制到 `~/.dsh-voice-studio/refs/`，不引用原路径；同名导入返回 `409 VOICE_CONFLICT`，页面选择替换或另存 |
| 情绪 | 显式参数 → DSH 情绪插件（Service / `get_mood` 工具 / `POST /emotion/api/state`）→ 内置词典；按引擎映射 |
| 歌曲翻唱 | 标题/路径/链接找歌；MSST 或 RVC 内置 PyMSS 分离（失败自动回退）；RVC 模型自动扫描；混音按原人声 RMS 对齐并 loudnorm |
| QQ 发送 | 渲染 → 复制进 qq-bridge 语音库 → 调用其 `qq_send_voice`；缺 key/token 时给出可执行的下一步 |
| 随机语音 | 宿主端概率 + 冷却 + 每小时上限，命中才计数；唱歌永不随机 |
| 可观测 | 状态页显示 DSH 地址/端口、qq-bridge 配置的 DSH 地址是否一致，并按「当前选择」探测服务 |
| 零第三方依赖 | 只用 Node 内置模块；RVC/分离/混音通过 Python worker 调用本机已有环境 |

## 环境要求

- **DeepSeek Harness ≥ 0.1.7**（桌面版或 web profile；插件通过 `settings.section` 出现在设置里）
- **Node.js ≥ 18**（宿主自带即可，插件无需额外安装依赖）
- 可选的本机服务（按需启用，缺哪个就少哪项能力，不会导致插件加载失败）：

| 服务 | 用途 | 默认地址 | 备注 |
|---|---|---|---|
| IndexTTS 2.x WebUI | 本地语音合成（情绪向量） | `http://127.0.0.1:7860` | Gradio，调用 `gen_single` |
| GPT-SoVITS `api_v2.py` | 本地语音合成 | `http://127.0.0.1:9880` | **9874 是 WebUI，没有 TTS API** |
| MSST_WebUI | 人声/伴奏分离 | `http://127.0.0.1:7860` | 需要「双轨」模型 |
| RVC（整合包） | 歌曲换声 | 目录配置 | 需要 `assets/weights/*.pth` 与 `runtime/python.exe` |
| qq-bridge | QQ 收发与语音发送 | 仓库目录 + 内置 3100 控制台 | 见 [QQ 发送](#qq-发送交给-qq-bridge) |

## 安装

### 方式一：应用内安装（推荐）

在 DSH 桌面端打开 **设置 → 插件**，把本目录作为本地包装入；或在对话里让 Agent 执行
`plugin_manager install_bundle`（目标为本仓库目录的绝对路径）。

### 方式二：CLI 安装

```bash
# 从本仓库目录安装（本地链接）
dsh plugin --profile desktop add /path/to/dsh-plugin-voice-studio
```

### 方式三：npm 包 / Release 包

`npm pack` 生成的 `dsh-plugin-voice-studio-*.tgz`（Release 附件）可以直接作为安装源：

```bash
dsh plugin --profile desktop add ./dsh-plugin-voice-studio-0.2.0.tgz
```

安装后**刷新设置页**即可看到「语音工坊」。

## 快速开始

1. **配置一个语音提供商**：设置 → 语音工坊 → 语音合成，选择提供商并填写地址（本地填 `baseUrl`，在线填 `apiKey`）。
2. **导入参考音色**：语音合成页选「参考音色」，或到「参考音色」页上传/导入一个 3~15 秒的干净人声。
3. **试听**：语音合成页底部输入文字，点「生成」，确认能出声、音色正确。
4. **（可选）翻唱**：歌曲翻唱页填 RVC 目录与模型，点「重新扫描模型」；输入歌名或路径开始翻唱。
5. **（可选）QQ**：QQ 发送页启用并确认 `qq-bridge` 路径；点「把当前 DSH 地址写入 qq-bridge」，重启 qq-bridge。

## 语音合成

| 提供商 id | 类型 | 端点 | 认证 | 情绪 |
|---|---|---|---|---|
| `indextts` | 本地 | `POST {base}/gradio_api/call/gen_single` | 无 | 8 维情绪向量 |
| `gptsovits` | 本地 | `GET/POST {base}/tts` | 无 | 无（靠参考音频） |
| `siliconflow` | 在线 | `POST {base}/audio/speech` → 二进制 | `Authorization: Bearer` | 指令前缀 `<指令> <\|endofprompt\|> 正文` |
| `minimax` | 在线 | `POST {base}/t2a_v2` → JSON | `Authorization: Bearer` | `voice_setting.emotion`（9 值枚举） |
| `mimo` | 在线 | `POST {base}/chat/completions` + `audio` | `api-key` 或 Bearer | user 消息风格指令 |
| `openai` | 在线 | `POST {base}/audio/speech` → 二进制 | `Authorization: Bearer` | `instructions` |

提供商配置示例（`~/.dsh-voice-studio/config.json`）：

```json
{
  "tts": {
    "provider": "indextts",
    "providers": {
      "indextts": { "baseUrl": "http://127.0.0.1:7860", "refAudioId": "v_xxx", "lang": "ZH", "emoWeight": 0.8 },
      "gptsovits": { "baseUrl": "http://127.0.0.1:9880", "refAudioId": "v_xxx", "promptText": "参考音频对应的文本" },
      "siliconflow": { "baseUrl": "https://api.siliconflow.cn/v1", "apiKey": "sk-...", "model": "FunAudioLLM/CosyVoice2-0.5B", "voice": "FunAudioLLM/CosyVoice2-0.5B:alex" },
      "minimax": { "baseUrl": "https://api.minimax.cn/v1", "apiKey": "eyJ...", "model": "speech-2.8-hd", "voice": "female-shaonv" },
      "mimo": { "baseUrl": "https://api.xiaomimimo.com/v1", "apiKey": "...", "model": "mimo-v2.5-tts", "voice": "冰糖" },
      "openai": { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "model": "gpt-4o-mini-tts", "voice": "alloy" }
    }
  }
}
```

**要点**

- 本地提供商必须先有参考音色；未配置默认音色时自动使用库里第一个可用音色。
- GPT-SoVITS 需要先运行 `api_v2.py`；其 WebUI（9874）只提供 UI，没有 TTS API。
- MiniMax 返回的是 **hex** 编码音频，插件会自动解码；同时校验 `base_resp.status_code`。
- MiMo 是 Chat Completions 形态（不是 `/v1/audio/speech`），插件按协议分支处理。

## 参考音色库

- **上传**（浏览器文件选择）、**从路径导入**、**批量导入目录**（递归，最多 200 个）。
- 文件**复制**到 `~/.dsh-voice-studio/refs/`，不引用原路径，原文件可随时搬走。
- 同名导入返回 `409 { code: "VOICE_CONFLICT", existing }`，页面弹窗选择 **替换** 或 **另存为新音色**（自动加序号），目录不会无限膨胀。
- 列表每行：播放按钮 + 时长（不加载原生音频控件），行内「重命名」（Enter 保存 / Esc 取消）、两步删除。
- 删除音色会清空引用它的提供商默认值。

## 情绪系统

来源链（缺插件也绝不失败）：

1. 调用方显式传 `emotion` / `intensity`（工具参数或设置页）；
2. 已安装的 DSH 情绪插件：
   - Host Service：`ctx.get('emotion' | 'emotions' | 'sentiment' | 'affect')` 上的 `classify` / `detect` 等；
   - 工具：`get_mood`（`dsh-emotion` 提供）；
   - HTTP：`POST {DSH}/emotion/api/state`；
3. 内置词典（开心/生气/悲伤/害怕/厌恶/低落/惊喜/平静）。

映射到各引擎：

| 维度 | IndexTTS 向量 | MiniMax enum | CosyVoice / MiMo / OpenAI |
|---|---|---|---|
| 开心 | 喜 | `happy` | 风格指令 |
| 生气 | 怒 | `angry` | 风格指令 |
| 悲伤 | 哀 | `sad` | 风格指令 |
| 害怕 | 惧 | `fearful` | 风格指令 |
| 厌恶 | 厌恶 | `disgusted` | 风格指令 |
| 低落 | 低落 | `sad` | 风格指令 |
| 惊喜 | 惊喜 | `surprised` | 风格指令 |
| 平静 | 平静 | `calm` | 风格指令 |

GPT-SoVITS 与 RVC 没有情绪参数，结果里会如实标注「该提供商无情绪参数」。

## 歌曲翻唱

流程：**找歌 → 分离 → RVC 换声 → 混音母带**。

1. **找歌**：标题（在「音乐目录」递归模糊匹配，返回候选）、绝对路径、链接（需开启下载并配置 yt-dlp）。
2. **分离**：配置了 `msstUrl` 就走 MSST_WebUI；否则用 RVC 自带 PyMSS；MSST 失败自动回退，并把两边失败原因一起返回。
3. **RVC**：自动扫描 `assets/weights/*.pth` 与 `logs/*/G_*.pth`；索引按模型名自动匹配（优先 `added_`）；headless 调用 RVC 的 `VC` 类，不占用 WebUI 端口。
4. **混音**：转换后的干声按分离人声 RMS 对齐 → 与伴奏相加 → 峰值 −1 dB → loudnorm（默认 `I=-11.5:TP=-1.0:LRA=11`），输出 24-bit WAV + 320 kbps MP3。

翻唱参数（设置页 → 歌曲翻唱）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `rvcRoot` | 自动探测 | RVC 整合包目录 |
| `rvcPython` | 自动探测 `runtime/python.exe` | RVC 的 Python |
| `model` | 第一个模型 | `.pth` 模型 id 或绝对路径 |
| `index` | 自动匹配 | `.index` 路径 |
| `f0Method` | `rmvpe` | 可选 `rmvpe` / `fcpe` / `pm` |
| `f0UpKey` | `0` | 升降调（半音） |
| `indexRate` | `0.75` | 索引混合比例 |
| `rmsMix` | `0.25` | 音量包络混合 |
| `protect` | `0.33` | 辅音保护 |
| `musicDirs` | `[]` | 音乐目录（找歌用） |
| `msstUrl` | 空 | 留空则用 RVC 内置分离 |
| `ytdlpPath` | 空 | 链接下载用 |

## QQ 发送：交给 qq-bridge

本插件**不接管 QQ 连接**。部署形态是：

```
QQ ⟶ SnowLuma（OneBot v11 WS）⟶ qq-bridge ⟶ DSH Web API（agent 对话）
                                      ⟵ 本插件：生成音频 → 放入语音库 → 调用 qq_send_voice
```

1. 生成音频；
2. 复制进 `<qq-bridge>/audio/voice-studio/`（自动读取 bridge 的 `socialV2.voice.dir` 与体积上限）；
3. 用调用方传入的 `qq_key` / `qq_token` 调用 `mcp__snowluma__qq_send_voice` 完成发送。

**必须满足的三件事**（设置页 QQ 页签均可检查）：

| 项 | 位置 | 说明 |
|---|---|---|
| bridge 语音开关 | `config.json → socialV2.voice.enabled` 与 `socialV2.tools.sendVoice` | 设置页有「打开 bridge 语音开关」按钮；改完**重启 qq-bridge** |
| QQ 会话工具白名单 | `plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 `SAFE_EXACT` | 需包含 `voice_generate` / `song_cover` / `voice_studio_info` / `voice_random_check`，否则 QQ 会话里这些工具会被 guard 拒绝 |
| DSH 地址 | `config.json → dsh.baseUrl` | DSH 桌面版每次启动换端口；状态页显示当前端口与是否一致，可一键写入 |

> 语音库为空是正常状态：`voice_generate` 会现场生成并入库，不要先调用 `qq_list_voices` 判断能不能发。

## 随机语音回复

- 设置 → 语音工坊 → QQ → 「随机语音回复」：开关、概率（默认 0.12）、冷却秒数（600）、每小时上限（6）。
- 模型在 QQ 会话每次回复前调用 `voice_random_check`：命中且回复适合朗读（短、无代码/列表/链接）时，改用 `voice_generate` 发语音代替文字。
- 冷却与每小时上限在宿主端持久化，命中才计数；**唱歌不走随机**。

## 状态页

- **只探测当前选择**：TTS 只测选中的提供商；翻唱测本地 RVC（目录 + python）；MSST 填了才测；QQ 启用才测 qq-bridge。
- **服务签名校验**：`/config` 必须包含 `gen_single`（IndexTTS）或 `run_inference_single`（MSST），避免两个服务共用 7860 时误报 OK。
- **DSH 端口**：显示 `http://127.0.0.1:<port>`、qq-bridge 配置的 `dsh.baseUrl` 与一致性；不一致时可一键同步（写 `dsh.baseUrl`，重启 qq-bridge 生效）。
- 完整清单：`POST /tts-studio/api/probe?all=1`。

## Agent 工具参考

### `voice_generate`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | ✅ | 要朗读的文本 |
| `voice` | string | | 参考音色 id 或名称 |
| `provider` | string | | 提供商 id |
| `emotion` | string | | 情绪标签 |
| `intensity` | number | | 情绪强度 0–1 |
| `speed` | number | | 语速倍数 |
| `lang` | string | | 本地提供商语言码 |
| `send_to_qq` | boolean | | 生成后交给 qq-bridge 发送 |
| `qq_key` / `qq_token` | string | | QQ 会话凭据（来自唤醒提示） |

### `song_cover`

`song`（标题/路径/链接，必填）、`model`、`index`、`key_shift`、`send_to_qq`、`qq_key`、`qq_token`。
同步执行整条流水线，返回混音后的 MP3/WAV 路径。

### `voice_studio_info`

`action`：`providers` | `voices` | `models` | `probe` | `settings`。

### `voice_random_check`

无参数，返回 `{ voice: boolean, reason }`。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/tts-studio/api/state` | 设置、音色库、RVC 模型、bridge 状态、DSH 地址 |
| PUT/POST | `/tts-studio/api/settings` | 保存设置（深合并，不会重置未提及的段） |
| GET/POST | `/tts-studio/api/voices` | 列表 / 上传 / 导入目录 / 删除 / 重命名 |
| GET | `/tts-studio/api/voice-audio?id=` | 试听参考音色（支持 Range） |
| GET | `/tts-studio/api/audio?path=` | 播放生成结果（限定数据目录内） |
| POST | `/tts-studio/api/tts` | 生成语音（可带 `sendToQQ` / `qqKey` / `qqToken`） |
| POST | `/tts-studio/api/cover` | 启动翻唱任务 |
| GET | `/tts-studio/api/jobs?id=` | 查询翻唱进度 |
| POST | `/tts-studio/api/probe?all=1` | 探测服务（默认只测当前选择） |
| GET/POST | `/tts-studio/api/qq` | QQ 状态 / 发送测试 |
| POST | `/tts-studio/api/qq/bridge-enable` | 打开 qq-bridge 两个语音开关 |
| POST | `/tts-studio/api/qq/sync-dsh-url` | 把当前 DSH 地址写入 qq-bridge |
| GET | `/tts-studio/api/models?rescan=1` | RVC 模型/索引清单 |

## 数据目录

```
~/.dsh-voice-studio/
  config.json    设置（原子写 + 串行化）
  refs/          参考音色副本
  out/           生成的语音与翻唱成品
  tmp/           每次任务的分离开临时文件
  boot.log       插件激活/注册/提示词诊断
```

可用 `DSH_VOICE_STUDIO_DATA` 覆盖整个数据目录。

## 开发

```
index.js         Host 插件：路由、工具、系统提示词
client.js        Client 插件：设置页（settings.section）
lib/store.js     配置 + 参考音色库 + RVC 模型扫描
lib/tts.js       6 个提供商适配器 + Gradio 客户端
lib/cover.js     找歌 / 分离 / RVC / 混音编排
lib/qq.js        qq-bridge 交付 + OneBot/shell 兜底
lib/emotion.js   情绪来源链 + 引擎映射
worker/*.py      RVC 转换 / 分离 / 混音（调用本机 Python）
```

本地验证：

```bash
node --check index.js client.js lib/*.js
python -m py_compile worker/*.py
npm pack            # 产出安装包
```

常见约定（踩过的坑）：

- RVC 整合包的 `TEMP\` 可能对当前账户不可写 → worker 把 `TEMP/TMP/NUMBA_CACHE_DIR` 指向可写目录，否则 numba 导入 librosa 会卡死。
- Windows Python 默认 cp936 → worker 输出 ASCII-safe JSON，父进程设置 `PYTHONIOENCODING=utf-8`。
- Host 没有可回读的控制台 → 激活失败写 `boot.log`；路由与工具分别 try/catch。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件已装但没出现在设置里 | 客户端 bundle 需页面加载 | 刷新设置页 / 重启 DSH |
| `cannot get property "webServer" without inject` | 插件未声明依赖 | 本仓库已修复（`apply.inject`），旧版本请升级 |
| 本地 TTS 报 `fetch failed` | 服务没开或地址错 | 启动 IndexTTS / GPT-SoVITS `api_v2.py`，检查端口 |
| 旧版 `plugin_manager` 保存设置后音色库清空 | patch 合并重置了数组 | 本仓库已修复（深合并） |
| 翻唱很慢（>20 分钟） | RVC 的 `TEMP` 不可写导致 numba 卡住 | 参见开发约定 |
| QQ 里说「语音库是空的」 | 模型先查了 `qq_list_voices` | 已在系统提示词中要求直接调用 `voice_generate` |
| `qq_send_voice` 不存在 | bridge 语音开关关闭 / 未重启 | 设置页打开开关并重启 qq-bridge |
| bridge 日志「事件流 0 帧」 | `dsh.baseUrl` 是上一次的端口 | 状态页一键同步 + 重启 qq-bridge |

## 已知限制

- 语音/视频**接收**仍为占位文本（桥接侧限制），本插件只负责「发出」。
- IndexTTS 与 MSST 默认都想用 7860，必须错开端口。
- MSST 需要能输出「人声 + 伴奏」双轨的模型；只有去混响模型时会回退 RVC PyMSS。
- Application 类型壁纸/音源不涉及；RVC 若为 v1 模型索引匹配可能为空。
- qq-bridge 的 preset 白名单是对方项目文件，升级/重跑 `setup-dsh.mjs` 后可能需要重新加入四个工具名。

## 许可证

MIT © 2026 keduoli-lovely
