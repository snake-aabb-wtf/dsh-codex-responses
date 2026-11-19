import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelCatalog } from '../src/model-catalog.mjs'

const fallback = [{ id: 'bundled-only' }]
const remoteRow = { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list', input_modalities: ['text', 'image'],
  context_window: 500000, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }],
}

function setup(fetch) {
  let identity = 'account-one'
  let now = 0
  const catalog = createModelCatalog({ credentials: {
    catalogIdentity: async () => identity,
    accessToken: async (_oauth, expected) => {
      assert.equal(expected, identity)
      return 'synthetic-bearer'
    },
  }, fetch, bundled: fallback, now: () => now })
  return { catalog, switchTo: value => { identity = value }, expire: () => { now += 600_000 } }
}

test('fetches one authenticated catalog concurrently and discards hidden rows and non-metadata fields', async () => {
  let requests = 0
  const { catalog } = setup(async (url, options) => {
    requests++
    assert.equal(new URL(url).origin + new URL(url).pathname, 'https://chatgpt.com/backend-api/codex/models')
    assert.match(new URL(url).searchParams.get('client_version'), /^\d+\.\d+\.\d+$/)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic-bearer')
    return Response.json({ models: [{ ...remoteRow, base_instructions: 'untrusted prompt', supported_in_api: false },
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }, { slug: '../../invalid', visibility: 'list' }] })
  })
  const [first, second] = await Promise.all([catalog.load(), catalog.load()])
  assert.equal(requests, 1)
  assert.strictEqual(first, second)
  assert.deepEqual(first.models.map(model => model.id), ['gpt-6.2-sol'])
  assert.doesNotMatch(JSON.stringify(first.models), /untrusted prompt/)
  assert.equal(first.models[0].contextWindow, 500000)
  assert.equal(first.models[0].thinkingLevelMap.off, null)
  assert.equal(first.source, 'upstream')
})

test('transient failures fall back only before an authoritative result; empty stays empty', async () => {
  let sequence = 0
  const { catalog, expire } = setup(async () => {
    sequence++
    if (sequence === 1) throw new TypeError('network down')
    if (sequence === 2) return Response.json({ models: [] })
    return new Response('private upstream error', { status: 503 })
  })
  const bundled = await catalog.load()
  assert.deepEqual(bundled.models, fallback)
  assert.equal(bundled.source, 'bundled')
  expire()
  assert.deepEqual((await catalog.load()).models, [])
  expire()
  assert.deepEqual((await catalog.load()).models, [])
})

test('never restores static or cached names after an access denial; a different account starts clean', async () => {
  let request = 0
  const { catalog, expire, switchTo } = setup(async () => {
    request++
    if (request === 1) return Response.json({ models: [remoteRow] })
    return new Response('', { status: request === 2 ? 403 : 503 })
  })
  assert.deepEqual((await catalog.load()).models.map(model => model.id), ['gpt-6.2-sol'])
  expire()
  assert.deepEqual((await catalog.load()).models, [])
  expire()
  assert.deepEqual((await catalog.load()).models, [])
  switchTo('account-two')
  assert.deepEqual((await catalog.load()).models, fallback)
  switchTo(undefined)
  assert.deepEqual((await catalog.load()).models, [])
  assert.equal(request, 4)
})

test('late results cannot publish after sign-out or account replacement', async () => {
  const started = Promise.withResolvers()
  const oldRequest = Promise.withResolvers()
  let count = 0
  const { catalog, switchTo } = setup(async () => {
    if (++count === 1) { started.resolve(); return oldRequest.promise }
    return Response.json({ models: [{ ...remoteRow, slug: 'account-two-only' }] })
  })
  const first = catalog.load()
  await started.promise
  switchTo('account-two')
  const second = await catalog.load()
  oldRequest.resolve(Response.json({ models: [remoteRow] }))
  assert.deepEqual((await first).models, [])
  assert.deepEqual(second.models.map(model => model.id), ['account-two-only'])
  switchTo(undefined)
  assert.deepEqual((await catalog.load()).models, [])
})

test('a malformed success is not treated as a network outage', async () => {
  const { catalog } = setup(async () => Response.json({ unexpected: [] }))
  assert.deepEqual((await catalog.load()).models, [])
})

test('a broken response body preserves the authoritative catalog', async () => {
  let requests = 0
  const { catalog, expire } = setup(async () => ++requests === 1 ? Response.json({ models: [remoteRow] })
    : new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError('connection closed')) } })))
  const first = await catalog.load()
  expire()
  const next = await catalog.load()
  assert.deepEqual(next.models, first.models)
  assert.equal(next.source, 'cached')
})

test('a fresh login to the same account retires in-flight work from the previous login', async () => {
  const started = Promise.withResolvers()
  const oldRequest = Promise.withResolvers()
  let count = 0
  const { catalog } = setup(async () => {
    if (++count === 1) { started.resolve(); return oldRequest.promise }
    return Response.json({ models: [{ ...remoteRow, slug: 'new-login-only' }] })
  })
  const first = catalog.load()
  await started.promise
  try {
    catalog.invalidate()
    assert.deepEqual((await catalog.load()).models.map(model => model.id), ['new-login-only'])
  } finally { oldRequest.resolve(Response.json({ models: [remoteRow] })) }
  assert.deepEqual((await first).models, [])
})
