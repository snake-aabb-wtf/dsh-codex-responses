import { randomUUID } from 'node:crypto'
import { open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const readLimit = 1024 * 1024

async function readJson(file) {
  try {
    const handle = await open(file, 'r')
    try {
      const size = (await handle.stat()).size
      if (size > readLimit) return undefined
      const bytes = Buffer.alloc(size)
      const { bytesRead } = await handle.read(bytes, { length: size })
      return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    } finally { await handle.close() }
  } catch { return undefined }
}

async function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const body = JSON.stringify(value)
    if (Buffer.byteLength(body) > readLimit) throw new Error('Codex cost cache too large.')
    await writeFile(temp, body, { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } finally { await unlink(temp).catch(() => {}) }
}

export function createCostStorage(directory) {
  // Retain the existing filename so previous window settings migrate in place.
  const prefs = join(directory, 'dsh-codex-estimator.json')
  const rates = join(directory, 'dsh-codex-rates.json')
  return {
    readPreferences: () => readJson(prefs),
    writePreferences: value => writeJson(prefs, value),
    readCache: () => readJson(rates),
    writeCache: value => writeJson(rates, value),
  }
}
