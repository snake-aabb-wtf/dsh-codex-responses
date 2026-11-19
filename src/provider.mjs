import { LlmError } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { CodexAuthError } from './auth.mjs'
import { createModelCatalog } from './model-catalog.mjs'

export const PROVIDER = 'codex-responses'
export const DISPLAY_NAME = 'ChatGPT Codex'
const baseURL = 'https://chatgpt.com/backend-api'
const responsesURL = `${baseURL}/codex/responses`

const authContext = { env: async () => undefined, fileExists: async () => false }
const emptyStore = { read: async () => undefined }

async function waitForCatalog(discovery, signal) {
  if (!signal) return discovery.load()
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers()
  const onAbort = () => cancelled.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try { return await Promise.race([discovery.load(), cancelled.promise]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

async function normalizeHttpFailure(response) {
  if (response.ok) return response
  let message = `HTTP ${response.status}`
  if ([400, 413, 429].includes(response.status)) {
    try {
      const { error } = await response.json()
      const code = error?.code ?? error?.type
      if (response.status === 429 && ['usage_limit_reached', 'usage_not_included', 'insufficient_quota'].includes(code)) {
        message = 'ChatGPT usage limit reached'
      } else if (code === 'context_length_exceeded') {
        message = 'Maximum context length exceeded'
      }
    } catch {}
  } else {
    await response.body?.cancel().catch(() => {})
  }
  return new Response(message, { status: response.status, headers: response.headers })
}

function makeProfile(catalog, request, descriptors) {
  const models = descriptors.map(model => ({ ...model, provider: PROVIDER, baseUrl: baseURL }))
  const streamOptions = (model, options) => {
    const original = options.apiKey
    const parts = original?.split('.') ?? []
    const localApiKey = parts.length === 3 && /[-_]/u.test(parts[1])
      ? [parts[0], Buffer.from(parts[1], 'base64url').toString('base64'), parts[2]].join('.') : original
    return {
      ...options, apiKey: localApiKey,
      ...(model.omitReasoningSummary || model.serialTools ? { onPayload(body) {
        if (model.omitReasoningSummary && body.reasoning) delete body.reasoning.summary
        if (model.serialTools) body.parallel_tool_calls = false
        return body
      } } : {}),
      fetch: async (url, init) => {
        if (String(url) !== responsesURL || !original) throw new Error('Unexpected Codex upstream request.')
        init.signal?.throwIfAborted()
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${original}`)
        return normalizeHttpFailure(await request(url, { ...init, headers, redirect: 'error' }))
      },
    }
  }
  return {
    provider: PROVIDER, displayName: DISPLAY_NAME, transport: 'sse',
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024, maxRequestImages: 50, imageOffloadCountQuantum: 10,
    requestImagePixelBudget: 2048 ** 2, requestImageMaxBytes: 1024 ** 2,
    modelErrors: new Map(), configuredMaxTokens: new Map(),
    piProvider: {
      id: PROVIDER, name: DISPLAY_NAME, baseUrl: baseURL,
      auth: { apiKey: { name: DISPLAY_NAME, async resolve({ credential }) {
        return credential?.key ? { auth: { apiKey: credential.key } } : undefined
      } } },
      getModels: () => models,
      stream: (model, context, options) => catalog.stream(model, context, streamOptions(model, options)),
      streamSimple: (model, context, options) => catalog.streamSimple(model, context, streamOptions(model, options)),
    },
  }
}

function safeFailure(code) {
  switch (code) {
    case 'ABORTED': return 'ChatGPT Codex request cancelled.'
    case 'AUTH': case 'INVALID_CREDENTIAL': case 'HTTP_401': case 'HTTP_403':
      return 'ChatGPT Codex denied access. Check your subscription or sign in again.'
    case 'QUOTA': case 'ACCOUNT_QUOTA': return 'ChatGPT Codex subscription usage limit reached.'
    case 'RATE_LIMIT': case 'HTTP_429': return 'ChatGPT Codex is rate-limiting requests. Try again later.'
    case 'CONTEXT_WINDOW_EXCEEDED': return 'The conversation exceeds this Codex model’s context window.'
    case 'TIMEOUT': return 'ChatGPT Codex did not respond in time.'
    default: return 'ChatGPT Codex could not complete the model request.'
  }
}

async function* sanitize(stream, signal) {
  const iterator = stream[Symbol.asyncIterator]()
  const abort = Promise.withResolvers()
  const onAbort = () => abort.resolve(undefined)
  signal?.addEventListener('abort', onAbort, { once: true })
  let exhausted = false
  try {
    while (true) {
      const next = signal?.aborted ? undefined : await Promise.race([iterator.next(), abort.promise])
      if (next === undefined) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: safeFailure('ABORTED') } } }
        return
      }
      if (next.done) { exhausted = true; return }
      const chunk = next.value
      if (chunk.type !== 'finish' || !chunk.reason.failure) {
        yield chunk
        continue
      }
      const { code } = chunk.reason.failure
      yield { ...chunk, reason: { ...chunk.reason, failure: { code, message: safeFailure(code) } } }
    }
  } catch (error) {
    if (error instanceof CodexAuthError) throw new LlmError(error.message, error.code)
    throw new LlmError(safeFailure(error instanceof LlmError ? error.code : 'PI_AI_ERROR'),
      error instanceof LlmError ? error.code : 'PI_AI_ERROR')
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!exhausted) void iterator.return?.().catch(() => {})
  }
}

export function createCodexAdapter({ credentials, catalog = openaiCodexProvider(), oauth = catalog.auth.oauth,
  fetch = (...args) => globalThis.fetch(...args), catalogFetch = fetch, image, signal, onCatalogChange }) {
  const bundled = catalog.getModels()
  const auth = { credentials: emptyStore, authContext }
  const makeOptions = (models, resolveApiKey) => {
    const profiles = new Map([[PROVIDER, makeProfile(catalog, fetch, models)]])
    return { profiles: () => profiles, resolveApiKey, auth, ...image }
  }
  const discovery = credentials.catalogIdentity && createModelCatalog({
    credentials, oauth, fetch: catalogFetch, bundled, signal, onChange: onCatalogChange,
  })
  let current
  let loginGeneration = 0

  const findModel = (models, id) => models.find(model => model.id === id)
  function withMetadata(info, descriptor) {
    const { context, ...model } = info
    return {
      ...model,
      ...(descriptor?.contextWindow > 0 && context ? { context } : {}),
      ...(descriptor?.defaultEffort && model.reasoning ? {
        reasoning: { ...model.reasoning, defaultEffort: descriptor.defaultEffort },
      } : {}),
    }
  }

  async function snapshot(callSignal) {
    const view = await waitForCatalog(discovery, callSignal)
    callSignal?.throwIfAborted()
    if (current?.view !== view) {
      const generation = loginGeneration
      current = { view, delegate: new PiAiAdapter(makeOptions(view.models, async () => {
        if (await credentials.catalogIdentity() !== view.identity || generation !== loginGeneration) {
          throw new CodexAuthError('MISSING_CREDENTIAL', 'The ChatGPT Codex account changed. Retry this request.')
        }
        return credentials.accessToken(oauth, view.identity)
      })) }
    }
    return current
  }

  return new class extends PiAiAdapter {
    constructor() {
      super(makeOptions(bundled, async () => credentials.accessToken(oauth)))
    }

    invalidateCatalog() {
      loginGeneration++
      discovery?.invalidate()
      current = undefined
    }

    async catalogStatus() {
      const view = await discovery?.load()
      return { source: view?.source ?? 'unavailable', count: view?.models.length ?? 0 }
    }

    async listModels(provider) {
      if (provider !== PROVIDER) return []
      const models = discovery ? (await snapshot()).view.models : await credentials.status() === 'signed-in' ? bundled : []
      return models.map(model => ({ provider, id: model.id, name: model.name, inputModalities: [...model.input] }))
    }

    async resolveModel(provider, model, callSignal) {
      if (!discovery) return super.resolveModel(provider, model, callSignal)
      const { view, delegate } = await snapshot(callSignal)
      return withMetadata(await delegate.resolveModel(provider, model, callSignal), findModel(view.models, model))
    }

    imageRequestTarget(provider, model, attachment) {
      return current ? current.delegate.imageRequestTarget(provider, model, attachment)
        : super.imageRequestTarget(provider, model, attachment)
    }

    stream(options) {
      if (!discovery) return sanitize(super.stream(options), options.signal)
      const adapter = this
      return (async function* () {
        const prepared = await adapter.prepareCall(options.provider, options.model, options.signal)
        yield* prepared.stream(options)
      })()
    }

    async prepareCall(provider, model, callSignal) {
      if (!discovery) {
        const prepared = await super.prepareCall(provider, model, callSignal)
        return { ...prepared, stream: options => sanitize(prepared.stream(options), options.signal) }
      }
      const { view, delegate } = await snapshot(callSignal)
      if (view.identity === undefined) throw new LlmError('Sign in to ChatGPT Codex in DSH Settings first.', 'MISSING_CREDENTIAL')
      const descriptor = findModel(view.models, model)
      const prepared = await delegate.prepareCall(provider, model, callSignal)
      return { ...prepared, model: withMetadata(prepared.model, descriptor),
        stream: options => sanitize(prepared.stream(options.reasoningEffort === undefined && descriptor?.defaultEffort
          ? { ...options, reasoningEffort: descriptor.defaultEffort } : options), options.signal) }
    }
  }()
}
