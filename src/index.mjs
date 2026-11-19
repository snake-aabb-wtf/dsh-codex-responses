import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { createCredentialStore, runDeviceLogin } from './auth.mjs'
import { createDeviceOAuth } from './oauth-wire.mjs'
import { createCodexAdapter, DISPLAY_NAME, PROVIDER } from './provider.mjs'
import { createSettings, SettingsError } from './settings.mjs'

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
}

const remoteInitializers = []
for (const method of ['status', 'signOut', 'login']) {
  const decorator = method === 'login' ? Remote({ mode: 'stream' }) : Remote
  decorator(CodexSettings.prototype[method], { name: method, addInitializer: initialize => remoteInitializers.push(initialize) })
}

export function apply(ctx) {
  const catalog = openaiCodexProvider()
  const oauth = createDeviceOAuth()
  const credentials = createCredentialStore(ctx.credentials, key)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-codex login lifetime')
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
      adapter.invalidateCatalog()
      ctx.emit('llm/models-updated', PROVIDER)
    } }, oauth),
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.on('credentials/record-updated', changed => {
    if (changed === key) ctx.emit('llm/models-updated', PROVIDER)
  })
  new CodexSettings(ctx, createSettings({ ...credentials, lifetime: lifetime.signal,
    catalogStatus: () => adapter.catalogStatus(),
    signOut: async () => {
      await credentials.signOut()
      adapter.invalidateCatalog()
      ctx.emit('llm/models-updated', PROVIDER)
    },
    local: () => ctx.get('profileContext')?.name === 'desktop' && ctx.get('connection')?.allowsRemoteAuthorities === false,
    begin: (interaction, signal) => ctx.authorization.begin({ key, method: 'device-code', interaction, signal }),
  }))
}
