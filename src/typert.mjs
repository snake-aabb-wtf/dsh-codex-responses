import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

const authStatus = z.enum(['signed-in', 'signed-out', 'relogin-required'])
const status = z.strictObject({ type: z.literal('status'), status: authStatus,
  catalog: z.strictObject({ source: z.enum(['upstream', 'cached', 'bundled', 'unavailable']), count: z.number().int().nonnegative() }).optional() })
const device = z.strictObject({ type: z.literal('device'), url: z.literal('https://auth.openai.com/codex/device'), code: z.string() })
const login = z.discriminatedUnion('type', [status, device])
const coordinate = z.number().min(0).max(100_000)
const position = z.strictObject({ x: coordinate, y: coordinate, edge: z.enum(['left', 'right']).optional() }).nullable()
const items = z.strictObject({ apiCost: z.boolean(), account: z.boolean(), quota: z.boolean() })
const preferences = z.strictObject({ enabled: z.boolean(), position, items })
const patch = preferences.partial().extend({ items: items.partial().optional() })
const sessionId = z.string().min(1).max(160).nullable()
const counter = z.number().int().nonnegative()
const summary = z.strictObject({ usd: z.number().nonnegative(), priced: counter, unpriced: counter, awaitingRates: counter })
const estimate = z.strictObject({ sessionId, current: summary.nullable(), total: summary,
  currentUnavailable: z.boolean(), unreadableSessions: counter, ratesSyncedAt: counter.nullable() })
const subscriptionItem = z.enum(['account', 'quota'])
const subscriptionSurface = z.enum(['floating', 'settings'])
const quotaWindow = z.strictObject({ remaining: z.number().min(0).max(100),
  durationSeconds: z.number().int().positive(), resetsAt: counter.nullable() })
const subscription = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account'), status: authStatus, email: z.string().max(254).nullable(), plan: z.string().max(64).nullable() }),
  z.strictObject({ kind: z.literal('quota'), status: z.enum(['signed-out', 'relogin-required', 'ready', 'stale', 'unavailable']),
    updatedAt: counter.nullable(), windows: z.array(quotaWindow).max(2) }),
])
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
  'codexResponses/floatingPreferences': method('FloatingPreferences', preferences),
  'codexResponses/setFloatingPreferences': method('FloatingPreferences', preferences, false,
    [parameter('patch', 'FloatingPreferencePatch', patch)]),
  'codexResponses/estimate': method('CostEstimate', estimate, true, [parameter('sessionId', 'EstimateSessionId', sessionId)]),
  'codexResponses/subscription': method('SubscriptionFrame', subscription, true, [
    parameter('kind', 'SubscriptionItem', subscriptionItem),
    parameter('surface', 'SubscriptionSurface', subscriptionSurface),
  ]),
} }, z)

export const TYPERT = {
  package: remote.package, face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] },
  get invocations() { return remote.descriptors },
}
