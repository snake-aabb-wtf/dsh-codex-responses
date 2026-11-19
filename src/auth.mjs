import { claimProfile, cleanProfile, decodeClaims } from './account-profile.mjs'

export const DEVICE_URL = 'https://auth.openai.com/codex/device'

const refreshWindowMs = 300_000
const refreshTimeoutMs = 15_000
const relogin = { kind: 'grant', payload: { state: 'relogin-required' } }

export class CodexAuthError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function validGrant(value) {
  return value?.type === 'oauth' && Number.isSafeInteger(value.expires) && value.expires > 0
    && ['access', 'refresh', 'accountId'].every(field => typeof value[field] === 'string'
      && /^[\x21-\x7e]+$/.test(value[field]))
}

function readGrant(record) {
  return record?.kind === 'grant' && validGrant(record.payload) ? record.payload : undefined
}

function projectGrant({ access, refresh, expires, accountId, profile }) {
  const details = cleanProfile(profile)
  return { kind: 'grant', payload: { type: 'oauth', access, refresh, expires, accountId,
    ...(Object.keys(details).length ? { profile: details } : {}) } }
}

function isExpired(grant) {
  return grant.expires <= Date.now() + refreshWindowMs
}

function terminalRefreshFailure(error) {
  const response = /^OpenAI Codex token refresh failed \((400|401|403)\): ([\s\S]*)$/.exec(error?.message ?? '')
  if (!response) return false
  try {
    const { error: upstream } = JSON.parse(response[2])
    const code = typeof upstream === 'string' ? upstream : upstream?.code
    return ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(code)
  } catch {
    return false
  }
}

function requireGrant(record) {
  if (record === undefined) {
    throw new CodexAuthError('MISSING_CREDENTIAL', 'Sign in to ChatGPT Codex in DSH Settings first.')
  }
  const grant = readGrant(record)
  if (!grant) throw new CodexAuthError('CODEX_RELOGIN_REQUIRED', 'Sign in to ChatGPT Codex again.')
  return grant
}

function scopedGrant(record, expectedAccount) {
  const grant = requireGrant(record)
  if (expectedAccount !== undefined && grant.accountId !== expectedAccount) {
    throw new CodexAuthError('MISSING_CREDENTIAL', 'The ChatGPT Codex account changed. Retry this request.')
  }
  return grant
}

export function createCredentialStore(credentials, key) {
  return {
    async status() {
      const record = await credentials.readRecord(key)
      return record === undefined ? 'signed-out' : readGrant(record) ? 'signed-in' : 'relogin-required'
    },
    async catalogIdentity() {
      return readGrant(await credentials.readRecord(key))?.accountId
    },
    async accountProfile() {
      const record = await credentials.readRecord(key)
      const grant = readGrant(record)
      if (!grant) return { status: record === undefined ? 'signed-out' : 'relogin-required' }
      const { accountId } = grant
      const { email = null, plan = null } = {
        ...cleanProfile(grant.profile), ...claimProfile(decodeClaims(grant.access), accountId),
      }
      return { status: 'signed-in', accountId, email, plan }
    },
    async accessToken(oauth, expectedAccount) {
      const record = await credentials.readRecord(key)
      const grant = scopedGrant(record, expectedAccount)
      if (!isExpired(grant)) return grant.access
      const nextRecord = await credentials.modifyRecord(key, async current => {
        const latest = scopedGrant(current, expectedAccount)
        if (!isExpired(latest)) return undefined
        let refreshed
        try {
          refreshed = await oauth.refresh(latest, AbortSignal.timeout(refreshTimeoutMs))
        } catch (error) {
          if (error?.code === 'CODEX_RELOGIN_REQUIRED' || terminalRefreshFailure(error)) return relogin
          throw new CodexAuthError('CODEX_REFRESH_UNAVAILABLE', 'Could not refresh ChatGPT Codex credentials. Try again later.')
        }
        if (!validGrant(refreshed) || refreshed.expires <= Date.now() || refreshed.accountId !== latest.accountId) {
          throw new CodexAuthError('CODEX_REFRESH_UNAVAILABLE', 'ChatGPT Codex returned an unusable refreshed credential.')
        }
        return projectGrant(refreshed)
      })
      return scopedGrant(nextRecord, expectedAccount).access
    },
    save(record, signal) {
      return credentials.modifyRecord(key, async () => {
        signal.throwIfAborted()
        return record
      })
    },
    signOut: () => credentials.deleteRecord(key),
  }
}

export async function runDeviceLogin(session, oauth) {
  const { signal } = session
  signal.throwIfAborted()
  let grant
  try {
    grant = await oauth.login({
      signal,
      async prompt(request) {
        if (request.type === 'select' && request.options.some(option => option.id === 'device_code')) return 'device_code'
        throw new Error('Unsupported OAuth prompt')
      },
      notify(event) {
        if (signal.aborted || event.type !== 'device_code') return
        if (event.verificationUri !== DEVICE_URL || !/^[A-Z0-9-]{4,32}$/u.test(event.userCode ?? '')) {
          throw new Error('Unexpected device authorization notice')
        }
        session.notify({ url: DEVICE_URL, code: event.userCode, message: 'Enter this code on the OpenAI verification page.' })
      },
    })
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof CodexAuthError) throw error
    throw new CodexAuthError('CODEX_LOGIN_FAILED', 'Device sign-in failed. Check that Codex device-code login is enabled and try again.')
  }
  signal.throwIfAborted()
  if (!validGrant(grant) || grant.expires <= Date.now()) {
    throw new CodexAuthError('CODEX_LOGIN_FAILED', 'ChatGPT Codex returned an unusable credential.')
  }
  await session.commit(projectGrant(grant))
}
