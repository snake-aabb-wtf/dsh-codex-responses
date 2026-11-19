import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

const status = z.strictObject({ type: z.literal('status'), status: z.enum(['signed-in', 'signed-out', 'relogin-required']),
  catalog: z.strictObject({ source: z.enum(['upstream', 'cached', 'bundled', 'unavailable']), count: z.number().int().nonnegative() }).optional() })
const device = z.strictObject({ type: z.literal('device'), url: z.literal('https://auth.openai.com/codex/device'), code: z.string() })
const login = z.discriminatedUnion('type', [status, device])
const method = (name, schema, stream = false) => ({
  service: 'codexResponses', invocation: { kind: 'direct' }, parameters: [],
  ...(stream ? { mode: 'stream', cancellation: { parameter: 'signal' } } : {}),
  result: { mode: 'strict', typeSymbol: `dsh-codex-responses#${name}`, create: () => schema },
})

const remote = createTypertRemoteInfo({ package: 'dsh-codex-responses', methods: {
  'codexResponses/status': method('Status', status),
  'codexResponses/signOut': method('Status', status),
  'codexResponses/login': method('LoginFrame', login, true),
} }, z)

export const TYPERT = {
  package: remote.package, face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] },
  get invocations() { return remote.descriptors },
}
