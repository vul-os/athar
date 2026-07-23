/**
 * Thin client for the Athar API.
 *
 * Two things this handles that every caller would otherwise repeat:
 *
 *   - CSRF. The server sets a readable athar_csrf cookie and requires it echoed
 *     in a header on state-changing requests. Doing that here means a new
 *     mutation cannot forget it.
 *   - Session expiry. A 401 anywhere is the session ending, which the whole app
 *     needs to know about, so it is broadcast rather than handled per-call.
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

/** Fired when the server reports the session is gone, so App can show the login. */
export const SESSION_EXPIRED = 'athar:session-expired'

async function request(method, path, body) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD') headers['X-Athar-CSRF'] = csrfToken()

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // Same-origin: the dashboard is served by the same binary as the API.
    credentials: 'same-origin',
  })

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
    throw new ApiError(res.status, payload?.error || `request failed (${res.status})`)
  }
  return payload
}

const get = (path) => request('GET', path)
const post = (path, body) => request('POST', path, body)

/** Serialises a query object, dropping empty values. */
function qs(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value)
  }
  const str = search.toString()
  return str ? `?${str}` : ''
}

export const api = {
  health: () => get('/api/health'),
  authStatus: () => get('/api/auth/status'),
  login: (username, password) => post('/api/auth/login', { username, password }),
  bootstrap: (username, password) => post('/api/auth/bootstrap', { username, password }),
  logout: () => post('/api/auth/logout'),
  me: () => get('/api/me'),

  websites: () => get('/api/websites'),
  createWebsite: (name, domain) => post('/api/websites', { name, domain }),
  deleteWebsite: (id) => request('DELETE', `/api/websites/${id}`),
  setShare: (id, enabled) => post(`/api/websites/${id}/share`, { enabled }),

  stats: (id, range) => get(`/api/websites/${id}/stats${qs(range)}`),
  series: (id, range) => get(`/api/websites/${id}/series${qs(range)}`),
  metrics: (id, metric, range, limit = 8) =>
    get(`/api/websites/${id}/metrics${qs({ metric, limit, ...range })}`),
  active: (id) => get(`/api/websites/${id}/active`),
  heatmap: (id, path, kind, range) =>
    get(`/api/websites/${id}/heatmap${qs({ path, kind, ...range })}`),
  revenue: (id, range) => get(`/api/websites/${id}/revenue${qs(range)}`),
}
