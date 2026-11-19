import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettings } from '../src/settings.mjs'
import { createFloatingPreferences } from '../src/floating-preferences.mjs'

const owner = { kind: 'owner' }

test('only the owner can manage the provider', async () => {
  const calls = []
  const settings = createSettings({
    begin: async () => { calls.push('begin') },
    status: async () => { calls.push('status'); return 'signed-out' },
    signOut: async () => { calls.push('signOut') },
  })
  const guest = { kind: 'paired' }
  await assert.rejects(settings.status(guest), { code: 'remote-access/denied' })
  await assert.rejects(settings.signOut(guest), { code: 'remote-access/denied' })
  await assert.rejects(settings.login(guest).next(), { code: 'remote-access/denied' })
  await assert.rejects(settings.status(undefined), { code: 'remote-access/denied' })
  assert.deepEqual(calls, [])
  assert.deepEqual(await settings.status(owner), { type: 'status', status: 'signed-out' })
})

test('floating preferences and usage require a local owner', async () => {
  const prefs = { enabled: false, position: null, items: { apiCost: true } }
  const calls = []
  const floating = {
    read() { calls.push('read'); return prefs },
    update(patch) { calls.push('save'); return { ...prefs, ...patch } },
  }
  const estimator = {
    async *observe(id) { calls.push('scan'); yield { sessionId: id } },
  }
  const local = createSettings({ estimator, floating, local: () => true })
  const remote = createSettings({ estimator, floating, local: () => false })
  const guest = { kind: 'paired' }
  await assert.rejects(local.floatingPreferences(guest), { code: 'remote-access/denied' })
  await assert.rejects(remote.setFloatingPreferences(owner, { enabled: true }), { code: 'remote-access/denied' })
  await assert.rejects(remote.estimate(owner, 'session-a').next(), { code: 'remote-access/denied' })
  assert.deepEqual(calls, [])
  assert.deepEqual(await local.floatingPreferences(owner), prefs)
  assert.equal((await local.setFloatingPreferences(owner, { enabled: true })).enabled, true)
  const stream = local.estimate(owner, 'session-a')
  assert.deepEqual((await stream.next()).value, { sessionId: 'session-a' })
  await stream.return()
  assert.deepEqual(calls, ['read', 'save', 'scan'])
})

test('device code is delivered privately and cancellation aborts the authorization', async () => {
  let finished = false
  const settings = createSettings({
    status: async () => 'signed-out', async signOut() {},
    async begin(interaction, signal) {
      interaction.notify({ url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE', message: 'ignored' })
      return new Promise(resolve => signal.addEventListener('abort', () => {
        finished = true
        resolve({ status: 'cancelled' })
      }, { once: true }))
    },
  })
  const controller = new AbortController()
  const stream = settings.login(owner, controller.signal)
  assert.deepEqual((await stream.next()).value, { type: 'device', url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' })
  assert.deepEqual(await settings.status(owner), { type: 'status', status: 'signed-out' })
  await assert.rejects(settings.login(owner).next(), { code: 'codex-responses/login-in-progress' })
  await assert.rejects(settings.signOut(owner), { code: 'codex-responses/login-in-progress' })
  controller.abort()
  assert.equal((await stream.next()).done, true)
  assert.equal(finished, true)
})

test('each subscription stream requires a local owner and stops when its item is deselected', async () => {
  const floating = createFloatingPreferences({
    readPreferences: () => ({ enabled: true, items: { account: true, quota: false } }),
    writePreferences() {},
  })
  const calls = []
  const monitor = { async *observe(kind, signal) {
    calls.push(kind)
    yield { kind }
    assert.equal(signal.aborted, true)
  } }
  const local = createSettings({ floating, monitor, local: () => true })
  const remote = createSettings({ floating, monitor, local: () => false })
  await assert.rejects(remote.subscription(owner, 'account', 'settings').next(), { code: 'remote-access/denied' })
  await assert.rejects(local.subscription({ kind: 'paired' }, 'account', 'settings').next(), { code: 'remote-access/denied' })
  assert.equal((await local.subscription(owner, 'quota', 'floating').next()).done, true)
  const stream = local.subscription(owner, 'account', 'floating')
  assert.deepEqual((await stream.next()).value, { kind: 'account' })
  await floating.update({ items: { account: false, quota: true } })
  assert.equal((await stream.next()).done, true)
  assert.deepEqual(calls, ['account'])
})

test('the settings subscription remains available with the floating window off and stops with its caller', async () => {
  const controller = new AbortController()
  const floating = createFloatingPreferences({ readPreferences: () => ({ enabled: false }), writePreferences() {} })
  const monitor = { async *observe(kind, signal) {
    yield { kind }
    assert.equal(signal.aborted, true)
  } }
  const settings = createSettings({ floating, monitor, local: () => true })
  const observing = settings.subscription(owner, 'quota', 'settings', controller.signal)
  assert.deepEqual((await observing.next()).value, { kind: 'quota' })
  controller.abort()
  assert.equal((await observing.next()).done, true)
})

test('floating preferences restore an edge through storage and clear it on move or reset', async () => {
  let stored = { enabled: true, position: { x: 32, y: 51 } }
  const open = () => createFloatingPreferences({ readPreferences: () => stored, writePreferences: next => { stored = next } })
  const floating = open()
  assert.deepEqual((await floating.read()).position, { x: 32, y: 51 })
  for (const edge of ['left', 'right']) {
    const position = { x: edge === 'left' ? 0 : 740, y: 51, edge }
    await floating.update({ position })
    assert.deepEqual((await open().read()).position, position)
  }
  assert.deepEqual((await floating.update({ position: { x: 50, y: 80 } })).position, { x: 50, y: 80 })
  assert.equal((await floating.update({ position: null })).position, null)
  stored = { enabled: true, position: { x: 50, y: 80, edge: 'top' } }
  assert.deepEqual((await open().read()).position, { x: 50, y: 80 })
})

test('failed login drops all upstream details', async () => {
  const settings = createSettings({ async begin() { throw new Error('synthetic-secret') } })
  await assert.rejects(settings.login(owner).next(), error => error.code === 'codex-responses/login-failed'
    && !String(error).includes('synthetic-secret'))
})

test('an owner principal on a remote deployment cannot operate the sign-in', async () => {
  const settings = createSettings({ local: () => false, status: async () => 'signed-out' })
  await assert.rejects(settings.status(owner), { code: 'remote-access/denied' })
})

test('a classified OAuth exchange failure is exposed without the upstream detail', async () => {
  const settings = createSettings({ async begin() {
    throw Object.assign(new Error('synthetic-secret'), { code: 'CODEX_EXCHANGE_FAILED' })
  } })
  await assert.rejects(settings.login(owner).next(), error => error.code === 'codex-responses/exchange-failed'
    && !String(error).includes('synthetic-secret'))
})

test('only safe catalog diagnostics are included in the settings status', async () => {
  const settings = createSettings({ status: async () => 'signed-in', catalogStatus: async () => ({
    source: 'upstream', count: 5, identity: 'private-account', bearer: 'private-token',
  }) })
  assert.deepEqual(await settings.status(owner), { type: 'status', status: 'signed-in', catalog: { source: 'upstream', count: 5 } })
})
