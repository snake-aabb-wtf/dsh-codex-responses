const catalogURL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.170.0'
const refreshMs = 300_000
const retryMs = 30_000
const responseLimit = 8 * 1024 * 1024
const unavailable = Object.freeze({ identity: undefined, models: Object.freeze([]), source: 'unavailable' })
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const effortNames = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined

function projectCatalog(payload, bundled) {
  if (!Array.isArray(payload?.models)) throw new Error('Invalid Codex model catalog.')
  const knownModels = new Map(bundled.map(model => [model.id, model]))
  const listed = new Map()
  for (const entry of payload.models) {
    const id = entry?.slug
    if (entry?.visibility !== 'list' || typeof id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(id) || listed.has(id)) continue
    const known = knownModels.get(id)
    const name = typeof entry.display_name === 'string' ? entry.display_name.trim() : ''
    const input = Array.isArray(entry.input_modalities)
      ? ['text', 'image'].filter(modality => entry.input_modalities.includes(modality)) : known?.input ?? ['text', 'image']
    if (!input.includes('text')) continue
    const levels = Array.isArray(entry.supported_reasoning_levels) ? new Set(entry.supported_reasoning_levels.map(level => level?.effort)) : undefined
    const thinkingLevelMap = levels === undefined ? known?.thinkingLevelMap : Object.fromEntries(effortNames.map(level => {
      const wire = level === 'off' ? 'none' : level
      return [level, levels.has(wire) ? wire : null]
    }))
    const reasoning = levels === undefined ? known?.reasoning ?? false : effortNames.some(level => level !== 'off' && levels.has(level))
    const defaultEffort = entry.default_reasoning_level === 'none' ? 'off' : entry.default_reasoning_level
    listed.set(id, {
      ...known, id, name: name.slice(0, 160) || known?.name || id, input, reasoning, thinkingLevelMap,
      type: 'chat', api: 'openai-codex-responses', cost: known?.cost ?? zeroCost,
      contextWindow: positive(entry.context_window) ?? positive(entry.max_context_window) ?? known?.contextWindow ?? 0,
      maxTokens: positive(entry.max_output_tokens) ?? known?.maxTokens ?? 4096,
      omitReasoningSummary: entry.supports_reasoning_summary_parameter === false,
      serialTools: entry.supports_parallel_tool_calls === false,
      ...(reasoning && effortNames.includes(defaultEffort) && levels?.has(entry.default_reasoning_level) ? { defaultEffort } : {}),
    })
  }
  return [...listed.values()]
}

async function readBody(response) {
  if (Number(response.headers.get('content-length')) > responseLimit) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Codex catalog exceeds its byte limit.')
  }
  const parts = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > responseLimit) throw new Error('Codex catalog exceeds its byte limit.')
    parts.push(chunk)
  }
  return Buffer.concat(parts).toString('utf8')
}

export function createModelCatalog({ credentials, oauth, fetch, bundled, now = Date.now, signal, onChange }) {
  let active

  function setState(identity) {
    active?.controller.abort()
    active = identity === undefined ? undefined : {
      identity, controller: new AbortController(), view: { identity, models: unavailable.models, source: 'unavailable' },
      authoritative: false, nextCheck: -Infinity,
    }
    return active
  }

  function publish(state, models, source) {
    const signature = JSON.stringify(models)
    const changed = state.signature !== signature
    if (!changed && state.view.source === source) return
    state.signature = signature
    state.view = { identity: state.identity, models, source }
    if (changed) onChange?.()
  }

  let timer
  signal?.addEventListener('abort', () => clearTimeout(timer), { once: true })

  function scheduleRefresh(delay) {
    if (!signal || signal.aborted) return
    clearTimeout(timer)
    timer = setTimeout(() => { void load().catch(() => scheduleRefresh(retryMs)) }, delay)
    timer.unref?.()
  }

  async function refresh(state) {
    const requestSignal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    let models
    let authoritative = false
    let transient = true
    try {
      const token = await credentials.accessToken(oauth, state.identity)
      requestSignal.throwIfAborted()
      const response = await fetch(catalogURL, {
        method: 'GET', redirect: 'error', signal: requestSignal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': state.identity },
      })
      if (response.ok) {
        const body = await readBody(response)
        transient = false
        models = projectCatalog(JSON.parse(body), bundled)
        authoritative = true
      } else {
        await response.body?.cancel().catch(() => {})
        transient = response.status === 408 || response.status === 429 || response.status >= 500
      }
    } catch (error) {
      if (['MISSING_CREDENTIAL', 'CODEX_RELOGIN_REQUIRED'].includes(error?.code)) transient = false
    }
    if (active !== state || signal?.aborted) return unavailable
    if (await credentials.catalogIdentity() !== state.identity) {
      if (active === state) setState(undefined)
      return unavailable
    }
    if (active !== state || signal?.aborted) return unavailable
    const delay = authoritative ? refreshMs : retryMs
    state.nextCheck = now() + delay
    scheduleRefresh(delay)
    if (authoritative || !transient) {
      state.authoritative = true
      publish(state, models ?? unavailable.models, authoritative ? 'upstream' : 'unavailable')
    } else if (!state.authoritative) {
      publish(state, bundled, 'bundled')
    } else if (state.view.source !== 'unavailable') {
      publish(state, state.view.models, 'cached')
    }
    return state.view
  }

  async function load() {
    if (signal?.aborted) return unavailable
    const identity = await credentials.catalogIdentity()
    if (signal?.aborted) return unavailable
    const state = active?.identity === identity ? active : setState(identity)
    if (!state) { clearTimeout(timer); return unavailable }
    if (state.pending) return state.pending
    if (now() < state.nextCheck) return state.view
    state.pending = refresh(state).finally(() => { state.pending = undefined })
    return state.pending
  }

  return { load, peek: () => active?.view, invalidate() { clearTimeout(timer); setState(undefined) } }
}
