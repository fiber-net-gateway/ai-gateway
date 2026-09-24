import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { loadDemoProviderConfig } from './config/demo.js'

const config = loadDemoProviderConfig()

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 1024 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object')
  }
  return value as Record<string, unknown>
}

function lastUserText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages)) return 'demo request'
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index]
    if (typeof message !== 'object' || message === null) continue
    const candidate = message as Record<string, unknown>
    if (candidate.role !== 'user') continue
    if (typeof candidate.content === 'string') return candidate.content.slice(0, 120)
    if (!Array.isArray(candidate.content)) continue
    const text = candidate.content
      .flatMap((block) => {
        if (typeof block !== 'object' || block === null) return []
        const contentBlock = block as Record<string, unknown>
        return contentBlock.type === 'text' && typeof contentBlock.text === 'string'
          ? [contentBlock.text]
          : []
      })
      .join(' ')
    if (text) return text.slice(0, 120)
  }
  return 'demo request'
}

function inputTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4))
}

function openAiUsage(text: string) {
  const promptTokens = inputTokens(text)
  return { prompt_tokens: promptTokens, completion_tokens: 12, total_tokens: promptTokens + 12 }
}

function json(reply: ServerResponse, status: number, body: unknown): void {
  const content = JSON.stringify(body)
  reply.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(content),
  })
  reply.end(content)
}

async function chat(request: IncomingMessage, reply: ServerResponse): Promise<void> {
  const body = await readJson(request)
  const model = typeof body.model === 'string' ? body.model : 'fiber-demo-upstream'
  const input = lastUserText(body)
  const content = `Fiber demo provider received: ${input}`
  const id = `chatcmpl-demo-${randomUUID()}`
  const tokenUsage = openAiUsage(input)
  if (body.stream === true) {
    reply.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    reply.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
    )
    reply.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    )
    reply.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: tokenUsage })}\n\n`,
    )
    reply.end('data: [DONE]\n\n')
    return
  }
  json(reply, 200, {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: tokenUsage,
  })
}

function anthropicEvent(reply: ServerResponse, event: string, data: unknown): void {
  reply.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function messages(request: IncomingMessage, reply: ServerResponse): Promise<void> {
  const body = await readJson(request)
  const model = typeof body.model === 'string' ? body.model : 'fiber-demo-upstream'
  const input = lastUserText(body)
  const content = `Fiber demo provider received: ${input}`
  const id = `msg_demo_${randomUUID().replaceAll('-', '')}`
  const tokenUsage = { input_tokens: inputTokens(input), output_tokens: 12 }
  if (body.stream === true) {
    reply.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    anthropicEvent(reply, 'message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: tokenUsage.input_tokens, output_tokens: 0 },
      },
    })
    anthropicEvent(reply, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
    anthropicEvent(reply, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: content },
    })
    anthropicEvent(reply, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    anthropicEvent(reply, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: tokenUsage.output_tokens },
    })
    anthropicEvent(reply, 'message_stop', { type: 'message_stop' })
    reply.end()
    return
  }
  json(reply, 200, {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: content }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: tokenUsage,
  })
}

async function responses(request: IncomingMessage, reply: ServerResponse): Promise<void> {
  const body = await readJson(request)
  const input =
    typeof body.input === 'string'
      ? body.input.slice(0, 120)
      : lastUserText({ messages: body.input })
  const content = `Fiber demo provider received: ${input}`
  const id = `resp_demo_${randomUUID()}`
  const itemId = `msg_demo_${randomUUID()}`
  const response = {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1_000),
    model: typeof body.model === 'string' ? body.model : 'fiber-demo-upstream',
    status: 'completed',
    store: false,
    background: false,
    error: null,
    incomplete_details: null,
    output: [
      {
        id: itemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: content, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: inputTokens(input),
      output_tokens: 12,
      total_tokens: inputTokens(input) + 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }
  if (body.stream !== true) {
    json(reply, 200, response)
    return
  }
  reply.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  })
  let sequence = 0
  const event = (type: string, data: Record<string, unknown>) =>
    anthropicEvent(reply, type, { type, sequence_number: sequence++, ...data })
  event('response.created', {
    response: { ...response, status: 'in_progress', output: [], usage: null },
  })
  event('response.output_item.added', {
    output_index: 0,
    item: { ...response.output[0], status: 'in_progress', content: [] },
  })
  event('response.content_part.added', {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  })
  event('response.output_text.delta', {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: content,
  })
  event('response.output_text.done', {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text: content,
  })
  event('response.content_part.done', {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: response.output[0]?.content[0],
  })
  event('response.output_item.done', { output_index: 0, item: response.output[0] })
  event('response.completed', { response })
  reply.end()
}

const server = createServer((request, reply) => {
  if (request.method === 'GET' && request.url === '/health') {
    json(reply, 200, { status: 'ok', service: 'fiber-demo-provider' })
    return
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    void chat(request, reply).catch(() => {
      if (!reply.headersSent) json(reply, 400, { error: { message: 'invalid demo request' } })
      else reply.destroy()
    })
    return
  }
  if (request.method === 'POST' && request.url === '/v1/responses') {
    void responses(request, reply).catch(() => {
      if (!reply.headersSent) json(reply, 400, { error: { message: 'invalid demo request' } })
      else reply.destroy()
    })
    return
  }
  if (request.method === 'POST' && request.url === '/v1/messages') {
    void messages(request, reply).catch(() => {
      if (!reply.headersSent) json(reply, 400, { error: { message: 'invalid demo request' } })
      else reply.destroy()
    })
    return
  }
  json(reply, 404, { error: { message: 'not found' } })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close())
}

server.listen(config.port, config.host, () => {
  process.stdout.write(`demo provider listening on ${config.host}:${config.port}\n`)
})
