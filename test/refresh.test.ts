import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { saveUserConfig } from '../src/config.ts'
import { createRuntimeState, discoverProviderModels, refreshCatalog } from '../src/refresh.ts'
import type { RefreshModelsContext } from '@earendil-works/pi-ai'

function tempLocation() {
  const root = mkdtempSync(join(tmpdir(), 'cliproxyapi-refresh-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { agentDir, cwd, env: {} as NodeJS.ProcessEnv }
}

function publish(): RefreshModelsContext['publish'] {
  return async (publication) => {
    publication.update?.()
    return true
  }
}

function context(allowNetwork: boolean): RefreshModelsContext {
  return {
    allowNetwork,
    signal: new AbortController().signal,
    publish: publish(),
  }
}

function catalogBody(ids: string[]) {
  return JSON.stringify({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', owned_by: id.startsWith('claude') ? 'anthropic' : 'openai' })),
  })
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ port: number, close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

test('publishes a loopback catalog, keeps the previous list on failure, and drops a retired model', async () => {
  const location = tempLocation()
  let ids = ['claude-opus-4-6', 'gpt-5.5', 'gemini-3-pro']
  let status = 200
  const requested: string[] = []
  const server = await listen((request, response) => {
    requested.push(request.url ?? '')
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(catalogBody(ids))
  })
  const baseUrl = `http://127.0.0.1:${server.port}/v1`
  saveUserConfig({ baseUrl, apiKey: 'secret-key-value' }, location)
  const state = createRuntimeState('cliproxyapi')
  try {
    await refreshCatalog(state, context(true), { location, codexIds: new Set(['gpt-5.5']) })
    assert.deepEqual(state.models.map((model) => model.id), ids)
    assert.equal(state.models.find((model) => model.id === 'claude-opus-4-6')?.api, 'anthropic-messages')
    assert.equal(state.models.find((model) => model.id === 'gpt-5.5')?.api, 'openai-responses')
    assert.equal(state.models.find((model) => model.id === 'gemini-3-pro')?.api, 'openai-completions')
    assert.equal(state.models.some((model) => model.baseUrl.includes('backend-api')), false)
    assert.equal(requested.every((url) => url.startsWith('/v1/models')), true)
    const snapshot = readFileSync(join(location.agentDir, 'pi-cliproxyapi-provider', 'snapshot.json'), 'utf8')
    assert.equal(snapshot.includes('secret-key-value'), false)
    assert.equal(snapshot.includes('baseUrl'), false)
    assert.equal(snapshot.includes(baseUrl), false)

    const published = state.models.map((model) => model.id)
    status = 500
    await assert.rejects(refreshCatalog(state, context(true), { location, codexIds: new Set() }))
    assert.deepEqual(state.models.map((model) => model.id), published)
    assert.match(state.lastError ?? '', /answered 500/)

    status = 200
    ids = ['gpt-5.5']
    await refreshCatalog(state, context(true), { location, codexIds: new Set(['gpt-5.5']) })
    assert.deepEqual(state.models.map((model) => model.id), ['gpt-5.5'])
  } finally {
    await server.close()
  }
})

test('sends a non-loopback catalog request to the configured host and omits Authorization when no key is set', async () => {
  const location = tempLocation()
  let seenHost = ''
  let seenAuthorization = 'unset'
  const server = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(catalogBody(['gemini-3-pro']))
  })
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    seenHost = url.host
    const headers = new Headers(init?.headers)
    seenAuthorization = headers.get('authorization') ?? 'absent'
    assert.equal(url.pathname, '/v1/models')
    assert.equal(url.searchParams.get('client_version') === 'pi' || url.searchParams.get('client_version') === null, true)
    assert.equal(url.pathname.includes('backend-api'), false)
    assert.equal(init?.redirect, 'error')
    return globalThis.fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init)
  }
  saveUserConfig({ baseUrl: 'https://proxy.example.com/v1', apiKey: '' }, location)
  const state = createRuntimeState('cliproxyapi')
  try {
    await refreshCatalog(state, context(true), { location, fetch: fetchImpl, codexIds: new Set() })
    assert.equal(seenHost, 'proxy.example.com')
    assert.equal(seenAuthorization, 'absent')
    assert.equal(state.models[0]?.baseUrl, 'https://proxy.example.com/v1')
    assert.equal(state.models[0]?.baseUrl.includes('127.0.0.1'), false)
  } finally {
    await server.close()
  }
})

test('restores a snapshot without contacting the network and recomputes the current endpoint', async () => {
  const location = tempLocation()
  saveUserConfig({ baseUrl: 'https://proxy.example.com/v1', apiKey: 'secret-key-value' }, location)
  const seeded = createRuntimeState('cliproxyapi')
  let calls = 0
  const fetchImpl: typeof fetch = async () => {
    calls += 1
    return new Response(catalogBody(['gemini-3-pro']), { status: 200 })
  }
  await refreshCatalog(seeded, context(true), { location, fetch: fetchImpl, codexIds: new Set() })
  assert.equal(calls, 2)
  saveUserConfig({ baseUrl: 'https://other.example.com/v1', apiKey: 'secret-key-value' }, location)
  const restored = createRuntimeState('cliproxyapi')
  await refreshCatalog(restored, context(false), { location, fetch: fetchImpl, codexIds: new Set() })
  assert.equal(calls, 2)
  assert.equal(restored.source, 'snapshot')
  assert.equal(restored.models[0]?.baseUrl, 'https://other.example.com/v1')
  assert.equal(restored.models[0]?.id, 'gemini-3-pro')
})

test('keeps the previous list when a catalog response declares more than 4 MiB', async () => {
  const location = tempLocation()
  saveUserConfig({ baseUrl: 'https://proxy.example.com/v1', apiKey: 'secret-key-value' }, location)
  const state = createRuntimeState('cliproxyapi')
  let oversized = false
  const fetchImpl: typeof fetch = async () => {
    if (!oversized) return new Response(catalogBody(['gemini-3-pro']), { status: 200 })
    return new Response('{}', {
      status: 200,
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    })
  }
  await refreshCatalog(state, context(true), { location, fetch: fetchImpl, codexIds: new Set() })
  oversized = true
  await assert.rejects(
    refreshCatalog(state, context(true), { location, fetch: fetchImpl, codexIds: new Set() }),
    /4 MiB/u,
  )
  assert.deepEqual(state.models.map((model) => model.id), ['gemini-3-pro'])
  assert.match(state.lastError ?? '', /4 MiB/u)
})

test('discover keeps a model when only one catalog responds', async () => {
  const models = await discoverProviderModels({
    providerId: 'cliproxyapi',
    baseUrl: 'https://proxy.example.com/v1',
    headers: {},
    authRequired: false,
    excludedModels: [],
    modelOverrides: {},
    metadataSources: [],
    fetchTimeoutMs: 15000,
    keySource: 'none',
    baseUrlSource: 'file',
  }, new AbortController().signal, {
    codexIds: new Set(),
    fetch: async (input) => {
      const url = String(input)
      if (url.includes('client_version=pi')) return new Response('no', { status: 404 })
      return new Response(catalogBody(['gemini-3-pro']), { status: 200 })
    },
  })
  assert.deepEqual(models.map((model) => model.id), ['gemini-3-pro'])
  assert.equal(models[0]?.baseUrl, 'https://proxy.example.com/v1')
})
