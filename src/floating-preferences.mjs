const coordinate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000

function normalize(value) {
  const point = value?.position
  const edge = ['left', 'right', 'top', 'bottom'].includes(point?.edge) ? { edge: point.edge } : {}
  return Object.freeze({
    enabled: value?.enabled === true,
    position: coordinate(point?.x) && coordinate(point?.y) ? Object.freeze({ x: point.x, y: point.y, ...edge }) : null,
    // Older versions only stored the window switch and position.
    items: Object.freeze({
      apiCost: value?.items?.apiCost !== false,
      account: value?.items?.account === true,
      quota: value?.items?.quota === true,
    }),
  })
}

export function createFloatingPreferences({ readPreferences, writePreferences, signal }) {
  const listeners = new Set()
  let snapshot
  let writes = Promise.resolve()

  const read = () => snapshot ??= Promise.resolve().then(readPreferences).catch(() => undefined).then(normalize)

  function update(patch) {
    const saved = writes.then(async () => {
      const current = await read()
      const next = normalize({ ...current, ...patch, items: { ...current.items, ...patch.items } })
      signal?.throwIfAborted()
      await writePreferences(next)
      snapshot = Promise.resolve(next)
      for (const notify of listeners) notify(next)
      return next
    })
    writes = saved.catch(() => {})
    return saved
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { read, update, subscribe }
}
