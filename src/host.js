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
 * Besides that projection, `apply` serves one same-origin GET answering what is
 * left in the wallet that pays for those tokens (see {@link DEFAULT_BALANCE}).
 * The browser half holds no credential and calls no third party: it reads the
 * numbers off that route.
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

/**
 * Defaults for the account-balance probe.
 *
 * The wallet that pays for these tokens is the DeepSeek open-platform account,
 * and this harness already knows it two ways. They are tried in this order:
 *
 * 1. `ctx.deepseekAccount` — the signed-in DeepSeek Platform account, whose
 *    `getBalance()` returns the recharge and bonus wallets. It is the same
 *    number the account settings surface shows, and it needs no credential
 *    handling here.
 * 2. `GET {baseUrl}{path}` — the open-platform REST endpoint the inference API
 *    key unlocks, resolved per request from `ctx.credentials` under
 *    `apiKeyEnv`. This is the path that works with a plain API key and no
 *    browser authorization.
 *
 * Either way the browser only ever receives numbers: no token, no key.
 */
export const DEFAULT_BALANCE = {
  enabled: true,
  route: '/token-billing/balance',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseUrl: 'https://api.deepseek.com',
  path: '/user/balance',
  /** How long one success — and one failure — is reused before asking again. */
  refreshMs: 60000,
  failureMs: 15000,
  timeoutMs: 10000,
}

/* ────────────────────────────── config ────────────────────────────── */

/** A finite, non-negative number, or the fallback. */
function amount(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Plain-object check that tolerates null and arrays. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A finite money amount from a JSON number or numeric string, or null. */
function money(value) {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

/** A positive duration in whole milliseconds, or the fallback. */
function duration(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** A non-empty trimmed string, or the fallback. */
function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** A path that starts with exactly one leading slash. */
function rooted(value) {
  return value.startsWith('/') ? value : `/${value}`
}

/**
 * Merge one instance's balance options over the defaults. A credential name
 * outside the reference grammar falls back to the default rather than being
 * passed on: it could never resolve, and silently probing the wrong wallet is
 * worse than probing the documented one.
 * @param raw - the row's `balance` block, or undefined.
 * @returns the resolved balance options of this instance.
 */
export function normalizeBalance(raw) {
  const source = isRecord(raw) ? raw : {}
  const env = text(source.apiKeyEnv, DEFAULT_BALANCE.apiKeyEnv)
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_BALANCE.enabled,
    route: rooted(text(source.route, DEFAULT_BALANCE.route)),
    apiKeyEnv: /^[A-Za-z_][A-Za-z0-9_]*$/.test(env) ? env : DEFAULT_BALANCE.apiKeyEnv,
    baseUrl: text(source.baseUrl, DEFAULT_BALANCE.baseUrl).replace(/\/+$/, ''),
    path: rooted(text(source.path, DEFAULT_BALANCE.path)),
    refreshMs: duration(source.refreshMs, DEFAULT_BALANCE.refreshMs),
    failureMs: duration(source.failureMs, DEFAULT_BALANCE.failureMs),
    timeoutMs: duration(source.timeoutMs, DEFAULT_BALANCE.timeoutMs),
  }
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

  return { prices, aliases, balance: normalizeBalance(raw.balance) }
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

/* ────────────────────────────── balance ────────────────────────────── */

/** One wallet row, keyed by currency; a null field is "the source omits it". */
function walletOf(currency, total, toppedUp, granted) {
  return { currency: currency === 'USD' ? 'USD' : 'CNY', total, toppedUp, granted }
}

/**
 * Signed-in Platform wallets: the recharge rows in `value` and the bonus rows
 * in `bonusWallets`, summed per currency. The Platform query reports the two
 * separately and never their total, so it is added here.
 * @param detail - a `ready` account balance outcome.
 * @returns one row per reported currency.
 */
export function walletsOfPlatform(detail) {
  const table = new Map()
  const merge = (rows, field) => {
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (!isRecord(row)) continue
      const value = money(row.balance)
      if (value === null) continue
      const currency = row.currency === 'USD' ? 'USD' : 'CNY'
      const current = table.get(currency) ?? { currency, toppedUp: null, granted: null }
      current[field] = (current[field] ?? 0) + value
      table.set(currency, current)
    }
  }
  merge(detail === undefined || detail === null ? undefined : detail.value, 'toppedUp')
  merge(detail === undefined || detail === null ? undefined : detail.bonusWallets, 'granted')
  return [...table.values()].map(row => ({
    ...row,
    total: (row.toppedUp ?? 0) + (row.granted ?? 0),
  }))
}

/**
 * Open-platform `GET /user/balance` wallets. A row whose total is not a number
 * is dropped: the panel must never show a parse failure as a zero balance.
 * @param body - the decoded response body.
 * @returns one row per reported currency.
 */
export function walletsOfRest(body) {
  const rows = isRecord(body) && Array.isArray(body.balance_infos) ? body.balance_infos : []
  const wallets = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const total = money(row.total_balance)
    if (total === null) continue
    wallets.push(walletOf(row.currency, total, money(row.topped_up_balance), money(row.granted_balance)))
  }
  return wallets
}

/**
 * One instance's balance probe, memoized so several badges — or two open tabs —
 * cost one upstream request per `refreshMs`, and one failure per `failureMs`
 * rather than one per click.
 *
 * The resolver is read from the context per request, never captured at apply
 * time, so a key rotated in settings reaches the next probe without a restart.
 * @param ctx - the plugin context (any service it needs is looked up optionally).
 * @param balance - this instance's resolved balance options.
 * @returns `read(force)` -> the payload the route serves.
 */
export function createBalanceReader(ctx, balance) {
  let cache = null
  let inflight = null

  /** The signed-in Platform account, or null when this path has nothing to say. */
  async function fromPlatform() {
    const account = ctx.get('deepseekAccount')
    if (account === undefined || account === null) return null
    const state = await account.getState()
    if (state === undefined || state === null || state.status !== 'credential-stored') return null
    const detail = await account.getBalance()
    if (detail === undefined || detail === null || detail.status !== 'ready') return null
    const wallets = walletsOfPlatform(detail)
    return wallets.length === 0 ? null : { ok: true, source: 'platform', available: true, wallets }
  }

  /** The open-platform REST probe, authorized with the inference API key. */
  async function fromRest() {
    const credentials = ctx.get('credentials')
    if (credentials === undefined || credentials === null) return { ok: false, reason: 'no-credential' }
    const hit = await credentials.resolve(balance.apiKeyEnv)
    if (hit === undefined || hit === null || typeof hit.value !== 'string' || hit.value === '') {
      return { ok: false, reason: 'no-credential' }
    }
    let response
    try {
      response = await fetch(`${balance.baseUrl}${balance.path}`, {
        headers: { authorization: `Bearer ${hit.value}`, accept: 'application/json' },
        signal: AbortSignal.timeout(balance.timeoutMs),
      })
    } catch (error) {
      const timedOut = error !== null && typeof error === 'object' && error.name === 'TimeoutError'
      return { ok: false, reason: timedOut ? 'timeout' : 'network' }
    }
    if (!response.ok) return { ok: false, reason: 'http', status: response.status }
    let body
    try {
      body = await response.json()
    } catch {
      return { ok: false, reason: 'protocol' }
    }
    const wallets = walletsOfRest(body)
    if (wallets.length === 0) return { ok: false, reason: 'protocol' }
    return {
      ok: true,
      source: 'api-key',
      available: !(isRecord(body) && body.is_available === false),
      wallets,
    }
  }

  /** Try the signed-in account first; a signed-out or failing one falls through. */
  async function probe() {
    try {
      const platform = await fromPlatform()
      if (platform !== null) return platform
    } catch {
      // A stored grant that could not be read is exactly when the API-key path
      // is worth trying, so this is a fall-through, not a failure.
    }
    try {
      return await fromRest()
    } catch {
      return { ok: false, reason: 'network' }
    }
  }

  return function read(force) {
    if (!force && cache !== null && Date.now() - cache.at < cache.ttl) {
      return Promise.resolve({ ...cache.payload, cached: true })
    }
    if (inflight !== null) return inflight
    const started = (async () => {
      const payload = { ...await probe(), fetchedAt: Date.now(), refreshMs: balance.refreshMs }
      cache = { at: payload.fetchedAt, ttl: payload.ok ? balance.refreshMs : balance.failureMs, payload }
      return payload
    })()
    inflight = started
    started.then(() => {
      if (inflight === started) inflight = null
    })
    return started
  }
}

/**
 * Serve the balance over one same-origin GET. The browser half holds no
 * credential, so this route is the whole cross-process surface: numbers out,
 * nothing in. It is the same idiom the shipped plugins use
 * (`ctx.webServer.register`), and it is registered through `ctx.inject` so a
 * profile with no web server — a terminal or ACP surface — still loads this
 * plugin for its projection.
 * @param ctx - the plugin context.
 * @param balance - this instance's resolved balance options.
 */
export function serveBalance(ctx, balance) {
  const read = createBalanceReader(ctx, balance)
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: balance.route,
      handler: async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        const query = new URL(request.url === undefined ? '/' : request.url, 'http://localhost').searchParams
        // A disabled probe still answers, because that answer is what tells the
        // browser half to drop its badge rather than show a figure that will
        // never arrive.
        const payload = balance.enabled
          ? await read(query.get('refresh') === '1')
          : { ok: false, reason: 'disabled', fetchedAt: Date.now(), refreshMs: balance.refreshMs }
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(payload))
      },
    }), 'token-billing: balance route')
  })
}

/* ────────────────────────────── the plugin ────────────────────────────── */

/**
 * Register the `tokenBilling` projection unit, and the balance route the
 * browser badge reads. Both registrations are effects on this plugin's fiber,
 * so unloading removes the key and the route.
 * @param ctx - registrant context carrying the projection registry.
 * @param config - the row's config block (prices, aliases, balance), or undefined.
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
  serveBalance(ctx, resolved.balance)
}
