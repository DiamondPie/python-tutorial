<template>
  <div class="python-runner">
    <div class="toolbar">
      <div class="actions">
        <button
          class="btn primary"
          @click="handleRun"
          :disabled="status === 'running' || status === 'initializing'"
        >
          <span class="icon" v-if="status !== 'running'">▶</span>
          <span class="icon spinner" v-else>↻</span>
          {{ status === 'running' ? '运行中...' : '运行' }}
        </button>
        <button
          class="btn danger"
          @click="handleCancel"
          :disabled="status !== 'running'"
        >
          <span class="icon">■</span> 中断
        </button>
        <button class="btn" @click="clearOutput">清空输出</button>
      </div>
      <div class="status-indicator">
        <span class="dot" :class="status"></span>
        <span class="status-text">{{ statusText }}</span>
      </div>
    </div>

    <div class="workspace">
      <div class="editor-pane" ref="editorContainer"></div>

      <div class="output-pane">
        <div class="output-header">输出控制台</div>
        <div class="output-content" ref="outputEl" @click="focusInputIfWaiting">
          <span
            v-for="line in outputLines"
            :key="line.id"
            :class="['log-line', line.type]"
          >{{ line.text }}</span><input
            v-if="waitingForInput"
            ref="inputEl"
            v-model="inputText"
            class="inline-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            :aria-label="'Standard input'"
            @keydown.enter.prevent="submitInput"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, readonly } from 'vue'

// ============ 能力检测:SharedArrayBuffer 是否可用 ============
// 需要满足:
//   1. SharedArrayBuffer 存在 (即 COOP/COEP 安全头已设置或环境支持)
//   2. Atomics 可用
//   3. 实际能够 new SharedArrayBuffer (有些环境定义了但不允许实例化)
const _SAB_SUPPORTED = (() => {
  try {
    if (typeof SharedArrayBuffer === 'undefined') return false
    if (typeof Atomics === 'undefined') return false
    // crossOriginIsolated 在 Service Worker 之外通常表示安全头是否到位
    if (typeof self !== 'undefined' && 'crossOriginIsolated' in self
        && self.crossOriginIsolated === false) {
      return false
    }
    // 试着真正分配一次 —— 某些环境定义了构造器但禁止使用
    // eslint-disable-next-line no-new
    new SharedArrayBuffer(4)
    return true
  } catch {
    return false
  }
})()

// ============ 模块级单例:整页共享 ============
let _worker      = null
let _initPromise = null
let _initResolve = null
let _initReject  = null
let _runIdCtr    = 0
let _runQueue    = Promise.resolve()

// SAB 模式下用于 stdin / interrupt 的共享缓冲
const _INPUT_BUF_SIZE = 4096
let _inputBuffer     = null   // SharedArrayBuffer (raw)
let _inputData       = null   // Uint8Array view
let _waitBuffer      = null   // SharedArrayBuffer (raw)
let _waitFlag        = null   // Int32Array view
let _interruptBuffer = null   // Uint8Array view (SharedArrayBuffer-backed)
const _encoder       = new TextEncoder()

const _pyVersion = ref(null)
const _isReady   = ref(false)
const _sabSupported = ref(_SAB_SUPPORTED)

// 监听者 & 取消集合
const _listeners = new Map()     // runId -> { stdout, stderr, finish, onInput, _done, _waitingForInput }
const _cancelled = new Set()     // 被软取消的 runId

// ============ Worker 源码 (内联) ============
// 与上传的 pyodide-worker.js 思路一致:支持 SAB 下的同步 stdin + interruptBuffer
// 不依赖 SAB 时,stdin 直接返回空字符串 (调用方应避免在 input() 程序上点中断)
const WORKER_SRC = `
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js')
let pyodide = null
let inputData = null
let waitFlag = null
const decoder = new TextDecoder()

self.onmessage = async (e) => {
  const { type } = e.data

  if (type === 'init') {
    try {
      pyodide = await loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/',
        checkAPIVersion: false
      })
      self.postMessage({ type: 'ready', version: pyodide.version })
    } catch (err) {
      self.postMessage({ type: 'error', id: 0, message: String(err) })
    }
    return
  }

  if (type === 'setup-sab') {
    // 仅在主线程检测到 SAB 时才会发来
    inputData = new Uint8Array(e.data.inputBuffer)
    waitFlag  = new Int32Array(e.data.waitBuffer)
    if (e.data.interruptBuffer) {
      pyodide.setInterruptBuffer(new Uint8Array(e.data.interruptBuffer))
    }
    return
  }

  if (type === 'run') {
    const { id, code } = e.data

    // stdout / stderr (按 chunk 分发,以便部分输出可以即时显示——例如 input() 之前的提示)
    pyodide.setStdout({ write: (buf) => {
      self.postMessage({ type: 'stdout', id, text: decoder.decode(buf) })
      return buf.length
    }})
    pyodide.setStderr({ write: (buf) => {
      self.postMessage({ type: 'stderr', id, text: decoder.decode(buf) })
      return buf.length
    }})

    // stdin —— 只在 SAB 模式下真正同步等待
    if (inputData && waitFlag) {
      pyodide.setStdin({ stdin: () => {
        self.postMessage({ type: 'input', id })
        // 同步阻塞,等主线程写入数据并 notify
        Atomics.wait(waitFlag, 0, 0)
        const len = Atomics.load(inputData, 0)
        const arr = new Uint8Array(len)
        for (let i = 0; i < len; i++) arr[i] = Atomics.load(inputData, i + 1)
        const text = decoder.decode(arr)
        // 把用户输入回显到输出区,模拟终端行为
        self.postMessage({ type: 'stdout', id, text: text + '\\n' })
        return text
      }})
    } else {
      pyodide.setStdin({ stdin: () => {
        self.postMessage({ type: 'stderr', id,
          text: '\\n[input() 不可用:当前环境缺少 SharedArrayBuffer 支持]\\n' })
        return ''
      }})
    }

    try {
      await pyodide.loadPackagesFromImports(code)
      // 每次运行用全新的 globals,避免互相污染
      const dict = pyodide.globals.get('dict')
      const globals = dict()
      try {
        const result = await pyodide.runPythonAsync(code, {
          filename: '<editor>',
          globals,
          locals: globals
        })
        self.postMessage({
          type: 'result', id,
          value: result == null ? null : String(result)
        })
      } finally {
        globals.destroy()
        dict.destroy()
      }
    } catch (err) {
      // KeyboardInterrupt 是用户主动中断,不需要把整段 traceback 推上去
      const msg = String(err && err.message ? err.message : err)
      const isInterrupt = msg.includes('KeyboardInterrupt')
      self.postMessage({
        type: 'error', id,
        message: msg,
        interrupted: isInterrupt
      })
    }
  }
}
`

function _createWorker() {
  const blob = new Blob([WORKER_SRC], { type: 'application/javascript' })
  const w = new Worker(URL.createObjectURL(blob))

  w.onmessage = ({ data: msg }) => {
    if (msg.type === 'ready') {
      _pyVersion.value = msg.version
      // 在 ready 之后才能 setInterruptBuffer —— pyodide 实例此时才存在
      if (_SAB_SUPPORTED) {
        _ensureSabAllocated()
        w.postMessage({
          type: 'setup-sab',
          inputBuffer: _inputBuffer,
          waitBuffer: _waitBuffer,
          interruptBuffer: _interruptBuffer.buffer
        })
      }
      _isReady.value = true
      _initResolve?.()
      _initResolve = _initReject = null
      return
    }
    if (msg.type === 'error' && msg.id === 0) {
      _initReject?.(new Error(msg.message))
      _initResolve = _initReject = null
      _initPromise = null
      return
    }

    const { id } = msg
    if (msg.type === 'result' || msg.type === 'error') {
      const cb = _listeners.get(id)
      if (!cb) return

      if (_cancelled.has(id)) {
        _cancelled.delete(id)
        _listeners.delete(id)
        cb._done()
        return
      }

      if (msg.type === 'result') cb.finish(true, msg.value, null)
      else cb.finish(false, null, msg.message, !!msg.interrupted)
      return
    }

    if (_cancelled.has(id)) return
    const cb = _listeners.get(id)
    if (!cb) return
    if (msg.type === 'stdout') cb.stdout?.(msg.text)
    if (msg.type === 'stderr') cb.stderr?.(msg.text)
    if (msg.type === 'input') {
      cb._waitingForInput = true
      cb.onInput?.()
    }
  }
  return w
}

function _ensureSabAllocated() {
  if (!_SAB_SUPPORTED) return
  if (!_inputBuffer) {
    _inputBuffer = new SharedArrayBuffer(_INPUT_BUF_SIZE)
    _inputData   = new Uint8Array(_inputBuffer)
  }
  if (!_waitBuffer) {
    _waitBuffer  = new SharedArrayBuffer(4)
    _waitFlag    = new Int32Array(_waitBuffer)
  }
  if (!_interruptBuffer) {
    _interruptBuffer = new Uint8Array(new SharedArrayBuffer(1))
  }
}

function _getWorker() {
  if (!_worker) _worker = _createWorker()
  return _worker
}

function _ensureInit() {
  if (_isReady.value) return Promise.resolve()
  if (_initPromise) return _initPromise
  _initPromise = new Promise((resolve, reject) => {
    _initResolve = resolve
    _initReject  = reject
    _getWorker().postMessage({ type: 'init' })
  })
  return _initPromise
}

function _scheduleRun(code, callbacks) {
  const runId = ++_runIdCtr
  _runQueue = _runQueue.then(() => {
    if (_cancelled.has(runId)) {
      _cancelled.delete(runId)
      return
    }
    return new Promise(done => {
      _listeners.set(runId, {
        _done: done,
        _waitingForInput: false,
        stdout: callbacks.stdout,
        stderr: callbacks.stderr,
        onInput: callbacks.onInput,
        finish(ok, val, err, interrupted) {
          callbacks.finish?.(ok, val, err, !!interrupted)
          _listeners.delete(runId)
          done()
        },
      })
      // 清零中断标志,以免上一次 SIGINT 残留
      if (_SAB_SUPPORTED && _interruptBuffer) _interruptBuffer[0] = 0
      _getWorker().postMessage({ type: 'run', code, id: runId })
    })
  })
  return runId
}

/**
 * 向运行中的 Python 进程提交一行 stdin。
 * 仅在 SAB 模式下有效。
 */
function _sendInput(runId, text) {
  if (!_SAB_SUPPORTED) return false
  const cb = _listeners.get(runId)
  if (!cb || !cb._waitingForInput) return false

  const bytes = _encoder.encode(text ?? '')
  // 截断到缓冲区容量内 (保留 1 字节给长度)
  const maxLen = Math.min(bytes.length, _INPUT_BUF_SIZE - 1)
  Atomics.store(_inputData, 0, maxLen)
  for (let i = 0; i < maxLen; i++) Atomics.store(_inputData, i + 1, bytes[i])

  cb._waitingForInput = false

  Atomics.store(_waitFlag, 0, 1)
  Atomics.notify(_waitFlag, 0)
  Atomics.store(_waitFlag, 0, 0)
  return true
}

/**
 * 硬重启:terminate 当前 Worker,清理所有状态,自动重新 init。
 * 在无 SAB 环境 (或 SAB 也无法 SIGINT 的极端情况) 下使用。
 */
function _hardReset(cancelledRunId = null) {
  if (_worker) {
    _worker.terminate()
    _worker = null
  }

  for (const [id, cb] of _listeners.entries()) {
    if (id === cancelledRunId) {
      cb._done()
    } else {
      try {
        cb.finish?.(false, null, '⚠ 因其他任务中断,该任务被一并取消。请重新运行。', false)
      } catch (e) { /* ignore */ }
    }
  }
  _listeners.clear()
  _cancelled.clear()

  _runQueue = Promise.resolve()

  _isReady.value = false
  _pyVersion.value = null
  _initPromise = null
  _initResolve = _initReject = null

  _ensureInit().catch(() => { /* 错误已通过 reject 传出 */ })
}

/**
 * 软中断 (SAB 模式):写入 SIGINT (2) 到 interruptBuffer,Pyodide 会在下次
 * 检查时抛出 KeyboardInterrupt —— Python 解释器和全局状态都保留。
 *
 * 如果当前 runId 正在等 input(),需要先解锁 Atomics.wait,SIGINT 才能传递过去。
 */
function _softInterrupt(runId) {
  if (!_SAB_SUPPORTED || !_interruptBuffer) return false
  const cb = _listeners.get(runId)

  _interruptBuffer[0] = 2  // SIGINT
  // 若正在等待输入,推一个空字符串进去解锁 worker 的 Atomics.wait
  if (cb && cb._waitingForInput) {
    _sendInput(runId, '')
  }
  return true
}

export function usePyodide() {
  return {
    pyVersion: readonly(_pyVersion),
    isReady: readonly(_isReady),
    sabSupported: readonly(_sabSupported),
    ensureInit: _ensureInit,
    run: async (code, callbacks) => {
      await _ensureInit()
      return _scheduleRun(code, callbacks)
    },
    sendInput: _sendInput,
    /**
     * 取消运行中的任务:
     *  - SAB 模式 → 软中断 (SIGINT),保留 Python 全局状态,几乎瞬时
     *  - 否则 → 硬重启 Worker (现有兜底逻辑)
     */
    cancel: (runId) => {
      if (runId == null) return
      if (_SAB_SUPPORTED) {
        _softInterrupt(runId)
      } else {
        _cancelled.add(runId)
        _hardReset(runId)
      }
    }
  }
}
</script>

<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import {
  history, defaultKeymap, historyKeymap, indentWithTab
} from '@codemirror/commands'
import {
  syntaxHighlighting, defaultHighlightStyle, bracketMatching,
  indentOnInput, indentUnit, foldGutter, foldKeymap
} from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { python, pythonLanguage } from '@codemirror/lang-python'
import { githubLight, githubDark } from '@uiw/codemirror-theme-github'
import { pythonBuiltin } from './pythonBuiltin'

const props = defineProps({
  initialCode: {
    type: String,
    default: 'print("Hello, Shared Worker!")'
  }
})

// === UI 状态 ===
const status = ref('idle')        // 'idle' | 'initializing' | 'ready' | 'running'
const statusText = ref('等待运行')
const outputLines = ref([])
const outputEl = ref(null)

// 内联输入状态
const waitingForInput = ref(false)
const inputText = ref('')
const inputEl = ref(null)

// === CodeMirror 6 状态 ===
const editorContainer = ref(null)
let editorView = null
const themeCompartment = new Compartment()
let themeObserver = null

// === Pyodide 钩子 ===
const { pyVersion, isReady, sabSupported, ensureInit, run, cancel, sendInput } = usePyodide()
let currentRunId = null
let runStartTime = 0

const checkDarkMode = () => typeof document !== 'undefined'
  && document.documentElement.classList.contains('dark')

const setReadyUI = () => {
  status.value = 'ready'
  statusText.value = `Python ${pyVersion.value} 就绪`
    + (sabSupported.value ? '' : ' (input/即时中断不可用)')
}

watch(isReady, (ready) => {
  if (ready) {
    if (status.value !== 'running') setReadyUI()
  } else {
    if (status.value !== 'running') {
      status.value = 'initializing'
      statusText.value = '环境重启中...'
    }
  }
})

onMounted(async () => {
  // 1. CodeMirror —— 显式装配 basicSetup 的等价扩展,这样可以:
  //    · 用 historyKeymap 提供的 Ctrl+Z / Ctrl+Shift+Z (无障碍历史)
  //    · 用 indentWithTab 提供"Tab 缩进、Escape 后 Tab 跳焦"的无障碍 Tab 行为
  //    · 叠加 pythonBuiltin 高亮内置函数
  editorView = new EditorView({
    parent: editorContainer.value,
    state: EditorState.create({
      doc: props.initialCode.trim(),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),                           // 启用撤销/重做历史栈
        foldGutter(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,                  // ⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z, ⌘/Ctrl+Y
          ...foldKeymap,
          ...completionKeymap,
          ...lintKeymap,
          indentWithTab                      // Tab 缩进、Shift+Tab 减少缩进;Esc 后 Tab 跳焦
        ]),
        indentUnit.of('    '),
        python(),
        pythonBuiltin(pythonLanguage),       // 高亮 print/len/... 等内置
        themeCompartment.of(checkDarkMode() ? githubDark : githubLight)
      ]
    })
  })

  themeObserver = new MutationObserver(() => {
    editorView.dispatch({
      effects: themeCompartment.reconfigure(checkDarkMode() ? githubDark : githubLight)
    })
  })
  themeObserver.observe(document.documentElement, {
    attributes: true, attributeFilter: ['class']
  })

  if (isReady.value) {
    setReadyUI()
    return
  }

  status.value = 'initializing'
  statusText.value = '加载 Python 环境...'
  try {
    await ensureInit()
    setReadyUI()
  } catch (e) {
    status.value = 'idle'
    statusText.value = '加载失败'
    appendOutput(`初始化失败: ${e.message}\n`, 'error')
  }
})

onBeforeUnmount(() => {
  if (themeObserver) themeObserver.disconnect()
  if (editorView) editorView.destroy()
})

// === 输出辅助 ===
const appendOutput = (text, type = 'info') => {
  outputLines.value.push({ id: Date.now() + Math.random(), text, type })
  nextTick(() => {
    if (outputEl.value) outputEl.value.scrollTop = outputEl.value.scrollHeight
  })
}

const clearOutput = () => { outputLines.value = [] }

const focusInputIfWaiting = () => {
  if (waitingForInput.value && inputEl.value) inputEl.value.focus()
}

const submitInput = () => {
  if (!waitingForInput.value || currentRunId == null) return
  const text = inputText.value
  inputText.value = ''
  waitingForInput.value = false
  // SAB 模式下 worker 会把这段文本回显到 stdout (带换行),所以这里不再 appendOutput
  // 无 SAB 模式下根本不会显示输入框,所以也走不到这一步
  sendInput(currentRunId, text)
}

// === 执行 ===
const handleRun = async () => {
  if (status.value === 'running' || status.value === 'initializing') return
  const code = editorView.state.doc.toString().trim()
  if (!code) return

  status.value = 'running'
  statusText.value = '排队执行中...'
  runStartTime = performance.now()
  waitingForInput.value = false
  inputText.value = ''

  try {
    currentRunId = await run(code, {
      stdout: (text) => appendOutput(text, 'stdout'),
      stderr: (text) => appendOutput(text, 'stderr'),
      onInput: async () => {
        waitingForInput.value = true
        await nextTick()
        inputEl.value?.focus()
      },
      finish: (ok, val, err, interrupted) => {
        if (currentRunId === null) return

        waitingForInput.value = false
        const elapsed = ((performance.now() - runStartTime) / 1000).toFixed(3)
        if (ok) {
          if (val !== null) appendOutput(`=> ${val}\n`, 'result')
          appendOutput(`[执行完成 用时 ${elapsed}s]\n\n`, 'meta')
        } else if (interrupted) {
          appendOutput(`\n⛔ 已中断 (KeyboardInterrupt)\n`, 'error')
          appendOutput(`[执行中断 用时 ${elapsed}s]\n\n`, 'meta')
        } else {
          appendOutput(`\n${err}\n`, 'error')
          appendOutput(`[执行异常 用时 ${elapsed}s]\n\n`, 'error')
        }
        currentRunId = null
        setReadyUI()
      }
    })

    statusText.value = '代码执行中...'

  } catch (e) {
    status.value = 'idle'
    statusText.value = '执行失败'
    appendOutput(`\n队列调度异常: ${e.message}\n\n`, 'error')
  }
}

const handleCancel = () => {
  if (!currentRunId) return

  if (sabSupported.value) {
    // 软中断:SIGINT,Python 全局状态保留,几乎瞬时
    appendOutput('\n⛔ 正在中断当前任务...\n', 'error')
    cancel(currentRunId)
    // finish 回调会自动把 status 切回 ready
  } else {
    // 回退:terminate worker → 重启 (会丢失 Python 全局状态)
    const runIdToCancel = currentRunId
    currentRunId = null
    waitingForInput.value = false
    appendOutput('\n⛔ 已中断当前任务,正在重启 Python 环境...\n', 'error')
    cancel(runIdToCancel)
    status.value = 'initializing'
    statusText.value = '环境重启中...'
  }
}
</script>

<style scoped>
/* 适配 VitePress 主题变量 */
.python-runner {
  margin: 16px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background-color: var(--vp-c-bg-soft);
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  background-color: var(--vp-c-bg-alt);
  border-bottom: 1px solid var(--vp-c-divider);
  flex-wrap: wrap;
  gap: 10px;
}

.actions { display: flex; gap: 8px; }

.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background-color: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
  transition: all 0.2s;
}

.btn:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.primary {
  background-color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: #fff;
}
.btn.primary:hover:not(:disabled) {
  background-color: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
}

.btn.danger { color: var(--vp-c-danger-1); }
.btn.danger:hover:not(:disabled) {
  border-color: var(--vp-c-danger-1);
  background-color: var(--vp-c-danger-soft);
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background-color: var(--vp-c-text-3);
  transition: background-color 0.3s;
}
.dot.idle { background-color: var(--vp-c-text-3); }
.dot.initializing { background-color: var(--vp-c-warning-1); animation: blink 1s infinite alternate; }
.dot.ready { background-color: var(--vp-c-success-1); }
.dot.running { background-color: var(--vp-c-brand-1); animation: blink 0.8s infinite alternate; }
@keyframes blink { from { opacity: 1; } to { opacity: 0.4; } }

.spinner {
  display: inline-block;
  animation: spin 1s linear infinite;
}
@keyframes spin { 100% { transform: rotate(360deg); } }

.workspace {
  display: flex;
  flex-direction: column;
}

.editor-pane {
  height: 300px;
  border-bottom: 1px solid var(--vp-c-divider);
  background-color: var(--vp-c-bg);
}

/* CodeMirror 6 内部样式 */
:deep(.cm-editor) {
  height: 100%;
  outline: none;
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
}
:deep(.cm-scroller) {
  overflow: auto;
}
:deep(.cm-content) {
  padding: 0
}
/* 内置函数高亮 (由 pythonBuiltin 注入 cm-builtin class) */
:deep(.cm-builtin) {
  color: var(--vp-c-brand-1);
}

.output-pane {
  background-color: var(--vp-c-bg-alt);
  display: flex;
  flex-direction: column;
}

.output-header {
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-text-2);
  border-bottom: 1px solid var(--vp-c-divider);
  background-color: var(--vp-c-bg-soft);
}

.output-content {
  padding: 12px 16px;
  min-height: 120px;
  max-height: 300px;
  overflow-y: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: text;
}

.log-line { color: var(--vp-c-text-1); }
.log-line.stderr, .log-line.error { color: var(--vp-c-danger-1); }
.log-line.result { color: var(--vp-c-brand-1); font-weight: bold; }
.log-line.meta { color: var(--vp-c-text-3); font-style: italic; }
.log-line.success { color: var(--vp-c-success-1); }

/* 内联输入框:与输出文本无缝衔接,模拟终端 */
.inline-input {
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  color: var(--vp-c-text-1);
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  margin: 0;
  min-width: 1ch;
  width: auto;
  /* 用一个微妙的下划线提示"在等输入",不打断行文 */
  border-bottom: 1px dashed var(--vp-c-brand-1);
  caret-color: var(--vp-c-brand-1);
}

.output-content::-webkit-scrollbar { width: 8px; }
.output-content::-webkit-scrollbar-track { background: transparent; }
.output-content::-webkit-scrollbar-thumb {
  background-color: var(--vp-c-divider);
  border-radius: 4px;
}
.output-content::-webkit-scrollbar-thumb:hover { background-color: var(--vp-c-text-3); }
</style>