/** OpenAI-compatible prefix used when the user has not set a base URL. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8317/v1'

export type ChatApi = 'anthropic-messages' | 'openai-responses' | 'openai-completions'

/**
 * Keep a configured http(s) prefix as written, aside from trimming a trailing slash.
 * Do not rewrite the host to 127.0.0.1 and do not insert `/backend-api/`.
 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/u, '')
  if (trimmed.length === 0) throw new TypeError('CLIProxyAPI base URL must not be empty')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new TypeError('CLIProxyAPI base URL must be an http or https URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('CLIProxyAPI base URL must use http or https')
  }
  return trimmed
}

/**
 * Base URL stored on a model for one Pi API.
 *
 * pi-ai 1.3.0 passes `model.baseUrl` through as the SDK base URL:
 * `openai-completions` then requests `{baseUrl}/chat/completions`, and
 * `openai-responses` requests `{baseUrl}/responses`. `anthropic-messages` also
 * uses `model.baseUrl` as the SDK base URL. The built-in Anthropic provider
 * root is `https://api.anthropic.com` (no `/v1`), and the SDK appends
 * `/v1/messages`, so a user prefix that already ends in `/v1` drops that
 * suffix once.
 *
 * None of these suffixes has been measured against a live CLIProxyAPI. Until
 * that measurement, this is the only function that derives them. Do not point
 * the request at `/backend-api/` or `/codex/responses`.
 */
export function baseUrlForApi(prefix: string, api: ChatApi): string {
  const base = normalizeEndpoint(prefix)
  if (api === 'anthropic-messages') return base.replace(/\/v1$/iu, '')
  return base
}

/** Catalog URLs relative to the same prefix used for chat. */
export function catalogRequestUrls(prefix: string): { rich: string; standard: string } {
  const base = normalizeEndpoint(prefix)
  const query = new URLSearchParams({ client_version: 'pi' })
  return {
    rich: `${base}/models?${query.toString()}`,
    standard: `${base}/models`,
  }
}

/** Endpoint shown in status. Userinfo is omitted. */
export function statusEndpoint(prefix: string): string {
  const url = new URL(normalizeEndpoint(prefix))
  const path = url.pathname.replace(/\/+$/u, '')
  return `${url.protocol}//${url.host}${path}`
}
