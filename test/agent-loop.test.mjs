import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools'
import { createCodexAdapter, PROVIDER } from '../src/provider.mjs'
import { registerCodexImageTool } from '../src/image-generation.mjs'

const claim = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')
const toolCall = { id: 'fc_test', call_id: 'call_test', type: 'function_call', name: 'lookup', arguments: '{"value":"synthetic"}', status: 'completed' }
const answer = { id: 'msg_test', role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'native-loop-ok', annotations: [] }] }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4UqcNAAQHAZ4BGagyAAAAAElFTkSuQmCC'

function sse(item) {
  const events = [
    { type: 'response.output_item.added', output_index: 0,
      item: item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] } },
    ...(item.type === 'function_call' ? [{ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }]
      : [{ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: item.content[0].text }]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: null, usage: null } },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('native Agent Loop gates, executes, and sends back a DSH tool result', { timeout: 10_000 }, async () => {
  const ctx = new Context()
  const fibers = []
  const mount = async plugin => { const fiber = ctx.plugin(plugin); fibers.push(fiber); await fiber }
  const input = []
  const calls = []
  let agentHandle
  const releaseGate = Promise.withResolvers()
  const presented = Promise.withResolvers()
  try {
    for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, LlmRuntime, SystemPrompt,
      ToolsService, nativeExecutor, AgentLoop]) await mount(plugin)
    const adapter = createCodexAdapter({ credentials: { status: async () => 'signed-in',
      accessToken: async () => `synthetic.${claim}.test` }, fetch: async (_url, init) => {
        input.push(JSON.parse(new Headers(init.headers).get('content-encoding') === 'zstd'
          ? zstdDecompressSync(init.body).toString() : init.body))
        return sse(input.length === 1 ? toolCall : answer)
      },
    })
    await mount({
      inject: ['llm', 'agents'],
      async apply(pluginCtx) {
        pluginCtx.llm.registerAdapter([PROVIDER], adapter)
        agentHandle = await pluginCtx.agents.create({
          sessionId: `test-${randomUUID()}`,
          agentOptions: { provider: PROVIDER, model: 'gpt-6.1-sol' },
          setup(agentCtx) {
            agentCtx.on('tools/pre-execute', async (_execution, next) => {
              presented.resolve()
              await releaseGate.promise
              return next()
            })
            agentCtx.tools.register(defineTool({ name: 'lookup', description: 'Returns its synthetic input',
              parameters: { value: { type: 'string', required: true } },
              output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
              async execute(args) { calls.push(args.value); return `test result: ${args.value}` },
            }))
          },
        })
      },
    })
    agentHandle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the test tool.' }] }))
    await Promise.race([presented.promise, agentHandle.agent.whenIdle().then(() => { throw new Error('The agent stopped before tool approval.') })])
    assert.deepEqual(calls, [])
    releaseGate.resolve()
    await agentHandle.agent.whenIdle()
    assert.deepEqual(calls, ['synthetic'])
    assert.equal(input.length, 2)
    assert.ok(input[1].input.some(item => item.type === 'function_call_output' && item.call_id === toolCall.call_id
      && JSON.stringify(item).includes('test result: synthetic')))
  } finally {
    releaseGate.resolve()
    await agentHandle?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})

test('Codex Responses continuation sends a generated image to the vision model in the tool output', { timeout: 10_000 }, async t => {
  const ctx = new Context()
  const fibers = []
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-vision-'))
  let handle
  t.after(async () => {
    await handle?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber }
  for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, LlmRuntime, SystemPrompt,
    ToolsService, nativeExecutor, AgentLoop]) await mount(plugin)
  await mount(LocalAttachmentStore, { dshHome: home })
  const input = []
  const imageCall = { ...toolCall, name: 'codex_generate_image', arguments: '{"prompt":"An orange square"}' }
  const model = 'gpt-6.1-sol'

  await mount({
    inject: ['llm', 'agents', 'tools', 'attachments'],
    async apply(pluginCtx) {
      const adapter = createCodexAdapter({
        credentials: { status: async () => 'signed-in', accessToken: async () => `synthetic.${claim}.test` },
        image: {
          resolveAttachments: () => pluginCtx.attachments,
          resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => path, ref),
        },
        fetch: async (_url, init) => {
          input.push(JSON.parse(new Headers(init.headers).get('content-encoding') === 'zstd'
            ? zstdDecompressSync(init.body).toString() : init.body))
          return sse(input.length === 1 ? imageCall : answer)
        },
      })
      pluginCtx.llm.registerAdapter([PROVIDER], adapter)
      registerCodexImageTool(pluginCtx, {
        credentials: { catalogIdentity: async () => 'fixture', accessToken: async () => 'fixture-subscription' },
        fetch: async () => Response.json({ data: [{ b64_json: png }] }),
      })
      handle = await pluginCtx.agents.create({
        sessionId: `test-${randomUUID()}`, agentOptions: { provider: PROVIDER, model },
      })
    },
  })

  handle.agent.followup(createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Generate and inspect the image.' }] }))
  await handle.agent.whenIdle()
  assert.equal(input.length, 2)
  const result = input[1].input.find(item => item.type === 'function_call_output' && item.call_id === imageCall.call_id)
  assert.ok(Array.isArray(result?.output), 'Expected a multimodal function_call_output')
  const { meta } = handle.agent.session.snapshotEvents().find(event => event.type === 'tool/result').data
  const saved = await ctx.attachments.readImage(meta.attachment)
  const image = result.output.find(part => part.type === 'input_image')
  assert.ok(image)
  assert.deepEqual(Buffer.from(image.image_url.split(',')[1], 'base64'), Buffer.from(saved.data))
  const path = ctx.attachments.imageHostPath(meta.attachment)
  assert.ok(path)
  assert.ok(result.output.some(part => part.type === 'input_text' && part.text.includes(JSON.stringify(path))))
})

test('non-Codex Agent Loop sees Codex image results and supports text-only continuations', { timeout: 10_000 }, async t => {
  const ctx = new Context()
  const fibers = []
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-image-'))
  let handle
  t.after(async () => {
    await handle?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber }
  for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, LlmRuntime, SystemPrompt,
    ToolsService, nativeExecutor, AgentLoop]) await mount(plugin)
  await mount(LocalAttachmentStore, { dshHome: home })
  await mount(SessionQueryEngine)

  const tool = 'codex_generate_image'
  const provider = 'fixture-provider'
  let account
  let login = new AbortController()
  let replaceLogin
  let deny = false
  let callOnNext = false
  let callName = tool
  let callArguments = { prompt: 'A simple orange square' }
  let sibling
  let cancelAfterSave = false
  let loseResponse = false
  let fetches = 0
  const imageRequests = []
  const requests = []
  class TestAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model,
        inputModalities: model === 'fixture-vision-model' ? ['text', 'image'] : ['text'] }
    }

    async *stream(options) {
      requests.push(options)
      if (callOnNext) {
        callOnNext = false
        const calls = [{ name: callName, args: callArguments }]
        if (sibling) calls.push(sibling)
        for (const [index, { name, args }] of calls.entries()) {
          const block = { type: 'tool-call', id: `call_${requests.length}_${index}`, name, arguments: JSON.stringify(args) }
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'block-end', index, block }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  await mount({
    inject: ['llm', 'agents', 'tools', 'attachments'],
    async apply(pluginCtx) {
      pluginCtx.llm.registerAdapter([provider], new TestAdapter())
      registerCodexImageTool(pluginCtx, {
        credentials: {
          catalogIdentity: async () => account,
          accessToken: async () => 'fixture-subscription',
        },
        loginSignal: () => login.signal,
        async fetch(url, init) {
          fetches++
          const body = JSON.parse(await new Response(init.body).text())
          imageRequests.push({ url, body })
          if (loseResponse) throw new Error('Fixture connection closed')
          return Response.json({ data: [{ b64_json: png }] })
        },
      })
      handle = await pluginCtx.agents.create({
        sessionId: `test-${randomUUID()}`,
        agentOptions: { provider, model: 'fixture-vision-model' },
        setup(agentCtx) {
          agentCtx.on('tools/pre-execute', (execution, next) => {
            if (execution.name !== tool) return next()
            if (deny) return { kind: 'deny', reason: 'Blocked by test tool policy.' }
            replaceLogin?.()
            return next()
          })
          agentCtx.on('tools/post-execute', (execution, result, next) => {
            if (execution.name === tool && !result.isError && cancelAfterSave) {
              handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
            }
            return next()
          })
        },
      })
    },
  })
  const ask = async (call, attachment) => {
    callOnNext = call
    const firstRequest = requests.length
    const content = [{ type: 'text', text: 'Test tool availability.' }]
    if (attachment) content.push({ type: 'image', attachment })
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content }))
    await handle.agent.whenIdle()
    return requests[firstRequest].tools?.some(schema => schema.name === tool) ?? false
  }
  const results = () => handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  const modelResult = ({ toolCallId }) => requests.at(-1).messages
    .find(message => message.role === 'tool' && message.toolCallId === toolCallId)

  assert.equal(await ask(false), false)
  account = 'fixture-account'
  deny = true
  assert.equal(await ask(true), true)
  assert.equal(results().at(-1).data.message.isError, true)
  assert.equal(fetches, 0)

  deny = false
  replaceLogin = () => {
    account = 'replacement-account'
    replaceLogin = undefined
  }
  assert.equal(await ask(true), true)
  assert.equal(fetches, 0)
  assert.equal(results().at(-1).data.error.code, 'MISSING_CREDENTIAL')
  assert.equal(requests.at(-1).tools?.some(schema => schema.name === tool) ?? false, false)

  replaceLogin = () => {
    login.abort()
    login = new AbortController()
    replaceLogin = undefined
  }
  assert.equal(await ask(true), true)
  assert.equal(fetches, 0)
  assert.equal(results().at(-1).data.error.code, 'MISSING_CREDENTIAL')

  callArguments = { prompt: 'Three orange squares', count: 3 }
  const requestOffset = requests.length
  assert.equal(await ask(true), true)
  assert.equal(fetches, 0)
  assert.equal(results().at(-1).data.error.code, 'CODEX_IMAGE_COUNT')
  for (const name of [tool, 'codex_edit_image']) {
    const schema = requests[requestOffset].tools.find(tool => tool.name === name)
    assert.ok(schema)
    assert.equal(Object.hasOwn(schema.parameters.properties, 'count'), false)
  }

  callArguments = { prompt: 'A simple orange square' }
  assert.equal(await ask(true), true)
  assert.equal(fetches, 1)
  const { message, meta } = results().at(-1).data
  assert.equal(message.isError, false, JSON.stringify(results().at(-1).data.error))
  assert.deepEqual(message.content.filter(block => block.type === 'image'), [{ type: 'image', attachment: meta.attachment }])
  assert.deepEqual(modelResult(message).content, message.content)
  assert.equal(meta.attachment.width, 1)
  const saved = await ctx.attachments.readImage(meta.attachment)
  assert.ok(saved.data.byteLength > 0)
  assert.equal(saved.ref.attachmentId, meta.attachment.attachmentId)

  callName = 'codex_edit_image'
  callArguments = { prompt: 'Use a blue background', references: [
    { source: 'current_upload', index: 1 }, { source: 'latest_generated', index: 1 },
  ], count: 1 }
  assert.equal(await ask(true, saved.ref), true)
  assert.equal(fetches, 2)
  const edit = results().at(-1).data
  assert.deepEqual(modelResult(edit.message).content.filter(block => block.type === 'image'),
    [{ type: 'image', attachment: edit.meta.attachment }])
  assert.ok(imageRequests[1].url.endsWith('/images/edits'))
  assert.equal(Object.hasOwn(imageRequests[1].body, 'n'), false)
  assert.equal(imageRequests[1].body.images.length, 2)
  assert.equal(imageRequests[1].body.images[0].image_url, `data:${saved.ref.mediaType};base64,${Buffer.from(saved.data).toString('base64')}`)

  callName = tool
  callArguments = { prompt: 'An orange square' }
  sibling = { name: 'codex_edit_image', args: { prompt: 'Make the background blue',
    references: [{ source: 'latest_generated', index: 1 }] } }
  assert.equal(await ask(true), true)
  assert.equal(fetches, 3)
  assert.equal(results().at(-2).data.message.isError, false)
  assert.equal(results().at(-1).data.error.code, 'CODEX_IMAGE_TURN_LIMIT')
  assert.equal(requests.at(-1).tools?.some(schema => [tool, 'codex_edit_image'].includes(schema.name)) ?? false, false)

  sibling = undefined
  cancelAfterSave = true
  assert.equal(await ask(true), true)
  assert.equal(fetches, 4)
  const cancelled = results().at(-1).data
  assert.equal(cancelled.error.code, 'ABORTED')
  assert.ok(cancelled.message.content.every(block => block.type === 'text'))
  const marker = cancelled.message.content.find(({ text }) => text?.startsWith('Codex saved image result: '))
  const partial = JSON.parse(marker.text.slice('Codex saved image result: '.length))
  assert.equal(partial.requested, 1)
  assert.equal(partial.attachments[0].attachmentId, saved.ref.attachmentId)
  assert.equal(partial.attachments.length, 1)

  cancelAfterSave = false
  loseResponse = true
  assert.equal(await ask(true), true)
  assert.equal(fetches, 5)
  assert.equal(results().at(-1).data.error.code, 'CODEX_IMAGE_UNCERTAIN')
  assert.equal(requests.at(-1).tools?.some(schema => [tool, 'codex_edit_image'].includes(schema.name)) ?? false, false)

  loseResponse = false
  handle.agent.model.select({ provider, model: 'fixture-text-model' })
  assert.equal(await ask(true), true)
  const textRouteResult = results().at(-1).data
  assert.equal(textRouteResult.message.isError, false)
  assert.ok(textRouteResult.message.content.some(block => block.type === 'image'))
  assert.ok(modelResult(textRouteResult.message).content.every(block => block.type === 'text'))
  assert.ok(modelResult(textRouteResult.message).content.some(block => /generated/i.test(block.text)))

  account = undefined
  assert.equal(await ask(false), false)
  assert.equal(fetches, 6)
})
