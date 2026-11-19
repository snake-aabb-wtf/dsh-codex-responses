import assert from 'node:assert/strict'
import test from 'node:test'
import { createCostEstimator } from '../src/cost-estimator.mjs'
import { createFloatingPreferences } from '../src/floating-preferences.mjs'

const rate = { short: { input: 2, output: 10, cacheRead: .1 } }
const model = 'gpt-6.2-sol'
const event = (seq, provider = 'codex-responses') => ({
  type: 'assistant/message', seq, time: 1000 + seq,
  data: { turn: seq, step: 0, message: { source: { provider, model } },
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
})

function fixture({ beforeObservation, pricing, archived = false, saved } = {}) {
  const sessions = new Map([['a', [event(0), event(1, 'openai')]], ['b', [event(0)]]])
  const live = new Map([...sessions].map(([id, events]) => [id, { get seq() { return events.length } }]))
  const revision = id => archived ? `rev-${sessions.get(id).length}` : undefined
  const reads = []
  const writes = []
  const syncs = []
  const lifetime = new AbortController()
  const floating = createFloatingPreferences({ signal: lifetime.signal,
    readPreferences: async () => saved, writePreferences: async value => { writes.push(value) } })
  const estimator = createCostEstimator({ signal: lifetime.signal, interval: 1,
    floating,
    pricing: { getRate: () => rate, getLastSync: () => null, getRevision: () => 0,
      async sync(ids) { syncs.push([...ids]) }, ...pricing },
    publishedModelIds: () => ['new-model-without-usage'],
    query: {
      async listSessions() { return [...sessions.keys()].map(id => ({ header: { id }, revision: revision(id) })) },
      async observeSession(id) {
        reads.push(id)
        beforeObservation?.(id)
        const events = sessions.get(id).slice()
        return { source: archived ? 'prepared' : 'live', events, cursor: events.length - 1,
          revision: revision(id), inheritedEventCount: 0, [Symbol.dispose]() {} }
      },
    },
    liveSession: id => archived ? undefined : live.get(id),
  })
  return { estimator, floating, lifetime, sessions, reads, writes, syncs }
}

test('estimates are opt-in, are separated by session, and reuse unchanged histories', async () => {
  const { estimator, floating, lifetime, sessions, reads, writes, syncs } = fixture()
  assert.deepEqual(await floating.read(), { enabled: false, position: null, items: { apiCost: true, account: false, quota: false } })
  assert.equal((await estimator.observe('a').next()).done, true)
  assert.deepEqual(reads, [])

  await floating.update({ enabled: true })
  const first = estimator.observe('a')
  const snapshot = (await first.next()).value
  assert.deepEqual(snapshot.current, { usd: .003, priced: 1, unpriced: 0, awaitingRates: 0 })
  assert.deepEqual(snapshot.total, { usd: .006, priced: 2, unpriced: 0, awaitingRates: 0 })
  assert.deepEqual(reads, ['a', 'b'])
  assert.ok(syncs.some(ids => ids.includes('new-model-without-usage')))

  sessions.get('a').push(event(2))
  const updated = (await first.next()).value
  assert.equal(updated.current.priced, 2)
  assert.deepEqual(reads, ['a', 'b', 'a'])

  sessions.delete('b')
  const updatedTotal = (await first.next()).value
  assert.deepEqual(updatedTotal.total, updatedTotal.current)

  await floating.update({ position: { x: 32, y: 48 } })
  await floating.update({ enabled: false })
  assert.equal((await first.next()).done, true)
  assert.deepEqual(writes.at(-1), { enabled: false, position: { x: 32, y: 48 }, items: { apiCost: true, account: false, quota: false } })
  lifetime.abort()
})

test('legacy estimator preferences keep their enabled state and position', async () => {
  const legacy = { enabled: true, position: { x: 170, y: 98 } }
  const { floating, writes } = fixture({ saved: legacy })
  assert.deepEqual(await floating.read(), { ...legacy, items: { apiCost: true, account: false, quota: false } })
  await floating.update({ enabled: false })
  assert.deepEqual(writes.at(-1), { ...legacy, enabled: false, items: { apiCost: true, account: false, quota: false } })
})

test('selecting a content item does not open the window, and deselection stops an active estimator', async () => {
  const { floating, estimator, reads, syncs } = fixture({ saved: { enabled: false, items: { apiCost: false } } })
  await floating.update({ items: { apiCost: true } })
  assert.equal((await estimator.observe('a').next()).done, true)
  assert.deepEqual(reads, [])
  assert.deepEqual(syncs, [])

  await floating.update({ enabled: true })
  const stream = estimator.observe('a')
  assert.equal((await stream.next()).value.total.usd, .006)
  await floating.update({ items: { apiCost: false } })
  assert.equal((await stream.next()).done, true)
  assert.equal((await floating.read()).enabled, true)
  assert.equal((await estimator.observe('a').next()).done, true)
  await floating.update({ enabled: false })
  await floating.update({ enabled: true })
  assert.equal((await floating.read()).items.apiCost, false)
})

test('a fee update during a history scan uses one pricing version for both totals', async () => {
  let repriced = false
  const { estimator, floating } = fixture({ beforeObservation: id => { if (id === 'b') repriced = true }, pricing: {
    getRate: () => repriced ? { short: { input: 4, output: 20, cacheRead: .2 } } : rate,
    getLastSync: () => Number(repriced),
  } })
  await floating.update({ enabled: true })
  const stream = estimator.observe('a')
  const { value } = await stream.next()
  assert.equal(value.ratesSyncedAt, 1)
  assert.equal(value.current.usd, .006)
  assert.equal(value.total.usd, .012)
  await stream.return()
})

test('an additional verified rate refreshes the estimate even at the same sync timestamp', { timeout: 1000 }, async () => {
  let revision = 0
  const { estimator, floating } = fixture({ pricing: {
    getRate: () => revision === 0 ? undefined : rate,
    getLastSync: () => 123,
    getRevision: () => revision,
  } })
  await floating.update({ enabled: true })
  const stream = estimator.observe('a')
  assert.equal((await stream.next()).value.current.awaitingRates, 1)
  revision++
  assert.equal((await stream.next()).value.total.usd, .006)
  await stream.return()
})

test('archived histories are loaded again only when their persistence revision changes', { timeout: 1000 }, async () => {
  const { estimator, floating, sessions, reads } = fixture({ archived: true })
  await floating.update({ enabled: true })
  const stream = estimator.observe('a')
  await stream.next()
  assert.deepEqual(reads, ['a', 'b'])
  sessions.get('b').push(event(1))
  const { value } = await stream.next()
  assert.equal(value.current.priced, 1)
  assert.equal(value.total.priced, 3)
  assert.deepEqual(reads, ['a', 'b', 'b'])
  await stream.return()
})

test('an unreadable history is visible as a partial total without discarding readable sessions', async () => {
  const { estimator, floating } = fixture({ beforeObservation: id => { if (id === 'a') throw new Error('unreadable') } })
  await floating.update({ enabled: true })
  const stream = estimator.observe('a')
  const { value } = await stream.next()
  assert.equal(value.current, null)
  assert.equal(value.currentUnavailable, true)
  assert.equal(value.unreadableSessions, 1)
  assert.equal(value.total.usd, .003)
  await stream.return()
})

test('deselecting the pricing content aborts an in-flight public pricing sync', { timeout: 1000 }, async () => {
  const started = Promise.withResolvers()
  const stopped = Promise.withResolvers()
  const { estimator, floating } = fixture({ pricing: { sync(_ids, signal) {
    started.resolve()
    signal.addEventListener('abort', () => stopped.resolve(), { once: true })
    return stopped.promise
  } } })
  await floating.update({ enabled: true })
  const stream = estimator.observe('a')
  await stream.next()
  await started.promise
  await floating.update({ items: { apiCost: false } })
  await stopped.promise
  assert.equal((await stream.next()).done, true)
})

test('a session switch aborts the old scan and yields a fresh snapshot for the new selection', async () => {
  const { estimator, floating, lifetime } = fixture()
  await floating.update({ enabled: true })
  const first = new AbortController()
  const former = estimator.observe('a', first.signal)
  await former.next()
  first.abort()
  assert.equal((await former.next()).done, true)

  const next = estimator.observe('b')
  const snapshot = (await next.next()).value
  assert.equal(snapshot.sessionId, 'b')
  assert.equal(snapshot.current.priced, 1)
  await next.return()
  lifetime.abort()
})
