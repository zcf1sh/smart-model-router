import Schema from '@deepseek-ai/schemastery'
import { LlmAdapter, createMessage } from '@deepseek-ai/dsh-llm'

export const Config = Schema.object({
  weakProvider: Schema.string().default(''),
  weakModel: Schema.string().default(''),
  strongProvider: Schema.string().default(''),
  strongModel: Schema.string().default(''),
  iterationEnabled: Schema.boolean().default(true),
  iterationProvider: Schema.string().default(''),
  iterationModel: Schema.string().default(''),
  iterationEvery: Schema.number().min(1).max(100).step(1).default(20),
  iterationSampleChars: Schema.number().min(500).max(10000).step(500).default(4000),
  draftMaxChars: Schema.number().min(1000).max(30000).step(1000).default(10000),
})

export const inject = ['llm']

const ROUTE = 'smart-model-router'
const AUTO_MODEL = 'auto'
const COMPLEX_KEYWORDS = /分析|比较|推导|证明|调研|研究|设计|调试|排查|实现|编程|代码|方案|评估|总结.*文档|analy[sz]e|compare|derive|prove|research|design|debug|implement|code|review|evaluate/i

function textOf(messages) {
  const out = []
  for (const message of messages ?? []) {
    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out.join('\n')
}

function errorChunk(code, message) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

class SmartRouterAdapter extends LlmAdapter {
  constructor(ctx, config) {
    super()
    this.ctx = ctx
    this.config = config
    this.requestCount = 0
    this.iterationBusy = false
    this.policy = { lengthThreshold: 900 }
  }

  providerInfo(provider) {
    return { id: provider, name: 'Smart model router' }
  }

  async listModels(provider) {
    return [{ provider, id: AUTO_MODEL, name: 'Auto · draft + review', description: 'Weak-model draft followed by strong-model review', inputModalities: ['text'] }]
  }

  async resolveModel(provider, model, signal) {
    if (model !== AUTO_MODEL) return { provider, id: model, name: model, inputModalities: ['text'] }
    const { strongProvider, strongModel } = this.config
    if (!strongProvider || !strongModel) return { provider, id: AUTO_MODEL, name: 'Auto · configure strong model', inputModalities: ['text'] }
    try {
      const info = await this.ctx.llm.resolveModelInfo(strongProvider, strongModel, signal)
      return { ...info, provider, id: AUTO_MODEL, name: `Auto · draft + ${info.name}` }
    } catch {
      return { provider, id: AUTO_MODEL, name: 'Auto · draft + review', inputModalities: ['text'] }
    }
  }

  isComplex(taskText, tools) {
    return (tools?.length ?? 0) > 0
      || taskText.length > this.policy.lengthThreshold
      || COMPLEX_KEYWORDS.test(taskText)
  }

  async *forwardWithLearning(options, meta) {
    let answer = ''
    let failed = false
    try {
      for await (const chunk of this.ctx.llm.stream(options)) {
        if (chunk.type === 'text-delta') answer += chunk.text
        if (chunk.type === 'finish' && !['stop', 'max-tokens', 'tool-calls'].includes(chunk.reason.kind)) failed = true
        yield chunk
      }
    } finally {
      await this.maybeIterate({ ...meta, failed }, answer)
    }
  }

  async maybeIterate(meta, answer) {
    const { iterationEnabled, iterationProvider, iterationModel, iterationEvery, iterationSampleChars } = this.config
    this.requestCount += 1
    if (!iterationEnabled || this.iterationBusy || !iterationProvider || !iterationModel) return
    if (iterationProvider === ROUTE || iterationModel === AUTO_MODEL) return
    if (this.requestCount % iterationEvery !== 0) return

    this.iterationBusy = true
    try {
      const sample = answer.slice(0, iterationSampleChars)
      const prompt = `You are the routing policy evaluator. Review this anonymized routing sample and return JSON only: {"lengthThreshold": integer}. Keep lengthThreshold between 500 and 2500. Increase it when short tasks are being escalated; decrease it when long or difficult tasks are being sent to the weak path. Do not change it based on one ambiguous sample.\n\nTask length: ${meta.taskText.length}\nUsed tools: ${meta.usedTools}\nComplex route selected: ${meta.complex}\nFinal stream failed: ${meta.failed}\nAnswer sample:\n${sample}`
      let evaluation = ''
      for await (const chunk of this.ctx.llm.stream({
        provider: iterationProvider,
        model: iterationModel,
        messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] })],
        maxTokens: 128,
        temperature: 0,
      })) {
        if (chunk.type === 'text-delta') evaluation += chunk.text
      }
      const match = evaluation.match(/\{[\s\S]*?\}/)
      if (!match) return
      const candidate = JSON.parse(match[0])
      if (Number.isInteger(candidate.lengthThreshold) && candidate.lengthThreshold >= 500 && candidate.lengthThreshold <= 2500) {
        this.policy.lengthThreshold = candidate.lengthThreshold
        this.ctx.logger.info(`Smart router self-iteration updated complexity threshold to ${candidate.lengthThreshold}`)
      }
    } catch (error) {
      this.ctx.logger.debug?.('Smart router self-iteration skipped', error)
    } finally {
      this.iterationBusy = false
    }
  }

  async *stream(options) {
    const { weakProvider, weakModel, strongProvider, strongModel, draftMaxChars } = this.config
    if (options.model !== AUTO_MODEL) {
      yield errorChunk('UNKNOWN_MODEL', `Smart router only serves model "${AUTO_MODEL}".`)
      return
    }
    if (!weakProvider || !weakModel) {
      yield errorChunk('ROUTER_NOT_CONFIGURED', 'Configure weakProvider and weakModel in this plugin settings.')
      return
    }
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted.' } } }
      return
    }

    const taskText = textOf(options.messages)
    const complex = this.isComplex(taskText, options.tools)
    const meta = { taskText, complex, usedTools: (options.tools?.length ?? 0) > 0 }

    if (!complex) {
      yield* this.forwardWithLearning({ ...options, provider: weakProvider, model: weakModel }, meta)
      return
    }

    if (!strongProvider || !strongModel) {
      yield errorChunk('ROUTER_NOT_CONFIGURED', 'Complex tasks require strongProvider and strongModel in this plugin settings.')
      return
    }

    const draftOptions = {
      ...options,
      provider: weakProvider,
      model: weakModel,
      tools: undefined,
      toolHistory: undefined,
      maxTokens: Math.min(options.maxTokens ?? 2048, 2048),
      reasoningEffort: undefined,
    }
    let draft = ''
    let draftFailed = false
    try {
      for await (const chunk of this.ctx.llm.stream(draftOptions)) {
        if (options.signal?.aborted) break
        if (chunk.type === 'text-delta' && draft.length < draftMaxChars) draft += chunk.text.slice(0, draftMaxChars - draft.length)
        if (chunk.type === 'finish' && !['stop', 'max-tokens'].includes(chunk.reason.kind)) draftFailed = true
      }
    } catch {
      draftFailed = true
    }

    const reviewText = draft && !draftFailed
      ? `\n\nA draft from a smaller model follows. Treat it as fallible working material: verify it against the conversation and tools, correct errors, and provide the final answer directly.\n\n--- DRAFT ---\n${draft}\n--- END DRAFT ---`
      : '\n\nProduce the final answer directly. The preliminary draft was unavailable.'
    const reviewMessage = createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: reviewText }] })
    yield* this.forwardWithLearning({ ...options, provider: strongProvider, model: strongModel, messages: [...options.messages, reviewMessage] }, meta)
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = Config(rawConfig)
  const adapter = new SmartRouterAdapter(ctx, config)
  ctx.llm.registerAdapter([ROUTE], adapter)
  ctx.logger.info('Smart model router registered provider smart-model-router (model: auto)')
}
