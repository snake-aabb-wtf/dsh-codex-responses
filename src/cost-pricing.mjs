const docs = 'https://developers.openai.com/api/docs'
const pricingUrl = `${docs}/pricing.md`
const modelUrl = id => `${docs}/models/${id}.md`
const modelIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const refreshMs = 6 * 60 * 60_000
const retryMs = 5 * 60_000
const timeoutMs = 8_000
const responseLimit = 256 * 1024
const dayMs = 86_400_000
const rateFields = ['input', 'cacheRead', 'output', 'cacheWrite']
const isModelId = id => typeof id === 'string' && modelIdPattern.test(id)
const isTimestamp = value => Number.isSafeInteger(value) && value >= 0
const isRate = value => Number.isFinite(value) && value >= 0 && value < 1e10

function invalidPricing() {
  throw new Error('Unrecognized or conflicting OpenAI pricing.')
}

function waitWhileActive(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    promise.finally(() => signal.removeEventListener('abort', abort)).then(resolve, reject)
  })
}

async function fetchMarkdown(fetch, url, signal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  requestSignal.throwIfAborted()
  const response = await fetch(url, {
    method: 'GET', credentials: 'omit', redirect: 'error', signal: requestSignal,
    headers: { Accept: 'text/markdown' },
  })
  if (requestSignal.aborted) {
    void response.body?.cancel().catch(() => {})
    requestSignal.throwIfAborted()
  }
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (!response.ok || response.redirected || mediaType !== 'text/markdown' ||
      Number(response.headers.get('content-length')) > responseLimit) {
    void response.body?.cancel().catch(() => {})
    if (response.status === 404 && !response.redirected) return undefined
    invalidPricing()
  }
  const parts = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    requestSignal.throwIfAborted()
    size += chunk.byteLength
    if (size > responseLimit) invalidPricing()
    parts.push(chunk)
  }
  requestSignal.throwIfAborted()
  const markdown = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
  const lines = []
  let fence
  for (const line of markdown.replace(/<!--[\s\S]*?-->/gu, '').split(/\r?\n/u)) {
    if (line.length > 8192) invalidPricing()
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined
    } else if (marker) {
      fence = marker[1]
    } else if (line.trim()) {
      lines.push(line.trim())
    }
  }
  if (fence) invalidPricing()
  return lines
}

function amount(cell, optional = false) {
  if (optional && cell === '-') return undefined
  if (!/^\$\d{1,10}(?:\.\d{1,12})?$/u.test(cell)) invalidPricing()
  return Number(cell.slice(1))
}

function readTable(lines, start, layouts) {
  const rows = []
  let layout
  let needsDivider = false
  let index = start
  for (; lines[index]?.startsWith('|'); index++) {
    const line = lines[index]
    if (!line.endsWith('|')) invalidPricing()
    const cells = line.slice(1, -1).split('|').map(value => value.trim())
    if (needsDivider) {
      if (cells.length !== layout.length || !cells.every(value => /^:?-{3,}:?$/u.test(value))) invalidPricing()
      needsDivider = false
    } else if (layouts.has(cells.join('|'))) {
      layout = cells
      needsDivider = true
    } else {
      if (!layout || cells.length !== layout.length) invalidPricing()
      rows.push({ layout, cells })
    }
  }
  if (!layout || needsDivider) invalidPricing()
  return { rows, end: index }
}

function uniqueIndex(lines, label) {
  const index = lines.indexOf(label)
  if (index !== lines.lastIndexOf(label)) invalidPricing()
  return index
}

function tokenCount(text) {
  const match = /^(\d+|\d{1,3}(?:,\d{3})+)(K)?$/iu.exec(text)
  const count = match && Number(match[1].replaceAll(',', '')) * (match[2] ? 1000 : 1)
  if (!Number.isSafeInteger(count) || count <= 0) invalidPricing()
  return count
}

const months = 'January February March April May June July August September October November December'.split(' ')
const pacificClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'longOffset' })

function mergePromotions(first, second) {
  if (!first || !second) return first ?? second
  if (first.boundaryDay !== second.boundaryDay || (first.zone && second.zone && first.zone !== second.zone)) invalidPricing()
  return { ...(second.zone ? second : first), expiryIsMinimum: first.expiryIsMinimum || second.expiryIsMinimum }
}

function promotionValidity(lines) {
  let validity
  for (const line of lines) {
    const match = /promotional pricing is available (until|(?:at least )?through) ([a-z]+) (\d{1,2}), (20\d{2})(?: \(([^()]+)\))?\./iu.exec(line)
    if (!match) invalidPricing()
    const [, qualifier, month, day, year, declaredZone] = match
    const boundary = qualifier.toLowerCase()
    const monthIndex = months.findIndex(name => name.toLowerCase() === month.toLowerCase())
    const date = new Date(Date.UTC(Number(year), monthIndex, Number(day)))
    if (monthIndex < 0 || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== Number(day)) invalidPricing()
    // Until excludes the named day. Through includes it. Use UTC when neither source names a zone.
    const boundaryDay = date.getTime() + (boundary === 'until' ? 0 : dayMs)
    let validUntil = boundaryDay
    let zone
    if (/^(?:Pacific time|PT)$/iu.test(declaredZone ?? '')) {
      zone = 'Pacific'
      // US Pacific clock changes happen after local midnight. Use the offset of the boundary day.
      const offset = pacificClock.formatToParts(boundaryDay).find(part => part.type === 'timeZoneName')?.value
      const hours = /^GMT-(0[78]):00$/u.exec(offset ?? '')
      if (!hours) invalidPricing()
      validUntil += Number(hours[1]) * 3_600_000
    } else if (declaredZone !== undefined) {
      if (declaredZone.toUpperCase() !== 'UTC') invalidPricing()
      zone = 'UTC'
    }
    validity = mergePromotions(validity, { boundaryDay, zone, validUntil, expiryIsMinimum: boundary.startsWith('at least') })
  }
  return validity
}

function mergeRates(first = {}, second = {}) {
  const merged = {}
  for (const field of rateFields) {
    if (first[field] !== undefined && second[field] !== undefined && first[field] !== second[field]) invalidPricing()
    const rate = first[field] ?? second[field]
    if (rate !== undefined) merged[field] = rate
  }
  return merged
}

function scaled(rate, multiplier) {
  return Number((rate * multiplier).toPrecision(15))
}

const standardIntros = new Set([
  'Prices are per 1M tokens. See the [pricing page](/api/docs/pricing) for processing tiers and billing details.',
  'Pricing is based on the number of tokens used, or other metrics based on the model type. ' +
    'For tool-specific models, like search and computer use, there’s a fee per tool call. ' +
    'See details in the [pricing page](/api/docs/pricing).',
])

function parseModelPage(lines, id) {
  if (!lines) return undefined
  const pricing = uniqueIndex(lines, '## Pricing')
  if (pricing < 0) invalidPricing()
  const declarations = lines.slice(0, pricing).filter(line => line.startsWith('Model ID:'))
  if (declarations.length !== 1 || declarations[0] !== `Model ID: \`${id}\``) invalidPricing()
  const end = lines.findIndex((line, index) => index > pricing && line.startsWith('## '))
  const section = lines.slice(pricing + 1, end < 0 ? undefined : end)
  const text = uniqueIndex(section, '### Text tokens')
  if (text < 0 || (text > 0 && !standardIntros.has(section.slice(0, text).join(' ')))) invalidPricing()

  const fields = new Map([['Input', 'input'], ['Output', 'output'], ['Cached input', 'cacheRead'], ['Cache writes', 'cacheWrite']])
  const table = readTable(section, text + 1, new Set(['Metric|Price|Unit']))
  const short = {}
  for (const { cells: [metric, price, unit] } of table.rows) {
    const field = fields.get(metric)
    if (!field || Object.hasOwn(short, field) || unit !== '1M tokens') invalidPricing()
    short[field] = amount(price, field === 'cacheWrite')
  }
  if (!rateFields.slice(0, 3).every(field => isRate(short[field]))) invalidPricing()

  const notes = section.slice(table.end)
  if (notes.some(line => /\b(?:these|the (?:following|listed|above)) (?:prices|rates) (?:apply to|are for) (?:Batch|Flex|Fast|Ultrafast|Priority)\b/iu.test(line))) invalidPricing()
  const promotions = notes.filter(line => /promotional pricing/iu.test(line))
  const writePolicies = notes.filter(line => line.startsWith('- Cache writes are billed at '))
  for (const line of writePolicies) {
    const policy = /^- Cache writes are billed at (\d+(?:\.\d+)?)x the uncached input token rate\.$/u.exec(line)
    if (!policy) invalidPricing()
    Object.assign(short, mergeRates(short, { cacheWrite: scaled(short.input, Number(policy[1])) }))
  }

  const context = notes.filter(line => /\b(?:prompts|requests)\b.*\binput tokens\b|\blong[ -]context (?:pricing|rates|tiers?)\b/iu.test(line))
  if (context.length > 1) invalidPricing()
  const parsed = { short, promotion: promotionValidity(promotions), source: modelUrl(id) }
  if (!context.length) return parsed

  const doubles = /^- For requests with more than ([\d,K]+) input tokens, input and cache rates double and output costs (\d+(?:\.\d+)?) times the short-context rate for the full request\.$/u.exec(context[0])
  const multipliers = /^- (?:API |For [^,]+, )?prompts with (?:more than |>)\s*([\d,K]+) input tokens are priced at (\d+(?:\.\d+)?)x input( and cache rates)? and (\d+(?:\.\d+)?)x output for the full (?:request|session)(?: for standard, batch, and flex)?\.$/iu.exec(context[0])
  if (!doubles && !multipliers) invalidPricing()
  const threshold = tokenCount(doubles?.[1] ?? multipliers[1])
  const input = doubles ? 2 : Number(multipliers[2])
  const output = Number(doubles?.[2] ?? multipliers[4])
  const rates = { input: scaled(short.input, input), output: scaled(short.output, output) }
  if (doubles || multipliers[3]) {
    rates.cacheRead = scaled(short.cacheRead, input)
    if (short.cacheWrite !== undefined) rates.cacheWrite = scaled(short.cacheWrite, input)
  }
  parsed.long = { threshold, rates }
  return parsed
}

const flatLayout = 'Model|Input|Output|Cached input'
const splitLayout = ['Model', ...['Short context', 'Long context'].flatMap(prefix =>
  ['input', 'output', 'cached input', '30m write', '12h write'].map(field => `${prefix} ${field}`))].join('|')
const flagshipLayouts = new Set([flatLayout, splitLayout])
const specializedLayouts = new Set([`Category|${flatLayout}|30m write|12h write`, `Category|${flatLayout}`])

function standardTable(lines, heading, layouts) {
  const index = layouts === specializedLayouts
    ? lines.findIndex((line, i) => line === heading && lines[i - 1] === 'Standard')
    : uniqueIndex(lines, heading)
  if (index < 2 || lines[index - 1] !== 'Standard' || lines[index - 2] !== 'Prices per 1M tokens.') invalidPricing()
  return readTable(lines, index + 1, layouts).rows
}

function readPricingPage(lines) {
  if (!lines) return undefined
  if (lines[0] !== '# Pricing') invalidPricing()
  const rows = standardTable(lines, '### Standard pricing data', flagshipLayouts)
  const specialized = lines.indexOf('Specialized models')
  if (specialized >= 0) {
    const end = lines.indexOf('Tools', specialized + 1)
    rows.push(...standardTable(lines.slice(specialized + 1, end < 0 ? undefined : end),
      '### Grouped Pricing Table data', specializedLayouts))
  }
  return { lines, rows }
}

function parsePricingPage(page, id) {
  if (!page) return undefined
  const { lines, rows } = page
  const matches = []
  for (const { layout, cells } of rows) {
    const [label, ...prices] = cells.slice(layout[0] === 'Category' ? 1 : 0)
    const qualifier = /^(.*) \(<([\d,K]+) context length\)$/u.exec(label)
    if (label === id || qualifier?.[1] === id) matches.push({ prices, split: layout[1] === 'Short context input', qualifier })
  }
  if (matches.length > 1) invalidPricing()
  if (!matches.length) return undefined

  const [{ prices, split, qualifier }] = matches
  if (qualifier && !split) invalidPricing()
  const [input, output, cacheRead, cacheWrite] = prices
  const short = { input: amount(input), cacheRead: amount(cacheRead), output: amount(output) }
  if (cacheWrite !== undefined) short.cacheWrite = amount(cacheWrite, true)

  const promotionPrefix = `${id.replaceAll('-', ' ')}'s promotional pricing`
  const promotions = lines.filter(line => line.toLowerCase().replace(/[‑–-]/gu, ' ').replaceAll('’', "'").includes(promotionPrefix))
  const parsed = { short, promotion: promotionValidity(promotions), source: pricingUrl }
  if (!split) return parsed

  const thresholds = new Set(lines.flatMap(line => {
    const match = /^Short context: ≤([\d,K]+) input tokens\. Long context: >([\d,K]+) input tokens\.$/u.exec(line)
    if (!match) return []
    const threshold = tokenCount(match[1])
    if (threshold !== tokenCount(match[2])) invalidPricing()
    return [threshold]
  }))
  if (thresholds.size > 1) invalidPricing()
  const [threshold] = thresholds
  if (qualifier && threshold !== undefined && tokenCount(qualifier[2]) !== threshold) invalidPricing()
  const [longInput, longOutput, longRead, longWrite] = prices.slice(5)
  parsed.long = { threshold, rates: {
    input: amount(longInput), cacheRead: amount(longRead), output: amount(longOutput), cacheWrite: amount(longWrite, true),
  } }
  return parsed
}

const startBases = new Set(['published-standard', 'first-observed', 'documented-expiry', 'change-observed'])

function validateEntry(entry, time) {
  if (!entry || !isModelId(entry.modelId) || !isTimestamp(entry.checkedAt) || entry.checkedAt > time ||
      !Array.isArray(entry.sources) || entry.sources.length < 1 || entry.sources.length > 2 ||
      !entry.sources.every(url => url === pricingUrl || url === modelUrl(entry.modelId))) return undefined
  const { modelId, checkedAt, validFrom, validFromBasis, validUntil, validUntilBasis, expiryIsMinimum, long } = entry
  if ((validFrom !== undefined && !isTimestamp(validFrom)) ||
      (validFromBasis !== undefined && !startBases.has(validFromBasis)) ||
      (validUntil !== undefined && (!isTimestamp(validUntil) || validUntil <= (validFrom ?? 0) || validUntil < checkedAt)) ||
      (validUntilBasis !== undefined && (validUntilBasis !== 'change-observed' || validUntil === undefined)) ||
      (expiryIsMinimum !== undefined && (expiryIsMinimum !== true || validUntil === undefined))) return undefined

  function validatedRates(rates) {
    if (!rates || !rateFields.slice(0, 3).every(field => isRate(rates[field])) ||
        (rates.cacheWrite !== undefined && !isRate(rates.cacheWrite))) return undefined
    return Object.freeze(mergeRates(rates))
  }

  const short = validatedRates(entry.short)
  const longRates = long && validatedRates(long.rates)
  if (!short || (long !== undefined && (!longRates || !Number.isSafeInteger(long.threshold) || long.threshold <= 0))) return undefined
  return Object.freeze({
    modelId, short, checkedAt, sources: Object.freeze([...entry.sources]),
    ...(long && { long: Object.freeze({ threshold: long.threshold, rates: longRates }) }),
    ...(validFrom !== undefined && { validFrom }),
    ...(validFromBasis !== undefined && { validFromBasis }),
    ...(validUntil !== undefined && { validUntil }),
    ...(validUntilBasis !== undefined && { validUntilBasis }),
    ...(expiryIsMinimum && { expiryIsMinimum }),
  })
}

function combine(id, model, pricing, checkedAt) {
  if (!model && !pricing) return undefined
  if (model?.long?.threshold !== undefined && pricing?.long?.threshold !== undefined &&
      model.long.threshold !== pricing.long.threshold) invalidPricing()
  const promotion = mergePromotions(model?.promotion, pricing?.promotion)
  const validUntil = promotion?.validUntil
  if (validUntil !== undefined && validUntil <= checkedAt) return undefined
  const long = model?.long || pricing?.long ? {
    threshold: model?.long?.threshold ?? pricing?.long?.threshold,
    rates: mergeRates(model?.long?.rates, pricing?.long?.rates),
  } : undefined
  return validateEntry({
    modelId: id, checkedAt, short: mergeRates(model?.short, pricing?.short), long,
    validUntil, expiryIsMinimum: promotion?.expiryIsMinimum || undefined,
    sources: [model?.source, pricing?.source].filter(Boolean),
  }, checkedAt)
}

const startOf = entry => entry.validFrom ?? 0
const endOf = entry => entry.validUntil ?? Infinity
const sameRates = (first, second) => rateFields.every(key => first?.[key] === second?.[key])

function applyRate(history, entry) {
  const previous = history.at(-1)
  if (!previous) {
    // An undated official Standard quote is the estimate for earlier usage until there is contrary rate history.
    // A promotion with no published start has only been verified from the first observation.
    const promotional = entry.validUntil !== undefined
    history.push(Object.freeze({ ...entry, ...(promotional && { validFrom: entry.checkedAt }),
      validFromBasis: promotional ? 'first-observed' : 'published-standard',
    }))
    return
  }

  if (previous.validUntil === entry.validUntil && previous.expiryIsMinimum === entry.expiryIsMinimum &&
      sameRates(previous.short, entry.short) && previous.long?.threshold === entry.long?.threshold &&
      sameRates(previous.long?.rates, entry.long?.rates)) {
    // A recheck refreshes the evidence for the same period without adding a history row.
    history[history.length - 1] = Object.freeze({
      ...previous, checkedAt: entry.checkedAt, sources: entry.sources,
    })
    return
  }

  const explicitRollover = previous.validUntil !== undefined && previous.validUntil <= entry.checkedAt &&
    !previous.expiryIsMinimum && !previous.validUntilBasis && entry.validUntil === undefined
  const validFrom = explicitRollover ? previous.validUntil : entry.checkedAt
  if (validFrom <= startOf(previous)) {
    history.pop()
  } else if (validFrom < endOf(previous)) {
    history[history.length - 1] = Object.freeze({ ...previous, validUntil: validFrom, validUntilBasis: 'change-observed' })
  }
  history.push(Object.freeze({ ...entry, validFrom, validFromBasis: explicitRollover ? 'documented-expiry' : 'change-observed' }))
}

export function createPricingCatalog({ fetch = globalThis.fetch, now = Date.now,
  readCache = async () => undefined, writeCache = async () => {} } = {}) {
  const histories = new Map()
  const nextCheck = new Map()
  const inFlight = new Map()
  let lastSync = null
  let revision = 0
  let loading
  let writing = Promise.resolve()

  function remember(history) {
    const latest = history.at(-1)
    histories.set(latest.modelId, history)
    lastSync = Math.max(lastSync ?? 0, latest.checkedAt)
    revision++
  }

  function load() {
    loading ??= Promise.resolve().then(readCache).then(cache => {
      if (cache?.version !== 1 || !Array.isArray(cache.entries)) return
      const time = now()
      const cachedHistories = new Map()
      for (const value of cache.entries) {
        const entry = validateEntry(value, time)
        if (!entry) continue
        const history = cachedHistories.get(entry.modelId) ?? []
        // Deployed v1 only stored one row per model and omitted the start for promotions.
        history.push(entry.validFrom === undefined && entry.validUntil !== undefined && entry.validFromBasis === undefined
          ? Object.freeze({ ...entry, validFrom: entry.checkedAt, validFromBasis: 'first-observed' }) : entry)
        cachedHistories.set(entry.modelId, history)
      }
      for (const [id, history] of cachedHistories) {
        history.sort((first, second) => startOf(first) - startOf(second))
        if (history.some((entry, i) => endOf(entry) <= startOf(entry) ||
          (i > 0 && (startOf(entry) < endOf(history[i - 1]) || entry.checkedAt < history[i - 1].checkedAt)))) continue
        remember(history)
        const latest = history.at(-1)
        nextCheck.set(id, Math.min(latest.checkedAt + refreshMs, endOf(latest)))
      }
    }).catch(() => {})
    return loading
  }

  async function refresh(id, signal, getPricing) {
    let entry
    try {
      const documents = await waitWhileActive(Promise.all([fetchMarkdown(fetch, modelUrl(id), signal), getPricing()]), signal)
      if (documents && !signal?.aborted) {
        const [model, pricing] = documents
        entry = combine(id, parseModelPage(model, id), parsePricingPage(pricing, id), now())
      }
    } catch {
      // A bad response never replaces the last validated rate for this model.
    }
    if (signal?.aborted) return false
    if (entry) {
      const history = histories.get(id) ?? []
      applyRate(history, entry)
      remember(history)
    }
    nextCheck.set(id, entry ? Math.min(entry.checkedAt + refreshMs, endOf(entry)) : now() + retryMs)
    return Boolean(entry)
  }

  async function sync(modelIds, signal) {
    if (signal?.aborted) return
    await waitWhileActive(load(), signal)
    if (signal?.aborted) return
    const ids = [...new Set(modelIds)].filter(isModelId)
    let index = 0
    let updated = false
    let pricing
    function getPricing() {
      pricing ??= fetchMarkdown(fetch, pricingUrl, signal).then(readPricingPage)
      return pricing
    }

    async function worker() {
      while (index < ids.length && !signal?.aborted) {
        const id = ids[index++]
        let active = inFlight.get(id)
        while (active && !active.signal?.aborted && !signal?.aborted) {
          await waitWhileActive(active.promise, signal)
          active = inFlight.get(id)
        }
        if (signal?.aborted || now() < (nextCheck.get(id) ?? -Infinity)) continue
        const task = { signal, promise: refresh(id, signal, getPricing).finally(() => {
          if (inFlight.get(id) === task) inFlight.delete(id)
        }) }
        inFlight.set(id, task)
        if (await task.promise) updated = true
      }
    }

    await Promise.all(Array.from({ length: Math.min(ids.length, 4) }, worker))
    if (updated) {
      // Serialize snapshots so a slow callback cannot overwrite a newer catalog.
      writing = writing.then(() => writeCache({ version: 1, entries: [...histories.values()].flat() })).catch(() => {})
      await writing
    }
  }

  function getRate(modelId, timestamp = now()) {
    const time = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp
    const history = histories.get(modelId)
    if (!history || !isTimestamp(time)) return undefined
    let first = 0
    let last = history.length - 1
    while (first <= last) {
      const index = Math.floor((first + last) / 2)
      const entry = history[index]
      if (time < startOf(entry)) last = index - 1
      else if (time >= endOf(entry)) first = index + 1
      else return entry
    }
    return undefined
  }

  return { load, sync, getRate, getLastSync: () => lastSync, getRevision: () => revision }
}
