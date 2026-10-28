import assert from 'node:assert/strict'
import { test } from 'node:test'

import { baseUrlForApi, normalizeEndpoint } from '../src/endpoints.ts'
import { selectApi, thinkingOf, toProviderModel } from '../src/models.ts'

const profile = {
  id: 'gpt-5.5',
  name: 'GPT 5.5',
  contextWindow: 272000,
  maxTokens: 128000,
  input: ['text'] as Array<'text' | 'image'>,
  reasoningEfforts: { low: 'low', high: 'high', max: 'ultra' },
}

test('routes Claude on an Anthropic owner to messages and leaves an ownerless Claude on completions', () => {
  assert.equal(selectApi('claude-opus-4-6', 'anthropic', new Set()), 'anthropic-messages')
  assert.equal(selectApi('anthropic/claude-opus-4-6', undefined, new Set()), 'anthropic-messages')
  assert.equal(selectApi('claude-opus-4-6', undefined, new Set()), 'openai-completions')
  assert.equal(selectApi('claude-opus-4-6', 'openai', new Set()), 'openai-completions')
})

test('routes Codex catalog ids and GPT-5.5, GPT-5.6, GPT-6 to responses', () => {
  const codex = new Set(['gpt-5.4-codex'])
  assert.equal(selectApi('gpt-5.4-codex', undefined, codex), 'openai-responses')
  assert.equal(selectApi('gpt-5.4', undefined, codex), 'openai-completions')
  assert.equal(selectApi('gpt-5.5', undefined, new Set()), 'openai-responses')
  assert.equal(selectApi('gpt-5.6-sol', undefined, new Set()), 'openai-responses')
  assert.equal(selectApi('openai/gpt-6', undefined, new Set()), 'openai-responses')
  assert.equal(selectApi('gpt-5.4-mini', undefined, new Set()), 'openai-completions')
  assert.equal(selectApi('gemini-3-pro', 'google', new Set()), 'openai-completions')
})

test('fills every thinking level and omits the map when the model does not reason', () => {
  assert.deepEqual(thinkingOf(profile.reasoningEfforts), {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'ultra',
    },
  })
  assert.deepEqual(thinkingOf(undefined), { reasoning: false })
})

test('keeps a remote prefix and does not let an override choose the API', () => {
  assert.throws(() => normalizeEndpoint('ftp://proxy.example.com/v1'), /http or https/)
  assert.equal(normalizeEndpoint('http://10.1.2.3:8317/v1/'), 'http://10.1.2.3:8317/v1')
  const model = toProviderModel({
    providerId: 'cliproxyapi',
    baseUrl: 'https://proxy.example.com/v1',
    profile,
    codexIds: new Set(),
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  })
  assert.equal(model.api, 'openai-responses')
  assert.equal(model.baseUrl, 'https://proxy.example.com/v1')
  assert.equal(baseUrlForApi('https://proxy.example.com/v1', 'anthropic-messages'), 'https://proxy.example.com')
  assert.equal(model.baseUrl.includes('backend-api'), false)
  assert.equal(model.baseUrl.includes('127.0.0.1'), false)
  assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 })
})

test('writes a zero cost when metadata has no price', () => {
  const model = toProviderModel({
    providerId: 'cliproxyapi',
    baseUrl: 'http://127.0.0.1:8317/v1',
    profile: { ...profile, id: 'gemini-3-pro', name: 'Gemini', reasoningEfforts: undefined },
    owner: 'google',
    codexIds: new Set(),
  })
  assert.equal(model.api, 'openai-completions')
  assert.equal(model.reasoning, false)
  assert.equal(model.thinkingLevelMap, undefined)
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})
