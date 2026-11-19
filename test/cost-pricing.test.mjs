import assert from 'node:assert/strict'
import test from 'node:test'
import { createPricingCatalog } from '../src/cost-pricing.mjs'

const docs = 'https://developers.openai.com/api/docs'
const pricingUrl = `${docs}/pricing.md`
const modelUrl = id => `${docs}/models/${id}.md`
const verifiedAt = Date.UTC(2026, 10, 19)
const day = 86_400_000
const sol = 'gpt-6.2-sol'
const upcoming = 'codex-example-2030-preview'

const shortHeader = '| Model | Input | Output | Cached input |'
const shortDivider = '| --- | --- | --- | --- |'
const longHeader = '| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |'
const longDivider = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
const solRow = `| ${sol} | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |`
const newRow = `| ${upcoming} | $1.20 | $6.00 | $0.12 |`

function pricePage(table, notes = '', unit = 'Prices per 1M tokens.') {
  return `# Pricing

Flagship models

    ${unit}

Standard

### Standard pricing data
${table}

Batch

### Batch pricing data
${shortHeader}
${shortDivider}
| ${upcoming} | $0.60 | $3.00 | $0.06 |

${notes}

Multimodal models
`
}

function modelPage(id, { input = '$1.2', cached = '$0.12', output = '$6', unit = '1M tokens', write, notes = '', heading = 'Text tokens' } = {}) {
  return `# Example model

Model ID: \`${id}\`

## Pricing

Prices are per 1M tokens. See the [pricing page](/api/docs/pricing) for processing tiers and billing details.
### ${heading}

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | ${input} | ${unit} |
| Cached input | ${cached} | ${unit} |
${write ? `| Cache writes | ${write} | ${unit} |\n` : ''}| Output | ${output} | ${unit} |
${notes}
## Endpoints
`
}

function markdown(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
}

function setup(documents = new Map(), overrides = {}) {
  const calls = []
  let time = verifiedAt
  let cache
  const catalog = createPricingCatalog({
    now: () => time,
    fetch: async (url, options) => {
      calls.push([String(url), options])
      const body = documents.get(String(url))
      if (typeof body === 'function') return body(options)
      if (body === undefined) return new Response(null, { status: 404 })
      return markdown(body)
    },
    writeCache: async value => { cache = JSON.parse(JSON.stringify(value)) },
    ...overrides,
  })
  return { catalog, calls, advance: (delta = day) => { time += delta }, cache: () => cache }
}

test('discovers a previously unpriced exact model from the Standard Markdown table', async () => {
  const documents = new Map([[pricingUrl, pricePage(`${shortHeader}\n${shortDivider}\n| ${upcoming}-other | $2 | $10 | $0.2 |`)]])
  const { catalog, calls, advance } = setup(documents)
  await catalog.sync([upcoming, upcoming, '../../pricing', 'gpt-6.2-sol'])
  assert.equal(catalog.getRate(upcoming, verifiedAt), undefined)
  assert.equal(catalog.getLastSync(), null)
  assert.deepEqual(calls.map(([url]) => url).sort(), [pricingUrl, modelUrl(upcoming), modelUrl(sol)].sort())

  documents.set(pricingUrl, pricePage(`${shortHeader}\n${shortDivider}\n${newRow}`))
  await catalog.sync([upcoming])
  assert.equal(calls.length, 3)
  advance()
  await catalog.sync([upcoming])
  assert.deepEqual(catalog.getRate(upcoming, verifiedAt)?.short, { input: 1.2, cacheRead: 0.12, output: 6 })
  assert.equal(catalog.getRate(upcoming.toUpperCase(), verifiedAt), undefined)
  assert.equal(catalog.getLastSync(), verifiedAt + day)
  for (const [url, options] of calls) {
    assert.equal(new URL(url).origin, 'https://developers.openai.com')
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    const headers = new Headers(options.headers)
    assert.equal(headers.get('accept'), 'text/markdown')
    assert.equal(headers.has('authorization'), false)
    assert.equal(headers.has('cookie'), false)
  }
})

test('cross-checks verified Sol Standard short and long rates, including default cache writes', async () => {
  const { catalog } = setup(new Map([
    [pricingUrl, pricePage(`${longHeader}\n${longDivider}\n${solRow}\n${shortHeader}\n${shortDivider}\n${newRow}`,
      'Short context: ≤272K input tokens. Long context: >272K input tokens.')],
    [modelUrl(sol), modelPage(sol, { input: '$2', cached: '$0.1', output: '$10', write: '$2.5', notes: [
      '- The cache write price is for 30 minutes of retention. A 12-hour cache write costs $5 per million tokens for short-context requests at Standard pricing.',
      '- For requests with more than 272K input tokens, input and cache rates double and output costs 1.5 times the short-context rate for the full request.',
    ].join('\n') })],
  ]))
  await catalog.sync([sol])
  const rate = catalog.getRate(sol, verifiedAt)
  assert.deepEqual(rate?.short, { input: 2, cacheRead: 0.1, output: 10, cacheWrite: 2.5 })
  assert.deepEqual(rate?.long, { threshold: 272000, rates: { input: 4, cacheRead: 0.2, output: 15, cacheWrite: 5 } })
  assert.equal(catalog.getRate(upcoming, verifiedAt), undefined)
})

test('uses a model-only published context rule without a model allowlist', async () => {
  const { catalog } = setup(new Map([[modelUrl(upcoming), modelPage(upcoming, { write: '$1.5',
    notes: '- Prompts with more than 320K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.',
  })]]))
  await catalog.sync([upcoming])
  assert.deepEqual(catalog.getRate(upcoming, verifiedAt)?.long,
    { threshold: 320000, rates: { input: 2.4, cacheRead: 0.24, output: 9, cacheWrite: 3 } })
})

test('reconciles published long-context wording across current and older model documents', async () => {
  const terra = 'gpt-6.1-terra'
  const sol61 = 'gpt-6.1-sol'
  const gpt55 = 'gpt-5.5'
  const { catalog } = setup(new Map([
    [pricingUrl, pricePage([
      longHeader, longDivider,
      `| ${terra} | $1 | $5 | $0.05 | $1.25 | $2.50 | $2 | $7.50 | $0.10 | $2.50 | $5 |`,
      `| ${sol61} | $2 | $10 | $0.10 | $2.50 | $5 | $4 | $15 | $0.20 | $5 | $10 |`,
      `| ${gpt55} (<272K context length) | $5 | $30 | $0.50 | - | - | $10 | $45 | $1 | - | - |`,
    ].join('\n'), 'Short context: ≤272K input tokens. Long context: >272K input tokens.')],
    [modelUrl(terra), modelPage(terra, { input: '$1', output: '$5', cached: '$0.05', write: '$1.25', notes: [
      '- Cache-write prices shown use 30-minute retention. Standard cache writes cost $1.25 per million tokens for 30-minute retention and $2.50 for 12-hour retention, before long-context adjustments.',
      '- Prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.',
    ].join('\n') })],
    [modelUrl(sol61), modelPage(sol61, { input: '$2', output: '$10', cached: '$0.10', write: '$2.50', notes: [
      '- API prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.',
      '- Usage drawn from your subscription has no long-context surcharge. See [Codex pricing](/codex/pricing).',
    ].join('\n') })],
    [modelUrl(gpt55), modelPage(gpt55, { input: '$5', output: '$30', cached: '$0.50',
      notes: '- For GPT-5.5, prompts with >272K input tokens are priced at 2x input and 1.5x output for the full session for standard, batch, and flex.',
    })],
  ]))
  await catalog.sync([terra, sol61, gpt55])
  assert.deepEqual(catalog.getRate(terra)?.long, {
    threshold: 272000, rates: { input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 },
  })
  assert.deepEqual(catalog.getRate(sol61)?.long, {
    threshold: 272000, rates: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
  })
  assert.deepEqual(catalog.getRate(gpt55)?.long, {
    threshold: 272000, rates: { input: 10, output: 45, cacheRead: 1 },
  })
})

test('uses the exact Codex row in the documented Specialized models Standard table', async () => {
  const page = `${pricePage(`${shortHeader}\n${shortDivider}\n${newRow}`)}
Specialized models

    Prices per 1M tokens.

Standard

### Grouped Pricing Table data
| Category | Model | Input | Output | Cached input | 30m write | 12h write |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $1.75 | $14.00 | $0.175 | - | - |

Fast

### Grouped Pricing Table data
| Category | Model | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $3.50 | $28.00 | $0.35 |
`
  const { catalog } = setup(new Map([[pricingUrl, page]]))
  await catalog.sync(['gpt-5.3-codex'])
  assert.deepEqual(catalog.getRate('gpt-5.3-codex', verifiedAt)?.short, { input: 1.75, cacheRead: 0.175, output: 14 })
})

test('preserves the last validated entry across same-tier conflicts and subsequent outages', async () => {
  const documents = new Map([[modelUrl(upcoming), modelPage(upcoming)]])
  const { catalog, advance, cache } = setup(documents)
  await catalog.sync([upcoming])
  const original = catalog.getRate(upcoming, verifiedAt)
  assert.equal(original?.short.input, 1.2)
  const persisted = cache()
  documents.set(pricingUrl, pricePage(`${shortHeader}\n${shortDivider}\n${newRow.replace('$1.20', '$1.25')}`))
  advance()
  await catalog.sync([upcoming])
  assert.deepEqual(catalog.getRate(upcoming, verifiedAt), original)
  assert.equal(catalog.getLastSync(), verifiedAt)
  assert.deepEqual(cache(), persisted)

  const offline = setup(new Map(), {
    now: () => verifiedAt + 2 * day,
    readCache: async () => persisted,
    fetch: async () => { throw new Error('offline') },
  })
  await offline.catalog.sync([upcoming])
  assert.deepEqual(offline.catalog.getRate(upcoming, verifiedAt), original)
  assert.equal(offline.catalog.getLastSync(), verifiedAt)
})

test('loads validated JSON rates without a network request and rejects corrupted cache entries', async () => {
  const online = setup(new Map([[modelUrl(upcoming), modelPage(upcoming)]]))
  await online.catalog.sync([upcoming])
  const cached = online.cache()
  assert.equal(cached.entries.length, 1)
  cached.entries.push({ ...cached.entries[0], modelId: 'unverified', sources: [modelUrl('unverified')],
    short: { input: -3, cacheRead: 0.12, output: 6 },
  })
  const offline = setup(new Map(), { readCache: async () => cached })
  await Promise.all([offline.catalog.load(), offline.catalog.load()])
  assert.equal(offline.catalog.getRate(upcoming, verifiedAt)?.short.input, 1.2)
  assert.equal(offline.catalog.getRate('unverified', verifiedAt), undefined)
  assert.equal(offline.catalog.getLastSync(), verifiedAt)
  assert.deepEqual(offline.calls, [])
})

test('uses promotional rates only within their documented validity', async () => {
  const documents = new Map([[modelUrl(upcoming), modelPage(upcoming, {
    notes: '- Example Model’s promotional pricing is available until November 30, 2026.',
  })]])
  const { catalog, advance } = setup(documents)
  const expiry = Date.UTC(2026, 10, 30)
  await catalog.sync([upcoming])
  assert.equal(catalog.getRate(upcoming, expiry - 1)?.short.input, 1.2)
  assert.equal(catalog.getRate(upcoming, expiry), undefined)
  advance(20 * day)
  await catalog.sync([upcoming])
  assert.equal(catalog.getRate(upcoming), undefined)
  assert.equal(catalog.getLastSync(), verifiedAt)
})

test('retains a promotion across rollover, subsequent refresh, and cache reload', async () => {
  const promotion = '- Example Model’s promotional pricing is available through March 14, 2027 (Pacific time).'
  const firstCheck = Date.UTC(2027, 2, 13, 12)
  const expiry = Date.UTC(2027, 2, 15, 7)
  let now = firstCheck
  const documents = new Map([
    [modelUrl(upcoming), modelPage(upcoming, { notes: promotion })],
    [pricingUrl, pricePage(`${shortHeader}\n${shortDivider}\n${newRow}`,
      'Codex Example 2030 Preview’s promotional pricing is available through March 14, 2027.')],
  ])
  const { catalog, cache } = setup(documents, { now: () => now })
  await catalog.sync([upcoming])
  assert.equal(catalog.getRate(upcoming, firstCheck - 1), undefined)
  assert.equal(catalog.getRate(upcoming, expiry - 1)?.short.input, 1.2)
  assert.equal(catalog.getRate(upcoming, expiry), undefined)

  now = expiry + day
  documents.set(modelUrl(upcoming), modelPage(upcoming, { input: '$2', cached: '$0.2', output: '$10' }))
  documents.set(pricingUrl, pricePage(`${shortHeader}\n${shortDivider}\n| ${upcoming} | $2.00 | $10.00 | $0.20 |`))
  await catalog.sync([upcoming])
  assert.equal(catalog.getRate(upcoming, expiry - 1)?.short.input, 1.2)
  assert.equal(catalog.getRate(upcoming, expiry)?.short.input, 2)
  assert.equal(catalog.getRate(upcoming, now)?.short.input, 2)

  now += day
  await catalog.sync([upcoming])
  assert.equal(cache().entries.length, 2)
  const offline = setup(new Map(), { now: () => now, readCache: async () => cache() })
  await offline.catalog.load()
  assert.deepEqual(offline.calls, [])
  assert.equal(offline.catalog.getLastSync(), now)
  assert.equal(offline.catalog.getRate(upcoming, expiry - 1)?.short.input, 1.2)
  assert.equal(offline.catalog.getRate(upcoming, expiry)?.short.input, 2)
})

test('keeps a gap after a guaranteed minimum promotion date until the new rate is verified', async () => {
  const documents = new Map([[modelUrl(upcoming), modelPage(upcoming, {
    notes: '- Example Model’s promotional pricing is available at least through November 21, 2026.',
  })]])
  const { catalog, advance } = setup(documents)
  await catalog.sync([upcoming])
  const guaranteedEnd = Date.UTC(2026, 10, 22)
  const detectedChange = Date.UTC(2026, 10, 24)
  documents.set(modelUrl(upcoming), modelPage(upcoming, { input: '$2' }))
  advance(detectedChange - verifiedAt)
  await catalog.sync([upcoming])
  assert.equal(catalog.getRate(upcoming, guaranteedEnd - 1)?.short.input, 1.2)
  assert.equal(catalog.getRate(upcoming, guaranteedEnd), undefined)
  assert.equal(catalog.getRate(upcoming, detectedChange - 1), undefined)
  assert.equal(catalog.getRate(upcoming, detectedChange)?.short.input, 2)
})

test('loads a deployed version 1 cache and carries its documented promotion boundary forward', async () => {
  const expiry = Date.UTC(2026, 10, 30)
  const deployed = { version: 1, entries: [
    { modelId: upcoming, checkedAt: verifiedAt, validUntil: expiry, sources: [modelUrl(upcoming)],
      short: { input: 1.2, cacheRead: 0.12, output: 6 } },
    { modelId: sol, checkedAt: verifiedAt, sources: [modelUrl(sol)],
      short: { input: 2, cacheRead: 0.1, output: 10 } },
  ] }
  const { catalog } = setup(new Map([[modelUrl(upcoming), modelPage(upcoming, { input: '$2' })]]), {
    now: () => expiry + day,
    readCache: async () => deployed,
  })
  await catalog.load()
  assert.equal(catalog.getRate(upcoming, expiry - 1)?.short.input, 1.2)
  assert.equal(catalog.getRate(sol, verifiedAt - 1)?.short.input, 2)
  await catalog.sync([upcoming])
  assert.equal(catalog.getRate(upcoming, expiry - 1)?.short.input, 1.2)
  assert.equal(catalog.getRate(upcoming, expiry)?.short.input, 2)
})

test('uses the first undated Standard quote for earlier requests and cuts later changes over at detection', async () => {
  const documents = new Map([[modelUrl(upcoming), modelPage(upcoming)]])
  const initialCheck = verifiedAt + 12 * 3_600_000
  let now = initialCheck
  const { catalog } = setup(documents, { now: () => now })
  const earlierRequest = verifiedAt + 8 * 3_600_000
  await catalog.sync([upcoming])
  const rate = catalog.getRate(upcoming, earlierRequest)
  assert.equal(rate?.short.input, 1.2)
  assert.equal(rate?.validFromBasis, 'published-standard')
  assert.deepEqual(rate?.sources, [modelUrl(upcoming)])

  now += day
  documents.set(modelUrl(upcoming), modelPage(upcoming, { input: '$2' }))
  await catalog.sync([upcoming])
  assert.equal(catalog.getRate(upcoming, earlierRequest)?.short.input, 1.2)
  assert.equal(catalog.getRate(upcoming, now - 1)?.short.input, 1.2)
  assert.equal(catalog.getRate(upcoming, now)?.short.input, 2)
})

test('does not backdate a replacement to a previous detection time when its successor is missing from cache', async () => {
  const documents = new Map([[modelUrl(upcoming), modelPage(upcoming)]])
  const { catalog, cache, advance } = setup(documents)
  await catalog.sync([upcoming])
  const earlierChange = verifiedAt + day
  advance()
  documents.set(modelUrl(upcoming), modelPage(upcoming, { input: '$2' }))
  await catalog.sync([upcoming])
  const partial = cache()
  partial.entries.pop()

  documents.set(modelUrl(upcoming), modelPage(upcoming, { input: '$3' }))
  const nextCheck = earlierChange + day
  const restarted = setup(documents, { now: () => nextCheck, readCache: async () => partial })
  await restarted.catalog.sync([upcoming])
  assert.equal(restarted.catalog.getRate(upcoming, earlierChange - 1)?.short.input, 1.2)
  assert.equal(restarted.catalog.getRate(upcoming, earlierChange), undefined)
  assert.equal(restarted.catalog.getRate(upcoming, nextCheck - 1), undefined)
  assert.equal(restarted.catalog.getRate(upcoming, nextCheck)?.short.input, 3)
})

test('advances the rate revision when two lookups finish in the same millisecond', async () => {
  const deferred = Promise.withResolvers()
  const started = Promise.withResolvers()
  const { catalog, cache } = setup(new Map([
    [modelUrl(upcoming), () => { started.resolve(); return deferred.promise }],
    [modelUrl(sol), modelPage(sol)],
  ]))
  const initialRevision = catalog.getRevision()
  const first = catalog.sync([upcoming])
  await started.promise
  await catalog.sync([sol])
  const firstRevision = catalog.getRevision()
  assert.ok(firstRevision > initialRevision)
  assert.equal(catalog.getRate(upcoming), undefined)
  assert.equal(catalog.getLastSync(), verifiedAt)

  deferred.resolve(markdown(modelPage(upcoming)))
  await first
  assert.equal(catalog.getRate(upcoming)?.short.input, 1.2)
  assert.ok(catalog.getRevision() > firstRevision)
  assert.equal(catalog.getLastSync(), verifiedAt)

  const offline = setup(new Map(), { readCache: async () => cache() })
  const unloaded = offline.catalog.getRevision()
  await offline.catalog.load()
  assert.ok(offline.catalog.getRevision() > unloaded)
  const loaded = offline.catalog.getRevision()
  await offline.catalog.load()
  await offline.catalog.sync([sol, upcoming])
  assert.equal(offline.catalog.getRevision(), loaded)
})

test('rejects non-Standard, wrong units, wrong identity, ambiguous context, and malformed prices', async t => {
  const validPrice = pricePage(`${shortHeader}\n${shortDivider}\n${newRow}`)
  const cases = [
    ['Batch-only pricing', pricePage(`${shortHeader}\n${shortDivider}\n| unrelated | $1 | $5 | $0.1 |`)],
    ['wrong pricing unit', validPrice.replace('1M tokens', '1K tokens')],
    ['wrong model unit', undefined, modelPage(upcoming, { unit: '1K tokens' })],
    ['model page for a different slug', undefined, modelPage(`${upcoming}-other`)],
    ['nondefault model pricing subsection', undefined, modelPage(upcoming, { heading: 'Batch text tokens' })],
    ['nondefault model price disclaimer', undefined, modelPage(upcoming, { notes: '- These prices apply to Batch only.' })],
    ['unlabelled long context threshold', pricePage(`${longHeader}\n${longDivider}\n${solRow.replace(sol, upcoming)}`)],
    ['unrecognised long context policy', undefined, modelPage(upcoming, { notes: '- Long context pricing is applied to large requests.' })],
    ['malformed amount', validPrice.replace('$1.20', '$1.20 / image')],
    ['duplicate matching rows', validPrice.replace(newRow, `${newRow}\n${newRow}`)],
    ['fenced pricing example', validPrice.replace(newRow, `${'```markdown'}\n${newRow}\n${'```'}`)],
    ['unsupported cached input', undefined, modelPage(upcoming, { cached: '-' })],
    ['unresolved promotion date', undefined, modelPage(upcoming, { notes: '- Promotional pricing is available for a limited time.' })],
    ['HTML response', () => new Response(validPrice, { headers: { 'Content-Type': 'text/html' } })],
    ['oversize streamed response', `${validPrice}\n${'x'.repeat(512 * 1024)}`],
  ]
  for (const [name, page, model] of cases) {
    await t.test(name, async () => {
      const { catalog } = setup(new Map([[pricingUrl, page], [modelUrl(upcoming), model]]))
      await catalog.sync([upcoming])
      assert.equal(catalog.getRate(upcoming, verifiedAt), undefined)
      assert.equal(catalog.getLastSync(), null)
    })
  }
})

test('deduplicates simultaneous model lookups while allowing another model to sync', async () => {
  const started = Promise.withResolvers()
  const result = Promise.withResolvers()
  const { catalog, calls } = setup(new Map([
    [modelUrl(upcoming), () => { started.resolve(); return result.promise }],
    [modelUrl(sol), modelPage(sol)],
  ]))
  const first = catalog.sync([upcoming])
  await started.promise
  const duplicate = catalog.sync([upcoming])
  await catalog.sync([sol])
  assert.equal(catalog.getRate(sol, verifiedAt)?.short.output, 6)
  result.resolve(markdown(modelPage(upcoming)))
  await Promise.all([first, duplicate])
  await catalog.sync([upcoming])
  assert.equal(calls.filter(([url]) => url === modelUrl(upcoming)).length, 1)
  assert.equal(catalog.getRate(upcoming, verifiedAt)?.short.output, 6)
})

test('aborted refreshes leave no successful sync or throttle that model from retrying', async () => {
  const started = Promise.withResolvers()
  const delayed = Promise.withResolvers()
  const documents = new Map([[modelUrl(upcoming), ({ signal }) => {
    started.resolve(signal)
    return delayed.promise
  }]])
  const { catalog, calls, cache } = setup(documents)
  const controller = new AbortController()
  await catalog.sync([upcoming], AbortSignal.abort())
  assert.deepEqual(calls, [])
  const pending = catalog.sync([upcoming], controller.signal)
  const requestSignal = await started.promise
  controller.abort()
  assert.equal(requestSignal.aborted, true)
  delayed.resolve(markdown(modelPage(upcoming)))
  await pending
  assert.equal(catalog.getRate(upcoming, verifiedAt), undefined)
  assert.equal(catalog.getLastSync(), null)
  assert.equal(cache(), undefined)
  documents.set(modelUrl(upcoming), modelPage(upcoming))
  await catalog.sync([upcoming])
  assert.equal(catalog.getRate(upcoming, verifiedAt)?.short.input, 1.2)
})

test('cancels a joined lookup without interrupting the caller that started it', async () => {
  const started = Promise.withResolvers()
  const delayed = Promise.withResolvers()
  const { catalog, calls } = setup(new Map([[modelUrl(upcoming), ({ signal }) => {
    started.resolve(signal)
    return delayed.promise
  }]]))
  const first = catalog.sync([upcoming])
  const requestSignal = await started.promise
  const controller = new AbortController()
  const joined = catalog.sync([upcoming], controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  let timeout
  try {
    const deadline = new Promise(resolve => { timeout = setTimeout(resolve, 75, 'still waiting') })
    assert.equal(await Promise.race([joined.then(() => 'cancelled'), deadline]), 'cancelled')
    assert.equal(requestSignal.aborted, false)
    assert.equal(catalog.getRate(upcoming), undefined)
    assert.equal(calls.filter(([url]) => url === modelUrl(upcoming)).length, 1)
  } finally {
    clearTimeout(timeout)
    delayed.resolve(markdown(modelPage(upcoming)))
  }
  await first
  assert.equal(catalog.getRate(upcoming)?.short.input, 1.2)
})
