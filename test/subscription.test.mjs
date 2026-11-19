import assert from 'node:assert/strict'
import test from 'node:test'
import { createSubscriptionMonitor } from '../src/subscription.mjs'

const account = { status: 'signed-in', accountId: 'test-account', email: 'owner@example.com', plan: 'plus' }
const window = (used_percent, limit_window_seconds = 18_000, reset_at = 2_000_000_000) => ({
  used_percent, limit_window_seconds, reset_at,
})

function fixture(fetch, interval = 4) {
  const controller = new AbortController()
  let profile = account
  const monitor = createSubscriptionMonitor({
    credentials: {
      accountProfile: async () => profile,
      accessToken: async (_oauth, expected) => {
        assert.equal(expected, profile.accountId)
        return 'synthetic-access'
      },
    },
    fetch, interval, now: () => 1_900_000_000_000,
  })
  return {
    monitor, controller, setProfile: next => { profile = next; monitor.invalidate() },
    watch: kind => monitor.observe(kind, controller.signal),
  }
}

test('account-only reads never request usage and return only display fields', async () => {
  const { watch, controller, setProfile } = fixture(async () => assert.fail('Unexpected usage request'))
  const stream = watch('account')
  assert.deepEqual((await stream.next()).value, {
    kind: 'account', status: 'signed-in', email: 'owner@example.com', plan: 'plus',
  })
  setProfile({ status: 'signed-out' })
  assert.deepEqual((await stream.next()).value, {
    kind: 'account', status: 'signed-out', email: null, plan: null,
  })
  controller.abort()
  assert.equal((await stream.next()).done, true)
})

test('Codex usage uses the active workspace and exposes only valid dynamic quota windows', async () => {
  const { watch, controller } = fixture(async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage')
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, 'Bearer synthetic-access')
    assert.equal(init.headers['ChatGPT-Account-Id'], account.accountId)
    return Response.json({ plan_type: 'pro', rate_limit: {
      primary_window: window(27, 604_800), secondary_window: window(101),
    }, private: 'do-not-expose' })
  })
  const stream = watch('quota')
  assert.deepEqual((await stream.next()).value, {
    kind: 'quota', status: 'ready', updatedAt: 1_900_000_000_000,
    windows: [{ remaining: 73, durationSeconds: 604_800, resetsAt: 2_000_000_000_000 }],
  })
  controller.abort()
  await stream.return()
})

test('transient errors keep the last result, but an account change clears it', async () => {
  let calls = 0
  const { watch, controller, setProfile } = fixture(async () => {
    if (++calls === 1) return Response.json({ rate_limit: { primary_window: window(12) } })
    return new Response(null, { status: 503 })
  })
  const stream = watch('quota')
  const ready = (await stream.next()).value
  assert.equal(ready.status, 'ready')
  assert.deepEqual((await stream.next()).value, { ...ready, status: 'stale' })
  setProfile({ ...account, accountId: 'other-account' })
  assert.deepEqual((await stream.next()).value, { kind: 'quota', status: 'unavailable', updatedAt: null, windows: [] })
  controller.abort()
  await stream.return()
})

test('quota polls send a frame even when the last reading is unchanged', async t => {
  let calls = 0
  const { watch, controller } = fixture(async () => {
    if (++calls === 1) return Response.json({ rate_limit: { primary_window: window(12) } })
    return new Response(null, { status: 503 })
  })
  const stream = watch('quota')
  const fallback = setTimeout(() => controller.abort(), 500)
  t.after(async () => { clearTimeout(fallback); controller.abort(); await stream.return() })
  assert.equal((await stream.next()).value.status, 'ready')
  const stale = (await stream.next()).value
  assert.equal(stale.status, 'stale')
  assert.deepEqual(await stream.next(), { done: false, value: stale })
  assert.equal(calls, 3)
})

test('subscription cancellation aborts an in-flight usage request', async () => {
  const started = Promise.withResolvers()
  const { watch, controller } = fixture(async (_url, { signal }) => {
    started.resolve(signal)
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const stream = watch('quota')
  const reading = stream.next()
  const request = await started.promise
  controller.abort()
  assert.equal(request.aborted, true)
  assert.equal((await reading).done, true)
})

test('two views share a usage request and closing one keeps the other connected', async () => {
  const started = Promise.withResolvers()
  const result = Promise.withResolvers()
  let calls = 0
  const { monitor, watch, controller } = fixture(async (_url, { signal }) => {
    calls++
    started.resolve(signal)
    return result.promise
  }, 1000)
  const first = watch('quota')
  const firstReading = first.next()
  const request = await started.promise
  const secondController = new AbortController()
  const second = monitor.observe('quota', secondController.signal)
  const secondReading = second.next()
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.equal(calls, 1)
  assert.equal(request.aborted, false)
  result.resolve(Response.json({ rate_limit: { primary_window: window(25) } }))
  assert.equal((await firstReading).done, true)
  assert.equal((await secondReading).value.windows[0].remaining, 75)
  secondController.abort()
  await second.return()
})

test('same-workspace sign-in invalidates a late response from the previous login', async () => {
  const started = Promise.withResolvers()
  const late = Promise.withResolvers()
  let calls = 0
  const { watch, controller, setProfile } = fixture(async (_url, { signal }) => {
    if (++calls === 1) {
      started.resolve(signal)
      return late.promise
    }
    return Response.json({ rate_limit: { primary_window: window(81) } })
  })
  const stream = watch('quota')
  const waiting = stream.next()
  const first = await started.promise
  setProfile({ ...account, email: 'other@example.com' })
  assert.equal(first.aborted, true)
  late.resolve(Response.json({ rate_limit: { primary_window: window(3) } }))
  assert.equal((await waiting).value.windows[0].remaining, 19)
  controller.abort()
  await stream.return()
})
