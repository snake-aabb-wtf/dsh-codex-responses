import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionUsageFold, summarizeUsage } from '../src/cost-usage.mjs'

const baseTime = Date.UTC(2026, 10, 19)
const codex = { provider: 'codex-responses', model: 'gpt-6.2-sol' }
const openai = { provider: 'openai', model: codex.model }
const position = { turn: 1, step: 1 }
const failure = { code: 'RATE_LIMIT', message: 'Synthetic rate limit' }

function event(seq, type, data) {
  return { seq, time: baseTime + seq * 1000, type, data }
}

function usageChunk(seq, usage) {
  return { type: 'chunk', time: baseTime + seq * 1000 - 1, chunk: { type: 'usage', usage } }
}

function message(seq, source, usage, stream = [], at = position) {
  return {
    ...event(seq, 'assistant/message', {
      ...at, message: { role: 'assistant', source, content: [] }, stream,
      ...usage === undefined ? {} : { usage },
    }),
    surfaceOp: 'append',
  }
}

function attempt(seq, usage, at = position) {
  return event(seq, 'assistant/attempt', {
    ...at, stream: [
      ...usage === undefined ? [] : [usageChunk(seq, usage)],
      { type: 'chunk', time: baseTime + seq * 1000 - 1, chunk: { type: 'finish', reason: { kind: 'error', failure } } },
    ],
  })
}

function schedule(seq, provider, retryId = 'retry-1', at = position) {
  return event(seq, 'llm/retry', {
    ...at, provider, retryId, retry: 1, policyKey: 'test', mode: 'normal', maxRetries: 2, delayMs: 1000, failure,
  })
}

function started(seq, retryId = 'retry-1', at = position) {
  return event(seq, 'llm/retry-started', { ...at, retryId, retry: 1 })
}

test('uses the settled assistant source to isolate Codex from the same OpenAI model', () => {
  const fold = createSessionUsageFold()
  const usage = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 13, totalTokens: 23 }
  fold.add([
    event(0, 'step/start', position),
    event(1, 'request/context', { ...codex, contextWindow: 100_000 }),
    message(2, codex, usage),
    event(3, 'step/end', position),
    event(4, 'step/start', { turn: 1, step: 2 }),
    event(5, 'request/context', { ...openai, contextWindow: 100_000 }),
    message(6, openai, usage, [], { turn: 1, step: 2 }),
    event(7, 'step/end', { turn: 1, step: 2 }),
    event(8, 'step/start', { turn: 2, step: 1 }),
    message(9, { provider: 'codex-responses', model: 'gpt-6.1-sol' }, usage, [], { turn: 2, step: 1 }),
  ])
  assert.deepEqual(fold.snapshot(), {
    requests: [
      { model: 'gpt-6.2-sol', time: baseTime, inputTokens: 7, outputTokens: 3, cacheReadTokens: 13, cacheWriteTokens: 0 },
      { model: 'gpt-6.1-sol', time: baseTime + 8000, inputTokens: 7, outputTokens: 3, cacheReadTokens: 13, cacheWriteTokens: 0 },
    ],
    unpriced: 0,
  })
})

test('replaces a usage sample in the same attempt and preserves the first durable time across batches', () => {
  const fold = createSessionUsageFold()
  const partialStreamUsage = { inputTokens: 25, outputTokens: 2 }
  const usage = { inputTokens: 9, outputTokens: 7, cacheReadTokens: 11, cacheWriteTokens: 3, reasoningTokens: 5, totalTokens: 30 }
  const first = attempt(0, partialStreamUsage)
  const settled = message(1, codex, usage, [usageChunk(1, partialStreamUsage)])
  fold.add([first])
  assert.deepEqual(fold.snapshot(), { requests: [], unpriced: 0 })
  fold.add([first, settled])
  fold.add([settled])
  assert.deepEqual(fold.snapshot(), {
    requests: [{ model: codex.model, time: baseTime, inputTokens: 9, outputTokens: 7, cacheReadTokens: 11, cacheWriteTokens: 3 }],
    unpriced: 0,
  })
})

test('uses the last compact usage chunk when the message has no explicit sample', () => {
  const fold = createSessionUsageFold()
  const earlier = { inputTokens: 25, outputTokens: 1 }
  const later = { inputTokens: 25, outputTokens: 3, cacheReadTokens: 5 }
  fold.add([message(0, codex, undefined, [
    usageChunk(0, earlier),
    { type: 'reasoning-chunks', time0: baseTime - 1, index: 0, dt: [], texts: ['fixture'] },
    usageChunk(0, later),
    { type: 'chunk', time: baseTime, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ])])
  assert.deepEqual(fold.snapshot(), {
    requests: [{ model: codex.model, time: baseTime, inputTokens: 25, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 0 }],
    unpriced: 0,
  })
})

test('counts a native retry separately once same-step source confirms its model', () => {
  const fold = createSessionUsageFold()
  const usage = { inputTokens: 20, outputTokens: 3 }
  fold.add([
    event(0, 'step/start', position),
    event(1, 'request/context', { ...codex, contextWindow: 100_000 }),
    attempt(2, usage),
    schedule(3, codex.provider),
  ])
  assert.deepEqual(fold.snapshot(), { requests: [], unpriced: 0 })
  const retry = started(4)
  const end = message(5, codex, usage)
  fold.add([retry, end])
  fold.add([retry, end, event(6, 'step/end', position)])
  assert.deepEqual(fold.snapshot(), {
    requests: [
      { model: codex.model, time: baseTime, inputTokens: 20, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: codex.model, time: baseTime + 4000, inputTokens: 20, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
    unpriced: 0,
  })
})

test('requires same-step corroboration for prior failed attempts and ignores sticky context', () => {
  const usage = { inputTokens: 20, outputTokens: 3 }
  for (const [name, events, count] of [
    ['a Codex schedule and context alone', [
      event(0, 'step/start', position), event(1, 'request/context', codex), attempt(2, usage),
      schedule(3, codex.provider), started(4), event(5, 'step/end', position),
    ], 0],
    ['a different provider before the retry', [
      attempt(0, usage), schedule(1, openai.provider), started(2), message(3, codex, usage),
    ], 1],
    ['a different model before the retry', [
      event(0, 'step/start', position), event(1, 'request/context', { ...codex, model: 'gpt-other' }),
      attempt(2, usage), schedule(3, codex.provider), started(4), message(5, codex, usage),
    ], 1],
    ['an unmatched retry id', [
      attempt(0, usage), schedule(1, codex.provider), started(2, 'different-retry'), message(3, codex, usage),
    ], 1],
    ['a different step with the same source', [
      attempt(0, usage), schedule(1, codex.provider), started(2),
      message(3, codex, usage, [], { turn: 1, step: 2 }),
    ], 1],
    ['a source-less settlement and a Codex context', [
      event(0, 'request/context', codex), event(1, 'step/start', position), message(2, undefined, usage),
    ], 0],
    ['an exact-provider mismatch', [
      message(0, { ...codex, provider: 'Codex-Responses' }, usage),
    ], 0],
  ]) {
    const fold = createSessionUsageFold()
    fold.add(events)
    assert.equal(fold.snapshot().requests.length, count, name)
    assert.equal(fold.snapshot().unpriced, 0, name)
  }
})

test('excludes the inherited prefix across incremental and replayed fork reads', () => {
  const fold = createSessionUsageFold(4)
  const usage = { inputTokens: 20, outputTokens: 3 }
  const inherited = [
    event(0, 'step/start', position),
    message(1, codex, usage),
    event(2, 'step/end', position),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  fold.add(inherited.slice(0, 2))
  const seed = event(4, 'session/end-seed', { inherited: true })
  fold.add([...inherited, seed])
  assert.deepEqual(fold.snapshot(), { requests: [], unpriced: 0 })
  const next = { turn: 2, step: 1 }
  fold.add([seed, event(5, 'step/start', next), message(6, codex, usage, [], next)])
  assert.deepEqual(fold.snapshot(), {
    requests: [{ model: codex.model, time: baseTime + 5000, inputTokens: 20, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    unpriced: 0,
  })
})

test('counts known Codex settlements with missing or invalid usage once', () => {
  const fold = createSessionUsageFold()
  const samples = [
    undefined,
    { inputTokens: 20 },
    { inputTokens: -1, outputTokens: 3 },
    { inputTokens: 2, outputTokens: 0, cacheReadTokens: null },
    { inputTokens: 2, outputTokens: 1, totalTokens: 4 },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ]
  fold.add(samples.map((usage, seq) => message(seq, codex, usage, [], { turn: 1, step: seq + 1 })))
  const snapshot = fold.snapshot()
  assert.deepEqual(snapshot, { requests: [], unpriced: 6 })
  assert.deepEqual(summarizeUsage(snapshot, () => undefined), { usd: 0, priced: 0, unpriced: 6 })
})

test('keeps the previous sample if a replacement reports no usage', () => {
  const fold = createSessionUsageFold()
  fold.add([attempt(0, { inputTokens: 10, outputTokens: 3 }), message(1, codex)])
  assert.deepEqual(fold.snapshot(), {
    requests: [{ model: codex.model, time: baseTime, inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    unpriced: 0,
  })
})

test('prices disjoint buckets using the prompt total and keeps the exact request time', () => {
  const short = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }
  const long = { threshold: 100, rates: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 } }
  const fold = createSessionUsageFold()
  fold.add([
    message(0, codex, { inputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 10, reasoningTokens: 9 }),
    message(1, codex, { inputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 31, outputTokens: 10 }, [], { turn: 1, step: 2 }),
    message(2, { ...codex, model: 'unlisted' }, { inputTokens: 1, outputTokens: 1 }, [], { turn: 1, step: 3 }),
  ])
  const lookups = []
  const totals = summarizeUsage(fold.snapshot(), (model, time) => {
    lookups.push([model, time])
    return model === codex.model ? { short, long } : undefined
  })
  assert.deepEqual(lookups, [[codex.model, baseTime], [codex.model, baseTime + 1000], ['unlisted', baseTime + 2000]])
  assert.deepEqual(totals, { usd: 0.00245, priced: 2, unpriced: 1 })
})

test('leaves a cache write unpriced until the applicable rate is known', () => {
  const fold = createSessionUsageFold()
  fold.add([
    message(0, codex, { inputTokens: 0, outputTokens: 1, cacheReadTokens: 10 }),
    message(1, codex, { inputTokens: 0, outputTokens: 1, cacheWriteTokens: 10 }, [], { turn: 1, step: 2 }),
  ])
  const snapshot = fold.snapshot()
  const short = { input: 5, cacheRead: 0.1, output: 1 }
  assert.deepEqual(summarizeUsage(snapshot, () => ({ short })), { usd: 0.000002, priced: 1, unpriced: 1 })
  assert.deepEqual(summarizeUsage(snapshot, () => ({ short: { ...short, cacheWrite: 2 } })),
    { usd: 0.000023, priced: 2, unpriced: 0 })
})
