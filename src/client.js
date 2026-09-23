/**
 * dsh-token-billing — browser half (the bundle body).
 *
 * Two entries, both in the session-header utilities row:
 *
 *  * the cost badge, whose durable session-wide value arrives through the
 *    standard `useProjection('tokenBilling')` seat, pushed by the Host half of
 *    this same package;
 *  * the balance badge, which reads the Host half's own same-origin
 *    `/token-billing/balance` route — this half holds no credential and never
 *    talks to DeepSeek itself.
 *
 * This half computes no billing and keeps no session state. Each detail panel
 * is a React portal onto `document.body` (the same idiom the shipped stats
 * pills use), so a long panel is never clipped by the header's own box and
 * needs no cross-entry store.
 *
 * Bootstrapped by build.mjs into the `window.__ModuleLoader__.load({...})`
 * closure factory the client module table expects. Only the baseline modules
 * `react` and `react-dom` are required from the shell's module table.
 */

const React = require('react')
const ReactDOM = require('react-dom')

/** Cost entry id; a fresh id is added beside the shipped header utilities. */
const ENTRY_ID = 'token-billing'

/** Balance entry id, beside the cost badge. */
const BALANCE_ID = 'token-balance'

/** The Host half's read-only balance route, anchored on the served base URI. */
const BALANCE_ROUTE = '/token-billing/balance'

/** Assumed poll interval until the Host half reports its own `refreshMs`. */
const DEFAULT_REFRESH_MS = 60000

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
  // Balance badge: same control geometry, with the word so the figure is not
  // mistaken for the session cost sitting beside it.
  '.dsb-bal-label{color:var(--dsw-alias-label-tertiary)}',
  // The refresh affordance on the balance panel: the same 11px capsule the
  // currency toggle uses, because both are panel-local controls.
  '.dsb-refresh{display:inline-flex;align-items:center;border:0.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:none;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:11px;line-height:17px;font-weight:500;padding:1px 8px;cursor:pointer;white-space:nowrap}',
  '.dsb-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '.dsb-refresh[disabled]{cursor:default;color:var(--dsw-alias-label-caption)}',
  '.dsb-error{margin:0;color:var(--dsw-alias-label-secondary)}',
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

/* ────────────────────────────── balance ────────────────────────────── */

/** Why a probe had no answer, written for the person reading the panel. */
const BALANCE_REASONS = {
  disabled: '余额查询已在插件配置里关闭',
  'no-credential': '没有可用的 API Key（DEEPSEEK_API_KEY），也没有登录 DeepSeek 账号',
  network: '连不上 DeepSeek 接口（网络或代理）',
  timeout: 'DeepSeek 接口响应超时',
  http: 'DeepSeek 接口拒绝了这次查询',
  protocol: 'DeepSeek 接口返回了无法识别的数据',
}

/** Where the figure came from, as one clause. */
const BALANCE_SOURCES = {
  platform: '已登录的 DeepSeek 账号',
  'api-key': 'API Key 对应的账户',
}

/** Where the balance figure came from, said once. */
const BALANCE_SUBJECT = 'DeepSeek 开放平台账户'

/**
 * The balance route, resolved against the directory the UI is served from.
 * Root-absolute paths miss a reverse proxy that mounts the harness under a
 * prefix, which is why this anchors on `document.baseURI` instead.
 */
function balanceUrl(force) {
  const relative = BALANCE_ROUTE.replace(/^\/+/, '')
  const path = typeof document === 'undefined'
    ? '/' + relative
    : new URL(relative, document.baseURI).pathname
  return force ? path + '?refresh=1' : path
}

/**
 * The wallet on screen. CNY wins, because the session panel beside it bills in
 * CNY, so a two-currency account still reads consistently across the two badges.
 * @param payload - a `ready` balance outcome.
 * @returns the chosen wallet, or null when the account reported none.
 */
function pickWallet(payload) {
  const wallets = payload !== null && typeof payload === 'object' && Array.isArray(payload.wallets)
    ? payload.wallets
    : []
  return wallets.find(entry => entry.currency === 'CNY') ?? wallets[0] ?? null
}

/**
 * One probe result as plain display data: what the badge shows, what the panel
 * lists, and why there is no figure. Kept out of the components so the
 * formatting and wording are testable without a DOM.
 * @param state - `{ status, reason?, payload? }`.
 * @returns `{ amount, rows, source, problem }`.
 */
function balanceView(state) {
  const ready = state !== undefined && state !== null && state.status === 'ready'
  const wallet = ready ? pickWallet(state.payload) : null
  const rows = []
  if (wallet !== null) {
    rows.push({ key: 'total', label: '账户总余额', value: fmtMoney(wallet.total, wallet.currency) })
    if (typeof wallet.toppedUp === 'number') {
      rows.push({ key: 'topped', label: '充值余额', value: fmtMoney(wallet.toppedUp, wallet.currency) })
    }
    if (typeof wallet.granted === 'number') {
      rows.push({ key: 'granted', label: '赠送余额', value: fmtMoney(wallet.granted, wallet.currency) })
    }
  }
  const payload = ready ? state.payload : null
  return {
    amount: wallet === null ? '--' : fmtMoney(wallet.total, wallet.currency),
    rows,
    source: payload === null ? null : BALANCE_SOURCES[payload.source] ?? null,
    // Loading is not a problem; a settled probe without a figure is.
    problem: ready || state === undefined || state === null || state.status === 'loading'
      ? null
      : BALANCE_REASONS[state.reason] ?? BALANCE_REASONS.network,
  }
}

/**
 * One balance probe, with a revision guard so a slow answer can never overwrite
 * a newer one, and a manual `force` that asks the Host half to skip its cache.
 * @returns `[state, load]`.
 */
function useBalance() {
  const [state, setState] = React.useState({ status: 'loading' })
  const revision = React.useRef(0)

  const load = React.useCallback(force => {
    const current = revision.current + 1
    revision.current = current
    // Keep the last figure on screen while refreshing; only a first probe is blank.
    setState(previous => (previous.status === 'ready' ? previous : { status: 'loading' }))
    if (typeof fetch !== 'function') {
      setState({ status: 'error', reason: 'network' })
      return
    }
    fetch(balanceUrl(force === true), { cache: 'no-store' })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
      .then(payload => {
        if (revision.current !== current) return
        if (payload !== null && typeof payload === 'object' && payload.ok === true) {
          setState({ status: 'ready', payload })
          return
        }
        setState({
          status: 'error',
          reason: payload !== null && typeof payload === 'object' ? payload.reason : 'protocol',
        })
      })
      .catch(() => {
        if (revision.current !== current) return
        setState({ status: 'error', reason: 'network' })
      })
  }, [])

  return [state, load]
}

/** The balance panel, portalled onto the document body. */
function balancePanel(state, view, load, onClose) {
  const ready = state.status === 'ready'
  const busy = state.status === 'loading'
  const refreshMs = ready && typeof state.payload.refreshMs === 'number'
    ? state.payload.refreshMs
    : DEFAULT_REFRESH_MS

  const body = ready
    ? [
      React.createElement('div', { className: 'dsb-hero', key: 'hero' },
        React.createElement('span', { className: 'dsb-hero-cost' }, view.amount),
        React.createElement('span', { className: 'dsb-hero-sub' },
          (view.source === null ? '' : view.source + ' · ') + '更新于 ' + fmtClock(state.payload.fetchedAt)),
      ),
      React.createElement('dl', { className: 'dsb-details', key: 'rows' },
        view.rows.map(row => detail(row.label, row.value, row.key))),
      React.createElement('div', { className: 'dsb-note dsb-fine', key: 'note' },
        '每 ' + Math.round(refreshMs / 1000) + ' 秒自动刷新'
        + (state.payload.available === false ? '；账户当前不可用（可能已欠费）。' : '。')
        + '余额是账户可用额度，与旁边的本会话花费是两回事。'),
    ]
    : [React.createElement('p', { className: 'dsb-error', key: 'error' },
      view.problem === null ? '正在查询账户余额…' : view.problem)]

  return ReactDOM.createPortal(
    React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'dsb-backdrop', onClick: onClose }),
      React.createElement('div', { className: 'dsb-panel', role: 'dialog', 'aria-label': BALANCE_SUBJECT },
        React.createElement('div', { className: 'dsb-head' },
          React.createElement('span', { className: 'dsb-title' }, BALANCE_SUBJECT),
          React.createElement('button', {
            type: 'button',
            className: 'dsb-refresh',
            disabled: busy,
            title: '立即重新查询（跳过 Host 端缓存）',
            onClick: () => { load(true) },
          }, busy ? '查询中…' : '刷新'),
          React.createElement('button', {
            type: 'button',
            className: 'dsb-close',
            title: '关闭',
            onClick: onClose,
          }, '\u00d7'),
        ),
        React.createElement('div', { className: 'dsb-rule' }),
        body,
      ),
    ),
    document.body,
  )
}

/**
 * Header utilities entry: the account-balance badge plus its panel. The figure
 * is the Host half's, read from its own same-origin route — no credential and
 * no third-party origin is ever touched from the page.
 */
function TokenBalanceBadge() {
  const [state, load] = useBalance()
  const [open, setOpen] = React.useState(false)
  const view = balanceView(state)
  const ready = state.status === 'ready'

  // One probe on mount, then one per interval. The Host half memoizes, so any
  // number of mounted badges still costs one upstream request per interval.
  React.useEffect(() => { load(false) }, [load])
  const refreshMs = ready && typeof state.payload.refreshMs === 'number'
    ? state.payload.refreshMs
    : DEFAULT_REFRESH_MS
  React.useEffect(() => {
    if (typeof setInterval !== 'function') return undefined
    const id = setInterval(() => { load(true) }, refreshMs)
    return () => { clearInterval(id) }
  }, [load, refreshMs])

  // Escape closes the panel, matching the shipped dialogs.
  React.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  // The Host half says the probe is off: no badge at all, rather than one that
  // permanently reads as broken.
  if (state.status === 'error' && state.reason === 'disabled') return null

  const badge = React.createElement('button', {
    type: 'button',
    className: 'dsb-badge' + (open ? ' is-open' : ''),
    title: ready
      ? BALANCE_SUBJECT + '：点击查看明细'
      : BALANCE_SUBJECT + '：' + (view.problem === null ? '正在查询…' : view.problem),
    'aria-expanded': open,
    onClick: () => { setOpen(current => !current) },
  },
    React.createElement('span', { className: 'dsb-dot' }),
    React.createElement('span', { className: 'dsb-bal-label' }, '余额'),
    React.createElement('span', { className: 'dsb-cost' }, view.amount),
  )

  if (!open) return badge
  return React.createElement(React.Fragment, null, badge, balancePanel(
    state,
    view,
    load,
    () => { setOpen(false) },
  ))
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
 * Client plugin body: two header-utilities entries sharing one stylesheet.
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

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: BALANCE_ID,
    order: -4,
    label: 'DeepSeek 余额',
  }, TokenBalanceBadge))
}

/* Cordis reads these named exports off the materialized module. */
exports.inject = ['slots']
exports.apply = apply
/* Exported for the test suite: the pure display mapping behind the badge. */
exports.balanceView = balanceView
