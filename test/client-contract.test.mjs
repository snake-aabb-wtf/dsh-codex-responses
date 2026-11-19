import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { z } from 'zod'
import { TYPERT } from '../src/typert.mjs'

test('client bundle mounts the same strict Remote contracts as the Host', async () => {
  let client
  const source = await readFile(new URL('../src/client.cjs', import.meta.url), 'utf8')
  runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) {
    client = factory(id => id === 'zod' ? { z } : {})
  } } } })
  let mounted, injected
  await client.apply({ remote: { $host: { isLoopback: true }, async $mount(contribution) { mounted = contribution } },
    inject(keys, register) { injected = keys; register({ remoteAccess: { whenAccess() {} } }) },
  })
  assert.deepEqual(Array.from(injected), ['remote.codexResponses'])
  assert.deepEqual(Array.from(mounted.descriptors, descriptor => descriptor.id), TYPERT.invocations.map(method => method.id))
  for (const descriptor of mounted.descriptors) {
    const host = TYPERT.invocations.find(method => method.id === descriptor.id)
    assert.deepEqual(z.toJSONSchema(descriptor.result.create()), z.toJSONSchema(host.result.create()))
  }
})
