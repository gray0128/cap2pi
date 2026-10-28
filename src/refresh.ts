import type { RefreshModelsContext } from '@earendil-works/pi-ai'

import { catalogEntriesOf, mergeCatalogPayloads, modelIdOf, readCatalog } from './catalog.ts'
import {
  loadConfig,
  readSnapshot,
  writeSnapshot,
  type ConfigLocation,
  type ModelSnapshot,
  type ResolvedConfig,
} from './config.ts'
import { baseUrlForApi, catalogRequestUrls, statusEndpoint } from './endpoints.ts'
import {
  asCatalogProfile,
  costFromMetadata,
  ownerOf,
  toProviderModel,
  type ListedModel,
} from './models.ts'
import {
  calibrateCatalogPayload,
  createMetadataResolver,
  lookupModelMetadata,
} from './metadata.ts'

const MAX_CATALOG_BYTES = 4 * 1024 * 1024

export interface RuntimeState {
  providerId: string
  models: ListedModel[]
  source: 'none' | 'snapshot' | 'live'
  lastError?: string
  endpoint?: string
  keyConfigured: boolean
}

export interface RefreshDeps {
  location?: ConfigLocation
  fetch?: typeof fetch
  codexIds?: ReadonlySet<string>
}

export function createRuntimeState(providerId: string): RuntimeState {
  return { providerId, models: [], source: 'none', keyConfigured: false }
}

/** Replace the in-memory catalog. A failed network refresh throws and leaves the previous list. */
export async function refreshCatalog(
  state: RuntimeState,
  context: RefreshModelsContext,
  deps: RefreshDeps = {},
): Promise<void> {
  const loaded = loadConfig(deps.location)
  if (!loaded.config) {
    state.lastError = loaded.error ?? 'CLIProxyAPI config is unavailable'
    throw new Error(state.lastError)
  }
  state.endpoint = statusEndpoint(loaded.config.baseUrl)
  state.keyConfigured = Boolean(loaded.config.apiKey)
  if (loaded.error) state.lastError = loaded.error

  if (!context.allowNetwork) {
    const snapshot = readSnapshot(loaded.agentDir)
    const models = snapshot ? rehydrate(snapshot, loaded.config) : []
    await context.publish({
      update: () => {
        state.models = models
        state.source = snapshot ? 'snapshot' : 'none'
      },
    })
    return
  }

  if (context.signal.aborted) throw abortError(context.signal)
  try {
    const codexIds = deps.codexIds ?? await loadCodexModelIds()
    const models = await discoverProviderModels(loaded.config, context.signal, {
      fetch: deps.fetch,
      codexIds,
    })
    if (context.signal.aborted) throw abortError(context.signal)
    writeSnapshot(loaded.agentDir, toSnapshot(models))
    await context.publish({
      update: () => {
        state.models = models
        state.source = 'live'
        state.lastError = undefined
      },
    })
  } catch (error) {
    if (!context.signal.aborted) state.lastError = errorText(error)
    throw error instanceof Error ? error : new Error(errorText(error))
  }
}

export async function discoverProviderModels(
  config: ResolvedConfig,
  signal: AbortSignal,
  deps: { fetch?: typeof fetch, codexIds?: ReadonlySet<string> } = {},
): Promise<ListedModel[]> {
  const urls = catalogRequestUrls(config.baseUrl)
  const [rich, standard] = await Promise.allSettled([
    fetchCatalog(urls.rich, config, signal, deps.fetch),
    fetchCatalog(urls.standard, config, signal, deps.fetch),
  ])
  if (signal.aborted) throw abortError(signal)
  const body = chooseCatalog(rich, standard)
  const resolver = metadataResolver(config)
  let calibrated = body
  let indexes: unknown[] = []
  try {
    indexes = await resolver.resolveIndexesForPayloads([body], signal) as unknown[]
    if (indexes.length > 0) calibrated = calibrateCatalogPayload(body, indexes)
  } catch {
    calibrated = body
  }
  const profiles = readCatalog(calibrated, catalogOptions(config)) as unknown[]
  const owners = ownersById(calibrated)
  const codexIds = deps.codexIds ?? new Set<string>()
  const models: ListedModel[] = []
  for (const item of profiles) {
    const profile = asCatalogProfile(item)
    if (!profile) continue
    const metadata = lookupModelMetadata(profile.id, indexes)
    models.push(toProviderModel({
      providerId: config.providerId,
      baseUrl: config.baseUrl,
      profile,
      owner: owners.get(profile.id),
      codexIds,
      cost: costFromMetadata(metadata),
    }))
  }
  if (models.length === 0) throw new Error('CLIProxyAPI model catalog contains no usable models')
  return models
}

export function loadCodexModelIds(): Promise<ReadonlySet<string>> {
  return import('@earendil-works/pi-ai/providers/all')
    .then((mod) => {
      const read = mod.getBuiltinModels as (provider: string) => Array<{ id: string }>
      return new Set(read('openai-codex').map((model) => model.id))
    })
    .catch(() => new Set<string>())
}

export function toSnapshot(models: readonly ListedModel[]): ModelSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: model.input,
      reasoning: model.reasoning,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      cost: model.cost,
    })),
  }
}

export function rehydrate(snapshot: ModelSnapshot, config: ResolvedConfig): ListedModel[] {
  return snapshot.models.map((model) => ({
    ...model,
    provider: config.providerId,
    baseUrl: baseUrlForApi(config.baseUrl, model.api),
  }))
}

function ownersById(body: unknown): Map<string, string> {
  const owners = new Map<string, string>()
  const entries = catalogEntriesOf(body) as unknown[] | undefined
  if (!Array.isArray(entries)) return owners
  for (const entry of entries) {
    const id = modelIdOf(entry) as string | undefined
    const owner = ownerOf(entry)
    if (id && owner && !owners.has(id)) owners.set(id, owner)
  }
  return owners
}

function chooseCatalog(rich: PromiseSettledResult<unknown>, standard: PromiseSettledResult<unknown>): unknown {
  if (rich.status === 'fulfilled' && hasEntries(rich.value)) {
    if (standard.status === 'fulfilled') return mergeCatalogPayloads(rich.value, standard.value)
    return rich.value
  }
  if (standard.status === 'fulfilled' && hasEntries(standard.value)) return standard.value
  if (rich.status === 'rejected') throw asError(rich.reason)
  if (standard.status === 'rejected') throw asError(standard.reason)
  throw new Error('CLIProxyAPI model catalog contains no usable models')
}

function hasEntries(body: unknown): boolean {
  const entries = catalogEntriesOf(body) as unknown[] | undefined
  return Array.isArray(entries) && entries.length > 0
}

function metadataResolver(config: ResolvedConfig): {
  resolveIndexesForPayloads: (payloads: unknown[], signal: AbortSignal) => Promise<unknown>
} {
  return createMetadataResolver({
    metadataSources: config.metadataSources,
    ...(config.openRouterModelsURL ? { openRouterModelsURL: config.openRouterModelsURL } : {}),
    ...(config.liteLlmModelsURL ? { liteLlmModelsURL: config.liteLlmModelsURL } : {}),
    ...(config.modelsDevURL ? { modelsDevURL: config.modelsDevURL } : {}),
    ...(config.metadataTimeoutMs !== undefined ? { metadataTimeoutMs: config.metadataTimeoutMs } : {}),
    ...(config.metadataCacheTtlMs !== undefined ? { metadataCacheTtlMs: config.metadataCacheTtlMs } : {}),
    ...(config.modelsDevCacheTtlMs !== undefined ? { modelsDevCacheTtlMs: config.modelsDevCacheTtlMs } : {}),
  }) as {
    resolveIndexesForPayloads: (payloads: unknown[], signal: AbortSignal) => Promise<unknown>
  }
}

function catalogOptions(config: ResolvedConfig): Record<string, unknown> {
  return {
    ...(config.defaultContextWindow !== undefined ? { defaultContextWindow: config.defaultContextWindow } : {}),
    ...(config.defaultMaxTokens !== undefined ? { defaultMaxTokens: config.defaultMaxTokens } : {}),
    ...(config.defaultInput ? { defaultInput: config.defaultInput } : {}),
    excludedModels: config.excludedModels,
    modelOverrides: config.modelOverrides,
  }
}

async function fetchCatalog(
  url: string,
  config: ResolvedConfig,
  parent: AbortSignal,
  fetchImpl: typeof fetch | undefined,
): Promise<unknown> {
  const request = timedSignal(parent, config.fetchTimeoutMs)
  const call = fetchImpl ?? globalThis.fetch
  try {
    let response: Response
    try {
      response = await call(url, {
        method: 'GET',
        redirect: 'error',
        signal: request.signal,
        headers: catalogHeaders(config),
      })
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason ?? error
      throw new Error(`Could not reach CLIProxyAPI at ${statusEndpoint(config.baseUrl)}`, { cause: error })
    }
    if (!response.ok) {
      throw new Error(`CLIProxyAPI model catalog answered ${response.status}`)
    }
    try {
      return await readBoundedJson(response)
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason ?? error
      if (error instanceof Error && error.message.includes('4 MiB')) throw error
      throw new Error('CLIProxyAPI model catalog did not return usable JSON', { cause: error })
    }
  } finally {
    request.dispose()
  }
}

function catalogHeaders(config: ResolvedConfig): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...config.headers }
  if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`
  else delete headers['authorization']
  return headers
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    await response.body?.cancel()
    throw new Error('CLIProxyAPI model catalog exceeds 4 MiB')
  }
  if (!response.body) return JSON.parse(await response.text()) as unknown
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_CATALOG_BYTES) throw new Error('CLIProxyAPI model catalog exceeds 4 MiB')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function timedSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal, dispose: () => void } {
  const controller = new AbortController()
  const timeoutError = new Error(`CLIProxyAPI model catalog timed out after ${timeoutMs} ms`)
  timeoutError.name = 'TimeoutError'
  const forwardAbort = () => controller.abort(parent.reason)
  if (parent.aborted) forwardAbort()
  else parent.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent.removeEventListener('abort', forwardAbort)
    },
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('CLIProxyAPI model catalog request was aborted')
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(errorText(reason))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
