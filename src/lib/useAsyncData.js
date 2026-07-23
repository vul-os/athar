import { useEffect, useState } from 'react'

/**
 * Runs an async loader and reports {data, error, loading}.
 *
 * The loader's own identity is the cache key, so callers wrap it in useCallback
 * over whatever it depends on (website id, time range, metric). Two things fall
 * out of that:
 *
 *   - Changing any of those inputs immediately reads as `loading` again,
 *     without an effect that clears state first. Clearing state in an effect
 *     body causes a cascading second render, and briefly shows the *previous*
 *     website's numbers under the new website's name.
 *   - A response that arrives after its inputs changed is ignored, because the
 *     loader it was produced for no longer matches the current one. Out-of-order
 *     responses cannot overwrite fresher data.
 */
export function useAsyncData(load) {
  const [entry, setEntry] = useState(null)

  useEffect(() => {
    let cancelled = false

    load()
      .then((data) => {
        if (!cancelled) setEntry({ load, data, error: null })
      })
      .catch((error) => {
        if (!cancelled) setEntry({ load, data: null, error })
      })

    return () => {
      cancelled = true
    }
  }, [load])

  const fresh = entry?.load === load ? entry : null
  return {
    data: fresh?.data ?? null,
    error: fresh?.error ?? null,
    loading: fresh === null,
  }
}
