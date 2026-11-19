window.__ModuleLoader__.load({ id: 'dsh-codex-responses', factory: require => {
  const { createElement: element, useEffect, useRef, useState, useSyncExternalStore } = require('react')
  const { z } = require('zod')
  const packageName = 'dsh-codex-responses'
  const namespace = 'codexResponses'
  const deviceURL = 'https://auth.openai.com/codex/device'
  const statusSchema = z.strictObject({ type: z.literal('status'), status: z.enum(['signed-in', 'signed-out', 'relogin-required']),
    catalog: z.strictObject({ source: z.enum(['upstream', 'cached', 'bundled', 'unavailable']), count: z.number().int().nonnegative() }).optional() })
  const deviceSchema = z.strictObject({ type: z.literal('device'), url: z.literal(deviceURL), code: z.string() })
  const loginSchema = z.discriminatedUnion('type', [statusSchema, deviceSchema])
  const position = z.strictObject({ x: z.number().min(0).max(100_000), y: z.number().min(0).max(100_000) }).nullable()
  const preferences = z.strictObject({ enabled: z.boolean(), position })
  const sessionIdSchema = z.string().min(1).max(160).nullable()
  const counter = z.number().int().nonnegative()
  const summary = z.strictObject({ usd: z.number().nonnegative(), priced: counter, unpriced: counter, awaitingRates: counter })
  const estimate = z.strictObject({ sessionId: sessionIdSchema, current: summary.nullable(), total: summary,
    currentUnavailable: z.boolean(), unreadableSessions: counter, ratesSyncedAt: counter.nullable() })
  const codec = (name, schema) => ({ mode: 'strict', typeSymbol: `${packageName}#${name}`, create: () => schema })
  const parameter = (name, type, schema) => {
    const value = codec(type, schema)
    return { name, wire: name, source: 'json', codec: value, strictCodec: value }
  }
  const descriptor = (method, result, parameters = [], stream = false) => ({
    id: `${packageName}#${namespace}/${method}`, namespace, method, service: namespace,
    invocation: { kind: 'direct' }, parameters, result,
    ...(stream ? { mode: 'stream', cancellation: { parameter: 'signal' } } : {}),
  })
  const contribution = { package: packageName, descriptors: [
    descriptor('status', codec('Status', statusSchema)),
    descriptor('signOut', codec('Status', statusSchema)),
    descriptor('login', codec('LoginFrame', loginSchema), [], true),
    descriptor('estimatorPreferences', codec('EstimatorPreferences', preferences)),
    descriptor('setEstimatorPreferences', codec('EstimatorPreferences', preferences),
      [parameter('patch', 'EstimatorPreferencePatch', preferences.partial())]),
    descriptor('estimate', codec('CostEstimate', estimate), [parameter('sessionId', 'EstimateSessionId', sessionIdSchema)], true),
  ] }
  const labels = { 'signed-in': '已登录', 'signed-out': '未登录', 'relogin-required': '需要重新登录' }
  const catalogLabels = { upstream: 'Codex 在线目录', cached: '上次成功的 Codex 目录', bundled: '内置备用目录', unavailable: '在线目录不可用' }
  const loginErrors = {
    'codex-responses/device-failed': '未能获取设备码。请检查网络和 ChatGPT 的设备码登录设置。',
    'codex-responses/poll-failed': '未能确认设备授权。请检查浏览器是否完成授权，或重新生成设备码。',
    'codex-responses/exchange-failed': '浏览器已授权，但 OpenAI 拒绝兑换凭据。请重新生成设备码再试。',
    'codex-responses/token-failed': '浏览器已授权，但 OpenAI 返回的凭据无法使用。',
  }
  const progressLabels = {
    read: '正在读取状态…', login: '正在获取设备码…', confirm: '正在读取模型目录…',
    cancel: '正在取消授权…', signOut: '正在退出登录…',
  }
  const styles = `
    .dsh-codex-settings {
      --codex-text: var(--dsw-alias-label-primary, CanvasText);
      --codex-muted: var(--dsw-alias-label-secondary, GrayText);
      --codex-border: var(--dsw-alias-settings-card-stroke, ButtonBorder);
      --codex-fill: var(--dsw-alias-settings-card-fill, Canvas);
      --codex-surface: var(--dsw-alias-button-tool-bar-fill, ButtonFace);
      --codex-hover: var(--dsw-alias-button-tool-bar-hover, ButtonFace);
      margin-block: 16px;
      color: var(--codex-text);
      font-size: 14px;
      line-height: 1.5;
    }
    .dsh-codex-settings .codex-card {
      border: 1px solid var(--codex-border);
      border-radius: var(--dsw-radius-panel, 14px);
      background: var(--codex-fill);
    }
    .dsh-codex-settings .codex-head, .dsh-codex-settings .codex-catalog,
    .dsh-codex-settings .codex-actions, .dsh-codex-settings .codex-device {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px 16px;
      padding: 14px 18px;
      margin: 0;
    }
    .dsh-codex-settings .codex-head { align-items: flex-start; padding-block: 18px; }
    .dsh-codex-settings .codex-intro { flex: 1 1 230px; min-width: 0; }
    .dsh-codex-settings h3 { font-size: 16px; font-weight: 650; line-height: 1.4; margin: 0; }
    .dsh-codex-settings p { margin: 0; }
    .dsh-codex-settings .codex-description { margin-top: 4px; color: var(--codex-muted); font-size: 13px; }
    .dsh-codex-settings .codex-status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--codex-surface);
      font-size: 12px;
      font-weight: 550;
    }
    .dsh-codex-settings .codex-status::before {
      content: '';
      inline-size: 7px;
      block-size: 7px;
      border-radius: 50%;
      background: var(--codex-muted);
    }
    .dsh-codex-settings .codex-status[data-tone='connected']::before { background: var(--dsw-alias-state-success-primary, #188254); }
    .dsh-codex-settings .codex-status[data-tone='attention']::before { background: var(--dsw-alias-state-error-primary, #b54a42); }
    .dsh-codex-settings .codex-catalog, .dsh-codex-settings .codex-actions,
    .dsh-codex-settings .codex-device { border-top: 1px solid var(--codex-border); }
    .dsh-codex-settings .codex-catalog dt, .dsh-codex-settings .codex-device-title { font-weight: 600; }
    .dsh-codex-settings .codex-catalog dd {
      flex: 1 1 170px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 4px 12px;
      margin: 0;
      color: var(--codex-muted);
    }
    .dsh-codex-settings .codex-count { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .dsh-codex-settings .codex-actions { justify-content: flex-end; gap: 8px; }
    .dsh-codex-settings .codex-actions:empty { display: none; }
    .dsh-codex-settings .codex-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      max-width: 100%;
      min-height: 34px;
      box-sizing: border-box;
      padding: 6px 12px;
      border: 1px solid var(--codex-border);
      border-radius: var(--dsw-radius-md, 8px);
      background: transparent;
      color: var(--codex-text);
      font: inherit;
      font-size: 13px;
      font-weight: 550;
      text-decoration: none;
      cursor: pointer;
    }
    .dsh-codex-settings .codex-button:hover:not(:disabled) { background: var(--codex-hover); }
    .dsh-codex-settings .codex-button:focus-visible { outline: 2px solid var(--dsw-alias-link, Highlight); outline-offset: 2px; }
    .dsh-codex-settings .codex-button:disabled { opacity: .55; cursor: default; }
    .dsh-codex-settings .codex-button.codex-primary {
      border-color: transparent;
      background: var(--dsw-alias-button-primary-fill, CanvasText);
      color: var(--dsw-alias-label-primary-inverted, Canvas);
    }
    .dsh-codex-settings .codex-button.codex-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, CanvasText); }
    .dsh-codex-settings .codex-device { display: grid; grid-template-columns: minmax(0, 1fr); }
    .dsh-codex-settings .codex-feedback:empty { position: absolute; }
    .dsh-codex-settings .codex-code-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px 14px;
      padding: 10px 12px;
      border-radius: var(--dsw-radius-md, 8px);
      background: var(--codex-surface);
    }
    .dsh-codex-settings code {
      font: 600 18px/1.4 var(--ds-font-family-code, monospace);
      letter-spacing: .08em;
      overflow-wrap: anywhere;
      user-select: all;
    }
    .dsh-codex-settings .codex-alert {
      margin: 0 18px 14px;
      padding: 9px 12px;
      border-inline-start: 2px solid var(--dsw-alias-state-error-primary, #b54a42);
      background: var(--codex-surface);
      font-size: 13px;
    }
    .dsh-codex-settings .codex-estimator-settings { margin-top: 14px; }
    .dsh-codex-settings .codex-toggle { display: flex; align-items: center; gap: 10px; }
    .dsh-codex-settings .codex-toggle input { inline-size: 18px; block-size: 18px; }
    .dsh-codex-settings .codex-estimator-reset { margin: 0 18px 14px; }
  `
  const button = (text, action, { disabled = false, primary = false } = {}) => element('button', {
    type: 'button', className: primary ? 'codex-button codex-primary' : 'codex-button', onClick: action, disabled,
  }, text)

  const estimatorStyles = `
    .dsh-codex-estimate {
      position: fixed;
      top: 78px;
      right: 24px;
      width: min(258px, calc(100vw - 16px));
      max-height: calc(100vh - 16px);
      box-sizing: border-box;
      overflow: auto;
      color: var(--dsw-alias-label-primary, CanvasText);
      background: var(--dsw-alias-settings-card-fill, Canvas);
      border: 1px solid var(--dsw-alias-settings-card-stroke, ButtonBorder);
      border-radius: 15px;
      box-shadow: 0 6px 24px #0002;
      pointer-events: auto;
      font-size: 13px;
      line-height: 1.45;
      font-variant-numeric: tabular-nums;
      --codex-est-muted: var(--dsw-alias-label-secondary, GrayText);
    }
    .dsh-codex-estimate[data-collapsed] { width: min(220px, calc(100vw - 16px)); }
    .dsh-codex-estimate .codex-est-header {
      display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 7px;
      background: color-mix(in srgb, var(--dsw-alias-link, Highlight) 8%, transparent);
    }
    .dsh-codex-estimate .codex-est-drag {
      flex: 1; display: flex; align-items: center; gap: 7px; padding: 5px 6px;
      cursor: grab; touch-action: none; user-select: none; font-weight: 620;
    }
    .dsh-codex-estimate .codex-est-drag:active { cursor: grabbing; }
    .dsh-codex-estimate .codex-est-grip { color: var(--codex-est-muted); }
    .dsh-codex-estimate button {
      min-height: 26px; min-width: 28px; background: transparent; border: 0; color: inherit;
      border-radius: 7px; font: inherit; cursor: pointer;
    }
    .dsh-codex-estimate button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
    .dsh-codex-estimate :focus-visible { outline: 2px solid var(--dsw-alias-link, Highlight); outline-offset: -2px; }
    .dsh-codex-estimate dl { display: grid; gap: 6px; margin: 10px 12px; }
    .dsh-codex-estimate .codex-est-row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 8px; }
    .dsh-codex-estimate dt, .dsh-codex-estimate dd, .dsh-codex-estimate p { margin: 0; }
    .dsh-codex-estimate dd { font-weight: 620; }
    .dsh-codex-estimate .codex-est-note { margin: 0 12px 10px; color: var(--codex-est-muted); font-size: 11px; }
  `

  function createEstimatorClient(remote) {
    let view = { preferences: null, sessionId: null, busy: false, failed: false }
    let binding
    const listeners = new Set()
    function update(partial) {
      view = { ...view, ...partial }
      for (const listener of listeners) listener()
    }
    return {
      get: () => view,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      async load() {
        if (view.preferences || view.busy) return
        update({ busy: true, failed: false })
        try {
          const result = await remote.estimatorPreferences()
          if (!result.ok) throw new Error()
          update({ preferences: result.value, busy: false })
        } catch { update({ busy: false, failed: true }) }
      },
      async save(patch) {
        if (!view.preferences || view.busy) return
        const previous = view.preferences
        // Start a newly enabled stream only after the Host has saved its preference.
        update({ preferences: { ...previous, ...patch, enabled: patch.enabled === false ? false : previous.enabled },
          busy: true, failed: false })
        try {
          const result = await remote.setEstimatorPreferences(patch)
          if (!result.ok) throw new Error()
          update({ preferences: result.value, busy: false })
        } catch { update({ preferences: previous, busy: false, failed: true }) }
      },
      bindSession(sessionId) {
        const selection = {}
        const id = typeof sessionId === 'string' ? sessionId : null
        binding = selection
        if (view.sessionId !== id) update({ sessionId: id })
        return () => {
          if (binding === selection) { binding = undefined; update({ sessionId: null }) }
        }
      },
      estimate: (sessionId, signal) => remote.estimate(sessionId, signal),
    }
  }

  function CostSettings({ cost }) {
    const { preferences: prefs, busy, failed } = useSyncExternalStore(cost.subscribe, cost.get)
    useEffect(() => { void cost.load() }, [cost])
    return element('div', { className: 'codex-card codex-estimator-settings' },
      element('div', { className: 'codex-head' },
        element('div', { className: 'codex-intro' },
          element('label', { className: 'codex-toggle' },
            element('input', { type: 'checkbox', role: 'switch', checked: prefs?.enabled === true,
              disabled: !prefs || busy, onChange: event => { void cost.save({ enabled: event.target.checked }) } }),
            element('strong', null, 'API 标价估算'),
          ),
          element('p', { className: 'codex-description' }, '在 DSH 内显示可拖动的会话用量估算窗。'),
        ),
      ),
      failed ? element('p', { className: 'codex-alert', role: 'alert' }, '无法更新估算器设置。') : null,
      failed && !prefs ? element('div', { className: 'codex-estimator-reset' }, button('重试', cost.load)) : null,
      prefs?.position ? element('div', { className: 'codex-estimator-reset' },
        button('重置悬浮窗位置', () => cost.save({ position: null }), { disabled: busy })) : null,
    )
  }

  function CostSessionBinding({ sessionId, cost }) {
    useEffect(() => cost.bindSession(sessionId), [cost, sessionId])
    return null
  }

  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })
  function displayAmount(sample, incomplete = false) {
    if (!sample) return '—'
    if (!incomplete && sample.priced === 0 && sample.awaitingRates > 0 && sample.awaitingRates === sample.unpriced) return '暂无可用标价'
    if (sample.priced === 0 && (sample.unpriced || incomplete)) return '暂无可估算金额'
    if (sample.priced === 0) return '暂无用量'
    return sample.usd > 0 && sample.usd < .0001 ? '<$0.0001' : money.format(sample.usd)
  }

  function CostOverlay({ cost }) {
    const { preferences: prefs, sessionId, busy } = useSyncExternalStore(cost.subscribe, cost.get)
    const enabled = prefs?.enabled === true
    const [value, setValue] = useState()
    const [error, setError] = useState(false)
    const [collapsed, setCollapsed] = useState(false)
    const [preview, setPreview] = useState()
    const [bounds, setBounds] = useState()
    const frame = useRef(null)
    const drag = useRef(null)

    useEffect(() => { void cost.load() }, [cost])
    useEffect(() => {
      if (!enabled) { setValue(undefined); return }
      const controller = new AbortController()
      let retry
      async function follow() {
        setError(false)
        try {
          for await (const snapshot of cost.estimate(sessionId, controller.signal)) {
            if (controller.signal.aborted) return
            if (snapshot.sessionId === sessionId) setValue(snapshot)
          }
        } catch {
          if (!controller.signal.aborted) {
            setError(true)
            retry = setTimeout(follow, 3000)
          }
        }
      }
      void follow()
      return () => { controller.abort(); clearTimeout(retry) }
    }, [cost, enabled, sessionId])

    useEffect(() => {
      if (!enabled) return
      const measure = () => {
        const rect = frame.current?.getBoundingClientRect()
        if (rect) setBounds({ x: Math.max(8, window.innerWidth - rect.width - 8),
          y: Math.max(8, window.innerHeight - rect.height - 8) })
      }
      const observer = new ResizeObserver(measure)
      if (frame.current) observer.observe(frame.current)
      window.addEventListener('resize', measure)
      measure()
      return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
    }, [enabled])

    if (!enabled) return null
    const clamp = point => ({ x: Math.min(bounds?.x ?? window.innerWidth - 16, Math.max(8, point.x)),
      y: Math.min(bounds?.y ?? window.innerHeight - 16, Math.max(8, point.y)) })
    const point = preview ?? prefs.position
    const located = point ? clamp(point) : undefined
    const startDrag = event => {
      if (event.button !== 0 || drag.current || busy) return
      const rect = frame.current.getBoundingClientRect()
      drag.current = { id: event.pointerId, left: event.clientX - rect.left, top: event.clientY - rect.top }
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const move = event => {
      const handle = drag.current
      if (handle?.id !== event.pointerId) return
      handle.position = clamp({ x: event.clientX - handle.left, y: event.clientY - handle.top })
      setPreview(handle.position)
    }
    const finishDrag = (event, commit) => {
      const handle = drag.current
      if (handle?.id !== event.pointerId) return
      drag.current = null
      if (commit && handle.position) void cost.save({ position: handle.position })
      setPreview(undefined)
    }
    const moveByKey = event => {
      const step = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key]
      if (!step || busy) return
      event.preventDefault()
      const { left, top } = frame.current.getBoundingClientRect()
      void cost.save({ position: clamp({ x: left + step[0], y: top + step[1] }) })
    }

    const current = value?.sessionId === sessionId ? value.current : null
    const currentText = value?.sessionId === sessionId && value.currentUnavailable ? '用量暂不可读' : displayAmount(current)
    const totalText = displayAmount(value?.total, value?.unreadableSessions > 0)
    const note = error ? '暂时无法读取用量，正在重试。' : !value ? '正在读取会话用量…'
      : [value.total.priced > 0 ? `${value.total.priced} 笔已计价` : '',
        value.total.priced > 0 && (value.total.unpriced > 0 || value.unreadableSessions > 0) ? '全部累计为已计价小计' : '',
        value.total.unpriced > 0 ? `${value.total.unpriced} 笔未计价` : '',
        value.unreadableSessions > 0 ? `${value.unreadableSessions} 个会话暂不可读` : '',
        Number.isFinite(value.ratesSyncedAt) ? `费率同步于 ${new Date(value.ratesSyncedAt).toLocaleDateString()}` : '',
      ].filter(Boolean).join(' · ')

    return element('aside', { className: 'dsh-codex-estimate', ref: frame, 'aria-label': 'ChatGPT Codex API 标价估算',
      'data-collapsed': collapsed || undefined, style: located ? { left: located.x, top: located.y, right: 'auto' } : undefined },
    element('style', null, estimatorStyles),
    element('header', { className: 'codex-est-header' },
      element('div', { className: 'codex-est-drag', tabIndex: 0, 'aria-label': '移动估算窗，可使用方向键',
        onKeyDown: moveByKey, onPointerDown: startDrag, onPointerMove: move, onPointerUp: e => finishDrag(e, true),
        onPointerCancel: e => finishDrag(e, false), onLostPointerCapture: e => finishDrag(e, false) },
      element('span', { className: 'codex-est-grip', 'aria-hidden': 'true' }, '⠿'),
      collapsed ? `当前会话 ${currentText}` : 'API 标价估算'),
      element('button', { type: 'button', 'aria-label': collapsed ? '展开估算窗' : '折叠估算窗',
        'aria-expanded': !collapsed, onClick: () => setCollapsed(!collapsed) }, collapsed ? '+' : '−'),
    ),
    collapsed ? null : element('dl', null,
      element('div', { className: 'codex-est-row' },
        element('dt', null, current?.priced && current.unpriced ? '当前会话（小计）' : '当前会话'), element('dd', null, currentText)),
      element('div', { className: 'codex-est-row' }, element('dt', null, '全部累计'), element('dd', null, totalText)),
    ),
    !collapsed && note ? element('p', { className: 'codex-est-note', role: 'status' }, note) : null)
  }

  function CodexPanel({ api, cost }) {
    const [status, setStatus] = useState()
    const [catalog, setCatalog] = useState()
    const [device, setDevice] = useState()
    const [operation, setOperation] = useState('read')
    const [copyFeedback, setCopyFeedback] = useState('')
    const [error, setError] = useState('')
    const mounted = useRef(false)
    const active = useRef()

    const update = frame => {
      if (frame?.type === 'status' && Object.hasOwn(labels, frame.status)) {
        setStatus(frame.status)
        setCatalog(frame.catalog)
      }
    }
    const read = async () => {
      try {
        const result = await api.status()
        if (!result.ok) {
          const code = result.error?.code
          const suffix = typeof code === 'string' && /^[a-z][a-z-]*\/[a-z][a-z-]*$/.test(code) ? `（${code}）` : ''
          if (mounted.current) setError(`无法读取登录状态。请检查插件是否已在 Host 启用。${suffix}`)
          return
        }
        if (mounted.current) setError('')
        if (mounted.current) update(result.value)
      } catch {
        if (mounted.current) setError('无法读取登录状态。请检查插件是否已在 Host 启用。')
      }
    }
    const refreshStatus = async () => {
      setOperation('read')
      setError('')
      await read()
      if (mounted.current) setOperation(undefined)
    }
    useEffect(() => {
      mounted.current = true
      void refreshStatus()
      return () => { mounted.current = false; active.current?.abort() }
    }, [api])

    const login = async () => {
      if (operation || active.current) return
      const controller = new AbortController()
      active.current = controller
      setOperation('login')
      setError('')
      setDevice(undefined)
      setCopyFeedback('')
      try {
        for await (const frame of api.login(controller.signal)) {
          if (controller.signal.aborted || !mounted.current) break
          if (frame.type === 'device' && frame.url === deviceURL && /^[A-Z0-9-]{4,32}$/u.test(frame.code)) setDevice(frame)
          else if (frame.type === 'status') {
            setDevice(undefined)
            setOperation('confirm')
            update(frame)
          }
        }
        if (mounted.current) await read()
      } catch (failure) {
        if (mounted.current && !controller.signal.aborted) {
          const code = failure?.code ?? failure?.error?.code
          setError(Object.hasOwn(loginErrors, code) ? loginErrors[code] : '设备码登录未完成。请确认 ChatGPT 允许 Codex 设备码登录，再重试。')
        }
      } finally {
        active.current = undefined
        if (mounted.current) { setDevice(undefined); setOperation(undefined) }
      }
    }

    const cancelLogin = () => {
      active.current?.abort()
      setOperation('cancel')
      setDevice(undefined)
    }

    const copyDeviceCode = async () => {
      const attempt = active.current
      if (!device || !attempt || attempt.signal.aborted) return
      let feedback
      try {
        await navigator.clipboard.writeText(device.code)
        feedback = '设备码已复制。'
      } catch {
        feedback = '复制失败，请手动选择设备码。'
      }
      if (mounted.current && active.current === attempt && !attempt.signal.aborted) setCopyFeedback(feedback)
    }

    const signOut = async () => {
      if (operation) return
      setOperation('signOut')
      setError('')
      try {
        const result = await api.signOut()
        if (!result.ok) throw new Error()
        if (mounted.current) update(result.value)
      } catch {
        if (mounted.current) setError('退出失败。请稍后重试。')
      } finally {
        if (mounted.current) setOperation(undefined)
      }
    }

    const signedIn = status === 'signed-in'
    const busy = Boolean(operation)
    const statusText = device ? '等待浏览器授权' : progressLabels[operation] ?? labels[status] ?? '状态未知'
    const tone = busy ? undefined : signedIn ? 'connected' : error || status === 'relogin-required' ? 'attention' : undefined

    return element('section', { className: 'dsh-codex-settings', 'aria-label': 'ChatGPT Codex 连接设置' },
      element('style', null, styles),
      element('div', { className: 'codex-card' },
        element('header', { className: 'codex-head' },
          element('div', { className: 'codex-intro' },
            element('h3', null, 'ChatGPT Codex'),
            element('p', { className: 'codex-description' }, signedIn
              ? '在会话的模型选择器中选择「ChatGPT Codex」分组。' : '用 ChatGPT 订阅连接 Codex 模型。'),
          ),
          element('span', { className: 'codex-status', role: 'status', 'data-tone': tone }, statusText),
        ),
        signedIn && catalog && Object.hasOwn(catalogLabels, catalog.source) ? element('dl', { className: 'codex-catalog' },
          element('dt', null, '模型目录'),
          element('dd', null,
            element('span', null, catalogLabels[catalog.source]),
            catalog.source === 'unavailable' ? null : element('span', { className: 'codex-count' }, `${catalog.count} 个模型`),
          ),
        ) : null,
        device ? element('div', { className: 'codex-device' },
          element('div', null,
            element('p', { className: 'codex-device-title' }, '一次性设备码'),
            element('p', { className: 'codex-description' }, '在浏览器输入设备码，只确认自己发起的授权。'),
          ),
          element('div', { className: 'codex-code-row' },
            element('code', null, device.code),
            button('复制设备码', copyDeviceCode),
          ),
          element('span', { className: 'codex-description codex-feedback', role: 'status' }, copyFeedback),
        ) : null,
        error ? element('p', { className: 'codex-alert', role: 'alert' }, error) : null,
        element('div', { className: 'codex-actions' },
          device ? element('a', { className: 'codex-button codex-primary', href: deviceURL,
            target: '_blank', rel: 'noopener noreferrer' }, '打开 OpenAI 验证页面') : null,
          operation === 'login' ? button('取消设备码登录', cancelLogin) : null,
          status && operation !== 'login' && operation !== 'cancel' ? button(
            signedIn || status === 'relogin-required' ? '重新登录' : '使用设备码登录', login, { disabled: busy, primary: !signedIn },
          ) : null,
          status && status !== 'signed-out' && operation !== 'login' && operation !== 'cancel'
            ? button('退出登录', signOut, { disabled: busy }) : null,
          !status && !busy ? button('重试', refreshStatus, { primary: true }) : null,
        ),
      ),
      cost ? element(CostSettings, { cost }) : null,
    )
  }

  return { name: 'codex-responses-client', inject: ['remote', 'remoteAccess', 'slots'], async apply(ctx) {
    if (!ctx.remote.$host.isLoopback) return
    await ctx.remote.$mount(contribution)
    ctx.inject(['remote.codexResponses'], remoteCtx => {
      const api = {
        status: () => remoteCtx.remote.codexResponses.status(),
        login: signal => remoteCtx.remote.codexResponses.login(signal),
        signOut: () => remoteCtx.remote.codexResponses.signOut(),
      }
      const cost = createEstimatorClient(remoteCtx.remote.codexResponses)
      remoteCtx.remoteAccess.whenAccess('codexResponses/status', () => {
        const disposers = [
          remoteCtx.slots.inject('settings.section', () => remoteCtx.slots.register({
            name: 'settings.section', id: 'codex-responses', order: 30, label: 'ChatGPT Codex',
            inject: () => ({ api, cost }),
          }, CodexPanel)),
          remoteCtx.slots.inject('shell.overlay', () => remoteCtx.slots.register({
            name: 'shell.overlay', id: 'codex-api-cost', inject: () => ({ cost }),
          }, CostOverlay)),
          remoteCtx.slots.inject('conversation.session.header.utilities', () => remoteCtx.slots.register({
            name: 'conversation.session.header.utilities', id: 'codex-cost-session', inject: () => ({ cost }),
          }, CostSessionBinding)),
        ]
        return () => { for (const dispose of disposers) dispose?.() }
      })
    })
  } }
} })
