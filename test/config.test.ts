import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadConfig, saveUserConfig, userConfigPath, writeSnapshot, readSnapshot } from '../src/config.ts'

function tempLocation() {
  const root = mkdtempSync(join(tmpdir(), 'cliproxyapi-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(cwd, '.pi', 'pi-cliproxyapi-provider'), { recursive: true })
  return { root, agentDir, cwd, env: {} as NodeJS.ProcessEnv }
}

test('uses the default endpoint when no base URL is configured', () => {
  const location = tempLocation()
  const loaded = loadConfig(location)
  assert.equal(loaded.config?.baseUrl, 'http://127.0.0.1:8317/v1')
  assert.equal(loaded.config?.baseUrlSource, 'default')
  assert.equal(loaded.config?.apiKey, undefined)
  assert.equal(loaded.config?.authRequired, false)
  assert.deepEqual(loaded.config?.metadataSources, ['pi-ai', 'models.dev', 'litellm'])
})

test('environment overrides the user file and the project file cannot set the endpoint or key', () => {
  const location = tempLocation()
  saveUserConfig({ baseUrl: 'https://file.example.com/v1', apiKey: 'file-key' }, location)
  const mode = statSync(userConfigPath(location.agentDir)).mode & 0o777
  assert.equal(mode, 0o600)
  writeFileSync(join(location.cwd, '.pi', 'pi-cliproxyapi-provider', 'config.json'), JSON.stringify({
    baseUrl: 'https://project.example.com/v1',
    apiKey: 'project-key',
    headers: { 'x-project': 'no' },
    excludedModels: ['*-preview'],
    modelOverrides: { 'gpt-5.5': { name: 'From project' } },
    metadataSources: ['pi-ai'],
    modelsDevURL: 'https://models.example/api.json',
  }))
  const fromFile = loadConfig(location)
  assert.equal(fromFile.config?.baseUrl, 'https://file.example.com/v1')
  assert.equal(fromFile.config?.apiKey, 'file-key')
  assert.deepEqual(fromFile.config?.headers, {})
  assert.deepEqual(fromFile.config?.excludedModels, ['*-preview'])
  assert.equal(fromFile.config?.modelOverrides['gpt-5.5']?.['name'], 'From project')
  assert.deepEqual(fromFile.config?.metadataSources, ['pi-ai'])
  assert.equal(fromFile.config?.modelsDevURL, 'https://models.example/api.json')

  const fromEnv = loadConfig({
    ...location,
    env: {
      CLIPROXYAPI_BASE_URL: 'https://env.example.com/v1/',
      CLIPROXYAPI_API_KEY: 'env-key',
      CLIPROXYAPI_AUTH_REQUIRED: 'true',
      CLIPROXYAPI_PROVIDER_ID: 'remote-cpa',
    },
  })
  assert.equal(fromEnv.config?.baseUrl, 'https://env.example.com/v1')
  assert.equal(fromEnv.config?.apiKey, 'env-key')
  assert.equal(fromEnv.config?.keySource, 'env')
  assert.equal(fromEnv.config?.authRequired, true)
  assert.equal(fromEnv.config?.providerId, 'remote-cpa')
  assert.equal(JSON.stringify(fromEnv.config).includes('project-key'), false)
})

test('accepts a non-loopback base URL and stores the snapshot without the key or endpoint', () => {
  const location = tempLocation()
  saveUserConfig({ baseUrl: 'http://10.1.2.3:8317/v1', apiKey: 'secret-key-value' }, location)
  const loaded = loadConfig(location)
  assert.equal(loaded.config?.baseUrl, 'http://10.1.2.3:8317/v1')
  writeSnapshot(location.agentDir, {
    fetchedAt: '2026-10-28T00:00:00.000Z',
    models: [{
      id: 'gpt-5.5',
      name: 'GPT 5.5',
      api: 'openai-responses',
      contextWindow: 128000,
      maxTokens: 32000,
      input: ['text'],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  })
  const text = readFileSync(join(location.agentDir, 'pi-cliproxyapi-provider', 'snapshot.json'), 'utf8')
  assert.equal(text.includes('secret-key-value'), false)
  assert.equal(text.includes('baseUrl'), false)
  assert.equal(text.includes('10.1.2.3'), false)
  assert.equal(readSnapshot(location.agentDir)?.models[0]?.api, 'openai-responses')
  assert.equal(statSync(join(location.agentDir, 'pi-cliproxyapi-provider', 'snapshot.json')).mode & 0o777, 0o600)
})

test('rejects a non-http base URL from the environment', () => {
  const location = tempLocation()
  const loaded = loadConfig({ ...location, env: { CLIPROXYAPI_BASE_URL: 'file:///tmp/models' } })
  assert.equal(loaded.config, undefined)
  assert.match(loaded.error ?? '', /http or https/)
})
