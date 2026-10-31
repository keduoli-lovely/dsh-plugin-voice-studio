/**
 * Browser half of Voice Studio: the settings page.
 *
 * One section under Settings, five tabs (voice / reference voices / cover / QQ
 * / status). The page talks to the host half over its own `/.tts-studio` routes
 * — the loopback port changes on every desktop restart, so nothing is kept in
 * localStorage; the host's config.json is the only source of truth.
 *
 * Evaluated as an external classic script, possibly more than once per page
 * lifetime (the shell re-evaluates a rebuilt bundle), so the whole file is one
 * IIFE and only `var`/`function` declarations would leak.
 */
(function () {
  var PREFIX = '/tts-studio'

  window.__ModuleLoader__.load({
    id: 'dsh-plugin-voice-studio',
    factory(require) {
      var React = require('react')
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useMemo = React.useMemo
      var useCallback = React.useCallback
      var useRef = React.useRef

      var copy = {
        zh: {
          nav: '语音工坊',
          title: '语音工坊',
          lead: '语音合成、参考音色库与 RVC 歌曲翻唱。设置保存在宿主端，重启不丢；Agent 通过 voice_generate / song_cover 工具使用这些配置。',
          tabs: { tts: '语音合成', voices: '参考音色', cover: '歌曲翻唱', qq: 'QQ 发送', status: '状态' },
          save: '保存',
          saved: '已保存',
          saving: '保存中…',
          cancel: '取消',
          remove: '删除',
          replace: '替换',
          addAsNew: '另存为新音色',
          preview: '试听',
          probe: '探测服务',
          probing: '探测中…',
          provider: '语音提供商',
          providerHint: '本地提供商需要参考音频；在线提供商需要 API Key 与音色 ID。',
          baseUrl: 'Base URL',
          apiKey: 'API Key',
          model: '模型',
          voiceId: '音色 ID',
          refVoice: '参考音色',
          refVoiceEmpty: '(未选择)',
          lang: '语言',
          emotionMode: '情绪模式',
          emotionHint: 'auto = 优先使用已安装的 DSH 情绪插件，其次内置词典；off = 不加情绪。',
          emotionAuto: '自动',
          emotionManual: '仅显式指定',
          emotionOff: '关闭',
          intensity: '情绪强度',
          library: '参考音色库',
          libraryHint: '上传或导入的音频会被复制到插件目录（refs/），同名时可选择替换或另存。',
          upload: '上传音频',
          importPath: '从路径导入',
          importDir: '导入整个目录',
          importPathPh: 'D:\\路径\\voice.wav',
          importDirPh: 'D:\\路径\\voices',
          play: '播放',
          pause: '暂停',
          rename: '重命名',
          save: '保存',
          sourcePath: '文件路径',
          emptyLibrary: '还没有参考音色。',
          size: '大小',
          duration: '时长',
          ttsTest: '试听生成',
          ttsText: '测试文本',
          generate: '生成',
          generating: '生成中…',
          coverSong: '歌曲（标题 / 路径 / 链接）',
          coverModel: 'RVC 模型',
          coverModelHint: '从 RVC 的 assets/weights 与 logs 中读取，也可以在下方填写任意 .pth 绝对路径。',
          coverIndex: '索引',
          coverIndexAuto: '自动匹配',
          coverShift: '升降调',
          coverStart: '开始翻唱',
          covering: '翻唱中…',
          coverRescan: '重新扫描模型',
          rvcRoot: 'RVC 目录',
          rvcPython: 'RVC Python',
          msst: 'MSST_WebUI 地址',
          msstHint: '留空则使用 RVC 自带的人声分离（PyMSS）。',
          musicDirs: '音乐目录',
          musicDirsHint: '每行一个目录；翻唱时按标题匹配歌曲。',
          ytdlp: 'yt-dlp 路径',
          allowDownload: '允许下载歌曲（链接）',
          qqEnable: '启用 QQ 发送',
          qqMode: '发送方式',
          qqTarget: '目标',
          qqTargetPrivate: '私聊 QQ 号',
          qqTargetGroup: '群号',
          qqSendAs: '发送为',
          qqRecord: '语音',
          qqFile: '文件',
          qqTest: '发送测试',
          qqStatus: 'QQ 状态',
          statusTitle: '服务状态',
          dataDir: '数据目录',
          voicesCount: '参考音色',
          modelsCount: 'RVC 模型',
          noProvider: '（未配置 Base URL）',
          error: '出错',
          done: '完成',
          conflictTitle: '该音色已存在',
          conflictBody: '同名音色已经在库里。要覆盖它，还是保留它并新增一份？',
          audioResult: '生成结果',
          coverResult: '翻唱结果',
          stage: '阶段',
          elapsed: '耗时',
          needsKey: '在线提供商请先填写 API Key',
          qqBridge: 'qq-bridge 发送（推荐）',
          qqBridgeHint: '语音工坊只负责生成与入库，真正发语音由 qq-bridge 的 qq_send_voice 完成。',
          qqBridgeRoot: 'qq-bridge 目录',
          qqBridgeSwitch: 'bridge 语音开关',
          qqBridgeTool: 'qq_send_voice 工具',
          qqBridgeLibrary: '语音库',
          qqBridgeEnable: '打开 bridge 语音开关',
          qqBridgeEnabled: '已写入 socialV2.voice.enabled / tools.sendVoice，重启 qq-bridge 生效',
          refreshStatus: '刷新状态',
          randomVoice: '随机语音回复',
          randomHint: '开启后，模型会在回复前随机决定用语音代替文字（唱歌不走随机）。',
          randomProb: '概率',
          randomCooldown: '冷却（秒）',
          randomMaxHour: '每小时上限',
          legacyChannel: '旧通道（OneBot / shell，可选）',
          qqModeAuto: '自动',
        },
        en: {
          nav: 'Voice Studio',
          title: 'Voice Studio',
          lead: 'Speech synthesis, a managed reference-voice library and RVC song covers. Settings live on the host and survive restarts; the agent uses them through voice_generate / song_cover.',
          tabs: { tts: 'Speech', voices: 'Reference voices', cover: 'Song covers', qq: 'QQ delivery', status: 'Status' },
          save: 'Save',
          saved: 'Saved',
          saving: 'Saving…',
          cancel: 'Cancel',
          remove: 'Delete',
          replace: 'Replace',
          addAsNew: 'Keep both',
          preview: 'Preview',
          probe: 'Probe services',
          probing: 'Probing…',
          provider: 'TTS provider',
          providerHint: 'Local providers need a reference voice; online providers need an API key and a voice id.',
          baseUrl: 'Base URL',
          apiKey: 'API key',
          model: 'Model',
          voiceId: 'Voice id',
          refVoice: 'Reference voice',
          refVoiceEmpty: '(none)',
          lang: 'Language',
          emotionMode: 'Emotion mode',
          emotionHint: 'auto = a registered DSH emotion plugin first, then the built-in lexicon; off = no emotion.',
          emotionAuto: 'Auto',
          emotionManual: 'Explicit only',
          emotionOff: 'Off',
          intensity: 'Emotion strength',
          library: 'Reference voice library',
          libraryHint: 'Uploaded or imported audio is copied into the plugin directory (refs/); when a name already exists you choose replace or keep both.',
          upload: 'Upload audio',
          importPath: 'Import from path',
          importDir: 'Import a directory',
          importPathPh: 'D:\\path\\voice.wav',
          importDirPh: 'D:\\path\\voices',
          play: 'Play',
          pause: 'Pause',
          rename: 'Rename',
          save: 'Save',
          sourcePath: 'File path',
          emptyLibrary: 'No reference voices yet.',
          size: 'Size',
          duration: 'Duration',
          ttsTest: 'Test synthesis',
          ttsText: 'Test text',
          generate: 'Generate',
          generating: 'Generating…',
          coverSong: 'Song (title / path / URL)',
          coverModel: 'RVC model',
          coverModelHint: 'Read from the RVC assets/weights and logs folders; an absolute .pth path also works.',
          coverIndex: 'Index',
          coverIndexAuto: 'Auto',
          coverShift: 'Key shift',
          coverStart: 'Start cover',
          covering: 'Covering…',
          coverRescan: 'Rescan models',
          rvcRoot: 'RVC folder',
          rvcPython: 'RVC python',
          msst: 'MSST_WebUI URL',
          msstHint: 'Leave empty to use the RVC built-in separation (PyMSS).',
          musicDirs: 'Music folders',
          musicDirsHint: 'One folder per line; covers match the song by title there.',
          ytdlp: 'yt-dlp path',
          allowDownload: 'Allow downloading a linked song',
          qqEnable: 'Enable QQ delivery',
          qqMode: 'Transport',
          qqTarget: 'Target',
          qqTargetPrivate: 'Private QQ id',
          qqTargetGroup: 'Group id',
          qqSendAs: 'Send as',
          qqRecord: 'Voice',
          qqFile: 'File',
          qqTest: 'Send a test',
          qqStatus: 'QQ status',
          statusTitle: 'Service status',
          dataDir: 'Data directory',
          voicesCount: 'Reference voices',
          modelsCount: 'RVC models',
          noProvider: '(no base URL)',
          error: 'Error',
          done: 'Done',
          conflictTitle: 'That voice already exists',
          conflictBody: 'A voice with this name is already in the library. Overwrite it, or keep both?',
          audioResult: 'Result',
          coverResult: 'Cover result',
          stage: 'Stage',
          elapsed: 'Elapsed',
          needsKey: 'Fill in an API key for online providers',
          qqBridge: 'Send through qq-bridge (recommended)',
          qqBridgeHint: 'Voice Studio only renders and imports the audio; qq-bridge actually sends it with qq_send_voice.',
          qqBridgeRoot: 'qq-bridge folder',
          qqBridgeSwitch: 'bridge voice switch',
          qqBridgeTool: 'qq_send_voice tool',
          qqBridgeLibrary: 'Voice library',
          qqBridgeEnable: 'Turn on the bridge voice switch',
          qqBridgeEnabled: 'Wrote socialV2.voice.enabled / tools.sendVoice — restart qq-bridge to apply',
          refreshStatus: 'Refresh status',
          randomVoice: 'Random voice replies',
          randomHint: 'When on, the model may replace a text reply with speech at random (songs excluded).',
          randomProb: 'Probability',
          randomCooldown: 'Cooldown (s)',
          randomMaxHour: 'Per hour cap',
          legacyChannel: 'Legacy channel (OneBot / shell, optional)',
          qqModeAuto: 'Auto',
        },
      }

      function text() {
        var lang = String((document.documentElement && document.documentElement.lang) || navigator.language || '')
        return lang.toLowerCase().indexOf('zh') === 0 ? copy.zh : copy.en
      }

      function t() {
        return text()
      }

      async function request(path, options) {
        var response = await fetch(path, Object.assign({ cache: 'no-store' }, options, {
          headers: Object.assign(
            { accept: 'application/json' },
            options && options.body !== undefined ? { 'content-type': 'application/json' } : {},
            (options && options.headers) || {},
          ),
        }))
        var raw = await response.text()
        var body
        try {
          body = raw ? JSON.parse(raw) : {}
        } catch (e) {
          body = { error: raw.slice(0, 200) }
        }
        if (!response.ok) {
          var error = new Error(body && body.error ? body.error : 'HTTP ' + response.status)
          error.status = response.status
          error.body = body
          throw error
        }
        return body
      }

      function formatDuration(value) {
        var total = Math.max(0, Math.round(Number(value) || 0))
        var minutes = Math.floor(total / 60)
        var seconds = total % 60
        return minutes + ':' + (seconds < 10 ? '0' + seconds : String(seconds))
      }

      function fmtBytes(n) {
        if (!n) return '—'
        if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MiB'
        return Math.max(1, Math.round(n / 1024)) + ' KiB'
      }

      // ---- small controls (host design tokens only) --------------------------

      function Group(props) {
        return h('section', { className: 'vs-group' },
          h('div', { className: 'vs-group-head' },
            h('h3', null, props.title),
            props.hint ? h('span', { className: 'vs-group-hint' }, props.hint) : null,
          ),
          h('div', { className: 'vs-group-body' }, props.children),
        )
      }

      function Row(props) {
        return h('label', { className: 'vs-row' },
          h('div', { className: 'vs-row-label' },
            h('span', null, props.label),
            props.hint ? h('span', { className: 'vs-row-hint' }, props.hint) : null,
          ),
          h('div', { className: 'vs-row-control' }, props.children),
        )
      }

      function Input(props) {
        return h('input', Object.assign({ className: 'vs-input', spellCheck: false }, props))
      }

      function Select(props) {
        return h('select', Object.assign({ className: 'vs-input vs-select' }, props), props.children)
      }

      function Button(props) {
        var cls = 'vs-btn' + (props.variant === 'primary' ? ' vs-btn-primary' : '') + (props.danger ? ' vs-btn-danger' : '')
        return h('button', Object.assign({ type: 'button', className: cls }, props, { className: cls }), props.children)
      }

      function Switch(props) {
        return h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          className: 'vs-switch' + (props.checked ? ' is-on' : ''),
          onClick: function () { props.onChange(!props.checked) },
        }, h('span', { className: 'vs-switch-knob' }))
      }

      function Notice(props) {
        if (!props.children) return null
        return h('div', { className: 'vs-notice ' + (props.kind || '') }, props.children)
      }

      // ---- page --------------------------------------------------------------

      function VoiceSettings() {
        var [state, setState] = useState(null)
        var [busy, setBusy] = useState('')
        var [error, setError] = useState('')
        var [flash, setFlash] = useState('')
        var [tab, setTab] = useState('tts')
        var [draft, setDraft] = useState(null)
        var [ttsText, setTtsText] = useState('你好呀，我是语音工坊，现在用的是你给的那副嗓子。')
        var [ttsResult, setTtsResult] = useState(null)
        var [conflict, setConflict] = useState(null)
        var [songInput, setSongInput] = useState('')
        var [job, setJob] = useState(null)
        var [importPath, setImportPath] = useState('')
        var [importDirPath, setImportDirPath] = useState('')
        var [renaming, setRenaming] = useState('')
        var [renameDraft, setRenameDraft] = useState('')
        var [confirmDelete, setConfirmDelete] = useState('')
        var [playingId, setPlayingId] = useState('')
        var audioRef = useRef(null)
        var fileRef = useRef(null)
        var fileTarget = useRef(null)
        var pollRef = useRef(null)
        var albumRef = useRef(null)

        var load = useCallback(async function (notify) {
          try {
            var data = await request(PREFIX + '/api/state')
            setState(data)
            setDraft(data.settings)
            if (notify) setFlash(t().saved)
          } catch (e) {
            setError(String(e.message || e))
          }
        }, [])

        useEffect(function () {
          void load(false)
          return function () {
            if (pollRef.current) clearTimeout(pollRef.current)
          }
        }, [load])

        useEffect(function () {
          if (!flash) return undefined
          var timer = setTimeout(function () { setFlash('') }, 2200)
          return function () { clearTimeout(timer) }
        }, [flash])

        function patchDraft(path) {
          return function (value) {
            setDraft(function (current) {
              var next = JSON.parse(JSON.stringify(current || {}))
              var cursor = next
              for (var i = 0; i < path.length - 1; i += 1) {
                if (!cursor[path[i]] || typeof cursor[path[i]] !== 'object') cursor[path[i]] = {}
                cursor = cursor[path[i]]
              }
              cursor[path[path.length - 1]] = value
              return next
            })
          }
        }

        async function save() {
          setBusy('save')
          setError('')
          try {
            var body = await request(PREFIX + '/api/settings', {
              method: 'PUT',
              body: JSON.stringify({ patch: draft }),
            })
            setState(function (current) { return Object.assign({}, current, { settings: body.settings }) })
            setDraft(body.settings)
            setFlash(t().saved)
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }

        async function probeServices() {
          setBusy('probe')
          setError('')
          try {
            var data = await request(PREFIX + '/api/probe', { method: 'POST', body: '{}' })
            setState(function (current) { return Object.assign({}, current, { services: data.services }) })
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }

        async function syncDshUrl() {
          setBusy('sync')
          setError('')
          try {
            var data = await request(PREFIX + '/api/qq/sync-dsh-url', { method: 'POST', body: '{}' })
            setFlash('已把 qq-bridge 的 dsh.baseUrl 改为 ' + data.origin + '，重启 qq-bridge 生效')
            var fresh = await request(PREFIX + '/api/state')
            setState(fresh)
            setDraft(fresh.settings)
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }

        async function generate() {
          setBusy('tts')
          setError('')
          setTtsResult(null)
          try {
            var body = await request(PREFIX + '/api/tts', {
              method: 'POST',
              body: JSON.stringify({
                text: ttsText,
                voiceId: draft && draft.tts && draft.tts.providers
                  ? (draft.tts.providers[draft.tts.provider || 'indextts'] || {}).refAudioId
                  : '',
              }),
            })
            setTtsResult(body)
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }

        function pickFile(target) {
          fileTarget.current = target
          if (fileRef.current) {
            fileRef.current.value = ''
            fileRef.current.click()
          }
        }

        async function onFileChosen(event) {
          var file = event.target.files && event.target.files[0]
          if (!file) return
          var target = fileTarget.current || {}
          setBusy('upload')
          setError('')
          try {
            var base64 = await new Promise(function (resolve, reject) {
              var reader = new FileReader()
              reader.onload = function () { resolve(String(reader.result)) }
              reader.onerror = function () { reject(reader.error || new Error('read failed')) }
              reader.readAsDataURL(file)
            })
            var payload = {
              mode: target.replaceId ? 'replace' : 'ask',
              name: target.replaceId ? undefined : file.name.replace(/\.[^.]+$/, ''),
              fileName: file.name,
              base64: base64,
              replaceId: target.replaceId,
            }
            await submitVoice(payload)
          } catch (e) {
            if (e.status === 409 && e.body && e.body.existing) {
              setConflict({ pending: null, existing: e.body.existing, name: file.name })
              // Keep the bytes so the dialog can retry without re-picking.
              conflictPending.current = { file: file, name: file.name.replace(/\.[^.]+$/, '') }
            } else {
              setError(String(e.message || e))
            }
          } finally {
            setBusy('')
          }
        }

        var conflictPending = useRef(null)

        async function submitVoice(payload) {
          var body = await request(PREFIX + '/api/voices', { method: 'POST', body: JSON.stringify(payload) })
          setState(function (current) { return Object.assign({}, current, { voices: body.voices }) })
          setConflict(null)
          return body
        }

        async function resolveConflict(kind) {
          var pending = conflictPending.current
          if (!pending) { setConflict(null); return }
          setBusy('upload')
          try {
            var base64 = await new Promise(function (resolve, reject) {
              var reader = new FileReader()
              reader.onload = function () { resolve(String(reader.result)) }
              reader.onerror = function () { reject(reader.error || new Error('read failed')) }
              reader.readAsDataURL(pending.file)
            })
            await submitVoice({
              mode: kind === 'replace' ? 'replace' : 'add',
              name: pending.name,
              fileName: pending.file.name,
              base64: base64,
              replaceId: kind === 'replace' && conflict && conflict.existing ? conflict.existing.id : undefined,
            })
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            conflictPending.current = null
            setBusy('')
          }
        }

        async function importFromPath() {
          var path = String(importPath || '').trim()
          if (!path) return
          setBusy('upload')
          setError('')
          try {
            var body = await request(PREFIX + '/api/voices', {
              method: 'POST',
              body: JSON.stringify({ mode: 'add', sourcePath: path }),
            })
            setState(function (current) { return Object.assign({}, current, { voices: body.voices }) })
            setImportPath('')
            setFlash('已导入')
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }

        async function importDir() {
          var dir = String(importDirPath || '').trim()
          if (!dir) return
          setBusy('upload')
          setError('')
          try {
            var body = await request(PREFIX + '/api/voices', {
              method: 'POST',
              body: JSON.stringify({ action: 'import-dir', dir: dir }),
            })
            setState(function (current) { return Object.assign({}, current, { voices: body.voices }) })
            setImportDirPath('')
            setFlash('导入 ' + body.added.length + ' 个')
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }

        function togglePlay(voice) {
          var audio = audioRef.current
          if (!audio) return
          if (playingId === voice.id) {
            audio.pause()
            setPlayingId('')
            return
          }
          audio.src = PREFIX + '/api/voice-audio?id=' + encodeURIComponent(voice.id)
          var played = audio.play()
          if (played && played.catch) played.catch(function () { setPlayingId('') })
          setPlayingId(voice.id)
        }

        async function saveRename(voice) {
          var name = String(renameDraft || '').trim()
          if (!name || name === voice.name) { setRenaming(''); return }
          await voiceAction('rename', voice.id, { name: name })
          setRenaming('')
        }

        async function refreshQq() {
          setBusy('qq')
          try {
            var data = await request(PREFIX + '/api/qq')
            setState(function (current) { return Object.assign({}, current, { qqStatus: data.status }) })
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }

        async function enableBridgeVoice() {
          setBusy('bridge')
          try {
            var data = await request(PREFIX + '/api/qq/bridge-enable', { method: 'POST', body: '{}' })
            setState(function (current) { return Object.assign({}, current, { qqStatus: data.status || current.qqStatus }) })
            setFlash(t().qqBridgeEnabled)
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }

        async function voiceAction(action, id, extra) {
          setBusy('voice')
          try {
            var body = await request(PREFIX + '/api/voices', {
              method: 'POST',
              body: JSON.stringify(Object.assign({ action: action, id: id }, extra || {})),
            })
            setState(function (current) { return Object.assign({}, current, { voices: body.voices }) })
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }

        async function startCover() {
          if (!songInput.trim()) return
          setBusy('cover')
          setError('')
          setJob(null)
          try {
            var body = await request(PREFIX + '/api/cover', {
              method: 'POST',
              body: JSON.stringify({ song: songInput.trim() }),
            })
            pollJob(body.job.id)
          } catch (e) {
            setError(String(e.message || e))
            setBusy('')
          }
        }

        function pollJob(id) {
          var tick = async function () {
            try {
              var data = await request(PREFIX + '/api/jobs?id=' + encodeURIComponent(id))
              setJob(data.job)
              if (data.job.status === 'running') {
                pollRef.current = setTimeout(tick, 1500)
                return
              }
              setBusy('')
            } catch (e) {
              setError(String(e.message || e))
              setBusy('')
            }
          }
          void tick()
        }

        async function rescanModels() {
          setBusy('models')
          try {
            var data = await request(PREFIX + '/api/models?rescan=1')
            setState(function (current) { return Object.assign({}, current, { models: data }) })
            setFlash(t().done)
          } catch (e) {
            setError(String(e.message || e))
          } finally {
            setBusy('')
          }
        }



        var T = t()
        if (!state || !draft) {
          return h('div', { className: 'vs-page' },
            h('div', { className: 'vs-header' }, h('h2', null, T.title), h('p', { className: 'vs-lead' }, T.lead)),
            error ? h(Notice, { kind: 'error' }, error) : h('p', { className: 'vs-muted' }, '…'),
          )
        }

        var cfg = draft
        var providers = state.providers || {}
        var activeId = cfg.tts.provider || 'indextts'
        var active = cfg.tts.providers[activeId] || {}
        var voices = state.voices || []
        var models = state.models || { models: [], indexes: [] }

        var tabs = [['tts', T.tabs.tts], ['voices', T.tabs.voices], ['cover', T.tabs.cover], ['qq', T.tabs.qq], ['status', T.tabs.status]]

        return h('div', { className: 'vs-page' },
          h('div', { className: 'vs-header' },
            h('h2', null, T.title),
            h('p', { className: 'vs-lead' }, T.lead),
          ),
          error ? h(Notice, { kind: 'error' }, error) : null,
          flash ? h(Notice, { kind: 'ok' }, flash) : null,
          h('div', { className: 'vs-tabs' }, tabs.map(function (entry) {
            return h('button', {
              key: entry[0],
              type: 'button',
              className: 'vs-tab' + (tab === entry[0] ? ' is-active' : ''),
              onClick: function () { setTab(entry[0]) },
            }, entry[1])
          })),
          h('input', { ref: fileRef, type: 'file', accept: 'audio/*,.wav,.mp3,.flac,.m4a,.ogg', style: { display: 'none' }, onChange: onFileChosen }),
          h('audio', { ref: audioRef, preload: 'none', onEnded: function () { setPlayingId('') }, style: { display: 'none' } }),

          tab === 'tts'
            ? h('div', { className: 'vs-tab-body' },
              h(Group, { title: T.provider, hint: T.providerHint },
                h(Row, { label: T.provider },
                  h(Select, {
                    value: activeId,
                    onChange: function (e) { patchDraft(['tts', 'provider'])(e.target.value) },
                  }, Object.keys(providers).map(function (id) {
                    return h('option', { key: id, value: id }, providers[id].label)
                  })),
                ),
                h(Row, { label: T.baseUrl }, h(Input, { value: active.baseUrl || '', onChange: function (e) { patchDraft(['tts', 'providers', activeId, 'baseUrl'])(e.target.value) } })),
                providers[activeId] && providers[activeId].kind === 'online'
                  ? h(Row, { label: T.apiKey }, h(Input, { type: 'password', value: active.apiKey || '', onChange: function (e) { patchDraft(['tts', 'providers', activeId, 'apiKey'])(e.target.value) } }))
                  : null,
                providers[activeId] && providers[activeId].kind === 'online'
                  ? h(Row, { label: T.model }, h(Input, { value: active.model || '', onChange: function (e) { patchDraft(['tts', 'providers', activeId, 'model'])(e.target.value) } }))
                  : null,
                activeId === 'indextts'
                  ? h(Row, { label: T.lang },
                    h(Select, { value: active.lang || 'ZH', onChange: function (e) { patchDraft(['tts', 'providers', 'indextts', 'lang'])(e.target.value) } },
                      ['ZH', 'EN', 'JA', 'AR', 'ES'].map(function (lang) { return h('option', { key: lang, value: lang }, lang) })))
                  : null,
                providers[activeId] && providers[activeId].needsRef
                  ? h(Row, { label: T.refVoice, hint: voices.length === 0 ? T.emptyLibrary : null },
                    h(Select, {
                      value: active.refAudioId || '',
                      onChange: function (e) { patchDraft(['tts', 'providers', activeId, 'refAudioId'])(e.target.value) },
                    },
                    h('option', { value: '' }, T.refVoiceEmpty),
                    voices.map(function (voice) { return h('option', { key: voice.id, value: voice.id }, voice.name) }),
                    ))
                  : h(Row, { label: T.voiceId }, h(Input, { value: active.voice || '', onChange: function (e) { patchDraft(['tts', 'providers', activeId, 'voice'])(e.target.value) } })),
                activeId === 'gptsovits'
                  ? h(Row, { label: 'prompt_text', hint: '参考音频对应的文本，留空则 ref_free' },
                    h(Input, { value: active.promptText || '', onChange: function (e) { patchDraft(['tts', 'providers', 'gptsovits', 'promptText'])(e.target.value) } }))
                  : null,
                activeId === 'minimax'
                  ? h(Row, { label: 'GroupId', hint: '部分账号需要，可留空' },
                    h(Input, { value: active.groupId || '', onChange: function (e) { patchDraft(['tts', 'providers', 'minimax', 'groupId'])(e.target.value) } }))
                  : null,
              ),
              h(Group, { title: T.emotionMode, hint: T.emotionHint },
                h(Row, { label: T.emotionMode },
                  h(Select, {
                    value: cfg.emotion.mode || 'auto',
                    onChange: function (e) { patchDraft(['emotion', 'mode'])(e.target.value) },
                  },
                  h('option', { value: 'auto' }, T.emotionAuto),
                  h('option', { value: 'manual' }, T.emotionManual),
                  h('option', { value: 'off' }, T.emotionOff),
                  ),
                ),
                h(Row, { label: T.intensity, hint: '0 – 1' },
                  h(Input, {
                    type: 'number', min: 0, max: 1, step: 0.05,
                    value: cfg.emotion.intensity,
                    onChange: function (e) { patchDraft(['emotion', 'intensity'])(Number(e.target.value)) },
                  })),
              ),
              h(Group, { title: T.ttsTest },
                h('textarea', { className: 'vs-textarea', rows: 3, value: ttsText, onChange: function (e) { setTtsText(e.target.value) } }),
                h('div', { className: 'vs-actions' },
                  h(Button, { variant: 'primary', disabled: busy === 'tts', onClick: generate }, busy === 'tts' ? T.generating : T.generate),
                ),
                ttsResult
                  ? h('div', { className: 'vs-result' },
                    h('div', { className: 'vs-muted' }, T.audioResult + '：' + ttsResult.providerLabel + ' · ' + ttsResult.emotion + (ttsResult.emotionApplied ? ' · 已应用情绪' : '')),
                    h('audio', { controls: true, src: ttsResult.url, style: { width: '100%' } }),
                  )
                  : null,
              ),
            )
            : null,

          tab === 'voices'
            ? h('div', { className: 'vs-tab-body' },
              h(Group, { title: T.library, hint: T.libraryHint },
                h('div', { className: 'vs-actions' },
                  h(Button, { variant: 'primary', disabled: busy === 'upload', onClick: function () { pickFile({}) } }, T.upload),
                ),
                h('div', { className: 'vs-inline' },
                  h(Input, { value: importPath, placeholder: T.importPathPh, onChange: function (e) { setImportPath(e.target.value) } }),
                  h(Button, { onClick: importFromPath, disabled: busy === 'upload' || !importPath.trim() }, T.importPath),
                ),
                h('div', { className: 'vs-inline' },
                  h(Input, { value: importDirPath, placeholder: T.importDirPh, onChange: function (e) { setImportDirPath(e.target.value) } }),
                  h(Button, { onClick: importDir, disabled: busy === 'upload' || !importDirPath.trim() }, T.importDir),
                ),
                voices.length === 0
                  ? h('p', { className: 'vs-muted' }, T.emptyLibrary)
                  : h('div', { className: 'vs-list' }, voices.map(function (voice) {
                    var editing = renaming === voice.id
                    return h('div', { key: voice.id, className: 'vs-list-item' },
                      h('div', { className: 'vs-list-main' },
                        editing
                          ? h(Input, {
                            value: renameDraft,
                            autoFocus: true,
                            onChange: function (e) { setRenameDraft(e.target.value) },
                            onKeyDown: function (e) {
                              if (e.key === 'Enter') saveRename(voice)
                              if (e.key === 'Escape') setRenaming('')
                            },
                          })
                          : h('div', { className: 'vs-list-title', title: voice.name }, voice.name),
                        h('div', { className: 'vs-list-meta' }, [
                          voice.available ? '' : '文件缺失',
                          fmtBytes(voice.size),
                        ].filter(Boolean).join(' · ')),
                      ),
                      h('div', { className: 'vs-list-actions' },
                        h('button', {
                          type: 'button',
                          className: 'vs-play' + (playingId === voice.id ? ' is-playing' : ''),
                          title: playingId === voice.id ? T.pause : T.play,
                          'aria-label': playingId === voice.id ? T.pause : T.play,
                          onClick: function () { togglePlay(voice) },
                        }, playingId === voice.id ? '❚❚' : '▶'),
                        h('span', { className: 'vs-duration' }, voice.durationSec ? formatDuration(voice.durationSec) : '—'),
                        editing
                          ? [
                            h(Button, { key: 'save', variant: 'primary', onClick: function () { saveRename(voice) } }, T.save),
                            h(Button, { key: 'cancel', onClick: function () { setRenaming('') } }, T.cancel),
                          ]
                          : [
                            h(Button, { key: 'rename', onClick: function () { setRenaming(voice.id); setRenameDraft(voice.name) } }, T.rename),
                            confirmDelete === voice.id
                              ? [
                                h(Button, { key: 'confirm', danger: true, onClick: async function () { setConfirmDelete(''); await voiceAction('delete', voice.id, {}) } }, '确认删除'),
                                h(Button, { key: 'keep', onClick: function () { setConfirmDelete('') } }, T.cancel),
                              ]
                              : h(Button, { key: 'delete', danger: true, onClick: function () { setConfirmDelete(voice.id) } }, T.remove),
                          ],
                      ),
                    )
                  })),
              ),
              h(Group, { title: '说明' },
                h('p', { className: 'vs-muted' },
                  '参考音频会被复制到 ' + ((state.paths && state.paths.dataDir) || '插件目录') + '/refs/。同名导入时可以选择替换或另存，避免目录无限膨胀。'),
              ),
            )
            : null,

          tab === 'cover'
            ? h('div', { className: 'vs-tab-body' },
              h(Group, { title: 'RVC API', hint: '翻唱通过 HTTP 调用 RVC，不在本机读取目录；RVC 可以部署在另一台机器' },
                h(Row, { label: 'RVC API 地址', hint: '在 RVC 机器上运行 server/rvc-api.py' },
                  h(Input, { value: cfg.cover.rvcUrl || '', placeholder: 'http://127.0.0.1:7866', onChange: function (e) { patchDraft(['cover', 'rvcUrl'])(e.target.value) } })),
                h(Row, { label: T.msst, hint: T.msstHint },
                  h(Input, { value: cfg.cover.msstUrl || '', placeholder: '留空 = 用 RVC API 自带的 PyMSS 分离', onChange: function (e) { patchDraft(['cover', 'msstUrl'])(e.target.value) } })),
                h(Row, { label: T.coverModel },
                  h(Select, {
                    value: cfg.cover.model || '',
                    onChange: function (e) { patchDraft(['cover', 'model'])(e.target.value) },
                  },
                  h('option', { value: '' }, '（默认：第一个模型）'),
                  models.models.map(function (model) { return h('option', { key: model.id, value: model.id }, model.name) }),
                  )),
                h(Row, { label: T.coverIndex },
                  h(Select, {
                    value: cfg.cover.index || '',
                    onChange: function (e) { patchDraft(['cover', 'index'])(e.target.value) },
                  },
                  h('option', { value: '' }, T.coverIndexAuto),
                  models.indexes.map(function (index) { return h('option', { key: index.id, value: index.path }, index.name + (index.trained ? ' (trained)' : '')) }),
                  )),
                h(Row, { label: 'F0 方法' },
                  h(Select, { value: cfg.cover.f0Method || 'rmvpe', onChange: function (e) { patchDraft(['cover', 'f0Method'])(e.target.value) } },
                    h('option', { value: 'rmvpe' }, 'rmvpe'),
                    h('option', { value: 'fcpe' }, 'fcpe'),
                    h('option', { value: 'pm' }, 'pm'),
                    )),
                h(Row, { label: T.coverShift },
                  h(Input, { type: 'number', step: 1, value: cfg.cover.f0UpKey, onChange: function (e) { patchDraft(['cover', 'f0UpKey'])(Number(e.target.value)) } })),
                h(Row, { label: 'ffmpeg 路径', hint: '留空用 PATH 里的 ffmpeg；没有则只输出 WAV' },
                  h(Input, { value: cfg.cover.ffmpegPath || '', onChange: function (e) { patchDraft(['cover', 'ffmpegPath'])(e.target.value) } })),
                h('div', { className: 'vs-actions' }, h(Button, { onClick: rescanModels, disabled: busy === 'models' }, T.coverRescan)),
                models.error ? h(Notice, { kind: 'error' }, String(models.error)) : null,
              ),
              h(Group, { title: T.coverStart },
                h(Input, { value: songInput, placeholder: 'D:\\music\\song.wav（本机绝对路径）', onChange: function (e) { setSongInput(e.target.value) } }),
                h('div', { className: 'vs-actions' },
                  h(Button, { variant: 'primary', disabled: busy === 'cover', onClick: startCover }, busy === 'cover' ? T.covering : T.coverStart),
                ),
                job
                  ? h('div', { className: 'vs-result' },
                    h('div', { className: 'vs-muted' }, job.status + ' · ' + job.stage + ' · ' + Math.round(job.elapsedMs / 1000) + 's'),
                    job.error ? h(Notice, { kind: 'error' }, job.error) : null,
                    job.result && job.result.mp3Url
                      ? h('audio', { controls: true, src: job.result.mp3Url, style: { width: '100%' } })
                      : null,
                    job.result
                      ? h('div', { className: 'vs-muted' },
                        '歌曲：' + job.result.song + ' · 模型：' + job.result.model + ' · 分离：' + job.result.separation
                        + (job.result.loudnessApplied === false ? ' · 未做 loudnorm（ffmpeg 不可用）' : ''))
                      : null,
                  )
                  : null,
              ),
            )
            : null,

          tab === 'qq'
            ? h('div', { className: 'vs-tab-body' },
              h(Group, { title: T.qqBridge, hint: T.qqBridgeHint },
                h(Row, { label: T.qqEnable },
                  h(Switch, { checked: Boolean(cfg.qq.enabled), onChange: patchDraft(['qq', 'enabled']) })),
                h(Row, { label: '发送方式' },
                  h(Select, { value: cfg.qq.mode || 'bridge', onChange: function (e) { patchDraft(['qq', 'mode'])(e.target.value) } },
                    h('option', { value: 'bridge' }, 'qq-bridge（推荐）'),
                    h('option', { value: 'onebot-http' }, 'OneBot v11 HTTP'),
                    h('option', { value: 'shell' }, 'Shell 命令'),
                    h('option', { value: 'off' }, '关闭'),
                    )),
                h(Row, { label: T.qqBridgeRoot, hint: '留空自动探测' },
                  h(Input, { value: cfg.qq.bridgeRoot || '', placeholder: 'D:\\keduoli_desk\\qq-bridge', onChange: function (e) { patchDraft(['qq', 'bridgeRoot'])(e.target.value) } })),
                h('div', { className: 'vs-kv' },
                  h('span', null, T.qqBridgeLibrary), h('code', null, (state.bridge && state.bridge.audioDir) || '—'),
                  h('span', null, T.qqBridgeSwitch), h('span', null, state.bridge && state.bridge.available ? (state.bridge.enabled ? '已开启' : '关闭') : '—'),
                  h('span', null, T.qqBridgeTool), h('span', null, state.bridge && state.bridge.available ? (state.bridge.toolEnabled ? '已开启' : '关闭') : '—'),
                ),
                h('div', { className: 'vs-actions' },
                  h(Button, { onClick: refreshQq, disabled: busy === 'qq' }, T.refreshStatus),
                  h(Button, { onClick: enableBridgeVoice, disabled: busy === 'bridge', variant: 'primary' }, T.qqBridgeEnable),
                ),
                state.qqStatus
                  ? h('p', { className: 'vs-muted' }, T.qqStatus + '：' + String(state.qqStatus.detail || ''))
                  : null,
              ),
              h(Group, { title: T.randomVoice, hint: T.randomHint },
                h(Row, { label: T.qqEnable },
                  h(Switch, { checked: Boolean(cfg.autoVoice && cfg.autoVoice.enabled), onChange: patchDraft(['autoVoice', 'enabled']) })),
                h(Row, { label: T.randomProb, hint: '0 – 1' },
                  h(Input, { type: 'number', min: 0, max: 1, step: 0.01, value: cfg.autoVoice ? cfg.autoVoice.probability : 0.12, onChange: function (e) { patchDraft(['autoVoice', 'probability'])(Number(e.target.value)) } })),
                h(Row, { label: T.randomCooldown },
                  h(Input, { type: 'number', min: 60, step: 60, value: cfg.autoVoice ? cfg.autoVoice.cooldownSec : 600, onChange: function (e) { patchDraft(['autoVoice', 'cooldownSec'])(Number(e.target.value)) } })),
                h(Row, { label: T.randomMaxHour },
                  h(Input, { type: 'number', min: 1, step: 1, value: cfg.autoVoice ? cfg.autoVoice.maxPerHour : 6, onChange: function (e) { patchDraft(['autoVoice', 'maxPerHour'])(Number(e.target.value)) } })),
              ),
              cfg.qq.mode && cfg.qq.mode !== 'bridge'
                ? h(Group, { title: T.legacyChannel },
                  cfg.qq.mode === 'shell'
                    ? h(Row, { label: '命令模板', hint: '{file} {text} {kind}' },
                      h(Input, { value: cfg.qq.shellTemplate || '', onChange: function (e) { patchDraft(['qq', 'shellTemplate'])(e.target.value) } }))
                    : h(Row, { label: T.baseUrl, hint: 'NapCat / Lagrange 的 HTTP 地址' },
                      h(Input, { value: cfg.qq.baseUrl || '', onChange: function (e) { patchDraft(['qq', 'baseUrl'])(e.target.value) } })),
                  cfg.qq.mode === 'onebot-http'
                    ? h(Row, { label: 'Access Token' },
                      h(Input, { type: 'password', value: cfg.qq.accessToken || '', onChange: function (e) { patchDraft(['qq', 'accessToken'])(e.target.value) } }))
                    : null,
                  h(Row, { label: T.qqTarget },
                    h(Select, { value: cfg.qq.targetType || 'private', onChange: function (e) { patchDraft(['qq', 'targetType'])(e.target.value) } },
                      h('option', { value: 'private' }, T.qqTargetPrivate),
                      h('option', { value: 'group' }, T.qqTargetGroup),
                      )),
                  h(Row, { label: T.qqTarget + ' ID' },
                    h(Input, { value: cfg.qq.targetId || '', onChange: function (e) { patchDraft(['qq', 'targetId'])(e.target.value) } })),
                )
                : null,
            )
            : null,

          tab === 'status'
            ? h('div', { className: 'vs-tab-body' },
              h(Group, { title: T.statusTitle, hint: '探测只覆盖当前选择的提供商、翻唱与 QQ 通道' },
                h('div', { className: 'vs-actions' },
                  h(Button, { onClick: probeServices, disabled: busy === 'probe' }, busy === 'probe' ? T.probing : T.probe),
                ),
                h('div', { className: 'vs-kv' },
                  h('span', null, 'DSH 地址'), h('code', null, (state.dsh && state.dsh.origin) || '—'),
                  h('span', null, 'DSH 端口'), h('code', null, (state.dsh && state.dsh.port) || '—'),
                  h('span', null, T.dataDir), h('code', null, (state.paths && state.paths.dataDir) || ''),
                  h('span', null, T.voicesCount), h('span', null, String(voices.length)),
                  h('span', null, T.modelsCount), h('span', null, String(models.models.length)),
                  h('span', null, '情绪来源'), h('span', null, (state.capabilities && state.capabilities.emotion
                    ? (state.capabilities.emotion.dsh.length ? state.capabilities.emotion.dsh.map(function (x) { return x.name }).join(', ') + ' + 词典' : '内置词典')
                    : '—')),
                ),
                state.bridge && state.bridge.dshBaseUrl
                  ? h('div', { className: 'vs-result' },
                    h('p', { className: 'vs-muted' },
                      'qq-bridge 配置的 DSH：' + state.bridge.dshBaseUrl
                      + (state.bridge.dshMatch === true ? '（与当前一致）' : '（与当前 DSH 端口不一致）')),
                    state.bridge.dshMatch === false
                      ? h(Notice, { kind: 'error' }, 'DSH 每次启动都会换端口。点下面的按钮把当前地址写进 qq-bridge，然后重启 qq-bridge。')
                      : null,
                    h('div', { className: 'vs-actions' },
                      h(Button, { variant: 'primary', onClick: syncDshUrl, disabled: busy === 'sync' }, '把当前 DSH 地址写入 qq-bridge'),
                    ),
                  )
                  : null,
                state.services
                  ? h('div', { className: 'vs-list' }, Object.keys(state.services).map(function (id) {
                    var service = state.services[id]
                    var stateText = service.ok
                      ? 'OK' + (service.ms ? ' (' + service.ms + 'ms)' : '')
                      : (service.error || (service.status ? 'HTTP ' + service.status : '不可用'))
                    return h('div', { key: id, className: 'vs-list-item' },
                      h('div', { className: 'vs-list-main' },
                        h('div', { className: 'vs-list-title' }, service.label + (service.selected ? '（当前选择）' : '')),
                        h('div', { className: 'vs-muted' }, [service.url || service.detail || '', stateText].filter(Boolean).join(' · ')),
                      ),
                    )
                  }))
                  : h('p', { className: 'vs-muted' }, '点「探测服务」查看当前选择的服务状态。'),
              ),
            )
            : null,

          h('div', { className: 'vs-footer' },
            h(Button, { variant: 'primary', onClick: save, disabled: busy === 'save' }, busy === 'save' ? T.saving : T.save),
            h(Button, { onClick: function () { setDraft(state.settings) } }, '还原'),
          ),

          conflict
            ? h('div', { className: 'vs-modal-backdrop' },
              h('div', { className: 'vs-modal', role: 'dialog' },
                h('h3', null, T.conflictTitle),
                h('p', { className: 'vs-muted' }, T.conflictBody + '（' + conflict.existing.name + '）'),
                h('div', { className: 'vs-actions' },
                  h(Button, { onClick: function () { resolveConflict('replace') } }, T.replace),
                  h(Button, { onClick: function () { resolveConflict('add') } }, T.addAsNew),
                  h(Button, { onClick: function () { conflictPending.current = null; setConflict(null) } }, T.cancel),
                ),
              ),
            )
            : null,
        )
      }

      var styles = `
.vs-page { display: flex; flex-direction: column; gap: 18px; max-width: 760px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); padding-bottom: 24px; }
.vs-header { display: flex; flex-direction: column; gap: 4px; }
.vs-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
.vs-lead { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.vs-tabs { display: flex; gap: 4px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); padding-bottom: 2px; flex-wrap: wrap; }
.vs-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 6px 10px; border-radius: var(--dsw-radius-md, 8px); cursor: pointer; }
.vs-tab:hover { background: var(--dsw-alias-bg-layer-2); }
.vs-tab.is-active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.vs-tab-body { display: flex; flex-direction: column; gap: 22px; }
.vs-group { display: flex; flex-direction: column; gap: 6px; }
.vs-group-head { display: flex; align-items: baseline; gap: 8px; }
.vs-group-head h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.vs-group-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.vs-group-body { display: flex; flex-direction: column; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-layer-2); padding: 4px 14px; }
.vs-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.vs-row:last-child { border-bottom: 0; }
.vs-row-label { display: flex; flex-direction: column; gap: 2px; min-width: 140px; }
.vs-row-label > span:first-child { font-size: 12px; color: var(--dsw-alias-label-primary); }
.vs-row-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.vs-row-control { display: flex; align-items: center; gap: 8px; flex: 1; justify-content: flex-end; max-width: 62%; }
.vs-input { width: 100%; min-width: 120px; box-sizing: border-box; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1, transparent); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); padding: 6px 8px; outline: none; }
.vs-input:focus { border-color: var(--dsw-alias-brand-primary, #4f8cff); }
.vs-select { cursor: pointer; }
.vs-switch { position: relative; width: 38px; height: 22px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.2)); cursor: pointer; padding: 0; }
.vs-switch.is-on { background: var(--dsw-alias-brand-primary, #4f8cff); border-color: transparent; }
.vs-switch-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .12s ease; }
.vs-switch.is-on .vs-switch-knob { transform: translateX(16px); }
.vs-actions { display: flex; gap: 8px; padding: 10px 0; flex-wrap: wrap; }
.vs-btn { appearance: none; font: inherit; font-size: 12px; padding: 6px 12px; border-radius: var(--dsw-radius-md, 8px); border: 0.5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
.vs-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.vs-btn:disabled { opacity: .5; cursor: default; }
.vs-btn-primary { background: var(--dsw-alias-brand-primary, #4f8cff); border-color: transparent; color: #fff; }
.vs-btn-danger { color: var(--dsw-alias-label-error, #e5484d); }
.vs-textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 8px; border-radius: var(--dsw-radius-md, 8px); border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); resize: vertical; }
.vs-muted { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin: 0; }
.vs-notice { font-size: 12px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 8px); border: 0.5px solid var(--dsw-alias-border-l2); }
.vs-notice.error { color: var(--dsw-alias-label-error, #e5484d); border-color: var(--dsw-alias-label-error, #e5484d); }
.vs-notice.ok { color: var(--dsw-alias-label-success, #3fb950); border-color: var(--dsw-alias-label-success, #3fb950); }
.vs-inline { display: flex; gap: 8px; padding: 8px 0; }
.vs-inline .vs-input { flex: 1; }
.vs-list { display: flex; flex-direction: column; }
.vs-list-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); min-height: 44px; }
.vs-list-item:last-child { border-bottom: 0; }
.vs-list-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.vs-list-title { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vs-list-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.vs-play { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 50%; border: 0.5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; padding: 0; }
.vs-play:hover { background: var(--dsw-alias-bg-layer-2); }
.vs-play.is-playing { border-color: var(--dsw-alias-brand-primary, #4f8cff); color: var(--dsw-alias-brand-primary, #4f8cff); }
.vs-duration { flex: 0 0 auto; min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.vs-list-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.vs-result { display: flex; flex-direction: column; gap: 8px; padding: 10px 0; }
.vs-kv { display: grid; grid-template-columns: 120px 1fr; gap: 6px 12px; padding: 10px 0; font-size: 12px; }
.vs-kv code { font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.vs-footer { display: flex; gap: 8px; padding-top: 6px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.vs-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
.vs-modal { background: var(--dsw-alias-bg-layer-2, #1c1c1e); color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-lg, 10px); padding: 18px; max-width: 420px; display: flex; flex-direction: column; gap: 10px; border: 0.5px solid var(--dsw-alias-border-l2); }
`

      function installStyles() {
        var element = document.createElement('style')
        element.setAttribute('data-voice-studio', '')
        element.textContent = styles
        document.head.appendChild(element)
        return function () { try { element.remove() } catch (e) { /* ignore */ } }
      }

      var name = 'dsh-plugin-voice-studio'
      var inject = ['slots']

      function apply(ctx) {
        ctx.effect(function () {
          var removeStyles = installStyles()
          var disposeSection = ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'voice-studio',
                order: 45,
                label: function () { return t().nav },
                inject: function () { return {} },
              },
              VoiceSettings,
            )
          })
          return function () {
            if (typeof disposeSection === 'function') disposeSection()
            removeStyles()
          }
        })
      }

      return { name: name, inject: inject, apply: apply }
    },
  })
})()
