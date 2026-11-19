import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { CodexAuthError } from '../src/auth.mjs'
import { createCodexImageGenerator } from '../src/image-generation.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4UqcNAAQHAZ4BGagyAAAAAElFTkSuQmCC'
const oauth = {}
const endpoint = 'https://chatgpt.com/backend-api/codex/images/generations'

function fixture(fetch, credentials = {}) {
  return createCodexImageGenerator({
    oauth, fetch, credentials: {
      catalogIdentity: async () => 'image-account',
      async accessToken(method, account) {
        assert.equal(method, oauth)
        assert.equal(account, 'image-account')
        return 'test-access'
      },
      ...credentials,
    },
  })
}

test('image generation sends one account-scoped native Codex Images request', async () => {
  let requests = 0
  const generate = fixture(async (url, init) => {
    requests++
    assert.equal(url, endpoint)
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    const headers = new Headers(init.headers)
    assert.equal(headers.get('authorization'), 'Bearer test-access')
    assert.equal(headers.get('chatgpt-account-id'), 'image-account')
    assert.equal(headers.get('content-type'), 'application/json')
    assert.ok(headers.get('x-codex-image-turn-id'))
    const body = await new Response(init.body).text()
    assert.equal(Number(headers.get('content-length')), Buffer.byteLength(body))
    assert.deepEqual(JSON.parse(body), {
      model: 'gpt-image-2', prompt: 'An orange square', background: 'auto', quality: 'auto', size: 'auto',
    })
    return Response.json({ data: [{ b64_json: png }] })
  })
  assert.deepEqual(await generate('  An orange square  ', new AbortController().signal), {
    data: Buffer.from(png, 'base64'), mediaType: 'image/png',
  })
  assert.equal(requests, 1)
})

test('the real HTTP transport does not replay a generation POST after 421', async t => {
  let warmPort
  const postPorts = []
  const server = createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      if (request.method === 'GET') {
        warmPort = request.socket.remotePort
        response.end('warm')
      } else {
        postPorts.push(request.socket.remotePort)
        response.writeHead(421).end('misdirected')
      }
    })
  })
  server.listen(0, '127.0.0.1')
  t.after(() => { server.close(); server.closeAllConnections() })
  await once(server, 'listening')
  const local = `http://127.0.0.1:${server.address().port}/test`
  assert.equal(await (await fetch(local)).text(), 'warm')
  await new Promise(resolve => setImmediate(resolve))
  const generate = fixture((_url, init) => fetch(local, init))
  await assert.rejects(generate('A square'), { code: 'CODEX_IMAGE_REJECTED' })
  assert.deepEqual(postPorts, [warmPort])
})

test('cancelled calls stop waiting for OAuth refresh and known auth errors keep a structured identity', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers()
  const refresh = Promise.withResolvers()
  const noFetch = () => assert.fail('Unexpected upstream request')
  const generate = fixture(noFetch, {
    accessToken() { started.resolve(); return refresh.promise },
  })
  const startedGeneration = generate('A square', controller.signal)
  await started.promise
  controller.abort()
  const guard = AbortSignal.timeout(500)
  try {
    await assert.rejects(Promise.race([startedGeneration, once(guard, 'abort').then(() => { throw guard.reason })]),
      { name: 'AbortError' })
  } finally { refresh.resolve('unused-token') }

  await assert.rejects(fixture(noFetch, {
    async accessToken() { throw new CodexAuthError('CODEX_RELOGIN_REQUIRED', 'Sign in to ChatGPT Codex again.') },
  })('A square'), error => error instanceof HarnessError && error.code === 'CODEX_RELOGIN_REQUIRED')
})

test('missing login, an account change, blank input, and pre-cancellation stop before dispatch', async () => {
  const noFetch = async () => assert.fail('Unexpected upstream request')
  const signedOut = fixture(noFetch, { catalogIdentity: async () => undefined })
  await assert.rejects(signedOut('A square'), { code: 'MISSING_CREDENTIAL' })
  await assert.rejects(fixture(noFetch)('  '), { code: 'CODEX_IMAGE_PROMPT' })
  await assert.rejects(fixture(noFetch)('A square', AbortSignal.abort()), { name: 'AbortError' })

  let account = 'image-account'
  const changed = fixture(noFetch, {
    catalogIdentity: async () => account,
    async accessToken() {
      account = 'other-account'
      return 'previous-token'
    },
  })
  await assert.rejects(changed('A square'), { code: 'MISSING_CREDENTIAL' })
})

test('image auth and rate failures expose a safe classification without the upstream body', async () => {
  for (const [status, code] of [[401, 'CODEX_IMAGE_AUTH'], [403, 'CODEX_IMAGE_PERMISSION'],
    [429, 'CODEX_IMAGE_LIMIT'], [503, 'CODEX_IMAGE_UNAVAILABLE']]) {
    let requests = 0
    const generate = fixture(async () => {
      requests++
      return new Response('private upstream detail', { status })
    })
    await assert.rejects(generate('A square'), error => error.code === code && !error.message.includes('private'))
    assert.equal(requests, 1)
  }
})

test('invalid, empty, and multiple image outputs are rejected', async () => {
  for (const data of [[], [{ b64_json: 'not a valid image' }], [{ b64_json: 'dGVzdA==' }],
    [{ b64_json: png }, { b64_json: png }]]) {
    await assert.rejects(fixture(async () => Response.json({ data }))('A square'), { code: 'CODEX_IMAGE_INVALID' })
  }
})

test('the generator preserves the raster format for DSH attachment admission', async () => {
  const formats = [
    ['image/jpeg', Buffer.from('ffd8ffe000', 'hex')],
    ['image/webp', Buffer.from('524946460000000057454250', 'hex')],
  ]
  for (const [mediaType, data] of formats) {
    const generate = fixture(async () => Response.json({ data: [{ b64_json: data.toString('base64') }] }))
    assert.deepEqual(await generate('A square'), { mediaType, data })
  }
})

test('reference editing sends verified inputs in order and saves one image', async () => {
  let posts = 0
  const generate = fixture(async (url, init) => {
    posts++
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/images/edits')
    const body = JSON.parse(await new Response(init.body).text())
    assert.deepEqual(body.images, [{ image_url: `data:image/png;base64,${png}` },
      { image_url: 'data:image/jpeg;base64,/9j/4AA=' }])
    assert.equal(body.prompt, 'Use a blue background')
    assert.equal(Object.hasOwn(body, 'n'), false)
    return Response.json({ data: [{ b64_json: png }] })
  })
  const image = await generate('Use a blue background', undefined, undefined, { references: [
    { mediaType: 'image/png', data: Buffer.from(png, 'base64') },
    { mediaType: 'image/jpeg', data: Buffer.from('ffd8ffe000', 'hex') },
  ] })
  assert.deepEqual(image, { data: Buffer.from(png, 'base64'), mediaType: 'image/png' })
  assert.equal(posts, 1)
})

test('generation bounds the body even when the server omits Content-Length', async () => {
  const chunk = Buffer.alloc(1024 * 1024)
  let cancelled = false
  const generate = fixture(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(chunk) },
    cancel() { cancelled = true },
  })))
  await assert.rejects(generate('A square'), { code: 'CODEX_IMAGE_INVALID' })
  assert.equal(cancelled, true)
})

test('cancelled image responses and uncertain network failures never retry', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers()
  let requests = 0
  const generate = fixture(async (_url, { signal }) => {
    requests++
    return new Response(new ReadableStream({
      start(response) {
        signal.addEventListener('abort', () => response.error(signal.reason), { once: true })
        started.resolve()
      },
    }))
  })
  const result = generate('A square', controller.signal)
  await started.promise
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(requests, 1)

  requests = 0
  const interrupted = fixture(async () => {
    requests++
    return new Response(new ReadableStream({
      pull(stream) { stream.error(new Error('private network error')) },
    }))
  })
  await assert.rejects(interrupted('A square'), { code: 'CODEX_IMAGE_UNCERTAIN' })
  assert.equal(requests, 1)
})
