import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { z } from 'zod'
import { TYPERT } from '../src/typert.mjs'

async function loadClient({ react = {}, navigator } = {}) {
  let client
  const source = await readFile(new URL('../src/client.cjs', import.meta.url), 'utf8')
  runInNewContext(source, { AbortController, navigator, window: { __ModuleLoader__: { load({ factory }) {
    client = factory(id => id === 'zod' ? { z } : react)
  } } } })
  return client
}

test('client bundle mounts the same strict Remote contracts as the Host', async () => {
  const client = await loadClient()
  let mounted, injected
  await client.apply({ remote: { $host: { isLoopback: true }, async $mount(contribution) { mounted = contribution } },
    inject(keys, register) { injected = keys; register({ remote: { codexResponses: {} }, remoteAccess: { whenAccess() {} } }) },
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

  assert.deepEqual(entries, [])
  grantAccess()
  assert.deepEqual(slots, ['settings.section', 'shell.overlay', 'conversation.session.header.utilities'])
  assert.deepEqual(entries.filter(entry => entry.name.startsWith('settings.')).map(({ name, id, label }) => ({ name, id, label })), [
    { name: 'settings.section', id: 'codex-responses', label: 'ChatGPT Codex' },
  ])
})

test('the estimator starts disabled and waits for the saved Host preference before enabling', async () => {
  const client = await loadClient()
  let resolveSave
  let cost
  const remote = {
    async estimatorPreferences() { return { ok: true, value: { enabled: false, position: null } } },
    setEstimatorPreferences() { return new Promise(resolve => { resolveSave = resolve }) },
  }
  await client.apply({ remote: { $host: { isLoopback: true }, async $mount() {} },
    inject(_keys, register) { register({ remote: { codexResponses: remote },
      remoteAccess: { whenAccess(_method, setup) { setup() } },
      slots: { inject(_name, setup) { setup() }, register(entry) {
        if (entry.name === 'shell.overlay') cost = entry.inject().cost
      } },
    }) },
  })
  await cost.load()
  assert.equal(cost.get().preferences.enabled, false)
  const saving = cost.save({ enabled: true })
  assert.equal(cost.get().preferences.enabled, false)
  resolveSave({ ok: true, value: { enabled: true, position: null } })
  await saving
  assert.equal(cost.get().preferences.enabled, true)

  const disable = cost.save({ enabled: false })
  assert.equal(cost.get().preferences.enabled, false)
  resolveSave({ ok: true, value: { enabled: false, position: null } })
  await disable
})

const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const status = value => ({ ok: true, value: { type: 'status', status: value } })

function descendants(node) {
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
