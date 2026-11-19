import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeviceOAuth } from '../src/oauth-wire.mjs'

const host = 'https://auth.openai.com'
const expiry = Math.trunc(Date.now() / 1000) + 3600
const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' }, exp: expiry, marker: 'ÿÿÿ' }
const access = `synthetic.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`
const signal = new AbortController().signal

test('device authorization accepts a token response without expires_in, using the JWT expiry', async () => {
  const stages = []
  const oauth = createDeviceOAuth({ fetch: async (url, init) => {
    assert.equal(init.redirect, 'error')
    stages.push(new URL(url).pathname)
    if (url.endsWith('/usercode')) return Response.json({ usercode: 'TEST-CODE', device_auth_id: 'fixture', interval: '5' })
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'fixture', code_verifier: 'fixture' })
    assert.equal(init.body.get('redirect_uri'), `${host}/deviceauth/callback`)
    return Response.json({ access_token: access, refresh_token: 'synthetic-refresh' })
  } })
  const notices = []
  const grant = await oauth.login({ signal, notify: notice => notices.push(notice) })
  assert.equal(grant.accountId, 'test-account')
  assert.equal(grant.expires, expiry * 1000)
  assert.deepEqual(stages, ['/api/accounts/deviceauth/usercode', '/api/accounts/deviceauth/token', '/oauth/token'])
  assert.equal(notices[0].userCode, 'TEST-CODE')
  assert.doesNotMatch(JSON.stringify(notices), /synthetic/)
})

test('invalid refresh reports only a classified code, never the response body', async () => {
  const oauth = createDeviceOAuth({ fetch: async (_url, init) => {
    assert.equal(init.body.get('grant_type'), 'refresh_token')
    return Response.json({ error: 'invalid_grant', error_description: 'synthetic-secret' }, { status: 400 })
  } })
  await assert.rejects(oauth.refresh({ refresh: 'synthetic-old' }, signal), error => error.code === 'CODEX_RELOGIN_REQUIRED'
    && !String(error).includes('synthetic-secret'))
})
