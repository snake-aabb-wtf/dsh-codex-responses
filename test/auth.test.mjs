import assert from 'node:assert/strict'
import test from 'node:test'
import { createCredentialStore, runDeviceLogin } from '../src/auth.mjs'

const key = 'dsh-codex/codex-responses'
const fixture = (label, expires = Date.now() + 3_600_000) => ({
  type: 'oauth', access: `synthetic-access-${label}`, refresh: `synthetic-refresh-${label}`,
  accountId: 'synthetic-account', expires,
})
const record = payload => ({ kind: 'grant', payload })

function harness(initial) {
  const records = new Map([['unrelated/provider', record(fixture('unrelated'))]])
  if (initial) records.set(key, initial)
  let queue = Promise.resolve()
  const serialize = operation => {
    const task = queue.then(operation)
    queue = task.catch(() => {})
    return task
  }
  return {
    records,
    credentials: {
      readRecord: async name => records.get(name),
      modifyRecord: (name, mutate) => serialize(async () => {
        const result = await mutate(records.get(name))
        if (result !== undefined) records.set(name, result)
        return records.get(name)
      }),
      deleteRecord: name => serialize(() => { records.delete(name) }),
    },
  }
}

test('login forces the device method and only relays the browser URL and code', async () => {
  const writes = []
  const notices = []
  await runDeviceLogin({ signal: new AbortController().signal, notify: value => notices.push(value),
    commit: async value => { writes.push(value) },
  }, {
    login: async ({ signal, notify, prompt }) => {
      assert.equal(signal.aborted, false)
      assert.equal(await prompt({ type: 'select', options: [{ id: 'browser' }, { id: 'device_code' }] }), 'device_code')
      notify({ type: 'device_code', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE', access: 'never-emit' })
      notify({ type: 'status', message: 'never-emit' })
      return fixture('new')
    },
  })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].payload.access, 'synthetic-access-new')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].url, 'https://auth.openai.com/codex/device')
  assert.equal(notices[0].code, 'TEST-CODE')
  assert.doesNotMatch(JSON.stringify(notices), /never-emit/)
})

test('cancelled, rejected, and malformed logins never commit', async () => {
  const controller = new AbortController()
  const writes = []
  const session = { signal: controller.signal, notify() {}, async commit(value) { writes.push(value) } }
  const leak = 'secret-in-provider-error'
  await assert.rejects(runDeviceLogin(session, { login: async () => { throw new Error(leak) } }), error => {
    assert.doesNotMatch(String(error), new RegExp(leak))
    return true
  })
  await assert.rejects(runDeviceLogin(session, { login: async () => ({ access: leak }) }))
  await assert.rejects(runDeviceLogin(session, { login: async () => {
    controller.abort()
    return fixture('late')
  } }), { name: 'AbortError' })
  assert.deepEqual(writes, [])
})

test('concurrent callers rotate an expiring grant only once, and status has no secrets', async () => {
  const expired = fixture('expired', Date.now() - 1)
  const next = fixture('renewed')
  const { credentials, records } = harness(record(expired))
  const left = createCredentialStore(credentials, key)
  const right = createCredentialStore(credentials, key)
  let count = 0
  const oauth = { async refresh(current, signal) {
    assert.equal(current.refresh, expired.refresh)
    assert.equal(signal.aborted, false)
    count++
    await Promise.resolve()
    return next
  } }
  assert.deepEqual(await Promise.all([left.accessToken(oauth), right.accessToken(oauth)]), [next.access, next.access])
  assert.equal(count, 1)
  assert.equal(records.get(key).payload.refresh, next.refresh)
  assert.equal(await left.status(), 'signed-in')
  await left.signOut()
  assert.equal(await left.status(), 'signed-out')
  assert.equal(records.has('unrelated/provider'), true)
})

test('refresh preserves a grant on transient failure but quarantines a revoked grant', async () => {
  const expired = fixture('expired', 1)
  const { credentials, records } = harness(record(expired))
  const store = createCredentialStore(credentials, key)
  await assert.rejects(store.accessToken({ async refresh() {
    throw new Error('OpenAI Codex token refresh failed (429): private upstream data')
  } }), error => error.code === 'CODEX_REFRESH_UNAVAILABLE' && !String(error).includes('private'))
  assert.equal(records.get(key).payload.refresh, expired.refresh)
  await assert.rejects(store.accessToken({ async refresh() {
    throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant","access_token":"private"}')
  } }), { code: 'CODEX_RELOGIN_REQUIRED' })
  assert.equal(await store.status(), 'relogin-required')
  let retried = false
  await assert.rejects(store.accessToken({ async refresh() { retried = true } }), { code: 'CODEX_RELOGIN_REQUIRED' })
  assert.equal(retried, false)
  assert.doesNotMatch(JSON.stringify(records.get(key)), /synthetic/)
})

test('invalid local records do not trigger OAuth or present usable models', async () => {
  const { credentials } = harness(record({ type: 'oauth', access: 'not-a-valid-record' }))
  const store = createCredentialStore(credentials, key)
  assert.equal(await store.status(), 'relogin-required')
  await assert.rejects(store.accessToken({}), { code: 'CODEX_RELOGIN_REQUIRED' })
})

test('a cancelled attempt cannot replace a grant while waiting for the credential lock', async () => {
  const previously = fixture('old')
  const { credentials, records } = harness(record(previously))
  const release = Promise.withResolvers()
  const locked = credentials.modifyRecord(key, () => release.promise)
  const controller = new AbortController()
  const store = createCredentialStore(credentials, key)
  const writing = store.save(record(fixture('new')), controller.signal)
  controller.abort()
  release.resolve(undefined)
  await locked
  await assert.rejects(writing, { name: 'AbortError' })
  assert.equal(records.get(key).payload.access, previously.access)
})

test('account display reads legacy token claims and picks up refreshed fields', async () => {
  const old = fixture('legacy', Date.now() - 1)
  const payload = { 'https://api.openai.com/profile': { email: 'owner@example.com' },
    'https://api.openai.com/auth': { chatgpt_account_id: old.accountId } }
  old.access = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`
  const { credentials, records } = harness(record(old))
  const store = createCredentialStore(credentials, key)
  assert.deepEqual(await store.accountProfile(), {
    status: 'signed-in', accountId: old.accountId, email: 'owner@example.com', plan: null,
  })
  await store.accessToken({ async refresh() {
    return { ...fixture('next'), profile: { email: 'owner@example.com', plan: 'pro', idToken: 'never-store' } }
  } })
  assert.deepEqual(await store.accountProfile(), {
    status: 'signed-in', accountId: old.accountId, email: 'owner@example.com', plan: 'pro',
  })
  assert.doesNotMatch(JSON.stringify(records.get(key)), /never-store/)
  await store.signOut()
  assert.deepEqual(await store.accountProfile(), { status: 'signed-out' })
})
