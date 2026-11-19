window.__ModuleLoader__.load({ id: 'dsh-codex-responses', factory: require => {
  const { createElement: element, useEffect, useRef, useState, useSyncExternalStore } = require('react')
  const { z } = require('zod')
  const packageName = 'dsh-codex-responses'
  const namespace = 'codexResponses'
  const deviceURL = 'https://auth.openai.com/codex/device'
  const authStatus = z.enum(['signed-in', 'signed-out', 'relogin-required'])
  const statusSchema = z.strictObject({ type: z.literal('status'), status: authStatus,
    catalog: z.strictObject({ source: z.enum(['upstream', 'cached', 'bundled', 'unavailable']), count: z.number().int().nonnegative() }).optional() })
  const deviceSchema = z.strictObject({ type: z.literal('device'), url: z.literal(deviceURL), code: z.string() })
  const loginSchema = z.discriminatedUnion('type', [statusSchema, deviceSchema])
  const position = z.strictObject({ x: z.number().min(0).max(100_000), y: z.number().min(0).max(100_000) }).nullable()
  const items = z.strictObject({ apiCost: z.boolean(), account: z.boolean(), quota: z.boolean() })
  const preferences = z.strictObject({ enabled: z.boolean(), position, items })
  const preferencePatch = preferences.partial().extend({ items: items.partial().optional() })
  const sessionIdSchema = z.string().min(1).max(160).nullable()
  const counter = z.number().int().nonnegative()
  const summary = z.strictObject({ usd: z.number().nonnegative(), priced: counter, unpriced: counter, awaitingRates: counter })
  const estimate = z.strictObject({ sessionId: sessionIdSchema, current: summary.nullable(), total: summary,
    currentUnavailable: z.boolean(), unreadableSessions: counter, ratesSyncedAt: counter.nullable() })
  const subscriptionItem = z.enum(['account', 'quota'])
  const subscriptionSurface = z.enum(['floating', 'settings'])
  const quotaWindow = z.strictObject({ remaining: z.number().min(0).max(100),
    durationSeconds: z.number().int().positive(), resetsAt: counter.nullable() })
  const subscription = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('account'), status: authStatus, email: z.string().max(254).nullable(), plan: z.string().max(64).nullable() }),
    z.strictObject({ kind: z.literal('quota'), status: z.enum(['signed-out', 'relogin-required', 'ready', 'stale', 'unavailable']),
      updatedAt: counter.nullable(), windows: z.array(quotaWindow).max(2) }),
  ])
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
    descriptor('floatingPreferences', codec('FloatingPreferences', preferences)),
    descriptor('setFloatingPreferences', codec('FloatingPreferences', preferences),
      [parameter('patch', 'FloatingPreferencePatch', preferencePatch)]),
    descriptor('estimate', codec('CostEstimate', estimate), [parameter('sessionId', 'EstimateSessionId', sessionIdSchema)], true),
    descriptor('subscription', codec('SubscriptionFrame', subscription), [
      parameter('kind', 'SubscriptionItem', subscriptionItem),
      parameter('surface', 'SubscriptionSurface', subscriptionSurface),
    ], true),
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
    .dsh-codex-settings .codex-floating-settings { margin-top: 14px; }
    .dsh-codex-settings .codex-toggle { display: flex; align-items: center; gap: 10px; }
    .dsh-codex-settings .codex-toggle input { inline-size: 18px; block-size: 18px; margin: 0; }
    @media (forced-colors: none) {
      .dsh-codex-settings .codex-toggle input[role='switch'] {
        appearance: none; position: relative; inline-size: 34px; block-size: 18px; flex: none;
        background: var(--codex-surface); border: 1px solid var(--codex-border);
        border-radius: 999px; cursor: pointer;
      }
      .dsh-codex-settings .codex-toggle input[role='switch']::before {
        content: ''; position: absolute; inset-block-start: 2px; inset-inline-start: 2px;
        inline-size: 12px; block-size: 12px; border-radius: 50%; background: var(--codex-muted);
      }
      .dsh-codex-settings .codex-toggle input[role='switch']:checked {
        border-color: transparent; background: var(--dsw-alias-button-primary-fill, CanvasText);
      }
      .dsh-codex-settings .codex-toggle input[role='switch']:checked::before {
        inset-inline-start: 18px; background: var(--dsw-alias-label-primary-inverted, Canvas);
      }
      .dsh-codex-settings .codex-toggle input[role='switch']:disabled { opacity: .55; cursor: default; }
    }
    .dsh-codex-settings .codex-toggle input:focus-visible { outline: 2px solid var(--dsw-alias-link, Highlight); outline-offset: 2px; }
    .dsh-codex-settings .codex-floating-items {
      display: grid; gap: 8px; min-inline-size: 0; margin: 0 18px 16px; padding: 8px 12px 10px;
      border: 1px solid var(--codex-border); border-radius: var(--dsw-radius-md, 8px);
    }
    .dsh-codex-settings .codex-floating-items legend { padding-inline: 4px; color: var(--codex-muted); font-size: 12px; }
    .dsh-codex-settings .codex-floating-action { margin: 0 18px 14px; }
  `
  const button = (text, action, { disabled = false, primary = false } = {}) => element('button', {
    type: 'button', className: primary ? 'codex-button codex-primary' : 'codex-button', onClick: action, disabled,
  }, text)

  const floatingStyles = `
    .dsh-codex-float {
      position: fixed;
      top: 78px;
      right: 24px;
      width: min(258px, calc(100vw - 16px));
      max-height: calc(100vh - 16px);
      display: grid;
      grid-template-columns: minmax(0, 1fr);
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
      --codex-float-muted: var(--dsw-alias-label-secondary, GrayText);
    }
    .dsh-codex-float .codex-float-toggle {
      grid-area: 1 / 1; display: flex; align-items: center; gap: 7px; min-height: 36px;
      padding: 6px 12px; border: 0; color: inherit; font: inherit; font-weight: 620;
      background: color-mix(in srgb, var(--dsw-alias-link, Highlight) 8%, transparent);
      cursor: pointer; touch-action: none; user-select: none;
    }
    .dsh-codex-float .codex-float-toggle:hover { background: color-mix(in srgb, var(--dsw-alias-link, Highlight) 14%, transparent); }
    .dsh-codex-float .codex-float-toggle:active { cursor: grabbing; }
    .dsh-codex-float .codex-float-grip { color: var(--codex-float-muted); }
    .dsh-codex-float .codex-float-cue { margin-inline-start: auto; min-inline-size: 14px; }
    .dsh-codex-float :focus-visible { outline: 2px solid var(--dsw-alias-link, Highlight); outline-offset: -2px; }
    .dsh-codex-float .codex-float-content { grid-area: 2 / 1; min-width: 0; }
    .dsh-codex-float[data-collapsed] {
      width: max-content; max-width: calc(100vw - 16px);
      border-radius: 20px; box-shadow: 0 5px 16px #0002, 0 1px 2px #0001;
    }
    .dsh-codex-float[data-collapsed] .codex-float-title { display: none; }
    .dsh-codex-float[data-collapsed] .codex-float-toggle {
      border-radius: inherit; background: transparent; padding-inline: 11px; min-height: 36px;
    }
    .dsh-codex-float[data-collapsed] .codex-float-toggle:hover {
      background: color-mix(in srgb, var(--dsw-alias-link, Highlight) 7%, transparent);
    }
    .dsh-codex-float[data-collapsed] .codex-float-cue {
      display: grid; place-items: center; min-inline-size: 12px; color: var(--codex-float-muted);
    }
    .dsh-codex-float[data-collapsed] .codex-float-cue::before {
      content: ''; width: 5px; height: 5px; margin-top: -3px;
      border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
    }
    .dsh-codex-float[data-collapsed] .codex-float-content {
      grid-area: 1 / 1; align-self: center; display: flex; flex-wrap: wrap; align-items: center;
      gap: 3px 9px; margin-inline: 29px 32px; padding-block: 7px;
      pointer-events: none; user-select: none; font-size: 12px; line-height: 1.4;
    }
    .dsh-codex-float[data-collapsed] .codex-float-pane { min-width: 0; }
    .dsh-codex-float[data-collapsed] .codex-float-pane + .codex-float-pane {
      border-inline-start: 1px solid var(--dsw-alias-settings-card-stroke, ButtonBorder);
      padding-inline-start: 9px;
    }
    .dsh-codex-float .codex-summary-metric { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
    .dsh-codex-float .codex-summary-label { color: var(--codex-float-muted); font-size: 11px; }
    .dsh-codex-float .codex-summary-plan {
      display: block; max-inline-size: 10em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 560;
    }
    .dsh-codex-float .codex-quota-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 8px; }
    .dsh-codex-float .codex-quota-summary:not([data-stale]) strong { color: var(--dsw-alias-link, LinkText); }
    .dsh-codex-float .codex-summary-stale {
      padding: 1px 5px; border-radius: 8px; white-space: nowrap;
      color: var(--codex-float-muted); font-size: 10px;
      background: color-mix(in srgb, var(--codex-float-muted) 12%, transparent);
    }
    @media (max-width: 420px) {
      .dsh-codex-float[data-collapsed] .codex-float-pane + .codex-float-pane { border-inline-start: 0; padding-inline-start: 0; }
    }
    .dsh-codex-float:not([data-collapsed]) .codex-float-pane + .codex-float-pane { border-top: 1px solid var(--dsw-alias-settings-card-stroke, ButtonBorder); }
  `
  const costStyles = `
    .dsh-codex-float .codex-cost-pane { padding: 10px 12px; }
    .dsh-codex-float .codex-cost-title { font-size: 12px; font-weight: 620; margin: 0 0 7px; }
    .dsh-codex-float .codex-cost-pane dl { display: grid; gap: 6px; margin: 0; }
    .dsh-codex-float .codex-cost-row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 8px; }
    .dsh-codex-float .codex-cost-row dt, .dsh-codex-float .codex-cost-row dd { margin: 0; }
    .dsh-codex-float .codex-cost-row dd { font-weight: 620; }
    .dsh-codex-float .codex-cost-note { margin: 7px 0 0; color: var(--codex-float-muted); font-size: 11px; }
  `
  const subscriptionStyles = `
    .dsh-codex-float .codex-subscription { padding: 10px 12px; }
    .dsh-codex-settings .codex-settings-subscription {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 205px), 1fr));
      gap: 14px 22px; padding: 14px 18px; border-top: 1px solid var(--codex-border);
    }
    :is(.dsh-codex-float, .dsh-codex-settings) .codex-subscription h3 { font-size: 12px; margin: 0 0 7px; }
    :is(.dsh-codex-float, .dsh-codex-settings) .codex-subscription dl { display: grid; gap: 6px; margin: 0; }
    :is(.dsh-codex-float, .dsh-codex-settings) .codex-subscription :is(dt, dd) { margin: 0; }
    :is(.dsh-codex-float, .dsh-codex-settings) .codex-subscription dd { font-weight: 620; overflow-wrap: anywhere; text-align: end; }
    :is(.dsh-codex-float, .dsh-codex-settings) .codex-subscription-row { display: flex; justify-content: space-between; gap: 2px 8px; }
    :is(.dsh-codex-float, .dsh-codex-settings) .codex-subscription-row dt { flex-shrink: 0; }
    :is(.dsh-codex-float, .dsh-codex-settings) .codex-subscription-note { margin: 5px 0 0; color: var(--codex-float-muted, var(--codex-muted)); font-size: 11px; }
    :is(.dsh-codex-float, .dsh-codex-settings) .codex-quota-window + .codex-quota-window { margin-top: 9px; }
    :is(.dsh-codex-float, .dsh-codex-settings) .codex-quota-window progress {
      display: block; width: 100%; height: 6px; margin-top: 4px; accent-color: var(--dsw-alias-link, Highlight);
    }
    .dsh-codex-settings .codex-quota-window .codex-subscription-row { flex-wrap: wrap; }
    .dsh-codex-settings .codex-quota-values { display: flex; flex-wrap: wrap; gap: 2px 8px; }
    .dsh-codex-settings .codex-quota-used { color: var(--codex-muted); }
  `

  function createFloatingClient(remote) {
    let view = { preferences: null, busy: false, failed: false }
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
          const result = await remote.floatingPreferences()
          if (!result.ok) throw new Error()
          update({ preferences: result.value, busy: false })
        } catch { update({ busy: false, failed: true }) }
      },
      async save(patch) {
        if (!view.preferences || view.busy) return
        const previous = view.preferences
        // Wait for the Host to save changes that start a content stream.
        const deselected = Object.fromEntries(Object.entries(patch.items ?? {}).filter(([, value]) => value === false))
        update({ preferences: { ...previous, ...patch, enabled: patch.enabled === false ? false : previous.enabled,
          items: { ...previous.items, ...deselected } },
          busy: true, failed: false })
        try {
          const result = await remote.setFloatingPreferences(patch)
          if (!result.ok) throw new Error()
          update({ preferences: result.value, busy: false })
        } catch { update({ preferences: previous, busy: false, failed: true }) }
      },
    }
  }

  function createApiCostClient(remote) {
    let current = null
    let binding
    const listeners = new Set()
    function select(id) {
      if (id === current) return
      current = id
      for (const listener of listeners) listener()
    }
    return {
      get: () => current,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      bindSession(sessionId) {
        const selection = {}
        const id = typeof sessionId === 'string' ? sessionId : null
        binding = selection
        select(id)
        return () => {
          if (binding === selection) {
            binding = undefined
            select(null)
          }
        }
      },
      estimate: (sessionId, signal) => remote.estimate(sessionId, signal),
    }
  }

  const floatingItems = [
    { id: 'apiCost', label: 'API 标价估算', component: ApiCostPane },
    { id: 'account', label: '账号与套餐', component: AccountPane },
    { id: 'quota', label: 'Codex 额度', component: QuotaPane },
  ]

  function FloatingSettings({ floating }) {
    const { preferences: prefs, busy, failed } = useSyncExternalStore(floating.subscribe, floating.get)
    useEffect(() => { void floating.load() }, [floating])
    return element('div', { className: 'codex-card codex-floating-settings' },
      element('div', { className: 'codex-head' },
        element('div', { className: 'codex-intro' },
          element('label', { className: 'codex-toggle' },
            element('input', { type: 'checkbox', role: 'switch', checked: prefs?.enabled === true,
              disabled: !prefs || busy, onChange: event => { void floating.save({ enabled: event.target.checked }) } }),
            element('strong', null, '悬浮窗'),
          ),
        ),
      ),
      element('fieldset', { className: 'codex-floating-items', disabled: !prefs || busy },
        element('legend', null, '显示内容'),
        ...floatingItems.map(({ id, label }) => element('label', { key: id, className: 'codex-toggle' },
          element('input', { type: 'checkbox', checked: prefs?.items[id] === true,
            onChange: event => { void floating.save({ items: { [id]: event.target.checked } }) } }),
          label,
        )),
      ),
      failed ? element('p', { className: 'codex-alert', role: 'alert' }, '无法更新悬浮窗设置。') : null,
      failed && !prefs ? element('div', { className: 'codex-floating-action' }, button('重试', floating.load)) : null,
      prefs?.position ? element('div', { className: 'codex-floating-action' },
        button('重置悬浮窗位置', () => floating.save({ position: null }), { disabled: busy })) : null,
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

  function FloatingOverlay({ floating, contentProps }) {
    const { preferences: prefs, busy } = useSyncExternalStore(floating.subscribe, floating.get)
    const [collapsed, setCollapsed] = useState(false)
    useEffect(() => { void floating.load() }, [floating])
    if (!prefs?.enabled) return null
    const selected = floatingItems.filter(({ id }) => prefs.items[id])
    if (!selected.length) return null
    return element(FloatingWindow, {
      position: prefs.position,
      busy,
      collapsed,
      onToggle: () => setCollapsed(value => !value),
      onMove: position => { void floating.save({ position }) },
    }, selected.map(({ id, component }) => element('div', { key: id, className: 'codex-float-pane' },
      element(component, { ...contentProps[id], collapsed }))))
  }

  function FloatingWindow({ position, busy, collapsed, onToggle, onMove, children }) {
    const [preview, setPreview] = useState()
    const [bounds, setBounds] = useState()
    const frame = useRef(null)
    const drag = useRef(null)
    // A released pointer can still generate a click on the captured button.
    const skipPointerClick = useRef(false)

    useEffect(() => {
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
    }, [])

    const clamp = point => ({ x: Math.min(bounds?.x ?? window.innerWidth - 16, Math.max(8, point.x)),
      y: Math.min(bounds?.y ?? window.innerHeight - 16, Math.max(8, point.y)) })
    const point = preview ?? position
    const located = point ? clamp(point) : undefined
    const dragPoint = (event, handle) => clamp({ x: handle.left + event.clientX - handle.x,
      y: handle.top + event.clientY - handle.y })
    const crossedThreshold = (event, handle) => Math.hypot(event.clientX - handle.x, event.clientY - handle.y) >= 5
    const startDrag = event => {
      if (event.button !== 0 || drag.current) return
      skipPointerClick.current = false
      const { left, top } = frame.current.getBoundingClientRect()
      drag.current = { id: event.pointerId, left, top, x: event.clientX, y: event.clientY, movable: !busy, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const move = event => {
      const handle = drag.current
      if (handle?.id !== event.pointerId) return
      handle.moved ||= crossedThreshold(event, handle)
      if (handle.moved && handle.movable) setPreview(dragPoint(event, handle))
    }
    const finishDrag = (event, commit) => {
      const handle = drag.current
      if (handle?.id !== event.pointerId) return
      drag.current = null
      const moved = handle.moved || crossedThreshold(event, handle)
      skipPointerClick.current = moved || !commit
      if (commit && moved && handle.movable) {
        const point = dragPoint(event, handle)
        if (point.x !== handle.left || point.y !== handle.top) onMove(point)
      }
      setPreview(undefined)
    }
    const toggleFromHeader = event => {
      if (event.detail === 0 || !skipPointerClick.current) onToggle()
      skipPointerClick.current = false
    }
    const moveByKey = event => {
      const step = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key]
      if (!step || busy) return
      event.preventDefault()
      const { left, top } = frame.current.getBoundingClientRect()
      onMove(clamp({ x: left + step[0], y: top + step[1] }))
    }

    return element('aside', { className: 'dsh-codex-float', ref: frame, 'aria-label': 'ChatGPT Subscription',
      'data-collapsed': collapsed || undefined, style: located ? { left: located.x, top: located.y, right: 'auto' } : undefined },
      element('style', null, floatingStyles + subscriptionStyles),
      element('button', { type: 'button', className: 'codex-float-toggle',
        'aria-label': collapsed ? '展开悬浮窗' : '折叠悬浮窗',
        'aria-expanded': !collapsed, 'aria-description': '按方向键移动悬浮窗',
        onClick: toggleFromHeader,
        onKeyDown: moveByKey, onPointerDown: startDrag, onPointerMove: move, onPointerUp: e => finishDrag(e, true),
        onPointerCancel: e => finishDrag(e, false), onLostPointerCapture: e => finishDrag(e, false) },
        element('span', { className: 'codex-float-grip', 'aria-hidden': 'true' }, '⠿'),
        element('span', { className: 'codex-float-title' }, 'ChatGPT Subscription'),
        element('span', { className: 'codex-float-cue', 'aria-hidden': 'true' }, collapsed ? null : '−'),
      ),
      element('div', { className: 'codex-float-content' }, children),
    )
  }

  function summaryMetric(label, value, key) {
    return element('span', { className: 'codex-summary-metric', key },
      element('span', { className: 'codex-summary-label' }, label),
      element('strong', null, value),
    )
  }

  function ApiCostPane({ cost, collapsed }) {
    const sessionId = useSyncExternalStore(cost.subscribe, cost.get)
    const [value, setValue] = useState()
    const [error, setError] = useState(false)

    useEffect(() => {
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
    }, [cost, sessionId])

    const current = value?.sessionId === sessionId ? value.current : null
    const currentText = value?.sessionId === sessionId && value.currentUnavailable ? '用量暂不可读' : displayAmount(current)
    if (collapsed) return summaryMetric('会话', currentText)
    const totalText = displayAmount(value?.total, value?.unreadableSessions > 0)
    const note = error ? '暂时无法读取用量，正在重试。' : !value ? '正在读取会话用量…'
      : [value.total.priced > 0 ? `${value.total.priced} 笔已计价` : '',
        value.total.priced > 0 && (value.total.unpriced > 0 || value.unreadableSessions > 0) ? '全部累计为已计价小计' : '',
        value.total.unpriced > 0 ? `${value.total.unpriced} 笔未计价` : '',
        value.unreadableSessions > 0 ? `${value.unreadableSessions} 个会话暂不可读` : '',
        Number.isFinite(value.ratesSyncedAt) ? `费率同步于 ${new Date(value.ratesSyncedAt).toLocaleDateString()}` : '',
      ].filter(Boolean).join(' · ')

    return element('section', { className: 'codex-cost-pane' },
      element('style', null, costStyles),
      element('h3', { className: 'codex-cost-title' }, 'API 标价估算'),
      element('dl', null,
        element('div', { className: 'codex-cost-row' },
          element('dt', null, current?.priced && current.unpriced ? '当前会话（小计）' : '当前会话'), element('dd', null, currentText)),
        element('div', { className: 'codex-cost-row' }, element('dt', null, '全部累计'), element('dd', null, totalText)),
      ),
      note ? element('p', { className: 'codex-cost-note', role: 'status' }, note) : null,
    )
  }

  function useSubscription(observe, kind) {
    const [value, setValue] = useState()
    useEffect(() => {
      const controller = new AbortController()
      let retry
      async function follow() {
        try {
          for await (const frame of observe(kind, controller.signal)) {
            if (controller.signal.aborted) break
            if (frame.kind === kind) setValue(frame)
          }
        } catch {
          if (controller.signal.aborted) return
          setValue(null)
          retry = setTimeout(follow, 3000)
        }
      }
      void follow()
      return () => { controller.abort(); clearTimeout(retry) }
    }, [observe, kind])
    return value
  }

  const planLabels = {
    guest: 'Guest',
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    prolite: 'Pro 100',
    pro: 'Pro 200',
    promax: 'Pro 500',
    free_workspace: 'Free Workspace',
    team: 'Team',
    business: 'Business',
    self_serve_business_prolite: 'Self-Serve Business Pro Lite',
    self_serve_business_usage_based: 'Self-Serve Business Usage-Based',
    enterprise: 'Enterprise',
    ent26: 'Enterprise',
    hc: 'Enterprise',
    enterprise_cbp_automation: 'Enterprise (Automation)',
    enterprise_cbp_usage_based: 'Enterprise CBP Usage-Based',
    edu: 'Edu',
    education: 'Edu',
    edu_plus: 'Edu Plus',
    edu_pro: 'Edu Pro',
    quorum: 'Quorum',
    k12: 'K–12',
    sci: 'Academic Researchers',
    sci_plus: 'Academic Researchers Plus',
  }
  const subscriptionDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const remainingFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
  const percent = value => `${remainingFormat.format(value)}%`
  const remainingLabel = value => `剩 ${percent(value)}`

  function quotaDuration(seconds) {
    if (seconds % 86400 === 0) return `${seconds / 86400} 天`
    if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
    if (seconds % 60 === 0) return `${seconds / 60} 分钟`
    return `${seconds} 秒`
  }

  const accountPlan = account => account?.plan && (Object.hasOwn(planLabels, account.plan) ? planLabels[account.plan] : account.plan)
  const accountStatusText = account => account ? labels[account.status] : account === null ? '账号暂不可用' : '正在读取账号…'
  const quotaStatusText = quota => quota === undefined ? '正在读取额度…' : labels[quota?.status] ?? '额度暂不可用'

  function accountDetails(account) {
    return element('section', { className: 'codex-subscription' },
      element('h3', null, '账号与套餐'),
      account?.status === 'signed-in' ? element('dl', null,
        element('div', { className: 'codex-subscription-row' },
          element('dt', null, '邮箱'), element('dd', null, account.email ?? '邮箱暂不可用')),
        element('div', { className: 'codex-subscription-row' },
          element('dt', null, '套餐'), element('dd', null, accountPlan(account) || '套餐暂不可用')),
      ) : element('p', { className: 'codex-subscription-note', role: 'status' }, accountStatusText(account)),
    )
  }

  function quotaDetails(quota, showUsed = false) {
    const windows = quota?.windows ?? []
    const stale = quota?.status === 'stale'
    return element('section', { className: 'codex-subscription' },
      element('h3', null, 'Codex 额度'),
      windows.length ? windows.map((window, index) => {
        const label = quotaDuration(window.durationSeconds)
        return element('div', { className: 'codex-quota-window', key: index },
          element('div', { className: 'codex-subscription-row' },
            element('span', null, label),
            element('span', { className: 'codex-quota-values' },
              showUsed ? element('span', { className: 'codex-quota-used' }, `已用 ${percent(100 - window.remaining)}`) : null,
              element('strong', null, remainingLabel(window.remaining)))),
          element('progress', { value: window.remaining, max: 100, 'aria-label': `${label}额度剩余` }),
          window.resetsAt === null ? null : element('p', { className: 'codex-subscription-note' },
            `重置于 ${subscriptionDate.format(window.resetsAt)}`),
        )
      }) : element('p', { className: 'codex-subscription-note', role: 'status' }, quotaStatusText(quota)),
      quota?.updatedAt == null ? null : element('p', { className: 'codex-subscription-note' },
        `${stale ? '更新失败 · 上次读取' : '读取于'} ${subscriptionDate.format(quota.updatedAt)}`),
    )
  }

  function AccountPane({ observe, collapsed }) {
    const account = useSubscription(observe, 'account')
    if (collapsed) return element('span', { className: 'codex-summary-plan' }, accountPlan(account) || accountStatusText(account))
    return accountDetails(account)
  }

  function QuotaPane({ observe, collapsed }) {
    const quota = useSubscription(observe, 'quota')
    if (!collapsed) return quotaDetails(quota)
    const windows = quota?.windows ?? []
    const stale = quota?.status === 'stale'
    return element('div', { className: 'codex-quota-summary', 'data-stale': stale || undefined },
      windows.length ? windows.map((window, index) => summaryMetric(quotaDuration(window.durationSeconds), percent(window.remaining), index))
        : element('span', { className: 'codex-summary-label' }, quotaStatusText(quota)),
      stale ? element('span', { className: 'codex-summary-stale' }, '上次') : null,
    )
  }

  function SettingsSubscription({ observe }) {
    const account = useSubscription(observe, 'account')
    const quota = useSubscription(observe, 'quota')
    return element('div', { className: 'codex-settings-subscription' },
      element('style', null, subscriptionStyles),
      accountDetails(account), quotaDetails(quota, true),
    )
  }

  function CodexPanel({ api, floating, observeSubscription }) {
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
        signedIn && observeSubscription ? element(SettingsSubscription, { observe: observeSubscription }) : null,
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
      floating ? element(FloatingSettings, { floating }) : null,
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
      const floating = createFloatingClient(remoteCtx.remote.codexResponses)
      const cost = createApiCostClient(remoteCtx.remote.codexResponses)
      const observeSubscription = (kind, signal) => remoteCtx.remote.codexResponses.subscription(kind, 'settings', signal)
      const subscriptionProps = { observe: (kind, signal) => remoteCtx.remote.codexResponses.subscription(kind, 'floating', signal) }
      const contentProps = { apiCost: { cost }, account: subscriptionProps, quota: subscriptionProps }
      remoteCtx.remoteAccess.whenAccess('codexResponses/status', () => {
        const disposers = [
          remoteCtx.slots.inject('settings.section', () => remoteCtx.slots.register({
            name: 'settings.section', id: 'codex-responses', order: 30, label: 'ChatGPT Codex',
            inject: () => ({ api, floating, observeSubscription }),
          }, CodexPanel)),
          remoteCtx.slots.inject('shell.overlay', () => remoteCtx.slots.register({
            name: 'shell.overlay', id: 'codex-floating-window', inject: () => ({ floating, contentProps }),
          }, FloatingOverlay)),
          remoteCtx.slots.inject('conversation.session.header.utilities', () => remoteCtx.slots.register({
            name: 'conversation.session.header.utilities', id: 'codex-cost-session', inject: () => ({ cost }),
          }, CostSessionBinding)),
        ]
        return () => { for (const dispose of disposers) dispose?.() }
      })
    })
  } }
} })
