import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { createCredentialStore, runDeviceLogin } from './auth.mjs'
import { createDeviceOAuth } from './oauth-wire.mjs'
import { createCodexAdapter, DISPLAY_NAME, PROVIDER } from './provider.mjs'
import { createSettings, SettingsError } from './settings.mjs'
import { createCostEstimator } from './cost-estimator.mjs'
import { createPricingCatalog } from './cost-pricing.mjs'
import { createCostStorage } from './cost-storage.mjs'
import { createFloatingPreferences } from './floating-preferences.mjs'
import { createSubscriptionMonitor } from './subscription.mjs'
import { registerCodexImageTool } from './image-generation.mjs'

const key = credentialKey('dsh-codex', PROVIDER)
export const name = 'dsh-codex'
export const inject = ['llm', 'credentials', 'authorization']

function remoteFailure(error) {
  return error instanceof SettingsError
    ? new RemoteError(error.code, error.message)
    : new RemoteError('codex-responses/failed', 'ChatGPT Codex settings could not be updated.')
}

class CodexSettings extends TypertRemoteService {
  constructor(ctx, settings) {
    super(ctx, 'codexResponses')
    this.settings = settings
    for (const initialize of remoteInitializers) initialize.call(this)
  }

  async status() {
    try { return await this.settings.status(this.ctx.invocation?.peer.principal) }
    catch (error) { throw remoteFailure(error) }
  }

  async signOut() {
    try { return await this.settings.signOut(this.ctx.invocation?.peer.principal) }
    catch (error) { throw remoteFailure(error) }
  }

  async *login(signal) {
    try { yield* this.settings.login(this.ctx.invocation?.peer.principal, signal) }
    catch (error) { throw remoteFailure(error) }
  }

  async floatingPreferences() {
    try { return await this.settings.floatingPreferences(this.ctx.invocation?.peer.principal) }
    catch (error) { throw remoteFailure(error) }
  }

  async setFloatingPreferences(patch) {
    try { return await this.settings.setFloatingPreferences(this.ctx.invocation?.peer.principal, patch) }
    catch (error) { throw remoteFailure(error) }
  }

  async *estimate(sessionId, signal) {
    try { yield* this.settings.estimate(this.ctx.invocation?.peer.principal, sessionId, signal) }
    catch (error) { throw remoteFailure(error) }
  }

  async *subscription(kind, surface, signal) {
    try { yield* this.settings.subscription(this.ctx.invocation?.peer.principal, kind, surface, signal) }
    catch (error) { throw remoteFailure(error) }
  }
}

const remoteInitializers = []
const streams = new Set(['login', 'estimate', 'subscription'])
for (const method of ['status', 'signOut', 'login', 'floatingPreferences', 'setFloatingPreferences', 'estimate', 'subscription']) {
  const decorator = streams.has(method) ? Remote({ mode: 'stream' }) : Remote
  decorator(CodexSettings.prototype[method], { name: method, addInitializer: initialize => remoteInitializers.push(initialize) })
}

export function apply(ctx) {
  const catalog = openaiCodexProvider()
  const oauth = createDeviceOAuth()
  const credentials = createCredentialStore(ctx.credentials, key)
  const monitor = createSubscriptionMonitor({ credentials, oauth })
  const lifetime = new AbortController()
  let imageLogin = new AbortController()
  const invalidateImageLogin = () => {
    imageLogin.abort()
    imageLogin = new AbortController()
  }
  ctx.effect(() => () => lifetime.abort(), 'dsh-codex login lifetime')
  ctx.inject(['tools', 'attachments'], toolCtx => {
    registerCodexImageTool(toolCtx, { credentials, oauth, signal: lifetime.signal, loginSignal: () => imageLogin.signal })
  })
  const adapter = createCodexAdapter({ credentials, catalog, oauth, signal: lifetime.signal,
    onCatalogChange: () => ctx.emit('llm/models-updated', PROVIDER),
    image: {
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
        attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    },
  })
  ctx.authorization.registerFlow({ key, label: DISPLAY_NAME, methods: [{ id: 'device-code', label: 'Device code' }],
    run: session => runDeviceLogin({ ...session, commit: async record => {
      await credentials.save(record, session.signal)
      invalidateImageLogin()
      monitor.invalidate()
      adapter.invalidateCatalog()
      ctx.emit('llm/models-updated', PROVIDER)
    } }, oauth),
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.on('credentials/record-updated', changed => {
    if (changed === key) {
      monitor.notify()
      ctx.emit('llm/models-updated', PROVIDER)
    }
  })
  const profile = ctx.get('profileContext')
  const storage = profile?.name === 'desktop' && profile.dir ? createCostStorage(profile.dir) : undefined
  const floating = storage && createFloatingPreferences({ ...storage, signal: lifetime.signal })
  const estimator = floating && createCostEstimator({ floating, signal: lifetime.signal,
    pricing: createPricingCatalog(storage),
    query: {
      async listSessions(signal) {
        const records = await ctx.get('sessionPersistence')?.list({ signal }) ?? []
        const byId = new Map(records.map(record => [record.header.id, record]))
        for (const session of ctx.get('sessions').list()) byId.set(session.id, { header: session.header })
        return byId.values()
      },
      observeSession: (id, options) => ctx.get('sessionQuery').observeSession(id, options),
    },
    liveSession: id => ctx.get('sessions')?.get(id),
    publishedModelIds: () => adapter.publishedModelIds(),
  })
  new CodexSettings(ctx, createSettings({ ...credentials, lifetime: lifetime.signal,
    estimator, floating, monitor,
    catalogStatus: () => adapter.catalogStatus(),
    signOut: async () => {
      await credentials.signOut()
      invalidateImageLogin()
      monitor.invalidate()
      adapter.invalidateCatalog()
      ctx.emit('llm/models-updated', PROVIDER)
    },
    local: () => ctx.get('profileContext')?.name === 'desktop' && ctx.get('connection')?.allowsRemoteAuthorities === false,
    begin: (interaction, signal) => ctx.authorization.begin({ key, method: 'device-code', interaction, signal }),
  }))
}
