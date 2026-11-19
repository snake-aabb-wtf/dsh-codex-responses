const PROVIDER = 'codex-responses'
const TOKEN_RATES = [
  ['inputTokens', 'input'],
  ['cacheReadTokens', 'cacheRead'],
  ['cacheWriteTokens', 'cacheWrite'],
  ['outputTokens', 'output'],
]

const isCount = value => Number.isSafeInteger(value) && value >= 0
const isModel = value => typeof value === 'string' && value.trim().length > 0

function tokenBuckets(usage) {
  if (!usage) return undefined
  const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, totalTokens, reasoningTokens } = usage
  const counts = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]
  if (!counts.every(isCount)) return undefined
  const total = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
  // pi-ai can emit an all-zero placeholder when the response has no usage.
  if (!isCount(total) || total === 0 || (totalTokens !== undefined && totalTokens !== total)) return undefined
  if (reasoningTokens !== undefined && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) return undefined
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

function usageOf(event) {
  const { data } = event
  if (event.type === 'assistant/message' && data.usage !== undefined) return data.usage
  if (!Array.isArray(data.stream)) return undefined
  return data.stream.findLast(record => record?.type === 'chunk' && record.chunk?.type === 'usage')?.chunk.usage
}

const samePosition = (step, data) => step !== undefined && step.turn === data.turn && step.step === data.step
const sameRoute = (left, right) => left?.provider === right?.provider && left?.model === right?.model

function appendRequest(result, attempt, source) {
  if (source?.provider !== PROVIDER) return
  if (!isModel(source.model) || !Number.isSafeInteger(attempt.time) || !attempt.usage) {
    result.unpriced++
    return
  }
  result.requests.push(Object.freeze({ model: source.model, time: attempt.time, ...attempt.usage }))
}

function appendStep(result, step) {
  if (!step) return
  const source = step.current.source
  for (const attempt of step.prior) {
    // The native loop holds selection fixed across retries of a step. A failed
    // attempt needs a matched retry transition and the same step's message source.
    const retrySource = isModel(source?.model) && (attempt.route === undefined || sameRoute(attempt.route, source))
      ? source : undefined
    appendRequest(result, attempt, attempt.source ?? retrySource)
  }
  appendRequest(result, step.current, source)
}

/** Fold monotonic DSH event batches, with an optional overlap and an inherited prefix cut. */
export function createSessionUsageFold(inheritedEventCount = 0) {
  let lastSeq = inheritedEventCount - 1
  let step
  const settled = { requests: [], unpriced: 0 }

  function endStep() {
    appendStep(settled, step)
    step = undefined
  }

  function startStep(data, time) {
    endStep()
    step = { turn: data.turn, step: data.step, prior: [], current: { time } }
  }

  function add(events) {
    for (const event of events) {
      if (!isCount(event?.seq) || event.seq <= lastSeq) continue
      lastSeq = event.seq
      const { type, data, time } = event
      if (!data) continue

      switch (type) {
        case 'step/start':
          startStep(data, time)
          break
        case 'turn/start':
        case 'session/end-seed':
          endStep()
          break
        case 'step/end':
          if (samePosition(step, data)) endStep()
          break
        case 'turn/end':
          if (step?.turn === data.turn) endStep()
          break
        case 'request/header':
        case 'request/context': {
          const attempt = step?.current
          if (!attempt || attempt.settled) break
          const route = type === 'request/header' ? data.header?.config : data
          // A route observation can rule out retry attribution. Only a message
          // source can supply it, since route metadata persists across requests.
          if (typeof route?.provider !== 'string' || !isModel(route?.model)
            || (attempt.route !== undefined && !sameRoute(attempt.route, route))) {
            attempt.route = null
          } else {
            attempt.route = { provider: route.provider, model: route.model }
          }
          break
        }
        case 'llm/retry': {
          if (!samePosition(step, data) || !step.current.settled) break
          step.current.retry = data.provider === PROVIDER && typeof data.retryId === 'string'
            && data.retryId.length > 0 && isCount(data.retry) && data.retry > 0
            ? { id: data.retryId, count: data.retry } : undefined
          break
        }
        case 'llm/retry-started': {
          if (!samePosition(step, data)) break
          const attempt = step.current
          const retry = attempt.retry
          const matchedRetry = retry && retry.id === data.retryId && retry.count === data.retry
          if (attempt.source || (attempt.source === undefined && matchedRetry)) {
            step.prior.push(attempt)
          }
          step.current = { time }
          break
        }
        case 'assistant/attempt':
        case 'assistant/message': {
          if (!isCount(data.turn) || !isCount(data.step)) break
          if (!samePosition(step, data)) startStep(data, time)
          const attempt = step.current
          if (!Number.isSafeInteger(attempt.time)) attempt.time = time
          attempt.settled = true
          const usage = usageOf(event)
          if (usage !== undefined) attempt.usage = tokenBuckets(usage)
          if (type === 'assistant/message') {
            const source = data.message?.source
            attempt.source = source ? { provider: source.provider, model: source.model } : null
          }
          break
        }
      }
    }
  }

  function snapshot() {
    const result = { requests: [...settled.requests], unpriced: settled.unpriced }
    appendStep(result, step)
    return result
  }

  return { add, snapshot }
}

function requestCostPerMillion(request, getRate) {
  const usage = tokenBuckets(request)
  if (!usage || !isModel(request.model) || !Number.isSafeInteger(request.time)) return undefined
  const rate = getRate(request.model, request.time)
  if (!rate) return undefined
  const { short, long } = rate
  if (long !== undefined && !isCount(long?.threshold)) return undefined
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const rates = long && prompt > long.threshold ? long.rates : short
  let costPerMillion = 0
  for (const [bucket, key] of TOKEN_RATES) {
    if (usage[bucket] === 0) continue
    // A cache-write rate must be verified for the applicable retention. The
    // durable usage carries the write count but no retention information.
    const price = rates?.[key]
    if (!Number.isFinite(price) || price < 0) return undefined
    costPerMillion += usage[bucket] * price
  }
  return costPerMillion
}

/** Price complete requests at the exact model and recorded time in USD. */
export function summarizeUsage(snapshot, getRate) {
  let costPerMillion = 0
  let priced = 0
  let unpriced = snapshot.unpriced
  for (const request of snapshot.requests) {
    const cost = requestCostPerMillion(request, getRate)
    if (!Number.isFinite(cost) || !Number.isFinite(costPerMillion + cost)) {
      unpriced++
      continue
    }
    costPerMillion += cost
    priced++
  }
  return { usd: costPerMillion / 1_000_000, priced, unpriced }
}
