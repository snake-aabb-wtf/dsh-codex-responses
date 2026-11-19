import { setTimeout as wait } from 'node:timers/promises'
import { CodexAuthError, DEVICE_URL } from './auth.mjs'
import { claimProfile, cleanProfile, decodeClaims } from './account-profile.mjs'

const authOrigin = 'https://auth.openai.com'
const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
const deviceTimeoutMs = 900_000
const invalidCodes = new Set(['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'])

function fail(stage) {
  return new CodexAuthError(`CODEX_${stage}_FAILED`, `ChatGPT Codex ${stage.toLowerCase()} failed.`)
}

function projection(body, stage, previous) {
  const access = body?.access_token
  const claims = decodeClaims(access)
  const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id
  const now = Date.now()
  const claimExpiry = Number.isSafeInteger(claims?.exp) ? claims.exp * 1000 : Infinity
  const exchangeExpiry = Number.isFinite(body?.expires_in) && body.expires_in > 0
    ? now + Math.floor(body.expires_in * 1000) : Infinity
  const expires = Math.min(claimExpiry, exchangeExpiry)
  const refresh = body?.refresh_token ?? previous?.refresh
  if (!/^[-\w]+$/u.test(accountId ?? '') || typeof accountId !== 'string' || typeof refresh !== 'string'
    || !/^[\x21-\x7e]+$/u.test(refresh) || !Number.isSafeInteger(expires) || expires <= now) throw fail(stage)
  const previousProfile = previous?.accountId === accountId
    ? { ...claimProfile(decodeClaims(previous.access), accountId), ...cleanProfile(previous.profile) } : {}
  const profile = { ...previousProfile, ...claimProfile(decodeClaims(body?.id_token), accountId), ...claimProfile(claims, accountId) }
  return { type: 'oauth', access, refresh, accountId, expires, ...(Object.keys(profile).length ? { profile } : {}) }
}

export function createDeviceOAuth({ fetch = (...args) => globalThis.fetch(...args) } = {}) {
  async function post(path, body, stage, signal) {
    signal.throwIfAborted()
    const form = body instanceof URLSearchParams
    try {
      return await fetch(`${authOrigin}${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', Accept: 'application/json' },
        body: form ? body : JSON.stringify(body),
      })
    } catch {
      signal.throwIfAborted()
      throw fail(stage)
    }
  }

  async function json(response) {
    return response.json().catch(() => undefined)
  }

  return {
    async login({ signal, notify }) {
      const created = await post('/api/accounts/deviceauth/usercode', { client_id: clientId }, 'DEVICE', signal)
      const device = await json(created)
      const userCode = device?.user_code ?? device?.usercode
      if (!created.ok || typeof userCode !== 'string' || !/^[A-Z0-9-]{4,32}$/u.test(userCode)
        || typeof device?.device_auth_id !== 'string' || !device.device_auth_id.trim()) throw fail('DEVICE')
      let intervalMs = Math.max(1000, Math.ceil((Number(device.interval) || 5) * 1000))
      const validFor = Number(device.expires_in) > 0 ? Math.min(deviceTimeoutMs, Number(device.expires_in) * 1000) : deviceTimeoutMs
      const deadline = Date.now() + validFor
      notify({ type: 'device_code', verificationUri: DEVICE_URL, userCode })
      while (Date.now() < deadline) {
        const polled = await post('/api/accounts/deviceauth/token', { device_auth_id: device.device_auth_id, user_code: userCode }, 'POLL', signal)
        const result = await json(polled)
        const errorCode = typeof result?.error === 'string' ? result.error : result?.error?.code
        if (polled.ok) {
          if (typeof result?.authorization_code !== 'string' || !result.authorization_code
            || typeof result?.code_verifier !== 'string' || !result.code_verifier) throw fail('POLL')
          const exchanged = await post('/oauth/token', new URLSearchParams({
            client_id: clientId, grant_type: 'authorization_code', code: result.authorization_code,
            code_verifier: result.code_verifier, redirect_uri: `${authOrigin}/deviceauth/callback`,
          }), 'EXCHANGE', signal)
          const token = await json(exchanged)
          if (!exchanged.ok) throw fail('EXCHANGE')
          return projection(token, 'TOKEN')
        }
        if (errorCode === 'access_denied' || errorCode === 'expired_token') throw fail('POLL')
        if (errorCode === 'slow_down' || polled.status === 429) {
          intervalMs = Math.max(intervalMs + 5000, (Number(polled.headers.get('retry-after')) || 0) * 1000)
        } else if (![403, 404].includes(polled.status) && !['authorization_pending', 'deviceauth_authorization_pending'].includes(errorCode)) {
          throw fail('POLL')
        }
        await wait(Math.min(intervalMs, Math.max(0, deadline - Date.now())), undefined, { signal })
      }
      throw fail('POLL')
    },
    async refresh(current, signal) {
      const response = await post('/oauth/token', new URLSearchParams({
        client_id: clientId, grant_type: 'refresh_token', refresh_token: current.refresh,
      }), 'REFRESH', signal)
      const value = await json(response)
      if (!response.ok) {
        const code = typeof value?.error === 'string' ? value.error : value?.error?.code
        if ([400, 401, 403].includes(response.status) && invalidCodes.has(code)) {
          throw new CodexAuthError('CODEX_RELOGIN_REQUIRED', 'Sign in to ChatGPT Codex again.')
        }
        throw fail('REFRESH')
      }
      return projection(value, 'REFRESH', current)
    },
  }
}
