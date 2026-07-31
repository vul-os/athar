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

/** Thrown for any non-2xx response, carrying the server's message and status. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)athar_csrf=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}

/** Fired when the server reports the session is gone, so the app can show sign-in. */
export const SESSION_EXPIRED = 'athar:session-expired'

async function request(method, path, body) {
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
    throw new ApiError(res.status, (payload && payload.error) || `request failed (${res.status})`)
  }
  return payload
}

const get = (path) => request('GET', path)
const post = (path, body) => request('POST', path, body)
const del = (path) => request('DELETE', path)

/**
 * Uploads raw bytes (a File, in practice) rather than JSON.
 *
 * Kept separate from request() rather than folded into it: request() owns the
 * "everything is JSON" contract that makes every other call one line, and a
 * body that must NOT be stringified is exactly the kind of exception that
 * quietly rots a shared helper. Both paths still share the CSRF token and the
 * session-expiry broadcast, which are the parts that must never diverge.
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
  let payload = null
  try {
    payload = await res.json()
  } catch {
    /* an error status with a non-JSON body is still an error */
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED))
    throw new ApiError(res.status, (payload && payload.error) || `upload failed (${res.status})`)
  }
  return payload
}

/** Serialises a query object, dropping empty values. */
function qs(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value)
  }
  const str = search.toString()
  return str ? `?${str}` : ''
}

/** The endpoints the dashboard actually calls. */
export const api = {
  authStatus: () => get('/api/auth/status'),
  login: (username, password) => post('/api/auth/login', { username, password }),
  bootstrap: (username, password) => post('/api/auth/bootstrap', { username, password }),
  logout: () => post('/api/auth/logout'),
  me: () => get('/api/me'),

  websites: () => get('/api/websites'),
  createWebsite: (name, domain) => post('/api/websites', { name, domain }),

  stats: (id, range) => get(`/api/websites/${id}/stats${qs(range)}`),
  series: (id, range) => get(`/api/websites/${id}/series${qs(range)}`),
  metrics: (id, metric, range, limit = 8) =>
    get(`/api/websites/${id}/metrics${qs({ metric, limit, ...range })}`),
  active: (id) => get(`/api/websites/${id}/active`),
  heatmap: (id, path, kind, range) =>
    get(`/api/websites/${id}/heatmap${qs({ path, kind, ...range })}`),
  revenue: (id, range) => get(`/api/websites/${id}/revenue${qs(range)}`),

  // Page images: the operator-supplied capture the click heatmap is drawn
  // over. pageImageURL is a URL builder rather than a fetch because the
  // consumer is an <img src>, which does its own conditional request against
  // the ETag the server sets.
  pageImages: (id) => get(`/api/websites/${id}/page-images`),
  pageImageURL: (id, path, viewport) =>
    `/api/websites/${id}/page-image${qs({ path, viewport })}`,
  putPageImage: (id, path, viewport, file) =>
    putBytes(`/api/websites/${id}/page-image${qs({ path, viewport })}`, file, file.type),
  deletePageImage: (id, path, viewport) =>
    del(`/api/websites/${id}/page-image${qs({ path, viewport })}`),
}
