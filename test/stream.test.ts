import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { Context, Model } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'

import { KEYLESS_API_KEY, stripKeylessAuth } from '../src/stream.ts'

const context = normalizeContext({
  messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
} as Context)

function sseBody(): string {
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    model: 'gemini-3-pro',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  return [
    chunk({ role: 'assistant', content: '' }, null),
    chunk({ content: 'ok' }, null),
    chunk({}, 'stop'),
    'data: [DONE]\n\n',
  ].join('')
}

async function capture(apiKey: string | undefined): Promise<{ path: string, authorization: string | undefined }> {
  let path = ''
  let authorization: string | undefined
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    path = request.url ?? ''
    authorization = request.headers.authorization
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sseBody())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const model: Model<'openai-completions'> = {
    id: 'gemini-3-pro',
    name: 'Gemini',
    api: 'openai-completions',
    provider: 'cliproxyapi',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }
  try {
    const stream = openAICompletionsApi().streamSimple(model, context, {
      apiKey: apiKey ?? KEYLESS_API_KEY,
      fetch: apiKey ? undefined : stripKeylessAuth(undefined),
      maxRetries: 0,
    })
    await stream.result()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { path, authorization }
}

test('a keyless chat request has no Authorization header and stays on the configured prefix', async () => {
  const keyless = await capture(undefined)
  assert.equal(keyless.path, '/v1/chat/completions')
  assert.equal(keyless.authorization, undefined)
  assert.equal(keyless.path.includes('backend-api'), false)
  const keyed = await capture('secret-key-value')
  assert.equal(keyed.path, '/v1/chat/completions')
  assert.equal(keyed.authorization, 'Bearer secret-key-value')
})
