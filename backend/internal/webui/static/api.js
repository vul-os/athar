/**
 * Thin client for the Athar API. Vanilla port of the former src/api.js — the
 * logic was already framework-agnostic, so this is unchanged apart from the
 * import path.
 *
 * Two things this handles that every caller would otherwise repeat:
 *
 *   - CSRF. The server sets a readable athar_csrf cookie and requires it
 *     echoed in a header on state-changing requests (double-submit pattern —
 *     see backend/internal/auth/session.go). Doing that here means a new
 *     mutation cannot forget it.
 *   - Session expiry. A 401 anywhere is the session ending, which the whole
 *     app needs to know about, so it is broadcast rather than handled
 *     per-call.
 */

/** @typedef {{ from: number, to: number }} DateRange */

/** Thrown for any non-2xx response, carrying the server's message and status. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** @returns {string} */
function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)athar_csrf=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}

/** Fired when the server reports the session is gone, so the app can show sign-in. */
export const SESSION_EXPIRED = 'athar:session-expired'

/**
 * Pulls a string `error` field out of a decoded JSON body, if there is one —
 * without assuming the body has any particular shape. res.json() is typed
 * `Promise<any>`, and the server error contract ({ error: string }) is only a
 * convention, not something worth casting our way past the type checker for.
 * @param {unknown} payload
 * @param {string} fallback
 * @returns {string}
 */
function errorMessage(payload, fallback) {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const err = /** @type {{ error?: unknown }} */ (payload).error
    if (typeof err === 'string') return err
  }
  return fallback
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
async function request(method, path, body) {
  /** @type {Record<string, string>} */
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD') headers['X-Athar-CSRF'] = csrfToken()

  let res
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Same-origin: the dashboard is served by the same binary as the API.
      credentials: 'same-origin',
    })
  } catch {
    // A network failure has no status and no server-authored message — say so
    // plainly rather than surfacing a TypeError.
    throw new ApiError(0, 'could not reach the Athar server')
  }

  if (res.status === 204) return null

  /** @type {unknown} */
  let payload = null
  try {
    payload = await res.json()
  } catch {
    // A non-JSON body on an error status is still an error; fall through.
  }

  if (!res.ok) {
    // The login and status endpoints legitimately 401; anywhere else it means
    // the session ended under us and the whole app should react.
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED))
    }
    throw new ApiError(res.status, errorMessage(payload, `request failed (${res.status})`))
  }
  return payload
}

/** @param {string} path */
const get = (path) => request('GET', path)
/**
 * @param {string} path
 * @param {unknown} [body]
 */
const post = (path, body) => request('POST', path, body)
/** @param {string} path */
const del = (path) => request('DELETE', path)

/**
 * Uploads raw bytes (a File, in practice) rather than JSON.
 *
 * Kept separate from request() rather than folded into it: request() owns the
 * "everything is JSON" contract that makes every other call one line, and a
 * body that must NOT be stringified is exactly the kind of exception that
 * quietly rots a shared helper. Both paths still share the CSRF token and the
 * session-expiry broadcast, which are the parts that must never diverge.
 * @param {string} path
 * @param {Blob} blob
 * @param {string} [contentType]
 * @returns {Promise<unknown>}
 */
async function putBytes(path, blob, contentType) {
  let res
  try {
    res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': contentType || 'application/octet-stream', 'X-Athar-CSRF': csrfToken() },
      body: blob,
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'could not reach the Athar server')
  }
  /** @type {unknown} */
  let payload = null
  try {
    payload = await res.json()
  } catch {
    /* an error status with a non-JSON body is still an error */
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED))
    throw new ApiError(res.status, errorMessage(payload, `upload failed (${res.status})`))
  }
  return payload
}

/**
 * Serialises a query object, dropping empty values.
 * @param {Record<string, string | number | null | undefined> | undefined} params
 * @returns {string}
 */
function qs(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const str = search.toString()
  return str ? `?${str}` : ''
}

/** The endpoints the dashboard actually calls. */
export const api = {
  authStatus: () => get('/api/auth/status'),
  /**
   * @param {string} username
   * @param {string} password
   */
  login: (username, password) => post('/api/auth/login', { username, password }),
  /**
   * @param {string} username
   * @param {string} password
   */
  bootstrap: (username, password) => post('/api/auth/bootstrap', { username, password }),
  logout: () => post('/api/auth/logout'),
  me: () => get('/api/me'),

  websites: () => get('/api/websites'),
  /**
   * @param {string} name
   * @param {string} domain
   */
  createWebsite: (name, domain) => post('/api/websites', { name, domain }),

  /**
   * @param {string} id
   * @param {DateRange} range
   */
  stats: (id, range) => get(`/api/websites/${id}/stats${qs(range)}`),
  /**
   * @param {string} id
   * @param {DateRange} range
   */
  series: (id, range) => get(`/api/websites/${id}/series${qs(range)}`),
  /**
   * @param {string} id
   * @param {string} metric
   * @param {DateRange} range
   * @param {number} [limit]
   */
  metrics: (id, metric, range, limit = 8) =>
    get(`/api/websites/${id}/metrics${qs({ metric, limit, ...range })}`),
  /** @param {string} id */
  active: (id) => get(`/api/websites/${id}/active`),
  /**
   * @param {string} id
   * @param {string} path
   * @param {string} kind
   * @param {DateRange} range
   */
  heatmap: (id, path, kind, range) =>
    get(`/api/websites/${id}/heatmap${qs({ path, kind, ...range })}`),
  /**
   * @param {string} id
   * @param {DateRange} range
   */
  revenue: (id, range) => get(`/api/websites/${id}/revenue${qs(range)}`),

  // Page images: the operator-supplied capture the click heatmap is drawn
  // over. pageImageURL is a URL builder rather than a fetch because the
  // consumer is an <img src>, which does its own conditional request against
  // the ETag the server sets.
  /** @param {string} id */
  pageImages: (id) => get(`/api/websites/${id}/page-images`),
  /**
   * @param {string} id
   * @param {string} path
   * @param {string} viewport
   */
  pageImageURL: (id, path, viewport) =>
    `/api/websites/${id}/page-image${qs({ path, viewport })}`,
  /**
   * @param {string} id
   * @param {string} path
   * @param {string} viewport
   * @param {File} file
   */
  putPageImage: (id, path, viewport, file) =>
    putBytes(`/api/websites/${id}/page-image${qs({ path, viewport })}`, file, file.type),
  /**
   * @param {string} id
   * @param {string} path
   * @param {string} viewport
   */
  deletePageImage: (id, path, viewport) =>
    del(`/api/websites/${id}/page-image${qs({ path, viewport })}`),
}
