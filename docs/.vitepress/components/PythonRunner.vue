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
        <div
          class="output-content"
          ref="outputEl"
          @click="focusInlineInput"
        >
          <span
            v-for="line in outputLines"
            :key="line.id"
            :class="['log-line', line.type]"
          >{{ line.text }}</span><!--
            Inline terminal-style input: appears at end of console only while THIS
            component is waiting for input. Uses an actual <input> so caret/edit
            keys behave naturally; styled to be invisible-bordered + monospace so
            it visually merges with the preceding stdout text (like a real TTY).
          --><input
            v-if="isWaitingInput"
            ref="inlineInputEl"
            v-model="userInputText"
            type="text"
            class="inline-stdin"
            aria-label="Python input prompt — press Enter to submit"
            @keydown.enter.prevent="submitInput"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, readonly } from 'vue'

// ============ 模块级单例:整页共享 ============
let _worker      = null
let _initPromise = null
let _initResolve = null
let _initReject  = null
let _runIdCtr    = 0
let _runQueue    = Promise.resolve()

const _pyVersion = ref(null)
const _isReady   = ref(false)

// 监听者 & 取消集合
const _listeners = new Map()     // runId -> { stdout, stderr, finish, _done }
const _cancelled = new Set()     // 被软取消的 runId

const WORKER_SRC = `
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js')
let pyodide = null
self.baseUrl = ''
// runId 当前正在执行的任务 id —— 在 stdin() 时回传给主线程,用于路由输入到正确的组件
let _currentRunId = 0

// ─── 自管 stdout / stderr 缓冲 ───────────────────────────────────────────
// 不能用 pyodide 内置的 batched 模式: batched 只在遇到 \\n 时才 flush,
// 而 input(prompt) 写的 prompt 不带换行,会被压在缓冲区里出不来 —— 表现
// 就是"输入框出现时看不到提示文字,等用户回车后 prompt 才迟到地冒出来"。
//
// 解决: 改用 raw (逐字节) 模式自己攒 buffer,遇到换行时 flush;同时在
// stdin() 阻塞前主动 flush 一次,确保 prompt 先抵达 UI,再让用户输入。
//
// 关键: raw 回调每次给一个**字节**(整数 0-255),不是字符。中文等多字节
// UTF-8 字符必须把字节攒齐再用 TextDecoder 解码,否则会出现 'æ¬¢è¿' 这种
// 把 UTF-8 字节当 Latin-1 单字符错解的乱码。
// 用 stream:true 的 decoder 还能正确处理"flush 时正好停在多字节字符中间"
// 的情况 —— 半个字符会被暂存到下一次 flush 自动拼回去。
const _outBytes = [];
const _errBytes = [];
const _outDecoder = new TextDecoder('utf-8');
const _errDecoder = new TextDecoder('utf-8');

function _flushOut() {
  if (_outBytes.length === 0) return;
  const text = _outDecoder.decode(new Uint8Array(_outBytes), { stream: true });
  _outBytes.length = 0;
  if (text) self.postMessage({ type: 'stdout', id: _currentRunId, text });
}
function _flushErr() {
  if (_errBytes.length === 0) return;
  const text = _errDecoder.decode(new Uint8Array(_errBytes), { stream: true });
  _errBytes.length = 0;
  if (text) self.postMessage({ type: 'stderr', id: _currentRunId, text });
}
function _flushAll() { _flushOut(); _flushErr(); }

// ─── Python 错误信息精简 ──────────────────────────────────────────────
// Pyodide 抛出的 PythonError 的 .message 是完整 traceback,大致长这样:
//   PythonError: Traceback (most recent call last):
//     File "/lib/python312.zip/_pyodide/_base.py", line 596, in eval_code_async
//       await CodeRunner(
//     File "/lib/python312.zip/_pyodide/_base.py", line 410, in run_async
//       coroutine = eval(self.code, globals, locals)
//                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//     File "<exec>", line 7, in <module>
//     File "<exec>", line 5, in main
//   ZeroDivisionError: division by zero
//
// 用户只关心:
//   1) 'Traceback (most recent call last):' 标题
//   2) 自己代码里的帧 (File "<exec>" / "<stdin>") + 它们的上下文行
//   3) 最后一行的异常类型 + 描述
// Pyodide runtime 自己的帧 (/lib/python*/.../, /lib/pyodide/) 是噪音,过滤掉。
//
// 注意: Python 3.11+ 的 traceback 在源码行下面还会多一行 ^^^ 标记,所以一个
// 帧之后跟着的"上下文行"可能不止一行 —— 凡是缩进开头的连续行都算上下文。
function _formatPyError(raw) {
  if (!raw) return raw;
  let s = String(raw);
  // 去掉首行 'PythonError: ' 前缀(Pyodide JS 端包装)
  s = s.replace(/^PythonError:\\s*/, '');

  const lines = s.split('\\n');
  const kept = [];
  let inTraceback = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^Traceback \\(most recent call last\\):/.test(ln)) {
      kept.push(ln);
      inTraceback = true;
      continue;
    }
    if (inTraceback && /^\\s*File \\"/.test(ln)) {
      // 一个 traceback 帧 + 紧随其后所有"上下文行"。
      // 上下文行的定义: 缩进起首,且本身不是另一个 File 帧。
      // (traceback 里 File 行也是缩进的,所以单纯按缩进会把下一个帧错当上下文吃掉)
      const isContext = (s2) => /^\\s+/.test(s2) && !/^\\s*File \\"/.test(s2);

      const isInternal = /File \\"\\/lib\\/python|File \\"\\/lib\\/pyodide|_pyodide[\\\\/]_base/.test(ln);
      if (isInternal) {
        // 跳过 File 行本身 + 后续所有连续的上下文行
        while (i + 1 < lines.length && isContext(lines[i + 1])) i++;
        continue;
      }
      kept.push(ln);
      while (i + 1 < lines.length && isContext(lines[i + 1])) {
        kept.push(lines[i + 1]);
        i++;
      }
      continue;
    }
    // 非 File 行: traceback 末尾的异常描述 (如 'ValueError: ...') 或其他内容
    kept.push(ln);
  }

  // 极端情况兜底: 过滤后所有用户帧都不在,只剩 'Traceback:' 标题 + 异常描述
  // —— 把标题也丢掉,只留最后那行异常描述,免得显示一个空 traceback
  const hasUserFrame = kept.some(l => /^\\s*File \\"/.test(l));
  if (!hasUserFrame) {
    const lastNonEmpty = [...kept].reverse().find(l => l.trim().length > 0);
    return (lastNonEmpty || s).trim();
  }

  return kept.join('\\n').trim();
}

self.onmessage = async ({ data: { type, code, id, baseUrl } }) => {
  if (type === 'init') {
    if (baseUrl) self.baseUrl = baseUrl;
    try {
      pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/' })

      // ─── 标准输出 / 错误: 逐字节进 buffer,遇 \\n (0x0A) flush ───
      // 注意: raw 回调每次给一个字节(整数 0-255),不是 unicode char。
      // 这里只 push 字节,真正的 UTF-8 解码在 _flushOut/_flushErr 里做。
      pyodide.setStdout({
        raw: (byte) => {
          _outBytes.push(byte);
          if (byte === 0x0A) _flushOut();
        }
      });
      pyodide.setStderr({
        raw: (byte) => {
          _errBytes.push(byte);
          if (byte === 0x0A) _flushErr();
        }
      });

      // ─── 核心:劫持 Python 标准输入 ───
      // 1) 先 flush stdout/stderr —— 把 input(prompt) 的 prompt 先发出去,
      //    否则它会卡在 buffer 里,等用户输入完才迟到出现。
      // 2) 发一条 input_request 给主线程,带 runId,主线程按 id 路由到正确组件。
      // 3) 同步 XHR 把 Worker 钉死,等 SW 塞数据回来 (维持原 SW + sync XHR 架构)。
      pyodide.setStdin({
        stdin: () => {
          _flushAll();
          self.postMessage({ type: 'input_request', id: _currentRunId });
          const targetUrl = self.baseUrl + '/__pyodide_input_trigger__?id=' + _currentRunId + '&r=' + Math.random();
          const xhr = new XMLHttpRequest();
          xhr.open('GET', targetUrl, false);
          xhr.send(null);
          return xhr.responseText;
        }
      });

      self.postMessage({ type: 'ready', version: pyodide.version })
    } catch (e) {
      self.postMessage({ type: 'error', id: 0, message: String(e) })
    }
    return
  }

  if (type === 'run') {
    _currentRunId = id
    // 新任务开始前清掉残留 buffer (理论上不会有,防御性)
    _outBytes.length = 0; _errBytes.length = 0;
    try {
      await pyodide.loadPackagesFromImports(code)
      const result = await pyodide.runPythonAsync(code)
      _flushAll();  // 运行结束兜底 flush 一次,避免末尾不带换行的输出丢失
      self.postMessage({ type: 'result', id, value: result == null ? null : String(result) })
    } catch (e) {
      _flushAll();  // 抛错前也兜底 flush
      // 用 e.message 而非 String(e) —— Pyodide 的 PythonError 的 message
      // 才是干净的 traceback 文本;再经 _formatPyError 去掉 Pyodide 内部帧。
      const raw = (e && e.message) ? e.message : String(e);
      self.postMessage({ type: 'error', id, message: _formatPyError(raw) })
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
      _isReady.value   = true
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
      else cb.finish(false, null, msg.message)
      return
    }

    if (_cancelled.has(id)) return
    const cb = _listeners.get(id)
    if (!cb) return
    if (msg.type === 'stdout') cb.stdout?.(msg.text)
    if (msg.type === 'stderr') cb.stderr?.(msg.text)
    // 路由 stdin 请求:只通知该 runId 对应的组件 —— 修复多组件同时弹输入的 bug
    if (msg.type === 'input_request') cb.onInputRequest?.()
  }
  return w
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
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : ''
    _getWorker().postMessage({ 
      type: 'init', 
      baseUrl: currentOrigin
    })
  })
  return _initPromise
}

function _scheduleRun(code, callbacks) {
  const runId = ++_runIdCtr
  _runQueue = _runQueue.then(() => {
    // 队列前面被 hardReset 中止时,本次任务可能已被标记取消
    if (_cancelled.has(runId)) {
      _cancelled.delete(runId)
      return
    }
    return new Promise(done => {
      _listeners.set(runId, {
        _done: done,
        stdout: callbacks.stdout,
        stderr: callbacks.stderr,
        onInputRequest: callbacks.onInputRequest,
        finish(ok, val, err) {
          callbacks.finish?.(ok, val, err)
          _listeners.delete(runId)
          done()
        },
      })
      _getWorker().postMessage({ type: 'run', code, id: runId })
    })
  })
  return runId
}

/**
 * 硬重启:terminate 当前 Worker,清理所有状态,自动重新 init。
 * - 所有正在执行 / 排队等待的任务都会被通知失败
 * - isReady 会先变 false,init 完成后再变 true
 * - 入参 cancelledRunId 表示是哪个 runId 触发的重启(那个任务不发 abort 错误,因为调用方已经知道)
 */
function _hardReset(cancelledRunId = null) {
  // 1. 杀掉当前 Worker
  if (_worker) {
    _worker.terminate()
    _worker = null
  }

  // 2. 通知所有挂起的监听者:任务被中断了
  for (const [id, cb] of _listeners.entries()) {
    if (id === cancelledRunId) {
      // 触发中断的那一个:让 promise 链解锁,但不调用 finish (UI 由 handleCancel 直接处理)
      cb._done()
    } else {
      // 被牵连的其他任务(队列里其他组件的):给个明确的失败通知
      try {
        cb.finish?.(false, null, '⚠ 因其他任务中断,该任务被一并取消。请重新运行。')
      } catch (e) { /* ignore */ }
    }
  }
  _listeners.clear()
  _cancelled.clear()

  // 3. 重置队列(丢弃所有未开始的排队任务)
  _runQueue = Promise.resolve()

  // 4. 重置 ready 标志 & init promise
  _isReady.value = false
  _pyVersion.value = null
  _initPromise = null
  _initResolve = _initReject = null

  // 5. 立即开始新一轮 init (UI 那边的 isReady watch 会自动反应)
  _ensureInit().catch(() => { /* 错误已经通过 reject 传出 */ })
}

export function usePyodide() {
  return {
    pyVersion: readonly(_pyVersion),
    isReady: readonly(_isReady),
    ensureInit: _ensureInit,
    run: async (code, callbacks) => {
      await _ensureInit()
      return _scheduleRun(code, callbacks)
    },
    /** 软取消:terminate 当前 Worker 并重启 (语义上"立刻停下",代价是丢失 Python 全局状态) */
    cancel: (runId) => {
      if (runId == null) return
      _cancelled.add(runId)
      _hardReset(runId)
    }
  }
}
</script>

<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick, watch, useSlots } from 'vue'
import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { indentWithTab, redo } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { completionStatus, acceptCompletion } from '@codemirror/autocomplete'
import { python } from '@codemirror/lang-python'
import { githubLight, githubDark } from '@uiw/codemirror-theme-github'

// const props = defineProps({
//   initialCode: {
//     type: String,
//     default: 'print("Hello, Shared Worker!")'
//   }
// })
const slots = useSlots()

// === UI 状态 ===
// 'idle' | 'initializing' | 'ready' | 'running'
const status = ref('idle')
const statusText = ref('等待运行')
const outputLines = ref([])
const outputEl = ref(null)

// === CodeMirror 6 状态 ===
const editorContainer = ref(null)
let editorView = null
const themeCompartment = new Compartment()
let themeObserver = null

// === Pyodide 钩子 ===
const { pyVersion, isReady, ensureInit, run, cancel } = usePyodide()
let currentRunId = null
let runStartTime = 0

const isWaitingInput = ref(false)
const userInputText = ref('')
const inlineInputEl = ref(null)

const checkDarkMode = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

const getCodeFromSlots = () => {
  if (!slots.default) return props.initialCode.trim()
  
  // 遍历插槽节点，将所有文本节点拼接起来
  const children = slots.default()
  let code = ''
  for (const node of children) {
    if (typeof node.children === 'string') {
      code += node.children
    } else if (Array.isArray(node.children)) {
      // 应对一些边界情况
      code += node.children.map(c => (typeof c === 'string' ? c : '')).join('')
    }
  }
  return code.trim()
}

// 让用户点击控制台空白处时,焦点回到正在等待的输入框 (真实终端体验)
const focusInlineInput = () => {
  if (isWaitingInput.value) inlineInputEl.value?.focus()
}

// 提交用户输入 —— 通过 Service Worker 把数据塞回挂起的同步 XHR
const submitInput = () => {
  if (!isWaitingInput.value) return

  const value = userInputText.value
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'INPUT_SUBMIT',
      value: value + '\n' // Python 的 input() 期望以换行符结束
    })
  }

  // 在控制台里把用户刚输入的内容当作 stdout 留痕,模拟真实终端的回显
  appendOutput(value + '\n', 'stdout')

  // 重置状态
  userInputText.value = ''
  isWaitingInput.value = false
}

// 把 UI 切回"空闲就绪"状态
const setReadyUI = () => {
  status.value = 'ready'
  statusText.value = `Pyodide ${pyVersion.value} 就绪`
}

// 监听全局 ready 状态变化,自动同步 UI
// 运行中(running)时不动它的状态,避免覆盖
watch(isReady, (ready) => {
  if (ready) {
    if (status.value !== 'running') setReadyUI()
  } else {
    // isReady 变 false 通常意味着 Worker 正在重启(被其他组件取消触发)
    if (status.value !== 'running') {
      status.value = 'initializing'
      statusText.value = '环境重启中...'
    }
  }
})

onMounted(async () => {
  // ─── 注册 Service Worker (仍是 input() 同步 XHR 的代理) ───
  // 注意:这里不再监听 SW 的 INPUT_REQUEST 广播 —— 那样会让"页面上所有
  // PythonRunner 同时弹出输入框"。改成由 Worker 主动 postMessage 一条带
  // runId 的 input_request,经 w.onmessage 路由到 _listeners 里对应组件的
  // onInputRequest 回调(见 handleRun)。SW 端的实现可以保持原样。
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js')
      navigator.serviceWorker.ready.then(() => {
        console.log('Pyodide Stdin Proxy Service Worker Ready')
      })
    } catch (err) {
      console.error('Service Worker 注册失败,无法支持 input():', err)
    }
  }

  const defaultCode = getCodeFromSlots();

  // 1. 初始化 CodeMirror
  editorView = new EditorView({
    parent: editorContainer.value,
    state: EditorState.create({
      doc: defaultCode,
      extensions: [
        basicSetup, // 自带 history() + historyKeymap (Ctrl+Z / Ctrl+Y 已就绪)
        python(),

        // === 无障碍 Tab 处理 + 补全优先 ===
        // CodeMirror 6 默认让 Tab 移动焦点(键盘用户能离开编辑器),但代价
        // 是无法用 Tab 插入缩进。常见两难。这里采用 Monaco 同款 a11y 模式:
        //   - 当补全菜单弹出时,Tab 接受当前补全候选(优先于缩进,避免冲突)
        //   - 否则 Tab 插入缩进
        //   - Escape 主动让编辑器失焦,这样紧接着按 Tab 就能离开,不会被困
        // 这也是 WCAG 2.1.2 (No Keyboard Trap) 的合规解法。
        //
        // 关键: 这条 keymap 在 basicSetup 内置的 completionKeymap 之前注册
        // (extension 数组里在它后面 = 优先级更高),所以这里必须自己处理
        // 补全场景,不能指望事件"穿透"到后面的 keymap。
        keymap.of([
          {
            key: 'Tab',
            run: (view) => {
              // completionStatus 返回 'active' / 'pending' / null。
              // 'active' 表示菜单已显示且有候选项 —— 这时 Tab 应接受补全。
              if (completionStatus(view.state) === 'active') {
                return acceptCompletion(view);
              }
              // 没有可接受的补全 —— 走原本的缩进逻辑
              return indentWithTab.run(view);
            },
            // Shift+Tab 仍然走 indentWithTab 的反向缩进(它内部已处理 shift)
            shift: indentWithTab.shift,
            preventDefault: true,
          },
          {
            key: 'Escape',
            run: (view) => {
              view.contentDOM.blur()
              return true
            },
          },
        ]),
        indentUnit.of('    '), // Python 缩进:4 个空格

        // === 撤销 / 重做 ===
        // basicSetup 已含 historyKeymap (Ctrl+Z=undo, Ctrl+Y=redo, Mac 上
        // Cmd+Shift+Z=redo)。下面这一行额外保证非 Mac 平台也能用
        // Ctrl+Shift+Z 重做,跨平台一致。
        keymap.of([
          { key: 'Mod-Shift-z', run: redo, preventDefault: true },
        ]),

        // 修复 VitePress 的 .vp-doc li + li { margin-top: 8px } 入侵了
        // CodeMirror 补全下拉列表里的 <li> 元素导致候选项之间出现难看的间距。
        // EditorView.theme() 生成带随机前缀的 scoped class 并挂到编辑器根节点,
        // 选择器优先级高于 .vp-doc 的规则,把 margin 重置为 0。
        EditorView.theme({
          '.cm-tooltip-autocomplete li + li': { marginTop: '0 !important' },
        }),

        // 让外层无障碍工具知道这是一个代码编辑区
        EditorView.contentAttributes.of({
          'aria-label': 'Python code editor. Press Escape to leave the editor.',
        }),

        themeCompartment.of(checkDarkMode() ? githubDark : githubLight),
      ],
    }),
  })

  // 2. 监听 VitePress 深浅色切换
  themeObserver = new MutationObserver(() => {
    editorView.dispatch({
      effects: themeCompartment.reconfigure(checkDarkMode() ? githubDark : githubLight)
    })
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

  // 3. 预热环境 —— await 完成后立即同步 UI,不再依赖 watch 兜底
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
  // 卸载组件时如果还有任务在跑,不主动 cancel —— 否则会影响其他组件
})

// === 输出辅助函数 ===
const appendOutput = (text, type = 'info') => {
  outputLines.value.push({ id: Date.now() + Math.random(), text, type })
  nextTick(() => {
    if (outputEl.value) outputEl.value.scrollTop = outputEl.value.scrollHeight
  })
}

const clearOutput = () => { outputLines.value = [] }

// === 执行逻辑 ===
const handleRun = async () => {
  if (status.value === 'running' || status.value === 'initializing') return
  const code = editorView.state.doc.toString().trim()
  if (!code) return

  status.value = 'running'
  statusText.value = '排队执行中...'
  runStartTime = performance.now()

  try {
    currentRunId = await run(code, {
      stdout: (text) => appendOutput(text, 'stdout'),
      stderr: (text) => appendOutput(text, 'stderr'),
      // 只有"自己的"那次运行触发 input() 时,本组件才会进入等待输入状态。
      // 这条回调是由 worker.onmessage 按 runId 路由进来的,从根上避免了
      // "页面上多个 PythonRunner 同时显示输入框"的 bug。
      onInputRequest: () => {
        isWaitingInput.value = true
        nextTick(() => inlineInputEl.value?.focus())
      },
      finish: (ok, val, err) => {
        // 如果是被 cancel 触发的牵连任务,currentRunId 已被置 null,跳过 UI 切换
        if (currentRunId === null) return

        const elapsed = ((performance.now() - runStartTime) / 1000).toFixed(3)
        if (ok) {
          if (val !== null) appendOutput(`=> ${val}\n`, 'result')
          appendOutput(`[执行完成 用时 ${elapsed}s]\n\n`, 'meta')
        } else {
          appendOutput(`\n${err}\n`, 'error')
          appendOutput(`[执行异常 用时 ${elapsed}s]\n\n`, 'error')
        }
        currentRunId = null
        // 任务结束,无论是否还在等待输入都关掉(异常退出可能直接跳过 submitInput)
        isWaitingInput.value = false
        userInputText.value = ''
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

  const runIdToCancel = currentRunId
  currentRunId = null   // 先清空,防止 finish 回调触发时还以为是正常结束

  appendOutput('\n⛔ 已中断当前任务,正在重启 Python 环境...\n', 'error')

  // 触发 hardReset: terminate worker → 清状态 → 重新 init
  cancel(runIdToCancel)

  // UI 立刻进入 initializing,watch(isReady) 会在重启完成后自动切到 ready
  status.value = 'initializing'
  statusText.value = '环境重启中...'

  isWaitingInput.value = false
  userInputText.value = ''
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

/* 工作区结构 */
.workspace {
  display: flex;
  flex-direction: column;
}

/* 核心设定:编辑器固定高度,CM6 充满容器 */
.editor-pane {
  height: 300px;
  border-bottom: 1px solid var(--vp-c-divider);
  background-color: var(--vp-c-bg);
}

/* 穿透修改 CodeMirror 6 内部样式 */
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
}

.log-line { color: var(--vp-c-text-1); }
.log-line.stderr, .log-line.error { color: var(--vp-c-danger-1); }
.log-line.result { color: var(--vp-c-brand-1); font-weight: bold; }
.log-line.meta { color: var(--vp-c-text-3); font-style: italic; }
.log-line.success { color: var(--vp-c-success-1); }

.output-content::-webkit-scrollbar { width: 8px; }
.output-content::-webkit-scrollbar-track { background: transparent; }
.output-content::-webkit-scrollbar-thumb {
  background-color: var(--vp-c-divider);
  border-radius: 4px;
}
.output-content::-webkit-scrollbar-thumb:hover { background-color: var(--vp-c-text-3); }

/*
  内联终端输入:看起来像光标接在最后一行 stdout 后面继续打字。
  - 无边框、无背景,字体/字号/行高完全继承 .output-content,做到视觉无缝
  - caret-color 用主题色,有"活的终端"感
  - 仅在 isWaitingInput 时才渲染,所以不需要额外的隐藏样式
*/
.inline-stdin {
  border: none;
  outline: none;
  background: transparent;
  padding: 0;
  margin: 0;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  color: var(--vp-c-text-1);
  caret-color: var(--vp-c-brand-1);
  /* 避免和上一段 stdout 之间出现意外的空白 */
  vertical-align: baseline;
  /* 至少占一点宽度,空状态下也能让用户看到光标 */
  min-width: 4px;
}
.inline-stdin:focus {
  /* 用一个轻微的下划线提示用户"这里在等输入",不打破终端美学 */
  box-shadow: inset 0 -1px 0 0 var(--vp-c-brand-1);
}
</style>