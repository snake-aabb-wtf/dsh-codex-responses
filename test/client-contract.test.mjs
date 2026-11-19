import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { z } from 'zod'
import { TYPERT } from '../src/typert.mjs'

async function loadClient({ react = {}, navigator, timers } = {}) {
  let client
  const source = await readFile(new URL('../src/client.cjs', import.meta.url), 'utf8')
  runInNewContext(source, { AbortController, navigator, ...timers, window: {
    innerWidth: 1000, innerHeight: 800,
    __ModuleLoader__: { load({ factory }) {
      client = factory(id => id === 'zod' ? { z } : react)
    } },
  } })
  return client
}

test('client bundle mounts the same strict Remote contracts as the Host', async () => {
  const client = await loadClient()
  let mounted, injected
  await client.apply({ remote: { $host: { isLoopback: true }, async $mount(contribution) { mounted = contribution } },
    inject(keys, register) {
      injected = keys
      register({ remote: { codexResponses: {} }, remoteAccess: { whenAccess() {} }, slots: { inject() {} } })
    },
  })
  assert.deepEqual(Array.from(injected), ['remote.codexResponses'])
  assert.deepEqual(Array.from(mounted.descriptors, descriptor => descriptor.id), TYPERT.invocations.map(method => method.id))
  for (const descriptor of mounted.descriptors) {
    const host = TYPERT.invocations.find(method => method.id === descriptor.id)
    assert.deepEqual(z.toJSONSchema(descriptor.result.create()), z.toJSONSchema(host.result.create()))
    assert.equal(descriptor.mode, host.mode)
    assert.deepEqual(Array.from(descriptor.parameters, param => [param.wire, z.toJSONSchema(param.codec.create())]),
      host.parameters.map(param => [param.wire, z.toJSONSchema(param.codec.create())]))
  }
  const floating = mounted.descriptors.find(descriptor => descriptor.method === 'floatingPreferences')
  const preferences = { enabled: true, items: { apiCost: true, account: false, quota: false }, position: { x: 0, y: 20 } }
  assert.deepEqual(floating.result.create().parse(preferences), preferences)
  for (const edge of ['left', 'right']) {
    const docked = { ...preferences, position: { ...preferences.position, edge } }
    assert.deepEqual(floating.result.create().parse(docked), docked)
  }
  assert.equal(floating.result.create().safeParse({ ...preferences, position: { ...preferences.position, edge: 'top' } }).success, false)
})

test('Codex registers only a top-level Settings section once status access is granted', async () => {
  const client = await loadClient()
  const slots = []
  const entries = []
  let grantAccess
  await client.apply({ remote: { $host: { isLoopback: true }, async $mount() {} },
    inject(_keys, register) { register({
      remote: { codexResponses: {} },
      remoteAccess: { whenAccess(method, setup) {
        assert.equal(method, 'codexResponses/status')
        grantAccess = setup
      } },
      slots: {
        inject(name, setup) { slots.push(name); setup() },
        register(entry) { entries.push(entry) },
      },
    }) },
  })

  assert.deepEqual(entries.map(({ key }) => key), ['codex_generate_image', 'codex_edit_image'])
  grantAccess()
  assert.deepEqual(slots, ['tool.call.toolview', 'tool.call.toolview', 'settings.section', 'shell.overlay', 'conversation.session.header.utilities'])
  assert.deepEqual(entries.filter(entry => entry.name.startsWith('settings.')).map(({ name, id, label }) => ({ name, id, label })), [
    { name: 'settings.section', id: 'codex-responses', label: 'ChatGPT Codex' },
  ])
})

test('Codex image tool has its own keyed pending, failed, and durable downloaded-image view', async () => {
  let preview
  let effect
  const client = await loadClient({ react: {
    createElement(type, props, ...children) { return { type, props, children } },
    useEffect(callback) { effect = callback },
    useMemo(compute) { return compute() },
    useState() { return [preview, value => { preview = value }] },
  } })
  let registration
  let View
  let EditView
  await client.apply({ remote: { $host: { isLoopback: true }, async $mount() {} },
    inject(_keys, setup) { setup({
      remote: { codexResponses: {} },
      remoteAccess: { whenAccess() {} },
      slots: { inject(_name, register) { register() }, register(entry, render) {
        if (entry.key === 'codex_generate_image') {
          registration = entry
          View = render
        }
        if (entry.key === 'codex_edit_image') EditView = render
      } },
    }) },
  })
  assert.equal(registration.name, 'tool.call.toolview')
  assert.equal(registration.children, undefined)
  assert.match(JSON.stringify(View({ phase: 'start' })), /正在生成图片/)
  const failed = View({ phase: 'result', block: {
    isError: true, error: { code: 'CODEX_IMAGE_LIMIT' }, content: [{ type: 'text', text: 'private detail' }],
  } })
  assert.match(JSON.stringify(failed), /额度/)
  assert.doesNotMatch(JSON.stringify(failed), /private detail/)
  for (const [code, expected] of [['CODEX_RELOGIN_REQUIRED', /重新登录/], ['ABORTED_BEFORE_DISPATCH', /已取消/],
    ['interrupted', /中断/]]) {
    assert.match(JSON.stringify(View({ phase: 'result', block: { isError: true, error: { code } } })), expected)
  }

  const attachment = { attachmentId: 'saved-image-1', mediaType: 'image/jpeg', width: 1024, height: 1024, bytes: 256 }
  const props = { phase: 'result', block: { meta: { attachment }, isError: false },
    async loadImage(ref) {
      assert.deepEqual({ ...ref }, attachment)
      return 'blob:preview'
    },
  }
  const find = (node, predicate) => {
    if (node == null || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const match = find(child, predicate)
      if (match) return match
    }
  }
  const image = find(View(props), node => typeof node.type === 'function')
  assert.match(JSON.stringify(image.type(image.props)), /正在读取图片/)
  effect()
  await new Promise(resolve => setImmediate(resolve))
  const ready = image.type(image.props)
  assert.equal(find(ready, node => node.type === 'img').props.src, 'blob:preview')
  const download = find(ready, node => node.type === 'a')
  assert.equal(download.props.href, 'blob:preview')
  assert.equal(download.props.download, 'codex-image.jpg')
  assert.match(JSON.stringify(EditView({ phase: 'start', toolName: 'codex_edit_image' })), /正在编辑图片/)

  const collect = (node, elements = []) => {
    if (node == null || typeof node !== 'object') return elements
    if (typeof node.type === 'function') elements.push(node)
    for (const child of node.children ?? []) collect(child, elements)
    return elements
  }
  const batch = { requested: 3, attachments: [attachment, { ...attachment, attachmentId: 'saved-image-2' }] }
  const cancelled = EditView({ ...props, toolName: 'codex_edit_image', block: {
    isError: true, error: { code: 'ABORTED' },
    content: [{ type: 'text', text: 'Codex saved image result: ' + JSON.stringify(batch) }],
  } })
  assert.match(JSON.stringify(cancelled), /2 \/ 3/)
  assert.match(JSON.stringify(cancelled), /已取消/)
  const pictures = collect(cancelled)
  assert.deepEqual(pictures.map(node => node.props.number), [1, 2])
  const numbered = find(pictures[1].type(pictures[1].props), node => node.type === 'a')
  assert.equal(numbered.props.download, 'codex-image-2.jpg')

  const complete = View({ ...props, block: { isError: false, meta: { ...batch, requested: 2 } } })
  assert.equal(collect(complete).length, 2)

  const missing = find(View({ ...props, async loadImage() { throw new Error('mount path secret') } }),
    node => typeof node.type === 'function')
  missing.type(missing.props)
  effect()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(JSON.stringify(missing.type(missing.props)), /无法读取/)
  assert.doesNotMatch(JSON.stringify(missing.type(missing.props)), /mount path secret/)
})

async function mountFloating(remote, hooks = {}, timers) {
  const client = await loadClient({ timers, react: {
    createElement(type, props, ...children) { return { type, props, children } },
    useEffect() {},
    useLayoutEffect() {},
    useRef(initial) { return { current: initial } },
    useState(initial) { return [initial, () => {}] },
    useSyncExternalStore(_subscribe, get) { return get() },
    ...hooks,
  } })
  let floating
  let render
  await client.apply({ remote: { $host: { isLoopback: true }, async $mount() {} },
    inject(_keys, register) { register({ remote: { codexResponses: remote },
      remoteAccess: { whenAccess(_method, setup) { setup() } },
      slots: { inject(_name, setup) { setup() }, register(entry, Overlay) {
        if (entry.name === 'shell.overlay') {
          const props = entry.inject()
          floating = props.floating
          render = () => {
            const content = Overlay(props)
            return content ? content.type(content.props) : null
          }
        }
      } },
    }) },
  })
  await floating.load()
  return { floating, render }
}

test('the floating window waits for saved preferences and requires at least one selected item', async () => {
  let resolveSave
  let pendingPatch
  const position = { x: 30, y: 40 }
  const initial = { enabled: false, position, items: { apiCost: false } }
  const { floating, render } = await mountFloating({
    async floatingPreferences() { return { ok: true, value: initial } },
    setFloatingPreferences(patch) {
      pendingPatch = patch
      return new Promise(resolve => { resolveSave = resolve })
    },
  })

  async function save(patch, saved) {
    const saving = floating.save(patch)
    assert.equal(pendingPatch, patch)
    assert.equal(render(), null)
    resolveSave({ ok: true, value: saved })
    await saving
  }

  assert.equal(render(), null)
  const empty = { ...initial, enabled: true }
  await save({ enabled: true }, empty)
  assert.equal(floating.get().preferences.enabled, true)
  assert.equal(render(), null)

  const visible = { ...empty, items: { apiCost: true } }
  await save({ items: { apiCost: true } }, visible)
  assert.equal(render().props.position, position)

  const disable = floating.save({ enabled: false })
  assert.equal(render(), null)
  resolveSave({ ok: false })
  await disable
  assert.equal(render().props.position, position)

  await save({ items: { apiCost: false } }, empty)
  assert.equal(render(), null)
  assert.deepEqual(floating.get().preferences, empty)
})

test('releasing a drag saves the final coordinates without an intermediate pointer move', async () => {
  const position = { x: 30, y: 40 }
  const { render } = await mountFloating({
    async floatingPreferences() { return { ok: true, value: { enabled: true, position, items: { apiCost: true } } } },
  })
  const shell = render()
  let moved
  const window = shell.type({ ...shell.props, onMove: point => { moved = point } })
  window.props.ref.current = { getBoundingClientRect: () => ({ left: 30, top: 40 }) }
  const handle = window.children.find(node => node.props?.onPointerDown).props
  const pointer = { button: 0, pointerId: 1, clientX: 40, clientY: 50, currentTarget: { setPointerCapture() {} } }
  handle.onPointerDown(pointer)
  handle.onPointerUp(pointer)
  assert.equal(moved, undefined)
  handle.onPointerDown(pointer)
  handle.onPointerUp({ ...pointer, clientX: 80, clientY: 110 })
  assert.equal(moved?.x, 70)
  assert.equal(moved?.y, 100)
})

test('releasing the capsule near a side saves its edge and vertical position', async () => {
  for (const [position, releaseLeft, collapsed, expected] of [
    [{ x: 100, y: 40 }, 24, true, { x: 0, y: 55, edge: 'left' }],
    [{ x: 300, y: 40 }, 726, true, { x: 750, y: 55, edge: 'right' }],
    [{ x: 0, y: 40, edge: 'left' }, 25, true, { x: 25, y: 55 }],
    [{ x: 0, y: 40, edge: 'left' }, 0, false, { x: 0, y: 55, edge: 'left' }],
    [{ x: 100, y: 40 }, 15, false, { x: 15, y: 55 }],
  ]) {
    const { render } = await mountFloating({
      async floatingPreferences() { return { ok: true, value: { enabled: true, position, items: { apiCost: true } } } },
    })
    const shell = render()
    let moved
    const frame = shell.type({ ...shell.props, collapsed, onMove: point => { moved = { ...point } } })
    frame.props.ref.current = { getBoundingClientRect: () => ({ left: position.x, top: position.y, width: 250 }) }
    const handle = frame.children.find(node => node.props?.onPointerDown).props
    const pointer = { button: 0, pointerId: 1, clientX: position.x + 15, clientY: 50, currentTarget: { setPointerCapture() {} } }
    handle.onPointerDown(pointer)
    handle.onPointerUp({ ...pointer, clientX: releaseLeft + 15, clientY: 65 })
    assert.deepEqual(moved, expected)
  }
})

test('account and quota mount independently of each other and of the cost estimator', async () => {
  for (const kind of ['account', 'quota']) {
    const { render } = await mountFloating({
      async floatingPreferences() {
        return { ok: true, value: { enabled: true, position: null,
          items: { apiCost: false, account: kind === 'account', quota: kind === 'quota' } } }
      },
    })
    const shell = render()
    for (const panes of [shell.props.summary, shell.props.details]) {
      assert.equal(panes.length, 1)
      assert.equal(panes[0].props.key, kind)
    }
  }
})

test('the floating window exposes only its current view to accessibility tools', async () => {
  const { render } = await mountFloating({
    async floatingPreferences() {
      return { ok: true, value: { enabled: true, position: null, items: { quota: true } } }
    },
  })
  const shell = render()
  for (const [collapsed, edge] of [[false, undefined], [true, undefined], [false, 'left'], [true, 'left'], [true, 'right']]) {
    const position = edge ? { x: 0, y: 20, edge } : null
    const window = shell.type({ ...shell.props, collapsed, position })
    const summary = window.children.find(node => node.props?.className?.endsWith(' codex-float-summary'))
    const portrait = window.children.find(node => node.props?.className?.endsWith(' codex-float-portrait'))
    const details = window.children.find(node => node.props?.className?.endsWith(' codex-float-details'))
    assert.equal(window.props['data-portrait'], collapsed ? edge : undefined)
    assert.equal(summary.props['aria-hidden'], collapsed && !edge ? undefined : true)
    assert.equal(portrait?.props['aria-hidden'], collapsed && edge ? undefined : true)
    assert.equal(details.props['aria-hidden'], collapsed ? true : undefined)
  }
})

test('collapsed summaries expose compact labels, two quota values and a separate stale indicator', async () => {
  const states = [
    { sessionId: null, current: { usd: 0.058, priced: 1, unpriced: 0, awaitingRates: 0 } },
    { kind: 'account', status: 'signed-in', email: 'owner@example.com', plan: 'plus' },
    { kind: 'quota', status: 'stale', windows: [
      { remaining: 68, durationSeconds: 18_000, resetsAt: null },
      { remaining: 39, durationSeconds: 604_800, resetsAt: null },
    ] },
  ]
  const { render } = await mountFloating({
    async floatingPreferences() {
      return { ok: true, value: { enabled: true, position: null, items: { apiCost: true, account: true, quota: true } } }
    },
  }, {
    useState(initial) { return [initial === undefined ? states.shift() : initial, () => {}] },
  })
  const summaries = render().props.summary.map(pane => {
    const [content] = pane.children
    return descendants(content.type(content.props))
  })
  const texts = nodes => nodes.filter(node => typeof node === 'string')
  assert.deepEqual(texts(summaries[0]), ['会话', '$0.058'])
  assert.deepEqual(texts(summaries[1]), ['Plus'])
  assert.deepEqual(texts(summaries[2]), ['5 小时', '68%', '7 天', '39%', '上次'])
})

for (const interruption of ['stream ended', 'stream stalled']) {
  test(`a mounted quota pane reconnects after its ${interruption}`, async () => {
    const ready = { kind: 'quota', status: 'ready', windows: [
      { remaining: 52, durationSeconds: 604_800, resetsAt: null },
    ], updatedAt: 1_900_000_000_000 }
    const refreshed = { ...ready, updatedAt: ready.updatedAt + 60_000, windows: [{ ...ready.windows[0], remaining: 51 }] }
    const pending = new Map()
    const timers = {
      setTimeout(callback, ms) {
        const id = Symbol()
        pending.set(id, { callback, ms })
        return id
      },
      clearTimeout(id) { pending.delete(id) },
    }
    const fire = ms => {
      const timer = [...pending].find(([, entry]) => entry.ms === ms)
      assert.ok(timer, `Expected a timer for ${ms} ms`)
      const [id, { callback }] = timer
      pending.delete(id)
      callback()
    }
    let value
    let effect
    const signals = []
    const { render } = await mountFloating({
      async floatingPreferences() {
        return { ok: true, value: { enabled: true, position: null,
          items: { apiCost: false, account: false, quota: true } } }
      },
      async *subscription(_kind, _surface, signal) {
        signals.push(signal)
        const first = signals.length === 1
        yield first ? ready : refreshed
        if (first && interruption === 'stream ended') return
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
    }, {
      useEffect(setup, dependencies) {
        if (dependencies[1] === 'quota') effect = setup
      },
      useState(initial) {
        return [initial ?? value, next => { value = typeof next === 'function' ? next(value) : next }]
      },
    }, timers)

    render()
    const cleanup = effect()
    try {
      await nextTurn()
      if (interruption === 'stream stalled') {
        assert.equal(value.status, 'ready')
        fire(90_000)
        await nextTurn()
        assert.equal(signals[0].aborted, true)
      }
      assert.equal(value.status, 'stale')
      assert.equal(value.windows[0].remaining, 52)
      const [quota] = render().props.summary[0].children
      assert.ok(descendants(quota.type(quota.props)).includes('上次'))
      fire(3000)
      await nextTurn()
      assert.equal(signals.length, 2)
      assert.equal(value, refreshed)
    } finally {
      cleanup()
      await nextTurn()
    }
    assert.equal(pending.size, 0)
    assert.equal(signals.at(-1).aborted, true)
  })
}

test('account details and the collapsed summary use the same human-readable plan labels', async () => {
  let plan
  const { render } = await mountFloating({
    async floatingPreferences() {
      return { ok: true, value: { enabled: true, position: null, items: { account: true } } }
    },
  }, {
    useState(initial) {
      return [initial === undefined ? { kind: 'account', status: 'signed-in', plan } : initial, () => {}]
    },
  })
  for (const [raw, expected] of [
    ['prolite', 'Pro 100'], ['pro', 'Pro 200'], ['promax', 'Pro 500'],
    ['plus', 'Plus'], ['go', 'Go'], ['education', 'Edu'],
    ['future_tier', 'future_tier'], ['constructor', 'constructor'],
  ]) {
    plan = raw
    const { summary, details } = render().props
    const [detail] = details[0].children
    const [compact] = summary[0].children
    assert.ok(descendants(detail.type(detail.props)).includes(expected), raw)
    assert.deepEqual(compact.type(compact.props).children, [expected], raw)
  }
})

test('the entire title bar toggles with a click but not after a drag', async () => {
  const { render } = await mountFloating({
    async floatingPreferences() {
      return { ok: true, value: { enabled: true, position: { x: 30, y: 40 }, items: { apiCost: true } } }
    },
  })
  const shell = render()
  let toggles = 0
  let moves = 0
  const onToggle = () => { toggles++ }
  const onMove = () => { moves++ }
  const view = shell.type({ ...shell.props, onToggle, onMove })
  view.props.ref.current = { getBoundingClientRect: () => ({ left: 30, top: 40 }) }
  const bar = view.children.find(node => node.props?.onPointerDown)
  assert.equal(bar.type, 'button')
  assert.equal(bar.props['aria-expanded'], true)
  assert.ok(descendants(bar).includes('ChatGPT Subscription'))

  const pointer = { button: 0, pointerId: 1, clientX: 40, clientY: 50, currentTarget: { setPointerCapture() {} } }
  bar.props.onPointerDown(pointer)
  bar.props.onPointerUp({ ...pointer, clientX: 41 })
  bar.props.onClick({ detail: 1 })
  assert.equal(toggles, 1)
  assert.equal(moves, 0)

  bar.props.onPointerDown(pointer)
  bar.props.onPointerUp({ ...pointer, clientX: 60 })
  bar.props.onClick({ detail: 1 })
  assert.equal(toggles, 1)
  assert.equal(moves, 1)

  bar.props.onPointerDown(pointer)
  bar.props.onPointerMove({ ...pointer, clientX: 60 })
  bar.props.onPointerUp(pointer)
  bar.props.onClick({ detail: 1 })
  assert.equal(toggles, 1)
  bar.props.onClick({ detail: 0 })
  assert.equal(toggles, 2)

  const collapsed = shell.type({ ...shell.props, collapsed: true, onToggle, onMove })
  const collapsedBar = collapsed.children.find(node => node.props?.onPointerDown)
  assert.equal(collapsedBar.type, 'button')
  assert.equal(collapsedBar.props['aria-expanded'], false)
  collapsedBar.props.onClick({ detail: 1 })
  assert.equal(toggles, 3)
})

const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const status = value => ({ ok: true, value: { type: 'status', status: value } })

function descendants(node) {
  if (Array.isArray(node)) return node.flatMap(descendants)
  return [node, ...(node?.children ?? []).flatMap(descendants)]
}

async function mountPanel(api, clipboard) {
  const hooks = []
  let index = 0
  let effect
  let Panel
  const client = await loadClient({ navigator: { clipboard }, react: {
    createElement(type, props, ...children) { return { type, props, children } },
    useState(initial) {
      const slot = index++
      if (!(slot in hooks)) hooks[slot] = initial
      return [hooks[slot], value => { hooks[slot] = value }]
    },
    useRef(initial) {
      const slot = index++
      return hooks[slot] ??= { current: initial }
    },
    useEffect(setup) { effect ??= setup },
  } })
  await client.apply({ remote: { $host: { isLoopback: true }, async $mount() {} },
    inject(_keys, register) { register({
      remote: { codexResponses: api },
      remoteAccess: { whenAccess(_method, setup) { setup() } },
      slots: { inject(_name, setup) { setup() }, register(entry, component) { if (entry.name === 'settings.section') Panel = component } },
    }) },
  })
  const render = () => {
    index = 0
    return descendants(Panel({ api }))
  }
  render()
  effect()
  await nextTurn()
  return {
    find: (type, label) => render().find(node => node?.type === type && node.children.includes(label)),
    hasText: label => render().includes(label),
  }
}

const verificationURL = 'https://auth.openai.com/codex/device'
const syntheticCode = 'TEST-1234'

function deviceLogin() {
  return {
    status: async () => status('signed-out'),
    async *login(signal) {
      yield { type: 'device', code: syntheticCode, url: verificationURL }
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    },
  }
}

test('device authorization copies the displayed code and removes it when cancelled', async () => {
  const copied = []
  const panel = await mountPanel(deviceLogin(), { async writeText(code) { copied.push(code) } })
  const login = panel.find('button', '使用设备码登录').props.onClick()
  await nextTurn()

  const copy = panel.find('button', '复制设备码')
  assert.ok(copy, 'the visible device code has a copy action')
  assert.equal(panel.find('a', '打开 OpenAI 验证页面').props.href, verificationURL)
  await copy.props.onClick()
  assert.deepEqual(copied, [syntheticCode])
  assert.ok(panel.hasText('设备码已复制。'))

  panel.find('button', '取消设备码登录').props.onClick()
  await login
  assert.equal(panel.hasText(syntheticCode), false)
  assert.equal(panel.hasText('设备码已复制。'), false)
})

test('device authorization provides a manual fallback when the clipboard is unavailable', async () => {
  const panel = await mountPanel(deviceLogin())
  const login = panel.find('button', '使用设备码登录').props.onClick()
  await nextTurn()

  const copy = panel.find('button', '复制设备码')
  assert.ok(copy, 'the visible device code has a copy action')
  await copy.props.onClick()
  assert.ok(panel.hasText('复制失败，请手动选择设备码。'))
  assert.ok(panel.find('code', syntheticCode))
  panel.find('button', '取消设备码登录').props.onClick()
  await login
})

test('sign-out disables actions and never offers device authorization cancellation', async () => {
  let finish
  const panel = await mountPanel({ status: async () => status('signed-in'), signOut: () => new Promise(resolve => { finish = resolve }) })
  const signOut = panel.find('button', '退出登录').props.onClick()

  assert.equal(panel.find('button', '取消设备码登录'), undefined)
  assert.ok(panel.hasText('正在退出登录…'))
  assert.equal(panel.find('button', '退出登录').props.disabled, true)

  finish(status('signed-out'))
  await signOut
  assert.ok(panel.find('button', '使用设备码登录'))
})
