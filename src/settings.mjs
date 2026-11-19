import { DEVICE_URL } from './auth.mjs'

const stages = new Map([
  ['CODEX_DEVICE_FAILED', ['device-failed', 'Could not start a Codex device sign-in.']],
  ['CODEX_POLL_FAILED', ['poll-failed', 'Could not confirm device authorization with OpenAI.']],
  ['CODEX_EXCHANGE_FAILED', ['exchange-failed', 'OpenAI rejected the Codex OAuth token exchange.']],
  ['CODEX_TOKEN_FAILED', ['token-failed', 'The Codex token response could not be used.']],
])

export class SettingsError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function createSettings({ begin, status, signOut, lifetime, local, catalogStatus, estimator, floating, monitor }) {
  let active = false
  const busy = () => new SettingsError('codex-responses/login-in-progress', 'A ChatGPT Codex sign-in is already running.')
  function requireOwner(principal) {
    if (principal?.kind !== 'owner' || local?.() === false) {
      throw new SettingsError('remote-access/denied', 'Only the local Host owner may manage ChatGPT Codex.')
    }
  }
  function requireEstimator(principal) {
    requireOwner(principal)
    if (!estimator) throw new SettingsError('codex-responses/estimator-unavailable', 'API cost estimation is unavailable in this profile.')
    return estimator
  }
  function requireFloating(principal) {
    requireOwner(principal)
    if (!floating) throw new SettingsError('codex-responses/floating-unavailable', 'Floating window settings are unavailable in this profile.')
    return floating
  }
  return {
    async floatingPreferences(principal) {
      return requireFloating(principal).read()
    },
    async setFloatingPreferences(principal, patch) {
      return requireFloating(principal).update(patch)
    },
    async *estimate(principal, sessionId, signal) {
      yield* requireEstimator(principal).observe(sessionId, signal)
    },
    async *subscription(principal, kind, surface, callerSignal) {
      const preferences = requireFloating(principal)
      if (!monitor) throw new SettingsError('codex-responses/subscription-unavailable', 'Codex subscription status is unavailable.')
      const scope = [callerSignal, lifetime].filter(Boolean)
      if (surface === 'settings') {
        yield* monitor.observe(kind, AbortSignal.any(scope))
        return
      }
      const visible = prefs => prefs.enabled && prefs.items[kind] === true
      const hidden = new AbortController()
      const signal = AbortSignal.any([hidden.signal, ...scope])
      const unsubscribe = preferences.subscribe(prefs => { if (!visible(prefs)) hidden.abort() })
      try {
        if (!visible(await preferences.read()) || signal.aborted) return
        yield* monitor.observe(kind, signal)
      } finally {
        unsubscribe()
        hidden.abort()
      }
    },
    async status(principal) {
      requireOwner(principal)
      const login = await status()
      const catalog = login === 'signed-in' && catalogStatus ? await catalogStatus() : undefined
      return { type: 'status', status: login, ...(catalog ? { catalog: { source: catalog.source, count: catalog.count } } : {}) }
    },
    async signOut(principal) {
      requireOwner(principal)
      if (active) throw busy()
      active = true
      try {
        await signOut()
        return { type: 'status', status: 'signed-out' }
      } finally { active = false }
    },
    async *login(principal, callerSignal) {
      requireOwner(principal)
      if (active) throw busy()
      const attempt = new AbortController()
      const signal = AbortSignal.any([attempt.signal, ...[callerSignal, lifetime].filter(Boolean)])
      if (signal.aborted) return
      active = true
      const device = Promise.withResolvers()
      const cancelled = Promise.withResolvers()
      const onCancel = () => cancelled.resolve({ type: 'cancelled' })
      signal.addEventListener('abort', onCancel, { once: true })
      const outcome = Promise.resolve().then(() => begin({
        async prompt() { throw new Error('Unexpected authorization prompt.') },
        notify({ url, code }) {
          if (!signal.aborted && url === DEVICE_URL && typeof code === 'string' && /^[A-Z0-9-]{4,32}$/u.test(code)) {
            device.resolve({ type: 'device', url, code })
          }
        },
      }, signal)).then(value => ({ type: 'settled', value }), error => ({ type: 'failed', stage: stages.get(error?.code) }))
      try {
        let event = await Promise.race([device.promise, outcome, cancelled.promise])
        if (event.type === 'device' && !signal.aborted) {
          yield event
          event = await Promise.race([outcome, cancelled.promise])
        }
        if (signal.aborted || event.value?.status === 'cancelled') return
        if (event.stage) throw new SettingsError(`codex-responses/${event.stage[0]}`, event.stage[1])
        if (event.value?.status !== 'authorized') {
          throw new SettingsError('codex-responses/login-failed', 'Device sign-in failed. Check that Codex device-code login is enabled and try again.')
        }
        yield { type: 'status', status: await status() }
      } finally {
        signal.removeEventListener('abort', onCancel)
        attempt.abort()
        await outcome
        active = false
      }
    },
  }
}
