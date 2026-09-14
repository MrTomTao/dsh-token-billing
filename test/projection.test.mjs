/**
 * dsh-token-billing — self-contained tests (`node --test test/`).
 *
 * Two halves, matching the two artifacts:
 *
 *  * the Host projection unit is exercised directly through the registered
 *    definition (init / apply / wire.view), which is exactly how the
 *    session-projection drive calls it;
 *  * the browser bundle is loaded the way the client module table loads it —
 *    a classic script calling `window.__ModuleLoader__.load({ id, factory })` —
 *    and its one registration plus its render output are asserted.
 *
 * No browser, no harness checkout, no network: `zod` is the only dependency.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/** Peak window start: Monday 2026-01-05, 02:00 UTC. */
const PEAK = Date.UTC(2026, 0, 5, 2, 0, 0)
/** Off-peak: the same Monday, 12:00 UTC. */
const OFF_PEAK = Date.UTC(2026, 0, 5, 12, 0, 0)

const FLASH = { provider: 'deepseek', model: 'deepseek-flash' }

/** Register the unit against a stub registry and hand back the definition. */
function register(config) {
  const registered = []
  apply({ sessionProjections: { register: definition => registered.push(definition) } }, config)
  assert.equal(registered.length, 1)
  return registered[0]
}

/** One settled assistant message carrying provider usage. */
function message(usage, { turn = 1, step = 1, time = OFF_PEAK, route = FLASH } = {}) {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: {
      turn,
      step,
      usage,
      message: { role: 'assistant', source: { kind: 'model', ...route } },
    },
  }
}

/** One in-flight attempt: no message, usage only inside the embedded stream. */
function attempt(usage, { turn = 1, step = 1, time = OFF_PEAK } = {}) {
  return {
    type: 'assistant/attempt',
    seq: 1,
    time,
    data: { turn, step, stream: [{ type: 'chunk', time, chunk: { type: 'usage', usage } }] },
  }
}

/** Fold a list of events and read the wire value (through its schema, as the drive does). */
function fold(unit, events, seed) {
  const state = events.reduce((current, event) => unit.apply(current, event), seed ?? unit.init({}, 0))
  return { state, value: unit.wire.viewSchema.parse(unit.wire.view(state)) }
}

test('host half declares its plugin identity', () => {
  assert.equal(name, 'token-billing')
  assert.deepEqual(inject, ['sessionProjections'])
})

test('an empty session prices to zero', () => {
  const { value } = fold(register(), [])
  assert.equal(value.calls, 0)
  assert.equal(value.turns, 0)
  assert.equal(value.tokens.total, 0)
  assert.deepEqual(value.cost, { CNY: 0, USD: 0 })
  assert.deepEqual(value.models, [])
  assert.equal(value.updatedAt, null)
  assert.equal(typeof value.peakNow, 'boolean')
})

test('uncached input bills at the peak rate inside a peak window and half of it outside', () => {
  const unit = register()
  const million = { inputTokens: 1000000, outputTokens: 0 }

  const peak = fold(unit, [message(million, { time: PEAK })]).value
  assert.equal(peak.tokens.total, 1000000)
  assert.equal(peak.tokens.input, 1000000)
  assert.equal(peak.cost.CNY, 2)
  assert.equal(peak.cost.USD, 0.3)

  const off = fold(unit, [message(million, { time: OFF_PEAK })]).value
  assert.equal(off.cost.CNY, 1)
  assert.equal(off.cost.USD, 0.15)
})

test('cache hits, cache writes and output each bill on their own rate', () => {
  const unit = register()
  const { value } = fold(unit, [message({
    inputTokens: 1000000,
    cacheReadTokens: 1000000,
    cacheWriteTokens: 1000000,
    outputTokens: 1000000,
    reasoningTokens: 250000,
  }, { time: PEAK })])
  // miss(2) + hit(0.04) + write-as-miss(2) + output(8), all at peak, in CNY.
  assert.equal(value.cost.CNY, 12.04)
  assert.equal(value.tokens.total, 4000000)
  // Reasoning is a slice of output, never an extra bucket.
  assert.equal(value.tokens.reasoning, 250000)
  assert.equal(value.tokens.output, 1000000)
})

test('a retried attempt replaces its own turn/step sample instead of adding to it', () => {
  const unit = register()
  const { value } = fold(unit, [
    attempt({ inputTokens: 1000, outputTokens: 10 }, { turn: 3, step: 2 }),
    attempt({ inputTokens: 2000, outputTokens: 20 }, { turn: 3, step: 2 }),
  ])
  assert.equal(value.tokens.input, 2000)
  assert.equal(value.tokens.output, 20)
  assert.equal(value.calls, 1)
})

test('llm/retry-started closes the replacement slot for the same step', () => {
  const unit = register()
  const { value } = fold(unit, [
    attempt({ inputTokens: 1000, outputTokens: 0 }, { turn: 1, step: 1 }),
    { type: 'llm/retry-started', seq: 2, time: OFF_PEAK, data: { turn: 1, step: 1 } },
    attempt({ inputTokens: 500, outputTokens: 0 }, { turn: 1, step: 1 }),
  ])
  assert.equal(value.tokens.input, 500)
  assert.equal(value.calls, 1)
})

test('an attempt without a message bills under the newest request header route', () => {
  const unit = register()
  const { value } = fold(unit, [
    {
      type: 'request/header',
      seq: 1,
      time: PEAK,
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, reason: 'initial' },
    },
    attempt({ inputTokens: 0, outputTokens: 1000000 }, { time: PEAK }),
  ])
  assert.equal(value.models.length, 1)
  assert.equal(value.models[0].model, 'deepseek-v4-pro')
  // Pro output is 27 CNY per 1M at peak.
  assert.equal(value.cost.CNY, 27)
})

test('turn/start is the only turn counter', () => {
  const unit = register()
  const { value } = fold(unit, [
    { type: 'turn/start', seq: 1, time: OFF_PEAK, data: { turn: 1 } },
    { type: 'turn/start', seq: 2, time: OFF_PEAK, data: { turn: 2 } },
    message({ inputTokens: 10, outputTokens: 1 }),
  ])
  assert.equal(value.turns, 2)
  assert.equal(value.calls, 1)
})

test('aliased model names are billed as their canonical row', () => {
  const unit = register()
  const { value } = fold(unit, [
    message({ inputTokens: 1000000, outputTokens: 0 }, { time: OFF_PEAK, route: { provider: 'deepseek', model: 'deepseek-chat' } }),
  ])
  assert.equal(value.models[0].canonical, 'deepseek-flash')
  assert.equal(value.models[0].estimated, false)
  assert.equal(value.cost.CNY, 1)
})

test('an unknown model is priced as Flash and flagged as an estimate', () => {
  const unit = register()
  const { value } = fold(unit, [
    message({ inputTokens: 1000000, outputTokens: 0 }, { time: OFF_PEAK, route: { provider: 'gateway', model: 'future-model' } }),
  ])
  assert.equal(value.models[0].model, 'future-model')
  assert.equal(value.models[0].estimated, true)
  assert.equal(value.cost.CNY, 1)
})

test('models are reported separately and sorted by spend', () => {
  const unit = register()
  const { value } = fold(unit, [
    message({ inputTokens: 1000, outputTokens: 0 }, { turn: 1, step: 1, time: PEAK, route: { provider: 'deepseek', model: 'deepseek-flash' } }),
    message({ inputTokens: 1000000, outputTokens: 0 }, { turn: 2, step: 1, time: PEAK, route: { provider: 'deepseek', model: 'deepseek-v4-pro' } }),
  ])
  assert.equal(value.models.length, 2)
  assert.equal(value.models[0].model, 'deepseek-v4-pro')
  assert.equal(value.cost.CNY, 9 + 0.002)
})

test('composition config overrides prices and keeps the untouched rates', () => {
  const unit = register({ prices: { CNY: { 'deepseek-flash': { output: 100 } } } })
  const { value } = fold(unit, [message({ inputTokens: 1000000, outputTokens: 1000000 }, { time: PEAK })])
  assert.equal(value.cost.CNY, 2 + 100)
  assert.equal(value.rates.CNY[0].output, 100)
  assert.equal(value.rates.CNY[0].miss, 2)
})

test('config can alias a custom route onto an official row', () => {
  const unit = register({ aliases: { 'my-gateway-model': 'deepseek-v4-pro' } })
  const { value } = fold(unit, [
    message({ inputTokens: 0, outputTokens: 1000000 }, { time: PEAK, route: { provider: 'gateway', model: 'my-gateway-model' } }),
  ])
  assert.equal(value.models[0].canonical, 'deepseek-v4-pro')
  assert.equal(value.models[0].estimated, false)
  assert.equal(value.cost.CNY, 27)
})

test('an event the unit does not bill returns the same state reference', () => {
  const unit = register()
  const state = unit.init({}, 0)
  assert.equal(unit.apply(state, { type: 'tool/call', seq: 1, time: PEAK, data: {} }), state)
  assert.equal(unit.apply(state, message({ inputTokens: 0, outputTokens: 0 })), state)
})

/* ───────────────────────── the browser bundle ───────────────────────── */

/** Minimal React/ReactDOM surface: enough to run the component as a pure function. */
function reactStub(openInitial) {
  let useStateCalls = 0
  return {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: () => {},
    useState: initial => {
      // The component's first useState is the panel's `open` flag.
      const value = useStateCalls === 0
        ? openInitial
        : (typeof initial === 'function' ? initial() : initial)
      useStateCalls += 1
      return [value, () => {}]
    },
  }
}

/** Every text node in a stub element tree, in order. */
function textsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (node.portal !== undefined) return textsOf(node.portal, out)
  if (node.children !== undefined) return textsOf(node.children, out)
  return out
}

/** Load the built bundle exactly as the client module table does. */
async function loadBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let row
  const windowStub = { __ModuleLoader__: { load: value => { row = value } } }
  // Classic script, not a module: evaluate it with the one global it touches.
  // eslint-disable-next-line no-new-func
  new Function('window', source)(windowStub)
  assert.ok(row !== undefined, 'the bundle must call window.__ModuleLoader__.load')
  return row
}

/** A realistic wire value for render assertions. */
const VIEW = {
  calls: 3,
  turns: 2,
  tokens: { input: 1000, cacheRead: 10000, cacheWrite: 0, output: 2400, reasoning: 500, total: 13400 },
  cost: { CNY: 0.0132, USD: 0.00184 },
  models: [{
    key: 'deepseek|deepseek-flash',
    provider: 'deepseek',
    model: 'deepseek-flash',
    canonical: 'deepseek-flash',
    estimated: false,
    calls: 3,
    tokens: { input: 1000, cacheRead: 10000, cacheWrite: 0, output: 2400, reasoning: 500, total: 13400 },
    cost: { CNY: 0.0132, USD: 0.00184 },
  }],
  rates: {
    CNY: [{ model: 'deepseek-flash', hit: 0.04, miss: 2, output: 8 }],
    USD: [{ model: 'deepseek-flash', hit: 0.006, miss: 0.3, output: 1.2 }],
  },
  peakNow: true,
  updatedAt: Date.UTC(2026, 0, 5, 2, 0, 0),
}

test('the bundle registers one header entry under the package id', async () => {
  const row = await loadBundle()
  assert.equal(row.id, 'dsh-token-billing')
  assert.equal(typeof row.factory, 'function')

  const registration = []
  const effects = []
  const documentStub = {
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    body: {},
  }
  const captured = globalThis.document
  globalThis.document = documentStub
  try {
    const exported = row.factory(requireStub(reactStub(false)))
    assert.deepEqual(exported.inject, ['slots'])
    assert.equal(typeof exported.apply, 'function')

    exported.apply({
      effect: (callback, label) => { effects.push(label); return callback() },
      slots: {
        inject: (slot, callback) => { callback() },
        register: (options, Component) => { registration.push({ options, Component }); return () => {} },
      },
    })
  } finally {
    globalThis.document = captured
  }

  assert.equal(registration.length, 1)
  assert.deepEqual(registration[0].options, {
    name: 'conversation.session.header.utilities',
    id: 'token-billing',
    order: -5,
    label: 'Token 计费',
  })
  assert.deepEqual(effects, ['dsh-token-billing: stylesheet'])
})

/** `require` for the bundle factory: the two baseline modules it asks for. */
function requireStub(react) {
  return specifier => {
    if (specifier === 'react') return react
    if (specifier === 'react-dom') return { createPortal: (element, container) => ({ portal: element, container }) }
    throw new Error(`the bundle must not require "${specifier}"`)
  }
}

test('the closed badge shows the formatted cost and token count', async () => {
  const row = await loadBundle()
  const text = renderBadge(row, reactStub(false), VIEW)
  assert.match(text, /¥0\.0132/)
  assert.match(text, /13\.4k/)
})

test('the open panel renders the breakdown, models and the billed rate table', async () => {
  const row = await loadBundle()
  const text = renderBadge(row, reactStub(true), VIEW)
  assert.match(text, /本会话 Token 计费/)
  assert.match(text, /高峰计价/)
  assert.match(text, /输入 · 缓存命中/)
  assert.match(text, /按模型/)
  assert.match(text, /deepseek-flash/)
  assert.match(text, /命中 ¥0\.04 · 未命中 ¥2 · 输出 ¥8/)
})

test('an absent projection renders a muted badge instead of throwing', async () => {
  const row = await loadBundle()
  const text = renderBadge(row, reactStub(false), undefined)
  assert.match(text, /¥--/)
})

/**
 * Apply the bundle against a throwaway ctx, render its registered component
 * with the given projection value, and return the element tree it produced.
 * The document stub stays installed for the whole render because the panel
 * portals onto `document.body`.
 */
function renderTree(row, react, value) {
  let Component
  const documentStub = {
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
    body: {},
  }
  const previous = globalThis.document
  globalThis.document = documentStub
  try {
    row.factory(requireStub(react)).apply({
      effect: callback => { callback() },
      slots: {
        inject: (slot, callback) => { callback() },
        register: (options, Registered) => { Component = Registered; return () => {} },
      },
    })
    return Component({ useProjection: key => (key === 'tokenBilling' ? value : undefined) })
  } finally {
    globalThis.document = previous
  }
}

/** Every text node of one rendered tree, joined for substring assertions. */
function renderBadge(row, react, value) {
  return textsOf(renderTree(row, react, value)).join(' | ')
}

/** Every element of one tag in the stub tree, in order. */
function nodesOf(node, tag, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) nodesOf(child, tag, out)
    return out
  }
  if (node.portal !== undefined) return nodesOf(node.portal, tag, out)
  if (node.type === tag) out.push(node)
  if (node.children !== undefined) nodesOf(node.children, tag, out)
  return out
}

test('every priced model gets its own rate line', async () => {
  const row = await loadBundle()
  const view = {
    ...VIEW,
    rates: {
      ...VIEW.rates,
      CNY: [
        { model: 'deepseek-flash', hit: 0.04, miss: 2, output: 8 },
        { model: 'deepseek-v4-pro', hit: 0.3, miss: 9, output: 27 },
      ],
    },
  }
  const tree = renderTree(row, reactStub(true), view)

  // One value node per priced model, not one sentence carrying them all.
  const lines = nodesOf(tree, 'dd')
    .map(node => textsOf(node).join(''))
    .filter(text => text.startsWith('命中 '))
  assert.equal(lines.length, 2)
  assert.equal(lines[0], '命中 ¥0.04 · 未命中 ¥2 · 输出 ¥8')
  assert.equal(lines[1], '命中 ¥0.3 · 未命中 ¥9 · 输出 ¥27')

  // Each line's term is its own model id.
  const terms = nodesOf(tree, 'dt').map(node => textsOf(node).join(''))
  assert.deepEqual(terms.slice(-2), ['deepseek-flash', 'deepseek-v4-pro'])
})
