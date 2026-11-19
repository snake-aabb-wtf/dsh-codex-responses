import { setTimeout as delay } from 'node:timers/promises'
import { createSessionUsageFold, summarizeUsage } from './cost-usage.mjs'

const empty = Object.freeze({ usd: 0, priced: 0, unpriced: 0, awaitingRates: 0 })
const isSelected = prefs => prefs.enabled && prefs.items.apiCost

async function waitFor(pending, signal) {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers()
  const abort = () => cancelled.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([pending, cancelled.promise]) }
  finally { signal.removeEventListener('abort', abort) }
}

export function createCostEstimator({ query, liveSession, pricing, publishedModelIds, floating,
  signal, interval = 2500 }) {
  let active
  let history = new Map()

  const unsubscribe = floating.subscribe(prefs => {
    if (isSelected(prefs)) return
    active?.controller.abort()
    active = undefined
    history = new Map()
  })
  signal?.addEventListener('abort', unsubscribe, { once: true })

  function syncPricing(state, ids) {
    if (state.pricing) return
    state.pricing = Promise.resolve().then(() => {
      state.signal.throwIfAborted()
      // The provider's published view is synchronous and never fetches credentials for pricing.
      for (const id of publishedModelIds?.() ?? []) ids.add(id)
      return pricing.sync(ids, state.signal)
    }).catch(() => {}).finally(() => { state.pricing = undefined })
  }

  async function readEntry(state, { header: { id }, revision: storedRevision }) {
    const live = liveSession(id)
    const previous = state.history.get(id)
    const sameSession = previous && previous.live === live
    if (sameSession && (live ? live.seq === previous.cursor + 1
      : storedRevision !== undefined && storedRevision === previous.revision)) return previous

    const observation = await query.observeSession(id, { projectionMode: 'none', signal: state.signal })
    try {
      state.signal.throwIfAborted()
      const { inheritedEventCount, cursor, revision } = observation
      const reusable = sameSession && previous.inheritedEventCount === inheritedEventCount && previous.cursor <= cursor
        && (live ? observation.source === 'live' : previous.revision !== undefined && previous.revision === revision)
      const fold = reusable ? previous.fold : createSessionUsageFold(inheritedEventCount)
      const from = reusable ? previous.cursor + 1 : inheritedEventCount
      if (cursor >= from) fold.add(observation.events.slice(from))
      const usage = fold.snapshot()
      const models = new Set(usage.requests.map(request => request.model))
      const entry = { live, cursor, revision, inheritedEventCount, fold, usage, models }
      state.history.set(id, entry)
      return entry
    } finally {
      observation[Symbol.dispose]()
    }
  }

  async function refresh(state) {
    const records = await query.listSessions(state.signal)
    await pricing.load?.()
    state.signal.throwIfAborted()
    const seen = new Set()
    const unavailable = new Set()
    const entries = new Map()
    for (const record of records) {
      state.signal.throwIfAborted()
      const { id } = record.header
      if (seen.has(id)) continue
      seen.add(id)
      try {
        entries.set(id, await readEntry(state, record))
      } catch {
        state.signal.throwIfAborted()
        unavailable.add(id)
      }
      if (seen.size % 16 === 0) await delay(0, undefined, { signal: state.signal })
    }
    for (const id of state.history.keys()) if (!seen.has(id)) state.history.delete(id)
    const ratesSyncedAt = pricing.getLastSync()
    const rateRevision = pricing.getRevision()
    const models = new Set()
    const bySession = new Map()
    const total = { ...empty }
    // Price all entries synchronously at the same revision, even if a sync completed during the scan.
    for (const [id, entry] of entries) {
      if (entry.rateRevision !== rateRevision) {
        let awaitingRates = 0
        const summary = summarizeUsage(entry.usage, (model, at) => {
          const rate = pricing.getRate(model, at)
          if (!rate) awaitingRates++
          return rate
        })
        entry.summary = { ...summary, awaitingRates }
        entry.rateRevision = rateRevision
      }
      const summary = entry.summary
      bySession.set(id, summary)
      for (const model of entry.models) models.add(model)
      total.usd += summary.usd
      total.priced += summary.priced
      total.unpriced += summary.unpriced
      total.awaitingRates += summary.awaitingRates
    }
    syncPricing(state, models)
    return { total, bySession, unavailable, ratesSyncedAt }
  }

  async function* observe(sessionId, callerSignal) {
    if (!isSelected(await floating.read()) || signal?.aborted || callerSignal?.aborted) return
    if (!active) {
      const controller = new AbortController()
      active = { controller, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        history, subscriptions: 0 }
    }
    const state = active
    state.subscriptions++
    const guard = callerSignal ? AbortSignal.any([callerSignal, state.signal]) : state.signal
    let previous
    try {
      while (!guard.aborted) {
        state.pending ??= refresh(state).finally(() => { state.pending = undefined })
        const { total, bySession, unavailable, ratesSyncedAt } = await waitFor(state.pending, guard)
        if (guard.aborted) return
        const currentUnavailable = unavailable.has(sessionId)
        const snapshot = { sessionId, total, current: sessionId === null || currentUnavailable ? null : bySession.get(sessionId) ?? empty,
          currentUnavailable, unreadableSessions: unavailable.size, ratesSyncedAt }
        const signature = JSON.stringify(snapshot)
        if (signature !== previous) {
          previous = signature
          yield snapshot
        }
        await delay(interval, undefined, { signal: guard })
      }
    } catch (error) {
      if (!guard.aborted) throw error
    } finally {
      if (--state.subscriptions === 0 && active === state) {
        state.controller.abort()
        active = undefined
      }
    }
  }

  return { observe }
}
