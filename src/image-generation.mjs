import { randomUUID } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CodexAuthError } from './auth.mjs'
import { EDIT_IMAGE, GENERATE_IMAGE, maxReferences, missingImageReference, PARTIAL_IMAGE_RESULT,
  selectCodexImageReferences } from './image-references.mjs'

const imagesURL = 'https://chatgpt.com/backend-api/codex/images'
const imageLimit = 24 * 1024 * 1024
const encodedLimit = 4 * Math.ceil(imageLimit / 3)
const responseLimit = encodedLimit + 64 * 1024
const requestDeadline = 300_000
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex')
const mediaTypes = ['image/png', 'image/jpeg', 'image/webp']

const failure = (code, message) => new HarnessError(message, code)
const invalidImage = () => failure('CODEX_IMAGE_INVALID', 'ChatGPT Codex returned an unusable image.')
const uncertain = () => failure('CODEX_IMAGE_UNCERTAIN', 'The connection ended before image generation could be confirmed. Check before requesting another image.')
const accountChanged = () => failure('MISSING_CREDENTIAL', 'Sign in to ChatGPT Codex in DSH Settings or retry with the current account.')
const turnLimit = () => failure('CODEX_IMAGE_TURN_LIMIT', 'This turn has already submitted a Codex image request. Send a new message for another image.')

function imageHttpFailure(status) {
  if (status === 401) return failure('CODEX_IMAGE_AUTH', 'ChatGPT Codex rejected the login for image generation. Check your sign-in.')
  if (status === 403) return failure('CODEX_IMAGE_PERMISSION', 'ChatGPT Codex did not allow this account to generate the requested image.')
  if (status === 402 || status === 429) return failure('CODEX_IMAGE_LIMIT', 'ChatGPT Codex image generation is limited. Check your remaining subscription usage.')
  if (status === 408 || status === 504) return uncertain()
  if (status >= 500) return failure('CODEX_IMAGE_UNAVAILABLE', 'ChatGPT Codex image generation is temporarily unavailable.')
  return failure('CODEX_IMAGE_REJECTED', 'ChatGPT Codex rejected the image generation request.')
}

async function readImageResponse(response, signal) {
  if (Number(response.headers.get('content-length')) > responseLimit) {
    await response.body?.cancel().catch(() => {})
    throw invalidImage()
  }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response.body ?? []) {
      signal.throwIfAborted()
      size += chunk.byteLength
      if (size > responseLimit) throw invalidImage()
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw uncertain()
  }
  let payload
  try { payload = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
  catch { throw invalidImage() }
  if (!Array.isArray(payload?.data) || payload.data.length !== 1) throw invalidImage()
  return decodeImage(payload.data[0]?.b64_json)
}

function decodeImage(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > encodedLimit) {
    throw invalidImage()
  }
  const data = Buffer.from(encoded, 'base64')
  if (data.length > imageLimit || data.toString('base64') !== encoded) throw invalidImage()
  if (data.subarray(0, 8).equals(pngSignature)) return { data, mediaType: 'image/png' }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { data, mediaType: 'image/jpeg' }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    return { data, mediaType: 'image/webp' }
  }
  throw invalidImage()
}

async function accessToken(credentials, oauth, account, signal) {
  signal?.throwIfAborted()
  const cancelled = Promise.withResolvers()
  const abort = () => cancelled.reject(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    // A caller can stop waiting while the credential store finishes its shared refresh.
    return await Promise.race([credentials.accessToken(oauth, account), cancelled.promise])
  } catch (error) {
    if (error instanceof CodexAuthError) throw failure(error.code, error.message)
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

export function createCodexImageGenerator({ credentials, oauth, fetch = globalThis.fetch }) {
  return async (value, signal, expectedAccount, { references = [], beforeSubmit } = {}) => {
    signal?.throwIfAborted()
    const prompt = value?.trim()
    if (!prompt) throw failure('CODEX_IMAGE_PROMPT', 'Provide a text prompt for the image.')
    const account = await credentials.catalogIdentity()
    signal?.throwIfAborted()
    if (!account || (expectedAccount !== undefined && expectedAccount !== account)) throw accountChanged()
    const token = await accessToken(credentials, oauth, account, signal)
    if (await credentials.catalogIdentity() !== account) throw accountChanged()
    signal?.throwIfAborted()

    const deadline = AbortSignal.timeout(requestDeadline)
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    const encoded = Buffer.from(JSON.stringify({
      model: 'gpt-image-2', prompt, background: 'auto', quality: 'auto', size: 'auto',
      ...(references.length ? { images: references.map(({ mediaType, data }) =>
        ({ image_url: `data:${mediaType};base64,${Buffer.from(data).toString('base64')}` })) } : {}),
    }))
    // A stream body keeps Undici from replaying the billed POST on a reused connection (HTTP 421).
    const body = new ReadableStream({
      start(stream) { stream.enqueue(encoded); stream.close() },
    })
    signal?.throwIfAborted()
    beforeSubmit?.()
    let result
    try {
      let response
      try {
        response = await fetch(`${imagesURL}/${references.length ? 'edits' : 'generations'}`, {
          method: 'POST', signal: requestSignal, redirect: 'error', duplex: 'half', body,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': String(encoded.length),
            Authorization: `Bearer ${token}`,
            'ChatGPT-Account-Id': account,
            'X-Codex-Image-Turn-Id': randomUUID(),
            originator: 'dsh-codex-responses',
          },
        })
      } catch { throw uncertain() }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw imageHttpFailure(response.status)
      }
      result = await readImageResponse(response, requestSignal)
    } catch (error) {
      signal?.throwIfAborted()
      if (deadline.aborted) throw uncertain()
      throw error
    }
    if (await credentials.catalogIdentity() !== account) throw accountChanged()
    signal?.throwIfAborted()
    return result
  }
}

const dimensions = { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } }
const attachment = {
  type: 'object', additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true, enum: mediaTypes },
    bytes: { type: 'integer', required: true },
    ...dimensions,
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: dimensions },
  },
}

const savedImageText = 'One image was generated and saved in the conversation.'
const imageOutput = {
  schema: attachment,
  render: (_args, ref) => [
    { type: 'text', text: savedImageText },
    { type: 'image', attachment: ref },
  ],
  presentationMeta: (_args, ref) => ({ attachment: ref }),
}

async function loadReferences(ctx, sessionId, selections, cut, signal) {
  const observation = await ctx.get('sessionQuery')?.observeSession(sessionId, { signal, projectionMode: 'none' })
  if (!observation) throw missingImageReference()
  let refs
  try { refs = selectCodexImageReferences(observation.events, selections, cut) }
  finally { observation[Symbol.dispose]() }
  const images = []
  let bytes = 0
  for (const ref of refs) {
    signal.throwIfAborted()
    if (!mediaTypes.includes(ref.mediaType) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || bytes + ref.bytes > imageLimit) {
      throw missingImageReference()
    }
    bytes += ref.bytes
    try {
      const image = await ctx.attachments.readImage(ref, signal)
      images.push({ data: image.data, mediaType: image.ref.mediaType })
    } catch {
      signal.throwIfAborted()
      throw missingImageReference()
    }
  }
  return images
}

export function registerCodexImageTool(ctx, { signal: lifetime, loginSignal, ...options }) {
  const generate = createCodexImageGenerator(options)
  const committed = new WeakMap()
  const turns = new WeakMap()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') turns.set(session, { startSeq: event.seq })
    if (event.type === 'turn/end') turns.delete(session)
  })
  const prompt = { type: 'string', required: true, description: 'Describe the image or edits.' }

  function register(name, description, parameters) {
    // DSH admits tools and dispatches their calls serially for each agent step.
    const admissions = new WeakMap()
    ctx.tools.register(defineTool({
      name, description, parameters: { prompt, ...parameters }, output: imageOutput,
      async execute({ prompt: text, count, references: selections }, exec) {
        const admitted = exec.agent && admissions.get(exec.agent)
        if (!admitted || admitted.turn.login?.aborted) throw accountChanged()
        const { turn, generatedBefore } = admitted
        if (turn.submitted) throw turnLimit()
        const signal = AbortSignal.any([exec.signal, lifetime, turn.login].filter(Boolean))
        // A model resuming an older request may still send the former count field.
        if (count !== undefined && count !== 1) throw failure('CODEX_IMAGE_COUNT', 'Only one output image is supported.')
        const references = name === EDIT_IMAGE ? await loadReferences(ctx, exec.agent.session.id, selections,
          { turnStart: turn.startSeq, generatedBefore }, signal) : []
        let image
        try {
          image = await generate(text, signal, turn.account, {
            references,
            beforeSubmit() {
              if (turn.submitted) throw turnLimit()
              turn.submitted = true
            },
          })
        } catch (error) {
          exec.signal.throwIfAborted()
          if (turn.login?.aborted) throw accountChanged()
          throw error
        }
        signal.throwIfAborted()
        let ref
        try { ref = await ctx.attachments.saveImage(image) }
        catch { throw failure('CODEX_IMAGE_SAVE', 'The image was generated, but DSH could not save it.') }
        committed.set(exec.token, ref)
        return ref
      },
      finalizeContent(exec, result) {
        const ref = committed.get(exec.token)
        if (result.error?.info?.code !== 'ABORTED' || !ref) return undefined
        // DSH clears normal metadata on cancellation. Keep the saved reference readable in history.
        return [
          { type: 'text', text: savedImageText },
          { type: 'text', text: PARTIAL_IMAGE_RESULT + JSON.stringify({ requested: 1, attachments: [ref] }) },
        ]
      },
    }), {
      async when({ agent, signal }) {
        admissions.delete(agent)
        const turn = turns.get(agent.session)
        if (!turn || turn.submitted) return false
        const login = loginSignal?.()
        try {
          const account = await options.credentials.catalogIdentity()
          if (turns.get(agent.session) !== turn || lifetime?.aborted || signal.aborted) return false
          if (!turn.bound) Object.assign(turn, { bound: true, account, login })
          if (!account || account !== turn.account || turn.login?.aborted) return false
          admissions.set(agent, { turn, generatedBefore: agent.session.seq })
          return true
        } catch { return false }
      },
    })
  }
  register(GENERATE_IMAGE,
    'Generate one image from a text prompt using the signed-in ChatGPT Codex subscription. The image appears in the conversation.')
  register(EDIT_IMAGE,
    'Create one edited image using references from this turn’s uploads or the most recent Codex image result.',
    { references: { type: 'array', required: true, description: `Select 1 to ${maxReferences} reference images in order.`,
      items: { type: 'object', additionalProperties: false, properties: {
        source: { type: 'string', required: true, enum: ['current_upload', 'latest_generated'] },
        index: { type: 'integer', required: true, description: 'One-based position within the selected source.' },
      } },
    } })
}
