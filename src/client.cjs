window.__ModuleLoader__.load({ id: 'dsh-codex-responses', factory: require => {
  const { createElement: element, useEffect, useRef, useState } = require('react')
  const { z } = require('zod')
  const packageName = 'dsh-codex-responses'
  const namespace = 'codexResponses'
  const deviceURL = 'https://auth.openai.com/codex/device'
  const statusSchema = z.strictObject({ type: z.literal('status'), status: z.enum(['signed-in', 'signed-out', 'relogin-required']),
    catalog: z.strictObject({ source: z.enum(['upstream', 'cached', 'bundled', 'unavailable']), count: z.number().int().nonnegative() }).optional() })
  const deviceSchema = z.strictObject({ type: z.literal('device'), url: z.literal(deviceURL), code: z.string() })
  const loginSchema = z.discriminatedUnion('type', [statusSchema, deviceSchema])
  const descriptor = method => ({
    id: `${packageName}#${namespace}/${method}`, namespace, method, service: namespace,
    invocation: { kind: 'direct' }, parameters: [],
    ...(method === 'login' ? { mode: 'stream', cancellation: { parameter: 'signal' } } : {}),
    result: { mode: 'strict', typeSymbol: `${packageName}#${method === 'login' ? 'LoginFrame' : 'Status'}`,
      create: () => method === 'login' ? loginSchema : statusSchema },
  })
  const contribution = { package: packageName, descriptors: ['status', 'signOut', 'login'].map(descriptor) }
  const labels = { 'signed-in': '已登录', 'signed-out': '未登录', 'relogin-required': '需要重新登录' }
  const catalogLabels = { upstream: 'Codex 在线目录', cached: '上次成功的 Codex 目录', bundled: '内置备用目录', unavailable: '在线目录不可用' }
  const loginErrors = {
    'codex-responses/device-failed': '未能获取设备码。请检查网络和 ChatGPT 的设备码登录设置。',
    'codex-responses/poll-failed': '未能确认设备授权。请检查浏览器是否完成授权，或重新生成设备码。',
    'codex-responses/exchange-failed': '浏览器已授权，但 OpenAI 拒绝兑换凭据。请重新生成设备码再试。',
    'codex-responses/token-failed': '浏览器已授权，但 OpenAI 返回的凭据无法使用。',
  }
  const panelStyle = { display: 'grid', justifyItems: 'start', gap: 12, marginBlock: 16 }
  const rowStyle = { display: 'flex', gap: 8, flexWrap: 'wrap' }
  const codeStyle = { fontSize: '1.2em', letterSpacing: '0.1em', userSelect: 'all' }
  const button = (text, action, disabled = false) => element('button', { type: 'button', onClick: action, disabled }, text)

  function CodexPanel({ api }) {
    const [status, setStatus] = useState()
    const [catalog, setCatalog] = useState()
    const [device, setDevice] = useState()
    const [pending, setPending] = useState(false)
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
    useEffect(() => {
      mounted.current = true
      void read()
      return () => { mounted.current = false; active.current?.abort() }
    }, [api])

    const login = async () => {
      if (active.current) return
      const controller = new AbortController()
      active.current = controller
      setPending(true)
      setError('')
      setDevice(undefined)
      try {
        for await (const frame of api.login(controller.signal)) {
          if (controller.signal.aborted || !mounted.current) break
          if (frame.type === 'device' && frame.url === deviceURL && /^[A-Z0-9-]{4,32}$/u.test(frame.code)) setDevice(frame)
          else update(frame)
        }
        if (mounted.current) await read()
      } catch (failure) {
        if (mounted.current && !controller.signal.aborted) {
          const code = failure?.code ?? failure?.error?.code
          setError(Object.hasOwn(loginErrors, code) ? loginErrors[code] : '设备码登录未完成。请确认 ChatGPT 允许 Codex 设备码登录，再重试。')
        }
      } finally {
        active.current = undefined
        if (mounted.current) { setDevice(undefined); setPending(false) }
      }
    }

    const signOut = async () => {
      setPending(true)
      setError('')
      try {
        const result = await api.signOut()
        if (!result.ok) throw new Error()
        if (mounted.current) update(result.value)
      } catch {
        if (mounted.current) setError('退出失败。请稍后重试。')
      } finally {
        if (mounted.current) setPending(false)
      }
    }

    return element('section', { style: panelStyle, 'aria-label': 'ChatGPT Codex 设备码登录' },
      element('h3', null, 'ChatGPT Codex'),
      element('p', null, '使用 ChatGPT 订阅与 DSH 的原生工具。登录后在会话的模型选择器中选择 ChatGPT Codex。'),
      element('p', { role: 'status' }, pending ? '正在处理…' : labels[status] ?? '正在读取状态…'),
      catalog && Object.hasOwn(catalogLabels, catalog.source)
        ? element('p', null, `模型目录：${catalogLabels[catalog.source]}（${catalog.count} 个模型）`) : null,
      element('div', { style: rowStyle },
        button(status === 'signed-in' ? '重新登录' : '使用设备码登录', login, pending),
        status && status !== 'signed-out' ? button('退出登录', signOut, pending) : null,
        pending ? button('取消设备码登录', () => { active.current?.abort(); setDevice(undefined) }) : null,
      ),
      device ? element('div', { style: panelStyle },
        element('p', null, '在浏览器打开 OpenAI 验证页面，输入以下一次性设备码。请只授权你自己发起的登录。'),
        element('code', { style: codeStyle }, device.code),
        element('a', { href: deviceURL, target: '_blank', rel: 'noopener noreferrer' }, '打开 OpenAI 验证页面'),
      ) : null,
      error ? element('p', { role: 'alert' }, error) : null,
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
      remoteCtx.remoteAccess.whenAccess('codexResponses/status', () => remoteCtx.slots.inject('settings.plugins.tab', () => remoteCtx.slots.register({
        name: 'settings.plugins.tab', id: 'codex-responses', order: 30, label: 'ChatGPT Codex',
        inject: () => ({ api }),
      }, CodexPanel)))
    })
  } }
} })
