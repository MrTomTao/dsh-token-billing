# Changelog

## 0.2.3

### Changed

- **Panels are anchored to their own badge instead of the viewport.** The detail
  and balance panels used a fixed `top` / `right`, which floated away from the
  control that opened them: the header pads its utilities row, and the corner
  cluster that follows pulls back further still. Both panels now measure the
  trigger's box and place themselves against it.

  The top offset is **measured, not hard-coded**. The header is not one height
  across builds — the desktop build drops its 76px `min-height` when the view
  carries no tab strip, and drops it entirely on a blank header — and the badge
  sits at a different depth inside the header in each build. So the panel walks
  up from the trigger to the last thin box at the top of the page instead of
  naming one, which covers the web build (76px header), the desktop build
  without tabs (collapsed to 10 + 30 + 10), and the desktop build with tabs.

  The right inset lines up the panel's right edge with the badge's, with the
  shipped dialog's 12px viewport margin as a floor. Both offsets fall back to
  the stylesheet's own values when there is no DOM to measure.

- **Panel surface is now opaque.** It used `--dsw-specific-menu`, a frosted
  token (`#f8f9faf0` in the desktop build) whose alpha let the conversation read
  through the panel behind the figures. It now uses the same role without alpha
  (`--dsw-alias-bg-layer-3`), with a `#fff` fallback so a missing token cannot
  resolve to transparent.

### Added

- Three tests covering the panel offsets, including both header builds and the
  no-DOM fallbacks. `panelStyle` / `panelTop` / `panelRight` are exported for
  them, alongside the existing `balanceView`.

### Removed

- The `prepare` script. It rebuilt `lib/` on install, but pnpm refuses to run a
  git-hosted dependency's build scripts by default
  (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), so on the git-install path it turned
  a working package into a failing one. `lib/` is committed instead.

## 0.2.0

- Cost badge and balance badge in the session header, with their detail panels.
- Host half registers the `tokenBilling` session projection (peak / off-peak
  token buckets per model) and a same-origin read-only balance route.
- Browser half renders the badges and holds no credential.
