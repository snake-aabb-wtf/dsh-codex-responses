import { setTimeout as delay } from 'node:timers/promises'
import { planName } from './account-profile.mjs'

const usageURL = 'https://chatgpt.com/backend-api/wham/usage'
const responseLimit = 512 * 1024
const positive = value => Number.isSafeInteger(value) && value > 0
const emptyQuota = status => ({ kind: 'quota', status, updatedAt: null, windows: [] })

function projectWindow(value) {
  if (!value) return undefined
  const { used_percent: used, limit_window_seconds: durationSeconds, reset_at: reset } = value
  if (!Number.isFinite(used) || used < 0 || used > 100 || !positive(durationSeconds)) return undefined
  return { remaining: 100 - used, durationSeconds,
    resetsAt: positive(reset) && reset < 8_640_000_000_000 ? reset * 1000 : null }
}

async function readUsage(response, accountId) {
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > responseLimit) throw new Error('Codex usage exceeds its byte limit.')
    chunks.push(chunk)
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || (payload.account_id != null && payload.account_id !== accountId)) throw new Error('Invalid Codex usage response.')
  const limits = payload.rate_limit
  const windows = [limits?.primary_window, limits?.secondary_window].map(projectWindow).filter(Boolean)
  return { windows, plan: planName(payload.plan_type) }
}

export function createSubscriptionMonitor({ credentials, oauth, fetch = globalThis.fetch, interval = 60_000, now = Date.now }) {
  let cache
  let pending
  let wake = new AbortController()
  let login = new AbortController()

  function notify() {
    const previous = wake
    wake = new AbortController()
    previous.abort()
  }

  function invalidate() {
    cache = undefined
    login.abort()
    login = new AbortController()
    notify()
  }

  async function fetchQuota(account, signal, loginSignal) {
    const { accountId } = account
    const previous = cache?.accountId === accountId ? cache : undefined
    const requestSignal = AbortSignal.any([signal, loginSignal, AbortSignal.timeout(10_000)])
    let view = emptyQuota('unavailable')
    let plan
    let temporary = false
    try {
      const token = await credentials.accessToken(oauth, accountId)
      requestSignal.throwIfAborted()
      const response = await fetch(usageURL, {
        method: 'GET', redirect: 'error', signal: requestSignal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': accountId },
      })
      if (response.ok) {
        const data = await readUsage(response, accountId)
        plan = data.plan
        if (data.windows.length) view = { kind: 'quota', status: 'ready', updatedAt: now(), windows: data.windows }
      } else {
        temporary = response.status === 408 || response.status === 429 || response.status >= 500
        await response.body?.cancel().catch(() => {})
      }
    } catch (error) {
      temporary = !['MISSING_CREDENTIAL', 'CODEX_RELOGIN_REQUIRED'].includes(error?.code)
    }
    if (signal.aborted || loginSignal.aborted) return view
    const latest = await credentials.accountProfile()
    if (signal.aborted || loginSignal.aborted) return view
    if (latest.status !== 'signed-in') return emptyQuota(latest.status)
    if (latest.accountId !== accountId) return view
    if (temporary && previous?.view.windows.length) view = { ...previous.view, status: 'stale' }
    if (temporary) plan = previous?.plan
    const previousPlan = previous?.plan
    cache = { accountId, view, plan, checkedAt: performance.now() }
    if (previousPlan !== plan) notify()
    return view
  }

  async function quota(account, signal, loginSignal) {
    const { accountId } = account
    if (cache?.accountId === accountId && performance.now() - cache.checkedAt < interval) return cache.view
    if (!pending || pending.accountId !== accountId || pending.loginSignal !== loginSignal) {
      const request = { accountId, loginSignal, controller: new AbortController(), readers: 0 }
      pending = request
      request.result = fetchQuota(account, request.controller.signal, loginSignal).finally(() => {
        if (pending === request) pending = undefined
      })
    }
    const request = pending
    request.readers++
    const caller = AbortSignal.any([signal, loginSignal])
    const cancelled = Promise.withResolvers()
    let attached = true
    function detach() {
      if (!attached) return
      attached = false
      if (--request.readers === 0 && pending === request) {
        pending = undefined
        request.controller.abort()
      }
    }
    const onAbort = () => {
      detach()
      cancelled.resolve(emptyQuota('unavailable'))
    }
    caller.addEventListener('abort', onAbort, { once: true })
    if (caller.aborted) onAbort()
    try { return await Promise.race([request.result, cancelled.promise]) }
    finally { caller.removeEventListener('abort', onAbort); detach() }
  }

  async function* observe(kind, signal) {
    let signature
    while (!signal.aborted) {
      const wakeSignal = wake.signal
      const loginSignal = login.signal
      const account = await credentials.accountProfile()
      if (signal.aborted) return
      if (loginSignal.aborted) continue
      const view = kind === 'account' ? {
        kind, status: account.status, email: account.email ?? null,
        plan: (cache?.accountId === account.accountId ? cache?.plan : undefined) ?? account.plan ?? null,
      } : account.status === 'signed-in' ? await quota(account, signal, loginSignal) : emptyQuota(account.status)
      if (signal.aborted) return
      if (loginSignal.aborted) continue
      const next = JSON.stringify(view)
      if (next !== signature) {
        signature = next
        yield view
      }
      const waiting = kind === 'account' ? AbortSignal.any([signal, wakeSignal]) : AbortSignal.any([signal, loginSignal])
      await delay(interval, undefined, { signal: waiting }).catch(error => { if (!waiting.aborted) throw error })
    }
  }

  return { observe, notify, invalidate }
}
