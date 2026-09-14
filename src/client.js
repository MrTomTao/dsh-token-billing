/**
 * dsh-token-billing — browser half (the bundle body).
 *
 * One entry: the session-header cost badge. The durable session-wide value
 * arrives through the standard `useProjection('tokenBilling')` seat, pushed by
 * the Host half of this same package — this half computes no billing and holds
 * no session state. The detail panel is a React portal onto `document.body`
 * (the same idiom the shipped stats pills use), so a long panel is never
 * clipped by the header's own box and needs no cross-entry store.
 *
 * Bootstrapped by build.mjs into the `window.__ModuleLoader__.load({...})`
 * closure factory the client module table expects. Only the baseline modules
 * `react` and `react-dom` are required from the shell's module table.
 */

const React = require('react')
const ReactDOM = require('react-dom')

/** Slot entry id; a fresh id is added beside the shipped header utilities. */
const ENTRY_ID = 'token-billing'

/** Panel width and offset, kept in one place for the sheet and the portal. */
const CSS = [
  // The badge copies the header control row the shipped entries beside it use
  // (ui-open-in-app/src/client/OpenInAppAction.module.css): 28px tall, hairline
  // l4 border, 14px pill radius, 11px/400 label in the page font. Hover paints
  // the interactive surface instead of recolouring the border.
  '.dsb-badge{display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;height:28px;padding:5px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:14px;background:none;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:11px;font-weight:400;line-height:16px;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap;transition:background .15s ease}',
  '.dsb-badge:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsb-badge:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsb-badge.is-open{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsb-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:0 0 auto}',
  '.dsb-cost{color:var(--dsw-alias-label-primary)}',
  '.dsb-tok{color:var(--dsw-alias-label-secondary)}',
  // Panel surface: the shipped stat-dialog skin, verbatim in spirit
  // (ui-chat/src/client/chat/stat-dialog.module.css) — menu surface, r12, and
  // prominent elevation whose 0.5px hairline comes from --dsw-elevation-stroke,
  // rebound to l1 here for the softer ring that dialog uses.
  '.dsb-backdrop{position:fixed;inset:0;z-index:39;background:transparent}',
  '.dsb-panel{position:fixed;top:56px;right:24px;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(320px,calc(100vw - 48px));max-width:min(400px,calc(100vw - 48px));max-height:70vh;overflow:auto;padding:16px;border:0;border-radius:12px;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:left;cursor:default}',
  '.dsb-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-weight:500}',
  '.dsb-title{flex:1 1 auto;min-width:0}',
  // The rule under the heading, as stat-dialog's .titleRule: a 0.5px l2 hairline.
  '.dsb-rule{margin:8px 0 10px;border-top:0.5px solid var(--dsw-alias-border-l2)}',
  // Chips copy ui-primitives Tag: fixed capsule geometry, outline tone by
  // default and the warning tone for a peak-priced session.
  '.dsb-peak{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}',
  '.dsb-peak.is-peak{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border-color:transparent;color:var(--dsw-alias-state-warn-primary)}',
  '.dsb-cur{display:inline-flex;align-items:center;border:0.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:none;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:11px;line-height:17px;font-weight:500;padding:1px 8px;cursor:pointer;white-space:nowrap}',
  '.dsb-cur:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '.dsb-close{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;padding:0;cursor:pointer}',
  '.dsb-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsb-hero{display:flex;flex-direction:column;gap:2px;margin:0 0 12px}',
  '.dsb-hero-cost{font-size:20px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
  '.dsb-hero-sub{color:var(--dsw-alias-label-tertiary)}',
  // Breakdown rows: stat-dialog's .details grid (auto label column, right-aligned
  // tabular figures).
  '.dsb-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}',
  '.dsb-details dt,.dsb-details dd{min-width:0;margin:0}',
  '.dsb-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}',
  // Price rows are prose, not figures: keep the shared grid but read left to right.
  '.dsb-rates dd{text-align:left}',
  '.dsb-section{margin:14px 0 2px;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}',
  '.dsb-model{display:flex;align-items:baseline;gap:6px;padding:6px 0}',
  '.dsb-model + .dsb-model{border-top:0.5px solid var(--dsw-alias-border-l2)}',
  '.dsb-model-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
  '.dsb-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}',
  '.dsb-model-cost{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.dsb-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
  '.dsb-note{margin-top:10px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
  '.dsb-fine{color:var(--dsw-alias-label-caption)}',
  '.dsb-empty{color:var(--dsw-alias-label-tertiary)}',
].join('\n')

/** Currency glyph. */
function symbolOf(currency) {
  return currency === 'USD' ? '$' : '\u00a5'
}

/** Compact token count: 942 / 12.4k / 1.25M. */
function fmtTokens(value) {
  const count = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (count <= 0) return '0'
  if (count < 1000) return String(Math.round(count))
  if (count < 1000000) return (count / 1000).toFixed(1) + 'k'
  return (count / 1000000).toFixed(2) + 'M'
}

/** Money with enough precision to stay non-zero on a cheap session. */
function fmtMoney(value, currency) {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0
  const sign = symbolOf(currency)
  if (amount <= 0) return sign + '0'
  if (amount < 0.0001) return '<' + sign + '0.0001'
  if (amount < 1) return sign + amount.toFixed(4)
  return sign + amount.toFixed(2)
}

/** Local wall clock for the newest billed sample. */
function fmtClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '--'
  const date = new Date(ms)
  const pad = value => (value < 10 ? '0' + value : String(value))
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

/**
 * One breakdown row as a `<dt>`/`<dd>` pair, so the panel can lay the figures
 * out on the shipped stat-dialog's grid: labels left in the tertiary color,
 * values right-aligned and tabular.
 */
function detail(label, value, key) {
  return React.createElement(React.Fragment, { key },
    React.createElement('dt', null, label),
    React.createElement('dd', null, value),
  )
}

/**
 * The billed price table as one row per model, so each line carries a single
 * model's three rates instead of one long sentence wrapping across lines.
 * Figures come from the same table the Host billed with, in the currency on
 * screen; the model id is the row's term.
 */
function rateRows(value, currency) {
  const table = Array.isArray(value.rates[currency]) ? value.rates[currency] : []
  const sign = symbolOf(currency)
  return table.map(entry => detail(entry.model,
    '命中 ' + sign + entry.hit
    + ' · 未命中 ' + sign + entry.miss
    + ' · 输出 ' + sign + entry.output,
    entry.model))
}

/** The detail panel, portalled onto the document body. */
function detailPanel(value, currency, onCurrency, onClose) {
  const tokens = value.tokens
  const breakdown = [
    detail('输入 · 未命中缓存', fmtTokens(tokens.input), 'miss'),
    detail('输入 · 缓存命中', fmtTokens(tokens.cacheRead), 'hit'),
  ]
  if (tokens.cacheWrite > 0) breakdown.push(detail('输入 · 缓存写入', fmtTokens(tokens.cacheWrite), 'write'))
  breakdown.push(detail('输出', fmtTokens(tokens.output), 'out'))
  if (tokens.reasoning > 0) breakdown.push(detail('其中推理', fmtTokens(tokens.reasoning), 'reasoning'))

  const modelRows = value.models.map(entry => React.createElement('div', { className: 'dsb-model', key: entry.key },
    React.createElement('span', { className: 'dsb-model-name' }, entry.model),
    entry.estimated ? React.createElement('span', { className: 'dsb-tag' }, '估算') : null,
    React.createElement('span', { className: 'dsb-model-meta' }, fmtTokens(entry.tokens.total) + ' · ' + entry.calls + ' 次'),
    React.createElement('span', { className: 'dsb-model-cost' }, fmtMoney(entry.cost[currency], currency)),
  ))

  return ReactDOM.createPortal(
    React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'dsb-backdrop', onClick: onClose }),
      React.createElement('div', { className: 'dsb-panel', role: 'dialog', 'aria-label': '本会话 Token 计费' },
        React.createElement('div', { className: 'dsb-head' },
          React.createElement('span', { className: 'dsb-title' }, '本会话 Token 计费'),
          React.createElement('span', {
            className: 'dsb-peak' + (value.peakNow ? ' is-peak' : ''),
          }, value.peakNow ? '高峰计价' : '空闲时段 ×0.5'),
          React.createElement('button', {
            type: 'button',
            className: 'dsb-cur',
            title: '切换显示币种（两套均为官方价目）',
            onClick: onCurrency,
          }, currency === 'CNY' ? '\u00a5 CNY' : '$ USD'),
          React.createElement('button', {
            type: 'button',
            className: 'dsb-close',
            title: '关闭',
            onClick: onClose,
          }, '\u00d7'),
        ),
        React.createElement('div', { className: 'dsb-rule' }),
        React.createElement('div', { className: 'dsb-hero' },
          React.createElement('span', { className: 'dsb-hero-cost' }, fmtMoney(value.cost[currency], currency)),
          React.createElement('span', { className: 'dsb-hero-sub' },
            fmtTokens(tokens.total) + ' tokens · ' + value.calls + ' 次调用 · ' + value.turns + ' 轮'),
        ),
        React.createElement('dl', { className: 'dsb-details' }, breakdown),
        React.createElement('div', { className: 'dsb-section' }, '按模型'),
        value.models.length === 0
          ? React.createElement('div', { className: 'dsb-empty' }, '本会话暂无用量记录')
          : React.createElement('div', null, modelRows),
        React.createElement('div', { className: 'dsb-section' },
          '官方价目（' + (currency === 'CNY' ? '人民币' : 'USD') + ' / 百万 tokens）'),
        React.createElement('dl', { className: 'dsb-details dsb-rates' }, rateRows(value, currency)),
        React.createElement('div', { className: 'dsb-note dsb-fine' },
          '空闲时段单价为高峰时段的一半；高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，逐条记录按发生时间判定。未定价模型按 Flash 估算。'),
        React.createElement('div', { className: 'dsb-note dsb-fine' },
          '数据时间 ' + fmtClock(value.updatedAt) + ' · 由 tokenBilling 会话投影实时推送'),
      ),
    ),
    document.body,
  )
}

/**
 * Header utilities entry: the cost badge plus its detail panel.
 * @param props - session-scoped slot props; `useProjection` is the standard kit seat.
 */
function TokenBillingBadge(props) {
  const value = props.useProjection('tokenBilling')
  const [open, setOpen] = React.useState(false)
  const [currency, setCurrency] = React.useState('CNY')

  // Escape closes the panel, matching the shipped dialogs.
  React.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const ready = value !== undefined && value !== null
  const badge = React.createElement('button', {
    type: 'button',
    className: 'dsb-badge' + (open ? ' is-open' : ''),
    title: 'Token 计费：点击查看本会话明细',
    'aria-expanded': open,
    onClick: () => { setOpen(current => !current) },
  },
    React.createElement('span', { className: 'dsb-dot' }),
    React.createElement('span', { className: 'dsb-cost' },
      ready ? fmtMoney(value.cost[currency], currency) : symbolOf(currency) + '--'),
    React.createElement('span', { className: 'dsb-tok' }, ready ? fmtTokens(value.tokens.total) : '--'),
  )

  if (!open || !ready) return badge
  return React.createElement(React.Fragment, null, badge, detailPanel(
    value,
    currency,
    () => { setCurrency(current => (current === 'CNY' ? 'USD' : 'CNY')) },
    () => { setOpen(false) },
  ))
}

/**
 * Client plugin body: one header-utilities entry.
 * @param ctx - client root context.
 */
function apply(ctx) {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-token-billing'
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-token-billing: stylesheet')

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: ENTRY_ID,
    order: -5,
    label: 'Token 计费',
  }, TokenBillingBadge))
}

/* Cordis reads these named exports off the materialized module. */
exports.inject = ['slots']
exports.apply = apply
