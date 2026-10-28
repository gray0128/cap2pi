import {
  anthropicMessagesApi,
  createProvider,
  openAICompletionsApi,
  openAIResponsesApi,
  type AuthResult,
  type DeferredFetchOptions,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai/compat'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import { loadConfig, saveUserConfig, type ResolvedConfig } from './config.ts'
import { normalizeEndpoint, statusEndpoint } from './endpoints.ts'
import { THINKING_LEVELS, type ListedModel } from './models.ts'
import { createRuntimeState, refreshCatalog, type RuntimeState } from './refresh.ts'
import { KEYLESS_API_KEY, stripKeylessAuth } from './stream.ts'

/**
 * Register one native provider.
 *
 * pi-coding-agent 1.3.0 deletes the other registration when both
 * `registerProvider(provider)` and `registerProvider(name, config)` run, and
 * startup applies the config registration before the native one. Keeping auth
 * and replace-style `refreshModels` on this single provider avoids that.
 * `createProvider` `fetchModels` is not used: it merges into the static
 * baseline and persists `baseUrl`. This refresh replaces the list and writes
 * a snapshot that has no API key and no base URL.
 */
export default function cliproxyapiProvider(pi: ExtensionAPI): void {
  const loaded = loadConfig()
  const state = createRuntimeState(loaded.config?.providerId ?? 'cliproxyapi')
  state.lastError = loaded.error
  state.endpoint = loaded.config ? statusEndpoint(loaded.config.baseUrl) : undefined
  state.keyConfigured = Boolean(loaded.config?.apiKey)
  pi.registerProvider(createCliproxyProvider(state))
  pi.registerCommand('cliproxyapi', {
    description: 'CLIProxyAPI base URL、密钥、目录和模型',
    handler: (args, ctx) => handleCommand(state, args, ctx),
  })
}

export function authFromConfig(config: ResolvedConfig | undefined): AuthResult | undefined {
  if (!config) return undefined
  if (config.authRequired && !config.apiKey) return undefined
  const headers = forwardHeaders(config)
  if (!config.apiKey) return { auth: headers ? { headers } : {}, source: 'keyless' }
  return {
    auth: { apiKey: config.apiKey, ...(headers ? { headers } : {}) },
    source: config.keySource === 'env' ? 'CLIPROXYAPI_API_KEY' : 'config file',
  }
}

export function createCliproxyProvider(state: RuntimeState): Provider {
  const streams = {
    'openai-completions': withoutKeylessCredential(openAICompletionsApi()),
    'openai-responses': withoutKeylessCredential(openAIResponsesApi()),
    'anthropic-messages': withoutKeylessCredential(anthropicMessagesApi()),
  }
  const inner = createProvider({
    id: state.providerId,
    name: 'CLIProxyAPI',
    auth: {
      apiKey: {
        name: 'CLIProxyAPI API key',
        resolve: async () => authFromConfig(loadConfig().config),
      },
    },
    models: [],
    api: streams,
  })
  return {
    ...inner,
    getModels: () => state.models,
    getAllModels: () => state.models,
    refreshModels: (context) => refreshCatalog(state, context),
  }
}

function withoutKeylessCredential(streams: ProviderStreams): ProviderStreams {
  const fetchDeferred = streams.fetchDeferred
  const wrapped: ProviderStreams = {
    ...streams,
    stream: (model, context, options) => streams.stream(model, context, prepare(options)),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, prepare(options)),
  }
  if (fetchDeferred) {
    wrapped.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, prepare(options))
  }
  return wrapped
}

function prepare<T extends StreamOptions | SimpleStreamOptions | DeferredFetchOptions>(options: T | undefined): T {
  const current = options ?? ({} as T)
  if (current.apiKey) return current
  return { ...current, apiKey: KEYLESS_API_KEY, fetch: stripKeylessAuth(current.fetch) }
}

function forwardHeaders(config: ResolvedConfig): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.headers)) {
    if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key') continue
    headers[key] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

async function handleCommand(state: RuntimeState, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const action = args.trim().split(/\s+/u)[0] ?? ''
  if (action === '' || action === 'status') {
    notify(ctx, statusText(state, loadConfig().config))
    return
  }
  if (action === 'refresh') {
    const result = await ctx.modelRegistry.refresh({ providers: [state.providerId], force: true })
    const failure = result.errors.get(state.providerId)
    if (failure && !state.lastError) state.lastError = failure.message
    notify(ctx, statusText(state, loadConfig().config))
    return
  }
  if (action === 'models') {
    notify(ctx, modelsText(state.models))
    return
  }
  if (action === 'config') {
    await configure(state, ctx)
    return
  }
  notify(ctx, '用法: /cliproxyapi [status|refresh|models|config]')
}

async function configure(state: RuntimeState, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, '/cliproxyapi config 需要在 Pi 界面中运行。')
    return
  }
  const current = loadConfig()
  const baseInput = await ctx.ui.input('CLIProxyAPI base URL', current.config?.baseUrl ?? 'https://example.com/v1')
  if (baseInput === undefined) return
  const baseUrl = baseInput.trim()
  if (!baseUrl) {
    notify(ctx, 'base URL 不能为空。')
    return
  }
  try {
    normalizeEndpoint(baseUrl)
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error))
    return
  }
  const keyInput = await ctx.ui.input('CLIProxyAPI API Key', '留空表示不发送 Bearer')
  if (keyInput === undefined) return
  saveUserConfig({ baseUrl, apiKey: keyInput })
  const result = await ctx.modelRegistry.refresh({ providers: [state.providerId], force: true })
  const failure = result.errors.get(state.providerId)
  if (failure && !state.lastError) state.lastError = failure.message
  notify(ctx, statusText(state, loadConfig().config))
}

function statusText(state: RuntimeState, config: ResolvedConfig | undefined): string {
  const lines = [
    'CLIProxyAPI',
    `端点: ${state.endpoint ?? config?.baseUrl ?? '未配置'}`,
    `密钥: ${state.keyConfigured ? '已配置' : '未配置'}`,
    `目录: ${state.source}`,
    `模型: ${state.models.length}`,
  ]
  if (config?.authRequired && !config.apiKey) lines.push('鉴权: 需要 API Key')
  if (state.lastError) lines.push(`错误: ${state.lastError}`)
  return lines.join('\n')
}

function modelsText(models: readonly ListedModel[]): string {
  if (models.length === 0) return '没有模型。'
  return models.map((model) => {
    const reasoning = model.reasoning && model.thinkingLevelMap
      ? THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level]).map((level) => `${level}=${model.thinkingLevelMap?.[level]}`).join(',')
      : 'false'
    return `${model.id}  ${model.api}  ${model.contextWindow}  ${model.maxTokens}  ${reasoning}`
  }).join('\n')
}

function notify(ctx: ExtensionCommandContext, text: string): void {
  if (ctx.hasUI) ctx.ui.notify(text, 'info')
  else process.stdout.write(`${text}\n`)
}
