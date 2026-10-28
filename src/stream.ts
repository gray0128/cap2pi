/**
 * Sentinel passed only to the built-in SDK so a keyless endpoint does not throw
 * "No API key" before the request is sent. `stripKeylessAuth` removes it from
 * the outgoing headers. A configured API key never uses this value.
 */
export const KEYLESS_API_KEY = 'cliproxyapi-keyless'

/** Drop the keyless sentinel from Authorization and x-api-key. Leave any other credential in place. */
export function stripKeylessAuth(base: typeof fetch | undefined): typeof fetch {
  const inner = base ?? globalThis.fetch
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    for (const name of ['authorization', 'x-api-key']) {
      const value = headers.get(name)
      if (value === KEYLESS_API_KEY || value === `Bearer ${KEYLESS_API_KEY}`) headers.delete(name)
    }
    if (input instanceof Request) return inner(new Request(input, { ...init, headers }))
    return inner(input, { ...init, headers })
  }
}
