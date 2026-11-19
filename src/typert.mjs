import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

const status = z.strictObject({ type: z.literal('status'), status: z.enum(['signed-in', 'signed-out', 'relogin-required']),
  catalog: z.strictObject({ source: z.enum(['upstream', 'cached', 'bundled', 'unavailable']), count: z.number().int().nonnegative() }).optional() })
const device = z.strictObject({ type: z.literal('device'), url: z.literal('https://auth.openai.com/codex/device'), code: z.string() })
const login = z.discriminatedUnion('type', [status, device])
const coordinate = z.number().min(0).max(100_000)
const position = z.strictObject({ x: coordinate, y: coordinate }).nullable()
const preferences = z.strictObject({ enabled: z.boolean(), position })
const patch = preferences.partial()
const sessionId = z.string().min(1).max(160).nullable()
const counter = z.number().int().nonnegative()
const summary = z.strictObject({ usd: z.number().nonnegative(), priced: counter, unpriced: counter, awaitingRates: counter })
const estimate = z.strictObject({ sessionId, current: summary.nullable(), total: summary,
  currentUnavailable: z.boolean(), unreadableSessions: counter, ratesSyncedAt: counter.nullable() })
const codec = (name, schema) => ({ mode: 'strict', typeSymbol: `dsh-codex-responses#${name}`, create: () => schema })
const parameter = (name, type, schema) => {
  const value = codec(type, schema)
  return { name, source: 'json', codec: value, strictCodec: value }
}
const method = (name, schema, stream = false, parameters = []) => ({
  service: 'codexResponses', invocation: { kind: 'direct' }, parameters,
  ...(stream ? { mode: 'stream', cancellation: { parameter: 'signal' } } : {}),
  result: codec(name, schema),
})

const remote = createTypertRemoteInfo({ package: 'dsh-codex-responses', methods: {
  'codexResponses/status': method('Status', status),
  'codexResponses/signOut': method('Status', status),
  'codexResponses/login': method('LoginFrame', login, true),
  'codexResponses/estimatorPreferences': method('EstimatorPreferences', preferences),
  'codexResponses/setEstimatorPreferences': method('EstimatorPreferences', preferences, false,
    [parameter('patch', 'EstimatorPreferencePatch', patch)]),
  'codexResponses/estimate': method('CostEstimate', estimate, true, [parameter('sessionId', 'EstimateSessionId', sessionId)]),
} }, z)

export const TYPERT = {
  package: remote.package, face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] },
  get invocations() { return remote.descriptors },
}
