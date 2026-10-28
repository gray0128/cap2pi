import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DEFAULT_BASE_URL,
  normalizeEndpoint,
  type ChatApi,
} from './endpoints.ts'

export const CONFIG_DIR_NAME = 'pi-cliproxyapi-provider'
export const DEFAULT_PROVIDER_ID = 'cliproxyapi'

const METADATA_SOURCES = new Set(['pi-ai', 'models.dev', 'openrouter', 'litellm'])
const CHAT_APIS = new Set<ChatApi>(['anthropic-messages', 'openai-responses', 'openai-completions'])

export interface ConfigLocation {
  agentDir?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface TokenCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface SnapshotModel {
  id: string
  name: string
  api: ChatApi
  contextWindow: number
  maxTokens: number
  input: Array<'text' | 'image'>
  reasoning: boolean
  thinkingLevelMap?: Record<string, string | null>
  cost: TokenCost
}

export interface ModelSnapshot {
  fetchedAt: string
  models: SnapshotModel[]
}

export interface ResolvedConfig {
  providerId: string
  baseUrl: string
  apiKey?: string
  headers: Record<string, string>
  authRequired: boolean
  excludedModels: string[]
  modelOverrides: Record<string, Record<string, unknown>>
  metadataSources: string[]
  openRouterModelsURL?: string
  liteLlmModelsURL?: string
  modelsDevURL?: string
  metadataTimeoutMs?: number
  metadataCacheTtlMs?: number
  modelsDevCacheTtlMs?: number
  defaultContextWindow?: number
  defaultMaxTokens?: number
  defaultInput?: string[]
  fetchTimeoutMs: number
  keySource: 'env' | 'file' | 'none'
  baseUrlSource: 'env' | 'file' | 'default'
}

export interface LoadedConfig {
  agentDir: string
  cwd: string
  config?: ResolvedConfig
  error?: string
}

interface JsonFile {
  value?: Record<string, unknown>
  missing: boolean
  error?: string
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['PI_CODING_AGENT_DIR']?.trim()
  if (fromEnv) {
    return fromEnv.startsWith('~') ? join(homedir(), fromEnv.slice(1)) : fromEnv
  }
  return join(homedir(), '.pi', 'agent')
}

export function userConfigPath(agentDir: string): string {
  return join(agentDir, CONFIG_DIR_NAME, 'config.json')
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, '.pi', CONFIG_DIR_NAME, 'config.json')
}

export function snapshotPath(agentDir: string): string {
  return join(agentDir, CONFIG_DIR_NAME, 'snapshot.json')
}

export function loadConfig(location: ConfigLocation = {}): LoadedConfig {
  const env = location.env ?? process.env
  const cwd = location.cwd ?? process.cwd()
  const agentDir = location.agentDir ?? resolveAgentDir(env)
  const user = readJson(userConfigPath(agentDir))
  const project = readJson(projectConfigPath(cwd))
  if (!user.missing && user.error) {
    return { agentDir, cwd, error: user.error }
  }
  const userRecord = user.value ?? {}
  const projectRecord = project.missing || project.error ? {} : project.value ?? {}
  const baseUrlResult = resolveBaseUrl(env, userRecord)
  if (baseUrlResult.error) {
    return { agentDir, cwd, error: baseUrlResult.error }
  }
  const provider = resolveProviderId(env, userRecord)
  const config: ResolvedConfig = {
    providerId: provider.id,
    baseUrl: baseUrlResult.baseUrl,
    headers: stringMap(userRecord['headers']) ?? {},
    authRequired: resolveAuthRequired(env, userRecord),
    excludedModels: stringList(projectRecord['excludedModels']) ?? stringList(userRecord['excludedModels']) ?? [],
    modelOverrides: overrideMap(projectRecord['modelOverrides']) ?? overrideMap(userRecord['modelOverrides']) ?? {},
    metadataSources: metadataSources(projectRecord['metadataSources']) ?? metadataSources(userRecord['metadataSources']) ?? ['pi-ai', 'models.dev', 'litellm'],
    fetchTimeoutMs: positiveInt(userRecord['fetchTimeoutMs']) ?? 15000,
    keySource: 'none',
    baseUrlSource: baseUrlResult.source,
  }
  const apiKey = resolveApiKey(env, userRecord)
  if (apiKey.value) {
    config.apiKey = apiKey.value
    config.keySource = apiKey.source
  }
  assignOptional(config, projectRecord, userRecord)
  const error = [provider.error, project.error].filter((item): item is string => item !== undefined).join('\n')
  return { agentDir, cwd, config, ...(error ? { error } : {}) }
}

export function saveUserConfig(
  update: { baseUrl: string, apiKey: string },
  location: ConfigLocation = {},
): void {
  const env = location.env ?? process.env
  const agentDir = location.agentDir ?? resolveAgentDir(env)
  const path = userConfigPath(agentDir)
  const current = readJson(path)
  const record = current.value ? { ...current.value } : {}
  record['baseUrl'] = normalizeEndpoint(update.baseUrl)
  if (update.apiKey.trim()) record['apiKey'] = update.apiKey.trim()
  else delete record['apiKey']
  delete record['allowRemote']
  writePrivateJson(path, record)
}

export function readSnapshot(agentDir: string): ModelSnapshot | undefined {
  const file = readJson(snapshotPath(agentDir))
  if (file.missing || file.error || !file.value) return undefined
  const fetchedAt = file.value['fetchedAt']
  const models = file.value['models']
  if (typeof fetchedAt !== 'string' || !Array.isArray(models)) return undefined
  const parsed: SnapshotModel[] = []
  for (const item of models) {
    const model = snapshotModel(item)
    if (model) parsed.push(model)
  }
  return { fetchedAt, models: parsed }
}

export function writeSnapshot(agentDir: string, snapshot: ModelSnapshot): void {
  const models = snapshot.models.map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    cost: model.cost,
  }))
  writePrivateJson(snapshotPath(agentDir), { fetchedAt: snapshot.fetchedAt, models })
}

export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
}

function assignOptional(
  config: ResolvedConfig,
  projectRecord: Record<string, unknown>,
  userRecord: Record<string, unknown>,
): void {
  const openRouter = stringValue(projectRecord['openRouterModelsURL']) ?? stringValue(userRecord['openRouterModelsURL'])
  const liteLlm = stringValue(projectRecord['liteLlmModelsURL']) ?? stringValue(userRecord['liteLlmModelsURL'])
  const modelsDev = stringValue(projectRecord['modelsDevURL']) ?? stringValue(userRecord['modelsDevURL'])
  const timeout = positiveInt(userRecord['metadataTimeoutMs'])
  const cacheTtl = nonNegativeInt(userRecord['metadataCacheTtlMs'])
  const modelsDevTtl = nonNegativeInt(userRecord['modelsDevCacheTtlMs'])
  const contextWindow = positiveInt(userRecord['defaultContextWindow'])
  const maxTokens = positiveInt(userRecord['defaultMaxTokens'])
  const input = inputList(userRecord['defaultInput'])
  if (openRouter) config.openRouterModelsURL = openRouter
  if (liteLlm) config.liteLlmModelsURL = liteLlm
  if (modelsDev) config.modelsDevURL = modelsDev
  if (timeout !== undefined) config.metadataTimeoutMs = timeout
  if (cacheTtl !== undefined) config.metadataCacheTtlMs = cacheTtl
  if (modelsDevTtl !== undefined) config.modelsDevCacheTtlMs = modelsDevTtl
  if (contextWindow !== undefined) config.defaultContextWindow = contextWindow
  if (maxTokens !== undefined) config.defaultMaxTokens = maxTokens
  if (input) config.defaultInput = input
}

function resolveBaseUrl(
  env: NodeJS.ProcessEnv,
  userRecord: Record<string, unknown>,
): { baseUrl: string, source: ResolvedConfig['baseUrlSource'], error?: string } {
  const fromEnv = env['CLIPROXYAPI_BASE_URL']?.trim()
  if (fromEnv) {
    try {
      return { baseUrl: normalizeEndpoint(fromEnv), source: 'env' }
    } catch (error) {
      return { baseUrl: DEFAULT_BASE_URL, source: 'env', error: errorText(error) }
    }
  }
  const fromFile = stringValue(userRecord['baseUrl'])
  if (fromFile) {
    try {
      return { baseUrl: normalizeEndpoint(fromFile), source: 'file' }
    } catch (error) {
      return { baseUrl: DEFAULT_BASE_URL, source: 'file', error: errorText(error) }
    }
  }
  return { baseUrl: DEFAULT_BASE_URL, source: 'default' }
}

function resolveApiKey(
  env: NodeJS.ProcessEnv,
  userRecord: Record<string, unknown>,
): { value?: string, source: ResolvedConfig['keySource'] } {
  if (Object.prototype.hasOwnProperty.call(env, 'CLIPROXYAPI_API_KEY')) {
    const value = env['CLIPROXYAPI_API_KEY']?.trim()
    if (value) return { value, source: 'env' }
    return { source: 'none' }
  }
  const fromFile = stringValue(userRecord['apiKey'])
  if (fromFile) return { value: fromFile, source: 'file' }
  return { source: 'none' }
}

function resolveAuthRequired(env: NodeJS.ProcessEnv, userRecord: Record<string, unknown>): boolean {
  const fromEnv = env['CLIPROXYAPI_AUTH_REQUIRED']?.trim().toLowerCase()
  if (fromEnv === '1' || fromEnv === 'true' || fromEnv === 'yes') return true
  if (fromEnv === '0' || fromEnv === 'false' || fromEnv === 'no') return false
  return userRecord['authRequired'] === true
}

function resolveProviderId(
  env: NodeJS.ProcessEnv,
  userRecord: Record<string, unknown>,
): { id: string, error?: string } {
  const raw = env['CLIPROXYAPI_PROVIDER_ID']?.trim() || stringValue(userRecord['providerId']) || DEFAULT_PROVIDER_ID
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(raw)) return { id: raw }
  return { id: DEFAULT_PROVIDER_ID, error: `CLIProxyAPI provider id ${JSON.stringify(raw)} is not usable` }
}

function readJson(path: string): JsonFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return { missing: true }
    return { missing: false, error: `Could not read ${path}: ${errorText(error)}` }
  }
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { missing: false, error: `${path} must contain a JSON object` }
    }
    return { missing: false, value: value as Record<string, unknown> }
  } catch (error) {
    return { missing: false, error: `Could not parse ${path}: ${errorText(error)}` }
  }
}

function snapshotModel(value: unknown): SnapshotModel | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const api = record['api']
  const id = stringValue(record['id'])
  const name = stringValue(record['name'])
  const contextWindow = positiveInt(record['contextWindow'])
  const maxTokens = positiveInt(record['maxTokens'])
  const input = inputList(record['input'])
  const cost = tokenCost(record['cost'])
  if (!id || !name || !contextWindow || !maxTokens || !input || !cost) return undefined
  if (typeof api !== 'string' || !CHAT_APIS.has(api as ChatApi)) return undefined
  const reasoning = record['reasoning'] === true
  const thinkingLevelMap = reasoning ? thinkingMap(record['thinkingLevelMap']) : undefined
  return {
    id,
    name,
    api: api as ChatApi,
    contextWindow,
    maxTokens,
    input,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    cost,
  }
}

function thinkingMap(value: unknown): Record<string, string | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const map: Record<string, string | null> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === null) map[key] = null
    else if (typeof item === 'string') map[key] = item
  }
  return map
}

function tokenCost(value: unknown): TokenCost | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const input = finite(record['input'])
  const output = finite(record['output'])
  const cacheRead = finite(record['cacheRead'])
  const cacheWrite = finite(record['cacheWrite'])
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined
  return { input, output, cacheRead, cacheWrite }
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

function overrideMap(value: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) out[key] = item as Record<string, unknown>
  }
  return out
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function inputList(value: unknown): Array<'text' | 'image'> | undefined {
  const list = stringList(value)
  if (!list) return undefined
  const input = list.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
  return input.length > 0 ? input : undefined
}

function metadataSources(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && METADATA_SOURCES.has(item))
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function positiveInt(value: unknown): number | undefined {
  const parsed = finite(value)
  if (parsed !== undefined && Number.isInteger(parsed) && parsed > 0) return parsed
  return undefined
}

function nonNegativeInt(value: unknown): number | undefined {
  const parsed = finite(value)
  if (parsed !== undefined && Number.isInteger(parsed) && parsed >= 0) return parsed
  return undefined
}

function finite(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
