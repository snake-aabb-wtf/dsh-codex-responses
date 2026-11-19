export function decodeClaims(token) {
  if (typeof token !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(token)) return undefined
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) }
  catch { return undefined }
}

export function planName(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/iu.test(value) ? value.toLowerCase() : undefined
}

export function cleanProfile(value) {
  const email = typeof value?.email === 'string' && value.email.length <= 254
    && /^[^\s@\p{C}]+@[^\s@\p{C}]+$/u.test(value.email) ? value.email : undefined
  const plan = planName(value?.plan)
  return { ...(email ? { email } : {}), ...(plan ? { plan } : {}) }
}

export function claimProfile(claims, accountId) {
  const auth = claims?.['https://api.openai.com/auth']
  if (auth?.chatgpt_account_id !== undefined && auth.chatgpt_account_id !== accountId) return {}
  return cleanProfile({
    email: claims?.email ?? claims?.['https://api.openai.com/profile']?.email,
    plan: auth?.chatgpt_plan_type,
  })
}
