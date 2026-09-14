/**
 * dsh-token-billing — Host half.
 *
 * Registers the `tokenBilling` session projection on `ctx.sessionProjections`:
 * a pure fold that turns every provider-reported token sample in a session log
 * into peak/off-peak token buckets, per model route, and a wire view that
 * prices those buckets under the configured tables.
 *
 * Two deliberate design points:
 *
 * 1. **The fold state is price-independent.** It stores only tokens and the
 *    peak/off-peak split, never money. The rates enter through `wire.view`,
 *    which is recomputed from the current config, so editing a price never
 *    invalidates a persisted projection-cache row (the cache stores state, not
 *    views). `stateVersion` therefore only has to move when the fold itself
 *    changes.
 * 2. **The split is exact, not an average.** Peak hours are decided per
 *    sample, from that event's own timestamp, so a session spanning a peak
 *    boundary bills each request at its real rate.
 *
 * The unit mirrors the shipped `tokenUsage` unit's sampling rule (a retried
 * attempt replaces its own turn/step sample instead of adding to it), so the
 * tokens this plugin prices agree with the usage the Web UI already reports.
 *
 * @module dsh-token-billing
 */

import { z } from 'zod'

/** Cordis plugin name. */
export const name = 'token-billing'

/** The projection registry is the plugin's whole host purpose. */
export const inject = ['sessionProjections']

/**
 * Official peak-hour prices per 1M tokens, keyed by currency.
 *
 * Source: https://api-docs.deepseek.com/quick_start/pricing (USD) and
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing (CNY). Off-peak is
 * exactly half the peak rate, so only the peak row is stored.
 */
export const DEFAULT_PRICES = {
  CNY: {
    'deepseek-flash': { hit: 0.04, miss: 2, output: 8 },
    'deepseek-v4-pro': { hit: 0.3, miss: 9, output: 27 },
  },
  USD: {
    'deepseek-flash': { hit: 0.006, miss: 0.3, output: 1.2 },
    'deepseek-v4-pro': { hit: 0.044, miss: 1.32, output: 3.96 },
  },
}

/**
 * Retired or aliased model names, billed at another row's price. The official
 * pages state that `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are
 * still accepted but served by Flash at Flash prices; the older public names
 * are mapped the same way so historical logs stay priced.
 */
export const DEFAULT_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v3.2': 'deepseek-flash',
  'deepseek-v3.2-exp': 'deepseek-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
}

/** Model billed when a route matches no price row. */
const FALLBACK_MODEL = 'deepseek-flash'

/** Currencies priced and reported. */
const CURRENCIES = ['CNY', 'USD']

/**
 * Peak windows as UTC hours [from, to). The Chinese pricing page states them
 * in Beijing time — Monday to Friday 09:00-12:00 and 14:00-18:00 — which is
 * exactly these two windows in UTC.
 */
const PEAK_WINDOWS_UTC = [[1, 4], [6, 10]]

/** Off-peak multiplier: the official pages state off-peak is half of peak. */
const OFF_PEAK = 0.5

const PER_MILLION = 1000000

/* ────────────────────────────── config ────────────────────────────── */

/** A finite, non-negative number, or the fallback. */
function amount(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Plain-object check that tolerates null and arrays. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Merge caller config over the official defaults.
 * @param config - the row's `config` block, or undefined.
 * @returns the price tables and alias map this plugin instance prices with.
 */
function normalizeConfig(config) {
  const raw = isRecord(config) ? config : {}
  const overrides = isRecord(raw.prices) ? raw.prices : {}

  const prices = {}
  for (const currency of CURRENCIES) {
    const table = { ...DEFAULT_PRICES[currency] }
    const override = overrides[currency]
    if (isRecord(override)) {
      for (const model of Object.keys(override)) {
        const row = override[model]
        if (!isRecord(row)) continue
        const base = table[model]
        table[model] = {
          hit: amount(row.hit, base === undefined ? 0 : base.hit),
          miss: amount(row.miss, base === undefined ? 0 : base.miss),
          output: amount(row.output, base === undefined ? 0 : base.output),
        }
      }
    }
    prices[currency] = table
  }

  const aliases = { ...DEFAULT_ALIASES }
  if (isRecord(raw.aliases)) {
    for (const alias of Object.keys(raw.aliases)) {
      const target = raw.aliases[alias]
      if (typeof target === 'string') aliases[alias.trim().toLowerCase()] = target.trim().toLowerCase()
    }
  }

  return { prices, aliases }
}

/* ────────────────────────────── pricing ────────────────────────────── */

/**
 * Canonical price row for a model name.
 * @param model - the raw model id from the route.
 * @param aliases - alias map of this instance.
 * @returns the canonical key (may be unknown to the tables).
 */
function canonicalModel(model, aliases) {
  const key = String(model === undefined || model === null ? '' : model).trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key
}

/** Whether a timestamp falls in a peak window (UTC, Monday to Friday). */
function isPeak(timeMs) {
  const time = Number(timeMs)
  if (!Number.isFinite(time) || time <= 0) return false
  // 1970-01-01 was a Thursday, so (days + 4) % 7 gives Sunday = 0.
  const days = Math.floor(time / 86400000)
  const weekday = (((days + 4) % 7) + 7) % 7
  if (weekday === 0 || weekday === 6) return false
  const hour = Math.floor((time % 86400000) / 3600000)
  for (const window of PEAK_WINDOWS_UTC) {
    if (hour >= window[0] && hour < window[1]) return true
  }
  return false
}

/** The price row a model bills under, plus whether it is an estimate. */
function ratesFor(model, config) {
  const key = canonicalModel(model, config.aliases)
  const table = config.prices.CNY
  const known = Object.prototype.hasOwnProperty.call(table, key)
  return {
    canonical: key,
    estimated: !known,
    rates: config.prices.CNY[known ? key : FALLBACK_MODEL],
  }
}

/* ────────────────────────────── the fold ────────────────────────────── */

const bucketSchema = z.object({
  peak: z.number().int().nonnegative(),
  off: z.number().int().nonnegative(),
}).strict()

const modelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  canonical: z.string(),
  calls: z.number().int().nonnegative(),
  input: bucketSchema,
  cacheRead: bucketSchema,
  cacheWrite: bucketSchema,
  output: bucketSchema,
  reasoning: z.number().int().nonnegative(),
}).strict()

/** One priced sample: its route, its peak/off split, and its own tokens. */
const sampleSchema = z.object({
  key: z.string(),
  provider: z.string(),
  model: z.string(),
  canonical: z.string(),
  input: bucketSchema,
  cacheRead: bucketSchema,
  cacheWrite: bucketSchema,
  output: bucketSchema,
  reasoning: z.number().int().nonnegative(),
}).strict()

const stateSchema = z.object({
  turns: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  lastTime: z.number().nonnegative().nullable(),
  route: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
  models: z.record(z.string(), modelSchema),
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    sample: sampleSchema,
  }).strict().nullable(),
}).strict()

/** A zeroed peak/off token bucket. */
function emptyBucket() {
  return { peak: 0, off: 0 }
}

/** A model's zeroed row. */
function emptyModel(provider, model, canonical) {
  return {
    provider,
    model,
    canonical,
    calls: 0,
    input: emptyBucket(),
    cacheRead: emptyBucket(),
    cacheWrite: emptyBucket(),
    output: emptyBucket(),
    reasoning: 0,
  }
}

/** The empty-log state. */
function emptyState() {
  return { turns: 0, calls: 0, lastTime: null, route: null, models: {}, last: null }
}

/** One sample's tokens in a single peak or off-peak bucket. */
function bucketOf(count, peak) {
  return peak ? { peak: count, off: 0 } : { peak: 0, off: count }
}

/** Read a non-negative count off a provider usage record. */
function count(usage, field) {
  const value = usage === undefined || usage === null ? undefined : usage[field]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The usage sample carried by one event: the settled message's own usage, or
 * the last `usage` chunk embedded in the stream of an in-flight attempt.
 * @param event - a committed session event.
 * @returns the sample, or undefined when the event bills nothing.
 */
function sampleUsage(event) {
  const data = event.data
  if (data === undefined || data === null) return undefined
  if (data.usage !== undefined && data.usage !== null) return data.usage
  const stream = data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === undefined || record === null || record.type !== 'chunk') continue
    const chunk = record.chunk
    if (chunk !== undefined && chunk !== null && chunk.type === 'usage') return chunk.usage
  }
  return undefined
}

/**
 * The route a sample bills under: the settled message's own provenance when it
 * has one, otherwise the route of the newest `request/header`.
 * @param event - a committed session event.
 * @param route - the tracked route for this session, or null.
 * @returns the provider/model pair to price.
 */
function routeOf(event, route) {
  const data = event.data
  const message = data === undefined || data === null ? undefined : data.message
  const source = message === undefined || message === null ? undefined : message.source
  if (source !== undefined && source !== null && typeof source.model === 'string' && source.model !== '') {
    return {
      provider: typeof source.provider === 'string' && source.provider !== ''
        ? source.provider
        : route === null ? 'unknown' : route.provider,
      model: source.model,
    }
  }
  return route === null ? { provider: 'unknown', model: 'unknown' } : route
}

/**
 * Add one sample to a model row, or remove it again (sign -1) when a retried
 * attempt replaces its own sample.
 * @param models - the current per-model rows.
 * @param sample - the sample to add or subtract.
 * @param sign - 1 to add, -1 to remove.
 * @returns the next rows (a new object; the input is never mutated).
 */
function mergeSample(models, sample, sign) {
  const previous = Object.prototype.hasOwnProperty.call(models, sample.key) ? models[sample.key] : undefined
  const base = previous === undefined
    ? emptyModel(sample.provider, sample.model, sample.canonical)
    : previous
  const shift = (bucket, delta) => ({
    peak: bucket.peak + sign * delta.peak,
    off: bucket.off + sign * delta.off,
  })
  return {
    ...models,
    [sample.key]: {
      provider: base.provider,
      model: base.model,
      canonical: base.canonical,
      calls: base.calls + sign,
      input: shift(base.input, sample.input),
      cacheRead: shift(base.cacheRead, sample.cacheRead),
      cacheWrite: shift(base.cacheWrite, sample.cacheWrite),
      output: shift(base.output, sample.output),
      reasoning: base.reasoning + sign * sample.reasoning,
    },
  }
}

/**
 * The pure transition behind {@link apply}'s registered unit. The same
 * reference is returned for every event this unit does not bill, which is what
 * keeps the projection drive cheap.
 * @param state - the fold state covering all prior events.
 * @param event - the next committed session event.
 * @param config - this instance's price tables and aliases.
 * @returns the next state.
 */
function fold(state, event, config) {
  if (event === undefined || event === null) return state
  const time = typeof event.time === 'number' ? event.time : state.lastTime

  if (event.type === 'turn/start') return { ...state, turns: state.turns + 1 }

  if (event.type === 'request/header') {
    const header = event.data === undefined || event.data === null ? undefined : event.data.header
    const call = header === undefined || header === null ? undefined : header.config
    if (call === undefined || call === null) return state
    const provider = typeof call.provider === 'string' && call.provider !== ''
      ? call.provider
      : state.route === null ? 'unknown' : state.route.provider
    const model = typeof call.model === 'string' && call.model !== ''
      ? call.model
      : state.route === null ? 'unknown' : state.route.model
    if (state.route !== null && state.route.provider === provider && state.route.model === model) return state
    return { ...state, route: { provider, model } }
  }

  if (event.type === 'llm/retry-started') {
    const last = state.last
    const data = event.data
    if (last === null || data === undefined || data === null) return state
    if (data.turn !== last.turn || data.step !== last.step) return state
    return {
      ...state,
      calls: Math.max(0, state.calls - 1),
      models: mergeSample(state.models, last.sample, -1),
      last: null,
      lastTime: time,
    }
  }

  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state

  const usage = sampleUsage(event)
  if (usage === undefined) return state
  const input = count(usage, 'inputTokens')
  const cacheRead = count(usage, 'cacheReadTokens')
  const cacheWrite = count(usage, 'cacheWriteTokens')
  const output = count(usage, 'outputTokens')
  if (input + cacheRead + cacheWrite + output === 0) return state

  const data = event.data
  const turn = typeof data.turn === 'number' ? data.turn : 0
  const step = typeof data.step === 'number' ? data.step : 0
  const route = routeOf(event, state.route)
  const price = ratesFor(route.model, config)
  const peak = isPeak(time)
  const sample = {
    key: `${route.provider}|${route.model}`,
    provider: route.provider,
    model: route.model,
    canonical: price.canonical,
    input: bucketOf(input, peak),
    cacheRead: bucketOf(cacheRead, peak),
    cacheWrite: bucketOf(cacheWrite, peak),
    output: bucketOf(output, peak),
    reasoning: count(usage, 'reasoningTokens'),
  }

  let models = state.models
  let calls = state.calls
  const previous = state.last
  if (previous !== null && previous.turn === turn && previous.step === step) {
    models = mergeSample(models, previous.sample, -1)
    calls -= 1
  }
  models = mergeSample(models, sample, 1)
  return { ...state, models, calls: calls + 1, last: { turn, step, sample }, lastTime: time }
}

/* ────────────────────────────── the view ────────────────────────────── */

const tokenTotalsSchema = z.object({
  input: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()

const costSchema = z.object({ CNY: z.number().nonnegative(), USD: z.number().nonnegative() }).strict()

const modelViewSchema = z.object({
  key: z.string(),
  provider: z.string(),
  model: z.string(),
  canonical: z.string(),
  estimated: z.boolean(),
  calls: z.number().int().nonnegative(),
  tokens: tokenTotalsSchema,
  cost: costSchema,
}).strict()

const rateSchema = z.object({
  model: z.string(),
  hit: z.number().nonnegative(),
  miss: z.number().nonnegative(),
  output: z.number().nonnegative(),
}).strict()

const viewSchema = z.object({
  calls: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  tokens: tokenTotalsSchema,
  cost: costSchema,
  models: z.array(modelViewSchema),
  rates: z.object({ CNY: z.array(rateSchema), USD: z.array(rateSchema) }).strict(),
  peakNow: z.boolean(),
  updatedAt: z.number().nonnegative().nullable(),
}).strict()

/** Total tokens in one bucket pair. */
function bucketTotal(bucket) {
  return bucket.peak + bucket.off
}

/**
 * Money for one model row under one currency's rates. Peak hours bill at the
 * table rate, off-peak at half of it; cache writes bill as uncached input
 * (DeepSeek charges no separate cache-write premium).
 */
function costOf(row, currency, config) {
  const rates = config.prices[currency][
    Object.prototype.hasOwnProperty.call(config.prices[currency], row.canonical)
      ? row.canonical
      : FALLBACK_MODEL
  ]
  const charge = (bucket, rate) => (bucket.peak + bucket.off * OFF_PEAK) * rate
  return (
    charge(row.input, rates.miss)
    + charge(row.cacheWrite, rates.miss)
    + charge(row.cacheRead, rates.hit)
    + charge(row.output, rates.output)
  ) / PER_MILLION
}

/**
 * State -> wire value. Runs only when the fold state actually changed, and
 * prices from the current config each time, so a config edit reprices without
 * touching the (price-free) fold state.
 * @param state - the current fold state.
 * @param config - this instance's price tables and aliases.
 * @returns the whole client value for the `tokenBilling` key.
 */
function view(state, config) {
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
  const cost = { CNY: 0, USD: 0 }
  const models = []

  for (const key of Object.keys(state.models)) {
    const row = state.models[key]
    const rowTokens = {
      input: bucketTotal(row.input),
      cacheRead: bucketTotal(row.cacheRead),
      cacheWrite: bucketTotal(row.cacheWrite),
      output: bucketTotal(row.output),
      reasoning: row.reasoning,
      total: 0,
    }
    rowTokens.total = rowTokens.input + rowTokens.cacheRead + rowTokens.cacheWrite + rowTokens.output
    const rowCost = { CNY: costOf(row, 'CNY', config), USD: costOf(row, 'USD', config) }
    cost.CNY += rowCost.CNY
    cost.USD += rowCost.USD
    tokens.input += rowTokens.input
    tokens.cacheRead += rowTokens.cacheRead
    tokens.cacheWrite += rowTokens.cacheWrite
    tokens.output += rowTokens.output
    tokens.reasoning += rowTokens.reasoning
    models.push({
      key,
      provider: row.provider,
      model: row.model,
      canonical: row.canonical,
      estimated: !Object.prototype.hasOwnProperty.call(config.prices.CNY, row.canonical),
      calls: row.calls,
      tokens: rowTokens,
      cost: rowCost,
    })
  }

  tokens.total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
  models.sort((left, right) => right.cost.CNY - left.cost.CNY)

  const rates = {}
  for (const currency of CURRENCIES) {
    rates[currency] = Object.keys(config.prices[currency]).map(model => ({
      model,
      hit: config.prices[currency][model].hit,
      miss: config.prices[currency][model].miss,
      output: config.prices[currency][model].output,
    }))
  }

  return {
    calls: state.calls,
    turns: state.turns,
    tokens,
    cost,
    models,
    rates,
    // A plain wall-clock read: the wire value is a user-facing reference, not a
    // gating input, so the host's own clock is the right source here.
    peakNow: isPeak(Date.now()),
    updatedAt: state.lastTime,
  }
}

/* ────────────────────────────── the plugin ────────────────────────────── */

/**
 * Register the `tokenBilling` projection unit. The registration is an effect on
 * this plugin's fiber, so unloading removes the key.
 * @param ctx - registrant context carrying the projection registry.
 * @param config - the row's config block (prices and aliases), or undefined.
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  ctx.sessionProjections.register({
    key: 'tokenBilling',
    stateVersion: 1,
    stateSchema,
    init: () => emptyState(),
    apply: (state, event) => fold(state, event, resolved),
    wire: {
      viewSchema,
      view: state => view(state, resolved),
    },
  })
}
