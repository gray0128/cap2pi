import { baseUrlForApi, type ChatApi } from './endpoints.ts'
import type { SnapshotModel, TokenCost } from './config.ts'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const ZERO_COST: TokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const CODEX_ROUTE = /(?:^|\/)gpt-(?:5\.(?:5|6)|6)(?:$|[^0-9.])/iu

export interface CatalogProfile {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  input: Array<'text' | 'image'>
  reasoningEfforts?: Record<string, string>
}

/** In-memory chat model. The snapshot copy omits `baseUrl` and never carries an API key. */
export interface ListedModel extends SnapshotModel {
  provider: string
  baseUrl: string
}

export function isCodexRouteId(id: string): boolean {
  return CODEX_ROUTE.test(id.trim().toLowerCase())
}

export function isClaudeId(id: string): boolean {
  const trimmed = id.trim().toLowerCase()
  const slash = trimmed.lastIndexOf('/')
  const tail = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  return tail.includes('claude')
}

/** Anthropic owner field, or an `anthropic/` channel prefix on the model id. */
export function isAnthropicChannel(id: string, owner: string | undefined): boolean {
  if (owner?.trim().toLowerCase() === 'anthropic') return true
  const trimmed = id.trim().toLowerCase()
  const slash = trimmed.indexOf('/')
  return slash > 0 && trimmed.slice(0, slash) === 'anthropic'
}

/**
 * Choose the built-in Pi API. `modelOverrides` is not an input: a wrong `api`
 * makes the built-in adapter send a body the proxy rejects.
 */
export function selectApi(id: string, owner: string | undefined, codexIds: ReadonlySet<string>): ChatApi {
  if (isClaudeId(id) && isAnthropicChannel(id, owner)) return 'anthropic-messages'
  if (matchesCodexCatalog(id, codexIds) || isCodexRouteId(id)) return 'openai-responses'
  return 'openai-completions'
}

export function ownerOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  for (const key of ['owned_by', 'owner', 'provider'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function thinkingOf(efforts: Record<string, string> | undefined): {
  reasoning: boolean
  thinkingLevelMap?: Record<string, string | null>
} {
  if (!efforts) return { reasoning: false }
  const thinkingLevelMap: Record<string, string | null> = {}
  let usable = false
  for (const level of THINKING_LEVELS) {
    const wire = efforts[level]
    if (typeof wire === 'string' && wire.trim()) {
      thinkingLevelMap[level] = wire.trim()
      if (level !== 'off') usable = true
    } else {
      thinkingLevelMap[level] = null
    }
  }
  if (!usable) return { reasoning: false }
  return { reasoning: true, thinkingLevelMap }
}

export function costFromMetadata(metadata: unknown): TokenCost {
  if (!metadata || typeof metadata !== 'object') return ZERO_COST
  const cost = (metadata as { cost?: unknown }).cost
  if (!cost || typeof cost !== 'object') return ZERO_COST
  const record = cost as Record<string, unknown>
  if (typeof record['input'] !== 'number' || typeof record['output'] !== 'number') return ZERO_COST
  return {
    input: record['input'],
    output: record['output'],
    cacheRead: typeof record['cacheRead'] === 'number' ? record['cacheRead'] : 0,
    cacheWrite: typeof record['cacheWrite'] === 'number' ? record['cacheWrite'] : 0,
  }
}

export function toProviderModel(input: {
  providerId: string
  baseUrl: string
  profile: CatalogProfile
  owner?: string
  codexIds: ReadonlySet<string>
  cost?: TokenCost
}): ListedModel {
  const api = selectApi(input.profile.id, input.owner, input.codexIds)
  const thinking = thinkingOf(input.profile.reasoningEfforts)
  return {
    id: input.profile.id,
    name: input.profile.name,
    api,
    provider: input.providerId,
    baseUrl: baseUrlForApi(input.baseUrl, api),
    contextWindow: input.profile.contextWindow,
    maxTokens: input.profile.maxTokens,
    input: input.profile.input,
    reasoning: thinking.reasoning,
    ...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
    cost: input.cost ?? ZERO_COST,
  }
}

export function asCatalogProfile(value: unknown): CatalogProfile | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
  const name = typeof record['name'] === 'string' ? record['name'].trim() : ''
  const contextWindow = record['contextWindow']
  const maxTokens = record['maxTokens']
  const input = record['input']
  if (!id || !name) return undefined
  if (typeof contextWindow !== 'number' || typeof maxTokens !== 'number') return undefined
  if (!Array.isArray(input)) return undefined
  const modalities = input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
  if (modalities.length === 0) return undefined
  const efforts = reasoningMap(record['reasoningEfforts'])
  return {
    id,
    name,
    contextWindow,
    maxTokens,
    input: modalities,
    ...(efforts ? { reasoningEfforts: efforts } : {}),
  }
}

function matchesCodexCatalog(id: string, codexIds: ReadonlySet<string>): boolean {
  const trimmed = id.trim()
  if (codexIds.has(trimmed)) return true
  const lower = trimmed.toLowerCase()
  for (const candidate of codexIds) {
    if (candidate.toLowerCase() === lower) return true
  }
  return false
}

function reasoningMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.trim()) out[key] = item
  }
  return Object.keys(out).length > 0 ? out : undefined
}
