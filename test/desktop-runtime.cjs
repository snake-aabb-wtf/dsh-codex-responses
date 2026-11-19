const { registerHooks } = require('node:module')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const runtime = process.env.DSH_TEST_RUNTIME
if (!runtime) throw new Error('DSH_TEST_RUNTIME must point to the installed Desktop app.asar/dsh directory.')
const anchor = pathToFileURL(join(runtime, 'package.json')).href

registerHooks({
  resolve(specifier, context, next) {
    if (/^(?:@deepseek-ai\/|@earendil-works\/|zod$)/u.test(specifier) && !context.parentURL?.includes('/app.asar/')) {
      return next(specifier, { ...context, parentURL: anchor })
    }
    return next(specifier, context)
  },
})
