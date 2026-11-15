import Schema from '@deepseek-ai/schemastery'
import { LlmAdapter, createMessage } from '@deepseek-ai/dsh-llm'

export const Config = Schema.object({
  weakProvider: Schema.string().default(''),
  weakModel: Schema.string().default(''),
  strongProvider: Schema.string().default(''),
  strongModel: Schema.string().default(''),
  // 'off' routes each step to exactly one model. 'on' adds the weak draft pass
  // before the strong model answers, which doubles input tokens per step.
  reviewMode: Schema.union([Schema.const('off'), Schema.const('on')]).default('off'),
  lengthThreshold: Schema.number().min(500).max(4000).step(100).default(900),
  draftMaxChars: Schema.number().min(1000).max(30000).step(1000).default(8000),
  iterationEnabled: Schema.boolean().default(false),
  iterationProvider: Schema.string().default(''),
  iterationModel: Schema.string().default(''),
  iterationEvery: Schema.number().min(5).max(200).step(1).default(50),
  iterationSampleChars: Schema.number().min(500).max(10000).step(500).default(2000),
})

export const inject = ['llm']

const ROUTE = 'smart-model-router'
const AUTO_MODEL = 'auto'
const COMPLEX_KEYWORDS = /分析|比较|推导|证明|调研|研究|设计|调试|排查|实现|编程|方案|评估|analy[sz]e|compare|derive|prove|research|design|debug|implement|review|evaluate/i

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

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

class SmartRouterAdapter extends LlmAdapter {
  constructor(ctx, config) {
    super()
    this.ctx = ctx
    this.config = config
    this.requestCount = 0
    this.iterationBusy = false
    // Runtime-tunable copy: the loaded config object may be frozen, and the
    // threshold is only ever adjusted in memory by self-iteration.
    this.policy = { lengthThreshold: config.lengthThreshold }
  }

  providerInfo(provider) {
    return { id: provider, name: 'Smart model router' }
  }

  async listModels(provider) {
    const { weakModel, strongModel, reviewMode } = this.config
    const parts = [weakModel, strongModel].filter(Boolean)
    return [{
      provider,
      id: AUTO_MODEL,
      name: parts.length > 0 ? `Auto · ${parts.join(' / ')}` : 'Auto · configure models',
      description: reviewMode === 'on'
        ? 'Routes each step to one model, with an optional weak draft before the strong review'
        : 'Routes each step to exactly one configured model',
      inputModalities: ['text'],
    }]
  }

  /**
   * Report the *weaker* route's capabilities so the harness keeps its context
   * pressure, compaction, and output cap honest. Inheriting the strong model's
   * window here is what made routed turns accumulate more history than a direct
   * weak-model selection, and inheriting its reasoning metadata raised effort.
   */
  async resolveModel(provider, model, signal) {
    if (model !== AUTO_MODEL) return { provider, id: model, name: model, inputModalities: ['text'] }

    const { weakProvider, weakModel, strongProvider, strongModel } = this.config
    const lookups = []
    if (weakProvider && weakModel) lookups.push([weakProvider, weakModel])
    if (strongProvider && strongModel) lookups.push([strongProvider, strongModel])

    const infos = []
    for (const [p, m] of lookups) {
      try {
        infos.push(await this.ctx.llm.resolveModelInfo(p, m, signal))
      } catch {
        // An unreachable or misconfigured route must not fail model resolution;
        // the stream reports the concrete route failure instead.
      }
    }

    const windows = infos.map(info => positive(info.context?.contextWindow)).filter(Boolean)
    const caps = infos.map(info => positive(info.defaultMaxTokens)).filter(Boolean)
    const names = infos.map(info => info.name).filter(Boolean)

    return {
      provider,
      id: AUTO_MODEL,
      name: names.length > 0 ? `Auto · ${names.join(' / ')}` : 'Auto',
      inputModalities: ['text'],
      ...(windows.length > 0 ? { context: { contextWindow: Math.min(...windows) } } : {}),
      ...(caps.length > 0 ? { defaultMaxTokens: Math.min(...caps) } : {}),
    }
  }

  isComplex(taskText) {
    return taskText.length > this.policy.lengthThreshold || COMPLEX_KEYWORDS.test(taskText)
  }

  route(complex) {
    const { weakProvider, weakModel, strongProvider, strongModel } = this.config
    if (complex && strongProvider && strongModel) return { provider: strongProvider, model: strongModel }
    return { provider: weakProvider, model: weakModel }
  }

  async *forward(options, meta) {
    let answer = ''
    let failed = false
    try {
      for await (const chunk of this.ctx.llm.stream(options)) {
        if (chunk.type === 'text-delta') answer += chunk.text
        if (chunk.type === 'finish' && !['stop', 'max-tokens', 'tool-calls'].includes(chunk.reason.kind)) failed = true
        yield chunk
      }
    } finally {
      this.observe({ ...meta, failed }, answer)
    }
  }

  /** Local bookkeeping only: no model call unless iteration is enabled. */
  observe(meta, answer) {
    this.requestCount += 1
    const { iterationEnabled, iterationProvider, iterationModel, iterationEvery, iterationSampleChars } = this.config
    if (!iterationEnabled || this.iterationBusy || !iterationProvider || !iterationModel) return
    if (iterationProvider === ROUTE || iterationModel === AUTO_MODEL) return
    if (this.requestCount % iterationEvery !== 0) return
    void this.iterate(meta, answer, iterationProvider, iterationModel, iterationSampleChars)
  }

  async iterate(meta, answer, provider, model, sampleChars) {
    this.iterationBusy = true
    try {
      const prompt = `Return JSON only: {"lengthThreshold": integer} between 500 and 2500. Raise it when short prompts should stay on the weak route; lower it when long prompts need the strong route. Judge from this one bounded sample only.\n\nTask length: ${meta.taskLength}\nComplex judged: ${meta.complex}\nRouted provider/model: ${meta.routed}\nStream failed: ${meta.failed}\nAnswer sample:\n${answer.slice(0, sampleChars)}`
      let evaluation = ''
      for await (const chunk of this.ctx.llm.stream({
        provider,
        model,
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
        this.ctx.logger.info(`Smart router self-iteration set lengthThreshold=${candidate.lengthThreshold}`)
      }
    } catch (error) {
      this.ctx.logger.debug?.('Smart router self-iteration skipped', error)
    } finally {
      this.iterationBusy = false
    }
  }

  async *stream(options) {
    const { weakProvider, weakModel, strongProvider, strongModel, reviewMode, draftMaxChars } = this.config
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
    const complex = this.isComplex(taskText)
    // Effort is deliberately cleared: each route then applies its own adapter
    // default instead of inheriting the other route's thinking budget.
    const base = { ...options, reasoningEffort: undefined }
    const target = this.route(complex)
    const routed = `${target.provider}/${target.model}`
    const meta = { taskLength: taskText.length, complex, routed }

    if (reviewMode !== 'on' || !complex || !strongProvider || !strongModel) {
      yield* this.forward({ ...base, provider: target.provider, model: target.model }, meta)
      return
    }

    const draftOptions = {
      ...base,
      provider: weakProvider,
      model: weakModel,
      tools: undefined,
      toolHistory: undefined,
      maxTokens: Math.min(base.maxTokens ?? 2048, 2048),
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
      ? `\n\nA draft from a smaller model follows. Treat it as fallible working material: verify it against the conversation and tools, correct errors, and answer directly.\n\n--- DRAFT ---\n${draft}\n--- END DRAFT ---`
      : '\n\nAnswer directly. The preliminary draft was unavailable.'
    const reviewMessage = createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: reviewText }] })
    yield* this.forward({
      ...base,
      provider: strongProvider,
      model: strongModel,
      messages: [...options.messages, reviewMessage],
    }, meta)
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = Config(rawConfig)
  const adapter = new SmartRouterAdapter(ctx, config)
  ctx.llm.registerAdapter([ROUTE], adapter)
  ctx.logger.info('Smart model router registered provider smart-model-router (model: auto)')
}
