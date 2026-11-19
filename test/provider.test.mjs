import assert from 'node:assert/strict'
import test from 'node:test'
import { zstdDecompressSync } from 'node:zlib'
import { createCodexAdapter, PROVIDER } from '../src/provider.mjs'

const account = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')
const token = `fixture.${account}.fixture`

function frames(items, usage = null) {
  const response = { id: 'resp_fixture', status: 'completed', output: null, usage }
  return new Response(items.concat({ type: 'response.completed', response })
    .map(item => `data: ${JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

async function collect(stream) {
  const result = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

test('catalog is unavailable before sign-in and uses the native Codex model identifiers afterward', async () => {
  let status = 'signed-out'
  const adapter = createCodexAdapter({ credentials: { status: async () => status } })
  assert.deepEqual(await adapter.listModels(PROVIDER), [])
  status = 'signed-in'
  const models = await adapter.listModels(PROVIDER)
  assert.ok(models.some(model => model.id === 'gpt-6.1-sol' && model.provider === PROVIDER))
  assert.equal((await adapter.resolveModel(PROVIDER, 'gpt-6.1-sol')).provider, PROVIDER)
})

test('a discovered model resolves and uses the same Responses transport on the selected account', async () => {
  let identity = 'first-account'
  let inference = 0
  let catalogReads = 0
  const adapter = createCodexAdapter({ credentials: {
    catalogIdentity: async () => identity,
    accessToken: async (_oauth, expected) => {
      assert.equal(expected, identity)
      return token
    },
  }, catalogFetch: async () => {
    catalogReads++
    return Response.json({ models: [{ slug: 'server-model', display_name: 'Server Model', visibility: 'list',
      context_window: 500000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low',
      supports_reasoning_summary_parameter: false, supports_parallel_tool_calls: false,
    }] })
  }, fetch: async (url, init) => {
    inference++
    assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses')
    const request = JSON.parse(new Headers(init.headers).get('content-encoding') === 'zstd'
      ? zstdDecompressSync(init.body).toString() : init.body)
    assert.equal(request.model, 'server-model')
    assert.equal(request.reasoning.effort, 'low')
    assert.equal(request.reasoning.summary, undefined)
    assert.equal(request.parallel_tool_calls, false)
    return new Response('fixture error', { status: 403 })
  } })
  assert.deepEqual(adapter.publishedModelIds(), [])
  assert.equal(catalogReads, 0)
  assert.deepEqual((await adapter.listModels(PROVIDER)).map(model => model.id), ['server-model'])
  assert.deepEqual(adapter.publishedModelIds(), ['server-model'])
  assert.equal(catalogReads, 1)
  const prepared = await adapter.prepareCall(PROVIDER, 'server-model')
  assert.deepEqual(prepared.model.inputModalities, ['text', 'image'])
  assert.equal(prepared.model.context.contextWindow, 500000)
  assert.equal(prepared.model.reasoning.defaultEffort, 'low')
  const input = { provider: PROVIDER, model: 'server-model', reasoningEffort: 'low', messages: [] }
  const result = await collect(prepared.stream(input))
  assert.equal(result.at(-1).reason.failure.code, 'AUTH')
  const stale = await adapter.prepareCall(PROVIDER, 'server-model')
  identity = 'other-account'
  await assert.rejects(collect(stale.stream(input)), { code: 'MISSING_CREDENTIAL' })
  assert.equal(inference, 1)
})

test('cancelling model resolution does not cancel or wait for a shared directory fetch', async () => {
  const started = Promise.withResolvers()
  const upstream = Promise.withResolvers()
  const adapter = createCodexAdapter({ credentials: { catalogIdentity: async () => 'account', accessToken: async () => token },
    catalogFetch: async () => { started.resolve(); return upstream.promise },
  })
  const controller = new AbortController()
  const resolving = adapter.resolveModel(PROVIDER, 'gpt-6.1-sol', controller.signal)
  const listing = adapter.listModels(PROVIDER)
  await started.promise
  controller.abort()
  try {
    const observed = await Promise.race([resolving.catch(error => error.name), new Promise(resolve => setTimeout(() => resolve('pending'), 100))])
    assert.equal(observed, 'AbortError')
  } finally { upstream.resolve(Response.json({ models: [] })); await Promise.allSettled([resolving, listing]) }
  assert.deepEqual(await listing, [])
})

test('real Responses adapter projects text, usage, function calls and DSH tool history over SSE', async () => {
  const requests = []
  const call = { id: 'fc_fixture', call_id: 'call_fixture', type: 'function_call', name: 'lookup', arguments: '{"key":"test"}', status: 'completed' }
  const message = { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'verified', annotations: [] }] }
  const adapter = createCodexAdapter({ credentials: { status: async () => 'signed-in', accessToken: async () => token },
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses')
      assert.equal(init.redirect, 'error')
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`)
      const request = JSON.parse(new Headers(init.headers).get('content-encoding') === 'zstd'
        ? zstdDecompressSync(init.body).toString() : init.body)
      requests.push(request)
      if (requests.length === 1) return frames([
        { type: 'response.output_item.added', item: { ...call, arguments: '', status: 'in_progress' }, output_index: 0 },
        { type: 'response.function_call_arguments.delta', delta: call.arguments, item_id: call.id, output_index: 0 },
        { type: 'response.output_item.done', item: call, output_index: 0 },
      ])
      return frames([
        { type: 'response.output_item.added', item: { ...message, content: [] }, output_index: 0 },
        { type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [] }, item_id: message.id, output_index: 0, content_index: 0 },
        { type: 'response.output_text.delta', delta: 'verified', item_id: message.id, output_index: 0, content_index: 0 },
        { type: 'response.output_item.done', item: message, output_index: 0 },
      ], { input_tokens: 12, output_tokens: 2, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 14 })
    },
  })
  const input = { provider: PROVIDER, model: 'gpt-6.1-sol', system: 'Use tools only via DSH.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look up a test value' }] }],
    tools: [{ name: 'lookup', description: 'Returns a fixture value', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
  }
  const first = await collect(adapter.stream(input))
  const tool = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
  assert.ok(tool, JSON.stringify(first))
  assert.equal(tool.name, 'lookup')
  assert.equal(first.at(-1).reason.kind, 'tool-calls')
  assert.equal(requests[0].store, false)
  assert.equal(requests[0].tools[0].name, 'lookup')
  const second = await collect(adapter.stream({ ...input, messages: [...input.messages,
    { role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: input.model, replayState: first.at(-1).replayState }, content: [tool] },
    { role: 'tool', source: { kind: 'tool', callId: tool.id }, toolCallId: tool.id, content: [{ type: 'text', text: 'DSH tool result' }] },
  ] }))
  assert.ok(requests[1].input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id && JSON.stringify(item).includes('DSH tool result')), JSON.stringify(requests[1].input))
  assert.ok(second.some(chunk => chunk.type === 'text-delta' && chunk.text === 'verified'))
  assert.equal(second.at(-1).reason.kind, 'stop')
  assert.equal(second.find(chunk => chunk.type === 'usage').usage.inputTokens, 8)
})

test('upstream error bodies do not surface in stream chunks', async () => {
  const adapter = createCodexAdapter({ credentials: { status: async () => 'signed-in', accessToken: async () => token },
    fetch: async () => new Response('{"error":{"message":"SYNTHETIC-SECRET"}}', { status: 403 }),
  })
  const result = await collect(adapter.stream({ provider: PROVIDER, model: 'gpt-6.1-sol', messages: [] }))
  assert.equal(result.at(-1).reason.kind, 'error')
  assert.equal(result.at(-1).reason.failure.code, 'AUTH')
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-SECRET/)
})

test('cancelling a turn does not wait for a refresh or start inference', async () => {
  const refresh = Promise.withResolvers()
  const started = Promise.withResolvers()
  let fetches = 0
  const adapter = createCodexAdapter({ credentials: { async accessToken() {
    started.resolve()
    return refresh.promise
  } }, fetch: async () => { fetches++ } })
  const cancellation = new AbortController()
  const pending = collect(adapter.stream({ provider: PROVIDER, model: 'gpt-6.1-sol', messages: [], signal: cancellation.signal }))
  await started.promise
  cancellation.abort()
  try {
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 100))])
    assert.equal(result?.at(-1).reason.kind, 'aborted')
    assert.equal(fetches, 0)
  } finally { refresh.resolve(token) }
})

test('structured context overflow is preserved without its private message', async () => {
  const adapter = createCodexAdapter({ credentials: { accessToken: async () => token }, fetch: async () =>
    new Response('{"error":{"code":"context_length_exceeded","message":"SYNTHETIC-SECRET"}}', { status: 400 }),
  })
  const result = await collect(adapter.stream({ provider: PROVIDER, model: 'gpt-6.1-sol', messages: [] }))
  assert.equal(result.at(-1).reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-SECRET/)
})

test('the original bearer is sent even when its JWT payload uses base64url characters', async () => {
  const claims = JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' }, pad: '~~ÿÿ' })
  const payload = Buffer.from(claims).toString('base64url')
  assert.match(payload, /[-_]/)
  const original = `fixture.${payload}.signature`
  let bearer
  const adapter = createCodexAdapter({ credentials: { accessToken: async () => original }, fetch: async (_url, init) => {
    bearer = new Headers(init.headers).get('authorization')
    return new Response('unauthorized', { status: 401 })
  } })
  await collect(adapter.stream({ provider: PROVIDER, model: 'gpt-6.1-sol', messages: [] }))
  assert.equal(bearer, `Bearer ${original}`)
})
