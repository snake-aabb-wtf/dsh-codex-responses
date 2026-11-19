import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools'
import { createCodexAdapter, PROVIDER } from '../src/provider.mjs'

const claim = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')
const toolCall = { id: 'fc_test', call_id: 'call_test', type: 'function_call', name: 'lookup', arguments: '{"value":"synthetic"}', status: 'completed' }
const answer = { id: 'msg_test', role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'native-loop-ok', annotations: [] }] }

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
