import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettings } from '../src/settings.mjs'

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
