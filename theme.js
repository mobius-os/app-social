export const CSS = `
/* mobius-ui:Root v1 — keep in sync; library candidate. Diverge below the marker only. */
.cn-root {
  position: relative;
  display: flex; flex-direction: column;
  height: 100%; width: 100%; max-width: 100%;
  overflow: hidden;
  background: var(--bg); color: var(--text); font-family: var(--font);
  -webkit-font-smoothing: antialiased;
}
.cn-root ::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); }
.cn-root :where(input, textarea) { caret-color: var(--accent); }
.cn-scroll {
  flex: 1; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 14px 16px 32px;
  word-break: break-word; overflow-wrap: anywhere;
}
/* /mobius-ui:Root */
.cn-scroll { order: 1; padding: 0 16px 104px; }
.cn-content { width: 100%; max-width: 720px; margin: 0 auto; }
.cn-screen { animation: cn-screen-in 0.26s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.cn-screen.has-dialog { animation: none; transform: none; }
@keyframes cn-screen-in {
  from { opacity: 0.4; transform: translateY(5px); }
  to { opacity: 1; transform: none; }
}

/* ── Top bar: aligned with the reading column ─────────────────────────────── */
.cn-header {
  flex: 0 0 auto; position: relative; z-index: 20;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 64px; padding: 9px 16px;
  width: min(100%, 752px); margin-inline: auto;
  background: var(--bg);
}
.cn-header::after {
  content: ""; position: absolute; left: 16px; right: 16px; bottom: 0;
  height: 1px; background: var(--border);
}
.cn-brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
.cn-app-icon {
  flex: 0 0 auto; width: 36px; height: 36px; display: block;
  object-fit: contain; user-select: none;
}
.cn-mark {
  flex: 0 0 auto; width: 34px; height: 34px; border-radius: 11px;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent);
  color: var(--accent-fg);
  position: relative; overflow: hidden;
}
.cn-mark::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.34), transparent 52%);
}
.cn-mark-orbit {
  width: 17px; height: 17px; border: 2px solid rgba(255,255,255,0.9);
  border-radius: 50%; position: relative;
}
.cn-mark-orbit::before, .cn-mark-orbit::after {
  content: ""; position: absolute; width: 4.5px; height: 4.5px;
  border-radius: 50%; background: #fff;
}
.cn-mark-orbit::before { top: -3px; left: 2px; }
.cn-mark-orbit::after { right: -3px; bottom: 1px; }
.cn-title {
  margin: 0; font-size: 20px; font-weight: 680; letter-spacing: -0.035em;
}
.cn-header-chip {
  display: inline-flex; align-items: center; gap: 8px;
  min-height: 44px; max-width: 55%; padding: 4px 12px 4px 5px; border-radius: 21px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  border: 1px solid var(--border); font-size: 12.5px; font-weight: 650;
  color: var(--muted);
}

/* Compact list header (messenger-style) */
.cn-list-top {
  display: flex; align-items: center; justify-content: space-between;
  padding: 22px 0 14px; min-height: 56px;
}
.cn-list-title { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.03em; }

/* ── Avatars: dimensional gradient discs ────────────────────────────────── */
.cn-avatar {
  width: 40px; height: 40px; border-radius: 50%; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 760; color: #fff; letter-spacing: -0.02em;
  position: relative; overflow: hidden;
  box-shadow: none;
}
.cn-avatar::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(140deg, rgba(255,255,255,0.36), transparent 56%);
  pointer-events: none;
}
.cn-avatar.has-image::after { background: linear-gradient(140deg, rgba(255,255,255,0.12), transparent 48%); }
.cn-avatar-image { width: 100%; height: 100%; display: block; object-fit: cover; }
.cn-avatar.is-small { width: 30px; height: 30px; font-size: 10px; }
.cn-avatar.is-micro { width: 21px; height: 21px; font-size: 7px; border-width: 1px; }
.cn-avatar-btn {
  min-width: 44px; min-height: 44px; padding: 2px; border: 0; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; cursor: pointer; -webkit-appearance: none; appearance: none;
}
.cn-avatar-btn .cn-avatar-visual { flex: 0 0 auto; }
.cn-avatar-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (hover: hover) { .cn-avatar-btn:hover { filter: brightness(1.06); } }
.cn-avatar-btn:active { transform: scale(0.94); }
@media (prefers-reduced-motion: reduce) { .cn-avatar-btn:active { transform: none; } }
.cn-avatar.is-large {
  width: 76px; height: 76px; font-size: 23px;
  box-shadow: none;
}
.cn-avatar.is-group {
  border-radius: 14px;
  background: linear-gradient(145deg,
    color-mix(in srgb, var(--accent) 88%, #fff 8%),
    color-mix(in srgb, var(--accent) 55%, #16102e));
  color: #fff;
}

/* ── Board: tighter, timeline-style rows ────────────────────────────────── */
.cn-feed { border-top: 1px solid var(--border); }
.cn-post {
  display: grid; grid-template-columns: 44px minmax(0, 1fr); column-gap: 10px;
  padding: 12px 6px 8px; margin-inline: -6px; border-radius: 10px;
  position: relative; cursor: pointer;
  transition: background .14s ease;
}
.cn-post:hover { background: color-mix(in srgb, var(--surface) 58%, transparent); }
.cn-post.has-thread { background: color-mix(in srgb, var(--surface) 44%, transparent); }
.cn-post + .cn-post::before {
  content: ""; position: absolute; top: 0; left: 6px; right: 6px; height: 1px;
  background: var(--border); opacity: 0.85;
}
.cn-post.is-pending { cursor: default; }
.cn-post > .cn-avatar, .cn-post > .cn-avatar-btn { grid-column: 1; grid-row: 1; align-self: start; }
.cn-post-main { grid-column: 2; min-width: 0; }
.cn-post-head { min-height: 24px; display: flex; align-items: flex-start; }
.cn-post.is-mine .cn-post-head { padding-right: 44px; }
.cn-post-delete {
  position: absolute; top: 7px; right: 0;
  width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--muted); cursor: pointer;
  transition: background .14s ease, color .14s ease, transform .1s ease;
}
.cn-post-delete:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.cn-post-delete:active { transform: scale(.94); }
.cn-post-delete svg { width: 17px; height: 17px; }
.cn-person {
  padding: 0; border: 0; background: transparent; text-align: left; color: inherit;
  font-family: var(--font); cursor: pointer; min-height: 24px; min-width: 0;
  display: flex; align-items: baseline; gap: 4px;
}
.cn-person-name { font-size: 14px; font-weight: 700; line-height: 1.25; letter-spacing: -0.018em; }
.cn-meta { font-size: 13px; color: var(--muted); }
.cn-post-dot { color: var(--muted); font-size: 13px; }
.cn-post-copy {
  font-size: 15px; line-height: 1.45; margin: 0;
  letter-spacing: -0.01em; white-space: pre-wrap;
}
.cn-pending-status { font-variant-numeric: tabular-nums; }
.cn-pending-image {
  margin-top: 12px; overflow: hidden; border-radius: 14px; background: transparent;
}
.cn-pending-image img {
  width: 100%; max-height: 520px; display: block; object-fit: contain;
}
.cn-pending-gallery img { width: 100%; height: 100%; display: block; object-fit: cover; }

/* Reactions + compose */
.cn-post-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 4px 0 0 -8px; max-width: 460px; }
.cn-react {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 44px; min-width: 44px; padding: 0 12px; border-radius: 8px;
  border: 0; background: transparent; color: var(--muted);
  font-family: var(--font); font-size: 12.5px; font-weight: 650; cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
}
.cn-react:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.cn-react:active { transform: scale(0.94); }
.cn-react.is-active { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.cn-react:disabled { opacity: 0.46; cursor: default; transform: none; }
.cn-reply-summary { padding-inline: 5px 10px; }
.cn-reactions {
  display: flex; flex: 1 1 180px; flex-wrap: wrap;
  align-items: center; gap: 5px; min-width: 0;
}
.cn-reactions.has-picker { flex-basis: 100%; }
.cn-reaction-chip {
  box-sizing: border-box; width: auto; min-width: 44px; height: 44px; padding: 0; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  border: 0; background: transparent; color: var(--muted); font: 650 12px var(--font); cursor: pointer;
  transition: transform .1s ease;
}
.cn-reaction-visual {
  min-width: 30px; height: 30px; padding: 3px 7px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  background: transparent;
  transition: background .14s ease, border-color .14s ease;
}
.cn-reaction-chip:hover .cn-reaction-visual { background: var(--surface); border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.cn-reaction-chip:active { transform: scale(.94); }
.cn-reaction-chip.is-reacted .cn-reaction-visual {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
  background: color-mix(in srgb, var(--accent) 11%, transparent); color: var(--accent);
}
.cn-flat-emoji { width: 19px; height: 19px; display: block; object-fit: contain; }
.cn-reaction-chip .cn-flat-emoji { width: 17px; height: 17px; }
.cn-reaction-chip b { font: inherit; }
.cn-add-reaction svg { width: 18px; height: 18px; }
.cn-reaction-picker {
  flex: 0 0 auto; width: max-content; max-width: 100%; padding: 10px; margin-top: 4px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: none;
  animation: cn-reaction-in .16s cubic-bezier(.2,.8,.2,1) both;
}
.cn-reaction-picker-title {
  display: block; padding: 2px 4px 8px; color: var(--muted);
  font-size: 11px; font-weight: 700; letter-spacing: .02em;
}
.cn-reaction-grid { display: grid; grid-template-columns: repeat(6, 44px); gap: 3px; }
.cn-reaction-grid button {
  box-sizing: border-box; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 9px;
  background: transparent; font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
  font-size: 20px; cursor: pointer; transition: background .12s ease, transform .12s ease;
}
.cn-reaction-grid .cn-flat-emoji { width: 21px; height: 21px; margin: auto; }
.cn-reaction-grid button:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); transform: translateY(-1px); }
.cn-reaction-grid button.is-reacted { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.cn-reply-avatars { display: inline-flex; padding-left: 4px; }
.cn-reply-avatars .cn-avatar + .cn-avatar { margin-left: -7px; }
.cn-reply-avatars .cn-avatar { box-shadow: none; outline: 2px solid var(--background); }
@keyframes cn-reaction-in { from { opacity: .4; transform: translateY(6px) scale(.96); } to { opacity: 1; transform: none; } }

.cn-profile-preview {
  position: relative; display: grid; grid-template-columns: auto minmax(0,1fr) auto;
  align-items: center; gap: 12px; margin: 2px 0 12px; padding: 14px;
  border: 1px solid var(--border); border-radius: 14px; background: var(--surface);
  box-shadow: none; cursor: default;
  animation: cn-reaction-in .18s cubic-bezier(.2,.8,.2,1) both;
}
.cn-profile-preview-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cn-profile-preview-copy strong { font-size: 15px; }
.cn-profile-preview-copy span, .cn-profile-preview-status { color: var(--muted); font-size: 13px; line-height: 1.4; }
.cn-profile-preview-bio {
  color: var(--text) !important; margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.cn-profile-preview-actions { display: flex; align-items: center; gap: 7px; padding-right: 30px; }
.cn-profile-preview-status { grid-column: 1 / -1; min-height: 44px; display: flex; align-items: center; }
.cn-profile-preview-close {
  position: absolute; top: 4px; right: 4px; min-width: 44px; min-height: 44px; padding: 0;
  display: flex; align-items: center; justify-content: center; border: 0; border-radius: 50%;
  background: transparent; color: var(--muted); cursor: pointer;
}
.cn-profile-preview-close:hover { background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text); }
.cn-profile-preview-close svg { width: 16px; height: 16px; }

.cn-inline-thread {
  width: 100%; min-width: 0; height: min(360px, 48vh); min-height: 190px;
  margin: 8px 0 10px; overflow: hidden;
  display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0,1fr) auto;
  border: 1px solid var(--border); border-radius: 16px; background: var(--bg); cursor: default;
}
.cn-inline-thread-head {
  min-height: 44px; padding: 0 12px; display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}
.cn-inline-thread-head strong { font-size: 13px; letter-spacing: -.008em; }
.cn-inline-thread-head button { min-height: 36px; border: 0; background: transparent; color: var(--accent); font: 650 12px var(--font); cursor: pointer; }
.cn-inline-replies { min-height: 0; overflow-y: auto; padding: 0 12px; overscroll-behavior: contain; }
.cn-inline-replies .cn-reply-row { padding: 12px 0; }
.cn-thread-loading { min-height: 96px; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--muted); font-size: 13px; }
.cn-inline-thread .cn-reply-composer { padding: 10px; background: var(--bg); }
.cn-confirm-sheet { max-width: 420px; }
.cn-compose-fab {
  position: absolute; z-index: 45;
  right: max(20px, calc((100% - 720px) / 2 + 20px));
  bottom: calc(82px + env(safe-area-inset-bottom));
  width: 52px; height: 52px; padding: 0; border: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent); color: var(--accent-fg); cursor: pointer;
  box-shadow: none;
  transition: filter .14s ease, transform .12s ease, box-shadow .14s ease;
}
.cn-compose-fab:hover { filter: brightness(1.07); box-shadow: none; }
.cn-compose-fab:active { transform: scale(.92); }
.cn-compose-fab svg { width: 25px; height: 25px; }
.cn-feed-skeleton { padding-top: 2px; }
.cn-post-skeleton {
  display: grid; grid-template-columns: 42px 1fr; gap: 11px;
  min-height: 150px; padding: 16px 0; border-bottom: 1px solid var(--border);
}

.cn-post-copy a, .cn-inline-replies p a {
  color: var(--accent); text-decoration: none; overflow-wrap: anywhere;
}
.cn-post-copy a:hover, .cn-inline-replies p a:hover { text-decoration: underline; }
.cn-link-preview {
  min-height: 58px; margin-top: 10px; padding: 10px 12px;
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--border); border-radius: 12px;
  background: transparent; color: inherit; text-decoration: none;
  transition: border-color .14s ease, background .14s ease;
}
.cn-link-preview:hover {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}
.cn-link-preview-mark {
  width: 30px; height: 30px; flex: 0 0 auto; display: grid; place-items: center;
  border: 1px solid var(--border); border-radius: 8px; color: var(--accent); font-size: 15px;
}
.cn-link-preview-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cn-link-preview-copy strong { font-size: 13px; font-weight: 720; }
.cn-link-preview-copy span {
  overflow: hidden; color: var(--muted); font-size: 12px;
  white-space: nowrap; text-overflow: ellipsis;
}
.cn-skeleton-avatar, .cn-skeleton-copy i {
  display: block; background: color-mix(in srgb, var(--surface2, var(--surface)) 84%, transparent);
  animation: cn-skeleton-pulse 1.4s ease-in-out infinite alternate;
}
.cn-skeleton-avatar { width: 42px; height: 42px; border-radius: 50%; }
.cn-skeleton-copy { padding-top: 4px; }
.cn-skeleton-copy i { height: 11px; margin-bottom: 12px; border-radius: 5px; }
.cn-skeleton-copy i:nth-child(1) { width: 32%; }
.cn-skeleton-copy i:nth-child(2) { width: 88%; margin-top: 24px; }
.cn-skeleton-copy i:nth-child(3) { width: 61%; }
@keyframes cn-skeleton-pulse { to { opacity: 0.42; } }
/* ── Rows (conversations, people) ───────────────────────────────────────── */
.cn-row {
  width: 100%; min-height: 82px; padding: 16px 8px; display: flex; align-items: center; gap: 13px;
  background: transparent; border: 0; border-radius: 14px;
  text-align: left; color: inherit; font-family: var(--font); cursor: pointer;
  position: relative; transition: background 0.15s ease;
}
.cn-row + .cn-row::before {
  content: ""; position: absolute; top: 0; left: 57px; right: 4px; height: 1px;
  background: var(--border); opacity: 0.6;
}
.cn-row:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.cn-row:active { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.cn-row-copy { min-width: 0; flex: 1; }
.cn-row-top { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.cn-row-top strong { font-size: 15.5px; font-weight: 720; letter-spacing: -0.012em; }
.cn-time { font-size: 12px; color: var(--muted); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.cn-preview {
  font-size: 13.5px; color: var(--muted); margin-top: 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cn-unread-dot {
  width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto;
  background: var(--accent);
}

.cn-view-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 24px 0 18px; }
.cn-view-heading h2 { margin: 0; font-size: 25px; line-height: 1.2; font-weight: 700; letter-spacing: -0.025em; }
.cn-view-heading p { margin: 6px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.cn-view-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.cn-view-actions svg { width: 18px; height: 18px; }
.cn-message-tabs {
  display: inline-flex; min-height: 44px; margin: 0 0 10px; padding: 3px; gap: 2px;
  border-radius: 13px; background: var(--surface2, var(--surface));
  box-shadow: none;
}
.cn-message-tabs button {
  min-height: 38px; padding: 7px 14px; border: 0; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  background: transparent; color: var(--muted); font: 650 13.5px var(--font);
  cursor: pointer; transition: background 0.15s ease, color 0.15s ease;
}
.cn-message-tabs button:hover { color: var(--text); }
.cn-message-tabs button.is-active {
  background: var(--bg); color: var(--text); box-shadow: none;
}
.cn-message-tabs button.has-requests:not(.is-active) {
  color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.cn-request-count {
  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent);
  font-size: 11px; font-variant-numeric: tabular-nums;
}
.cn-request-banner {
  width: 100%; min-height: 68px; margin: 2px 0 8px; padding: 10px 12px;
  display: flex; align-items: center; gap: 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  border-radius: 14px; background: color-mix(in srgb, var(--accent) 7%, transparent);
  color: var(--text); text-align: left; font-family: var(--font); cursor: pointer;
  transition: background .14s ease, border-color .14s ease;
}
.cn-request-banner:hover {
  background: color-mix(in srgb, var(--accent) 11%, transparent);
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
}
.cn-request-banner-mark {
  width: 38px; height: 38px; flex: 0 0 auto; border-radius: 50%;
  display: grid; place-items: center; background: var(--accent); color: var(--accent-fg);
}
.cn-request-banner-mark svg { width: 19px; height: 19px; }
.cn-request-banner-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.cn-request-banner-copy strong { font-size: 14px; line-height: 1.3; }
.cn-request-banner-copy span { color: var(--muted); font-size: 12px; line-height: 1.35; }
.cn-request-banner-action { color: var(--accent); font-size: 12px; font-weight: 720; }
.cn-directory-error { padding: 12px 0; color: var(--muted); font-size: 14px; }
.cn-directory-error p { margin: 0 0 8px; }
.cn-search-clear { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; min-height: 44px; padding: 0 6px; border: 0; background: transparent; color: var(--muted); font: 600 13px var(--font); cursor: pointer; }
.cn-search-status { margin: 10px 0 0; font-size: 13px; color: var(--muted); }
.cn-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.cn-dialog-head .cn-sheet-title { margin: 0; }

/* ── Search field ───────────────────────────────────────────────────────── */
.cn-search {
  min-height: 48px; border-radius: 15px;
  background: color-mix(in srgb, var(--surface2, var(--surface)) 80%, transparent);
  border: 1px solid var(--border);
  margin: 4px 0 8px; padding: 0 14px; display: flex; gap: 10px; align-items: center;
  color: var(--muted); transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.cn-search:focus-within {
  border-color: var(--accent);
  box-shadow: none;
}
.cn-search input {
  border: 0; outline: 0; background: transparent; min-width: 0; flex: 1;
  font-size: 16px; color: var(--text); font-family: var(--font); min-height: 46px;
}
.cn-search input::placeholder { color: var(--muted); }

/* ── Thread ─────────────────────────────────────────────────────────────── */
.cn-thread { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.cn-thread-bar {
  flex: 0 0 auto; position: relative; z-index: 5;
  display: flex; align-items: center; gap: 8px;
  min-height: 60px; padding: 8px 12px;
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
}
.cn-thread-bar::after {
  content: ""; position: absolute; left: 14px; right: 14px; bottom: 0; height: 1px;
  background: var(--border); opacity: 0.7;
}
.cn-thread-person { min-width: 0; }
.cn-thread-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cn-thread-name .cn-person-name {
  min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.cn-encryption-indicator {
  display: inline-flex; align-items: center; justify-content: center;
  flex: 0 0 auto; color: var(--accent);
}
.cn-encryption-indicator svg { width: 14px; height: 14px; }
.cn-thread-msgs {
  flex: 1; min-height: 0; overflow-y: auto; padding: 18px 16px;
  display: flex; flex-direction: column; gap: 8px;
}
.cn-history-more {
  align-self: center; min-height: 34px; padding: 7px 13px; margin-bottom: 4px;
  border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface); color: var(--muted); font: inherit;
  font-size: 12.5px; font-weight: 650; cursor: pointer;
}
.cn-history-more:hover:not(:disabled) { color: var(--text); border-color: var(--muted); }
.cn-history-more:disabled { opacity: 0.65; cursor: wait; }
.cn-request-panel {
  width: 100%; margin: 0 0 10px; padding: 16px;
  border-radius: 14px; background: var(--surface);
  box-shadow: none;
}
.cn-request-panel strong { display: block; font-size: 16px; letter-spacing: -0.01em; }
.cn-request-panel p {
  margin: 5px 0 0; color: var(--muted); font-size: 13.5px; line-height: 1.55;
  overflow-wrap: anywhere;
}
.cn-request-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.cn-request-actions .cn-btn { flex: 1 1 auto; }
.cn-btn-ghost.is-danger { color: var(--danger); }
.cn-request-error { color: var(--danger) !important; }
.cn-request-quiet {
  flex: 0 0 auto; padding: 16px 20px max(16px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--border); color: var(--muted);
  background: var(--bg); text-align: center; font-size: 13.5px; line-height: 1.5;
}
.cn-day { display: flex; justify-content: center; margin: 8px 0 4px; }
.cn-day span {
  color: var(--muted); font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em;
  padding: 4px 11px; border-radius: 11px; text-transform: uppercase;
  background: color-mix(in srgb, var(--surface2, var(--surface)) 80%, transparent);
}
.cn-bubble-row { display: flex; align-items: flex-end; gap: 8px; max-width: 86%; align-self: flex-start; }
.cn-bubble-row .cn-bubble { max-width: 100%; align-self: auto; }
.cn-bubble-row .cn-avatar { margin-bottom: 2px; }
.cn-bubble-row.no-avatar { padding-left: 38px; }
.cn-tick { display: inline-flex; vertical-align: -2px; margin-left: 4px; }
.cn-tick svg { width: 12px; height: 12px; }
.cn-author {
  font-size: 11.5px; font-weight: 680; color: var(--muted);
  margin: 3px 0 -3px 48px; align-self: flex-start;
}
.cn-bubble {
  max-width: 80%; font-size: 15px; line-height: 1.42; padding: 10px 14px;
  border-radius: 19px; background: var(--surface); align-self: flex-start;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  white-space: pre-wrap;
  animation: cn-bubble-in 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes cn-bubble-in {
  from { opacity: 0; transform: translateY(6px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
.cn-bubble.is-mine {
  background: var(--accent);
  color: var(--accent-fg); border-color: transparent;
  align-self: flex-end; border-bottom-right-radius: 7px;
}
.cn-bubble.is-theirs { border-bottom-left-radius: 7px; }
.cn-bubble-time { display: block; margin-top: 3px; font-size: 10.5px; opacity: 0.62; text-align: right; }
.cn-bubble.is-failed { border-color: var(--danger); }
.cn-failed-note {
  appearance: none; border: 0; background: transparent; padding: 0;
  font: inherit; font-size: 11px; color: var(--danger); cursor: pointer;
  align-self: flex-end; margin-top: -4px;
}
.cn-failed-note:disabled { cursor: default; opacity: 0.65; }
.cn-message-line {
  width: 92%; display: flex; align-items: flex-end; gap: 6px; align-self: flex-start;
}
.cn-message-line.is-mine { align-self: flex-end; justify-content: flex-end; }
.cn-message-avatar { width: 30px; min-width: 30px; min-height: 1px; display: flex; align-items: flex-end; }
.cn-message-avatar .cn-avatar { margin-bottom: 2px; }
.cn-message-line > .cn-bubble { align-self: auto; max-width: calc(100% - 50px); }
.cn-message-line.is-theirs > .cn-bubble { max-width: calc(100% - 86px); }
.cn-bubble-copy { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
.cn-bubble.has-attachment {
  width: min(68vw, 340px); padding: 4px; overflow: hidden;
}
.cn-bubble.has-attachment .cn-bubble-copy { padding: 5px 8px 2px; }
.cn-bubble.has-attachment .cn-bubble-time { padding: 0 7px 3px; }
.cn-bubble-reply {
  width: 44px; height: 44px; flex: 0 0 auto; border: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--muted); cursor: pointer;
  opacity: 0; pointer-events: none; transition: opacity 0.14s ease, background 0.14s ease;
}
.cn-bubble-reply svg { width: 17px; height: 17px; }
.cn-message-line:hover .cn-bubble-reply,
.cn-bubble-reply:focus-visible { opacity: 1; pointer-events: auto; }
.cn-bubble-reply:hover { background: var(--surface2, var(--surface)); color: var(--text); }
.cn-quote {
  margin: 0 0 7px; padding: 7px 9px; min-width: 0;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  color: var(--text); white-space: normal;
}
.cn-bubble.is-mine .cn-quote {
  border-color: color-mix(in srgb, var(--accent-fg) 32%, transparent);
  background: rgba(0, 0, 0, 0.13); color: var(--accent-fg);
}
.cn-bubble.has-attachment .cn-quote { margin: 3px 3px 5px; }
.cn-quote strong, .cn-quote span { display: block; min-width: 0; }
.cn-quote strong { font-size: 11.5px; line-height: 1.3; font-weight: 750; }
.cn-quote span {
  margin-top: 2px; font-size: 12px; line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.78;
}
.cn-compose-shell {
  flex: 0 0 auto; background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.cn-compose-bar {
  flex: 0 0 auto; padding: 9px 12px max(12px, env(safe-area-inset-bottom));
  display: flex; gap: 9px; align-items: flex-end;
  background: transparent;
}
.cn-compose-bar input {
  min-height: 46px; border-radius: 23px; border: 1px solid var(--border);
  background: var(--surface); padding: 0 16px; min-width: 0; flex: 1; outline: 0;
  font-size: 16px; color: var(--text); font-family: var(--font);
  transition: border-color 0.15s ease;
}
.cn-compose-bar input:focus { border-color: var(--accent); }
.cn-send {
  width: 46px; height: 46px; border-radius: 50%; border: 0; flex: 0 0 auto;
  background: var(--accent);
  color: var(--accent-fg);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  transition: filter 0.14s ease, transform 0.1s ease;
}
.cn-send:hover { filter: brightness(1.07); }
.cn-send:active { transform: scale(0.92); }
.cn-send:disabled { opacity: 0.45; cursor: default; }
.cn-file-input { display: none; }
.cn-compose-image {
  width: 46px; height: 46px; border-radius: 50%; border: 0; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: transparent; color: var(--muted);
  transition: background 0.14s ease, color 0.14s ease, transform 0.1s ease;
}
.cn-compose-image:hover { background: var(--surface2, var(--surface)); color: var(--text); }
.cn-compose-image:active { transform: scale(0.94); }
.cn-compose-image:disabled { opacity: 0.45; cursor: default; transform: none; }
.cn-compose-image svg { width: 21px; height: 21px; }
.cn-compose-image .cn-spinner { width: 20px; height: 20px; }
.cn-selected-image {
  min-height: 62px; margin: 9px 12px 0; padding: 5px 5px 5px 6px;
  display: flex; align-items: center; gap: 10px;
  background: var(--surface2, var(--surface)); border: 1px solid var(--border); border-radius: 14px;
}
.cn-selected-image img { width: 50px; height: 50px; border-radius: 10px; object-fit: cover; display: block; }
.cn-selected-image > span { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.cn-selected-image strong { font-size: 13px; font-weight: 720; }
.cn-selected-image small { color: var(--muted); font-size: 11.5px; }
.cn-selected-image button, .cn-reply-target button {
  width: 44px; height: 44px; border: 0; border-radius: 50%; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: transparent; color: var(--muted);
}
.cn-selected-image button:hover, .cn-reply-target button:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text);
}
.cn-selected-image button svg, .cn-reply-target button svg { width: 18px; height: 18px; }
.cn-reply-target {
  min-height: 62px; margin: 9px 12px 0; padding: 7px 5px 7px 12px;
  display: flex; align-items: center; gap: 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border)); border-radius: 14px;
  background: color-mix(in srgb, var(--accent) 7%, var(--surface));
}
.cn-reply-target-copy { min-width: 0; flex: 1; }
.cn-reply-target-copy strong, .cn-reply-target-copy span { display: block; }
.cn-reply-target-copy strong { color: var(--accent); font-size: 12px; font-weight: 760; }
.cn-reply-target-copy span {
  margin-top: 3px; color: var(--muted); font-size: 12.5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Image attachments: neutral while loading, never animated. */
.cn-media {
  position: relative; display: block; width: 100%; min-height: 44px; padding: 0;
  overflow: hidden; border: 0; background: var(--surface2, var(--surface)); color: var(--muted);
  cursor: zoom-in;
}
.cn-media:disabled { cursor: default; }
.cn-media.is-transparent { background: transparent; }
.cn-media img {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block; object-fit: cover;
}
.cn-media-state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.cn-media-state svg { width: 24px; height: 24px; opacity: 0.55; }
.cn-message-image { max-height: 320px; border-radius: 15px; }
.cn-board-image { max-height: 520px; margin-top: 12px; border-radius: 14px; }
.cn-board-image img { object-fit: contain; }

/* Multi-image board gallery */
.cn-gallery {
  display: grid; gap: 3px; margin-top: 12px;
  border-radius: 14px; overflow: hidden;
  grid-template-columns: 1fr 1fr;
}
.cn-gallery-item { aspect-ratio: 1 / 1; }
.cn-gallery-3 .cn-gallery-item:first-child { grid-column: 1 / -1; aspect-ratio: 2 / 1; }

/* Selected-image tray in the composer */
.cn-selected-gallery {
  display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0;
}
.cn-selected-thumb {
  position: relative; width: 74px; height: 74px; border-radius: 12px;
  overflow: hidden; background: var(--surface2, var(--surface));
  border: 1px solid var(--border); flex: 0 0 auto;
}
.cn-selected-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cn-selected-thumb button {
  position: absolute; top: 3px; right: 3px; width: 22px; height: 22px;
  border: 0; border-radius: 50%; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  background: rgba(8, 8, 12, 0.72); color: #fff;
}
.cn-selected-thumb button svg { width: 13px; height: 13px; }

@media (hover: none) {
  .cn-bubble-reply { display: none; }
  .cn-message-line.is-mine > .cn-bubble { max-width: 88%; }
  .cn-message-line.is-theirs > .cn-bubble { max-width: calc(100% - 38px); }
}

/* ── People / profile ───────────────────────────────────────────────────── */
.cn-people-list { margin-top: 6px; }
.cn-profile-head {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: 11px; padding: 20px 0 6px;
}
.cn-profile-name { font-size: 23px; font-weight: 780; letter-spacing: -0.03em; margin: 0; }
.cn-profile-copy { min-width: 0; }
.cn-handle { font-size: 13.5px; color: var(--muted); font-weight: 550; }
.cn-bio { font-size: 14.5px; line-height: 1.5; margin: 8px auto 0; max-width: 400px; text-align: center; }
.cn-profile-tenure {
  margin: 7px 0 0; color: var(--muted); font-size: 12.5px; line-height: 1.45;
}
.cn-profile-apps { margin-top: 18px; }
.cn-profile-section-title {
  margin: 0 0 6px; font-size: 14px; font-weight: 740; letter-spacing: -0.01em;
}
.cn-profile-app-row {
  display: flex; align-items: center; gap: 11px; min-height: 52px; padding: 8px 2px;
}
.cn-profile-app-row + .cn-profile-app-row {
  border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}
.cn-profile-app-initial {
  width: 34px; height: 34px; border-radius: 9px; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  color: var(--accent); font-size: 14px; font-weight: 760;
}
.cn-profile-app-copy { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 2px; }
.cn-profile-app-copy strong {
  overflow: hidden; color: var(--text); font-size: 13.5px; font-weight: 710;
  white-space: nowrap; text-overflow: ellipsis;
}
.cn-profile-app-copy > span {
  overflow: hidden; color: var(--muted); font-size: 12px;
  white-space: nowrap; text-overflow: ellipsis;
}

/* ── Standard bottom tab bar ────────────────────────────────────────────── */
.cn-nav {
  order: 2; flex: 0 0 auto; display: flex; gap: 4px;
  width: min(100%, 712px); margin-inline: auto;
  padding: 6px 16px max(6px, env(safe-area-inset-bottom));
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border-top: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
}
.cn-nav-wide { display: none; }
.cn-nav-item {
  flex: 1; min-height: 56px; border: 0; background: transparent; border-radius: 10px;
  color: var(--muted); display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; font-size: 11px; font-weight: 650; font-family: var(--font); cursor: pointer;
  position: relative; transition: color 0.15s ease;
}
.cn-nav-item svg { width: 26px; height: 26px; }
.cn-nav-item:hover { color: var(--text); }
.cn-nav-item.is-active { color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, transparent); }
.cn-badge {
  position: absolute; top: 5px; right: calc(50% - 22px);
  min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 8px; background: var(--accent); color: var(--accent-fg);
  font-size: 9.5px; font-weight: 750; display: flex; align-items: center; justify-content: center;
}
.cn-nav-dot {
  position: absolute; top: 7px; right: calc(50% - 16px);
  width: 9px; height: 9px; border-radius: 50%; background: var(--accent);
  box-shadow: none;
}

.cn-header-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── First-use and community context ────────────────────────────────────── */
.cn-welcome {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 13px;
  margin: 14px 0 12px; padding: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
  border-radius: 16px; background: color-mix(in srgb, var(--accent) 7%, var(--surface));
}
.cn-welcome.is-quiet { border-color: var(--border); background: var(--surface); }
.cn-welcome-mark {
  grid-row: 1 / span 2; display: flex; align-items: center; justify-content: center;
  width: 42px; height: 42px; border-radius: 14px;
  background: color-mix(in srgb, var(--accent) 17%, var(--surface)); color: var(--accent);
}
.cn-welcome-mark svg { width: 23px; height: 23px; }
.cn-welcome-copy { min-width: 0; }
.cn-welcome h2 {
  margin: 1px 0 5px; font-size: 17px; font-weight: 760; letter-spacing: -0.02em;
}
.cn-welcome p { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.5; }
.cn-welcome-privacy {
  display: block; margin-top: 7px; color: var(--muted); font-size: 12px; line-height: 1.45;
}
.cn-welcome > .cn-btn, .cn-welcome-actions {
  grid-column: 2; justify-self: start; margin-top: 11px;
}
.cn-welcome-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.cn-inline-error {
  margin: -3px 0 12px; color: var(--danger); font-size: 13px; line-height: 1.45;
}
.cn-intent-status {
  margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.4;
}
.cn-intent-notice {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  margin: 14px 0 2px; padding: 13px 14px; border-radius: 14px;
  background: color-mix(in srgb, var(--surface2, var(--surface)) 72%, transparent);
  box-shadow: none;
}
.cn-intent-notice > div { min-width: 0; }
.cn-intent-notice strong, .cn-intent-notice span { display: block; }
.cn-intent-notice strong { font-size: 14px; line-height: 1.35; letter-spacing: -0.01em; }
.cn-intent-notice span { margin-top: 3px; color: var(--muted); font-size: 12.5px; line-height: 1.45; }
.cn-intent-notice .cn-btn { flex: 0 0 auto; }
.cn-intent-notice.is-error { color: var(--danger); }

/* mobius-ui:Sheet v1 — keep in sync; library candidate. Diverge below the marker only. */
.cn-scrim {
  position: absolute; inset: 0; z-index: 100;
  display: flex; align-items: flex-end; justify-content: center;
  padding: 16px; background: rgba(0, 0, 0, 0.5);
}
.cn-sheet {
  width: 100%; max-width: 480px; max-height: 85vh; overflow-y: auto;
  padding: 24px; background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px 16px 0 0; box-shadow: none;
}
.cn-sheet-title { margin: 0 0 12px; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.cn-sheet-body { margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: var(--muted); }
.cn-sheet-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 24px; }
.cn-sheet-actions .cn-btn { flex: 1; }
/* /mobius-ui:Sheet */
.cn-scrim { backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); }
.cn-sheet {
  border-radius: 24px 24px 0 0;
  padding-bottom: max(24px, env(safe-area-inset-bottom));
  animation: cn-sheet-up 0.26s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes cn-sheet-up {
  from { transform: translateY(46px); opacity: 0.5; }
  to { transform: none; opacity: 1; }
}
.cn-grabber {
  width: 38px; height: 4px; border-radius: 2px; background: var(--border);
  margin: -8px auto 16px;
}
.cn-sheet .cn-selected-image { margin-inline: 0; }
.cn-post-compose { display: flex; align-items: flex-start; gap: 11px; }
.cn-post-compose .cn-avatar { margin-top: 5px; }
.cn-post-compose .cn-textarea { min-width: 0; flex: 1; min-height: 132px; }
.cn-post-sheet-actions {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 14px;
}
.cn-post-sheet-actions .cn-compose-image { margin-right: auto; }

/* Full-app image viewer. */
.cn-lightbox {
  position: absolute; inset: 0; z-index: 300;
  display: flex; align-items: center; justify-content: center;
  padding: max(18px, env(safe-area-inset-top)) 14px max(18px, env(safe-area-inset-bottom));
  background: rgba(5, 5, 8, 0.9); animation: cn-lightbox-in 0.16s ease-out both;
}
.cn-lightbox > img {
  max-width: 100%; max-height: 100%; object-fit: contain; display: block;
  border-radius: 10px; animation: cn-lightbox-image-in 0.16s ease-out both;
}
.cn-lightbox-close {
  position: absolute; top: max(12px, env(safe-area-inset-top)); right: 12px;
  width: 46px; height: 46px; border: 1px solid rgba(255,255,255,0.2); border-radius: 50%;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: rgba(18,18,22,0.82); color: #fff;
}
.cn-lightbox-close:hover { background: rgba(42,42,48,0.92); }
.cn-lightbox-close svg { width: 21px; height: 21px; }
@keyframes cn-lightbox-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes cn-lightbox-image-in { from { transform: scale(0.985); } to { transform: none; } }

/* Board conversations */
.cn-reply-row {
  display: flex; align-items: flex-start; gap: 11px; padding: 13px 2px;
  animation: cn-reply-in 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.cn-reply-row + .cn-reply-row { border-top: 1px solid color-mix(in srgb, var(--border) 62%, transparent); }
.cn-reply-row.is-pending { opacity: 0.68; }
.cn-reply-copy { flex: 1; min-width: 0; }
.cn-reply-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.cn-reply-meta strong { font-size: 13.5px; font-weight: 720; letter-spacing: -0.008em; }
.cn-reply-copy p {
  margin: 4px 0 0; font-size: 14.5px; line-height: 1.48; white-space: pre-wrap;
}
.cn-reply-empty {
  margin: 0; padding: 34px 18px; text-align: center; color: var(--muted);
  font-size: 14px; line-height: 1.5;
}
.cn-reply-empty p { margin: 0 0 14px; }
.cn-reply-composer {
  flex: 0 0 auto; display: flex; align-items: center; gap: 9px; padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}
.cn-reply-composer input {
  min-width: 0; flex: 1; min-height: 46px; padding: 0 16px; border-radius: 23px;
  border: 1px solid var(--border); outline: 0; background: var(--surface); color: var(--text);
  font-family: var(--font); font-size: 16px; transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.cn-reply-composer input::placeholder { color: var(--muted); }
.cn-reply-composer input:focus { border-color: var(--accent); box-shadow: none; }
.cn-reply-composer input:disabled { opacity: 0.58; }
.cn-reply-composer.is-gated { flex-wrap: wrap; }
.cn-reply-account { flex: 0 0 auto; }
.cn-reply-send {
  width: 46px; height: 46px; flex: 0 0 auto; border: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: var(--accent); color: var(--accent-fg);
  transition: filter 0.14s ease, transform 0.1s ease;
}
.cn-reply-send:hover { filter: brightness(1.07); }
.cn-reply-send:active { transform: scale(0.92); }
.cn-reply-send:disabled { opacity: 0.45; cursor: default; transform: none; }
@keyframes cn-reply-in {
  from { opacity: 0.35; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

/* mobius-ui:Button v1 — keep in sync; library candidate. Diverge below the marker only. */
.cn-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; padding: 10px 16px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
  font-family: var(--font); font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.1s ease;
}
.cn-btn:active { transform: scale(0.97); }
.cn-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cn-btn:disabled { opacity: 0.5; cursor: default; transform: none; }
.cn-btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.cn-btn-primary:hover { filter: brightness(1.06); }
.cn-btn-secondary { background: var(--surface2, var(--surface)); }
.cn-btn-secondary:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.cn-btn-ghost { background: transparent; border-color: transparent; color: var(--accent); }
.cn-btn-ghost:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.cn-btn-danger { background: var(--danger); border-color: var(--danger); color: var(--accent-fg); }
.cn-btn-icon { width: 44px; padding: 0; border-radius: 8px; font-size: 18px; }
/* /mobius-ui:Button */
.cn-btn { border-radius: 8px; font-weight: 650; }
.cn-btn-block { width: 100%; min-height: 50px; border-radius: 10px; font-size: 15px; }

/* mobius-ui:Input v1 — keep in sync; library candidate. Diverge below the marker only. */
.cn-input, .cn-textarea {
  display: block; width: 100%; box-sizing: border-box; min-height: 44px; padding: 11px 12px;
  background: var(--surface); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; outline: none; font-family: var(--font);
  font-size: 16px;
  line-height: 1.5; transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.cn-input::placeholder, .cn-textarea::placeholder { color: var(--muted); }
.cn-input:focus, .cn-textarea:focus { border-color: var(--accent); box-shadow: none; }
.cn-textarea { min-height: 120px; resize: vertical; }
/* /mobius-ui:Input */
.cn-input { border-radius: 13px; }
.cn-textarea { border: 0; box-shadow: none; font-size: 18px; line-height: 1.4; padding: 4px 2px; }
.cn-textarea:focus { border: 0; box-shadow: none; }

/* mobius-ui:Empty v1 — keep in sync; library candidate. Diverge below the marker only. */
.cn-empty {
  display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px;
  max-width: 440px; margin: 0 auto; padding: 48px 24px; color: var(--muted);
}
.cn-empty-mark {
  width: 64px; height: 64px; margin-bottom: 10px; border-radius: 18px;
  display: flex; align-items: center; justify-content: center; font-size: 30px; line-height: 1;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
}
.cn-empty-title { font-size: 17px; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
.cn-empty-text { margin: 0; font-size: 14px; line-height: 1.6; }
/* /mobius-ui:Empty */

/* mobius-ui:Toast v1 — keep in sync; library candidate. */
.cn-toast {
  position: absolute; left: 16px; right: 16px; bottom: 16px; z-index: 200;
  display: flex; align-items: center; gap: 12px; padding: 12px 16px;
  background: var(--surface); border: 1px solid var(--accent); border-radius: 12px;
  font-size: 14px; line-height: 1.5; box-shadow: none;
}
.cn-toast.is-success { border-color: var(--green); }
.cn-toast.is-error { border-color: var(--danger); }
/* /mobius-ui:Toast */
.cn-toast {
  bottom: calc(86px + env(safe-area-inset-bottom));
  border-radius: 16px; animation: cn-sheet-up 0.22s ease both;
}

/* mobius-ui:Spinner v1 — keep in sync; library candidate. */
@keyframes cn-spin { to { transform: rotate(360deg); } }
.cn-spinner {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2.5px solid color-mix(in srgb, var(--accent) 18%, transparent); border-top-color: var(--accent);
  animation: cn-spin 0.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) { .cn-spinner { animation: none; } }
/* /mobius-ui:Spinner */
.cn-center { display: flex; align-items: center; justify-content: center; padding: 48px 0; }

/* mobius-ui:Focus v1 — keep in sync; library candidate. Required once per app. */
:where(button, a, input, textarea, select, summary, [role="button"],
       [tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* /mobius-ui:Focus */

/* mobius-ui:ReducedMotion v1 — keep in sync; library candidate. Required once per app. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
/* /mobius-ui:ReducedMotion */

@media (min-width: 720px) {
  .cn-header {
    display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    min-height: 64px;
  }
  .cn-brand { grid-column: 1; grid-row: 1; }
  .cn-header-chip { grid-column: 3; grid-row: 1; justify-self: end; max-width: 100%; }
  .cn-nav-mobile { display: none; }
  .cn-nav-wide {
    grid-column: 2; grid-row: 1; display: flex; align-self: center;
    width: auto; margin: 0; padding: 3px; gap: 2px;
    background: color-mix(in srgb, var(--surface) 70%, transparent);
    border: 1px solid var(--border); border-radius: 11px;
    backdrop-filter: none; -webkit-backdrop-filter: none;
  }
  .cn-nav-wide .cn-nav-item {
    flex: 0 0 auto; min-width: 92px; min-height: 44px; padding: 0 11px;
    flex-direction: row; gap: 7px; border-radius: 8px; font-size: 12.5px;
  }
  .cn-nav-wide .cn-nav-item svg { width: 18px; height: 18px; }
  .cn-nav-wide .cn-badge { top: -3px; right: 2px; }
  .cn-nav-wide .cn-nav-dot { top: 3px; right: 5px; }
  .cn-scroll { padding-bottom: 32px; }
  .cn-compose-fab { bottom: 20px; }
  .cn-scrim { align-items: center; padding: 24px; }
  .cn-sheet { border-radius: 16px; max-width: 540px; max-height: min(85vh, 760px); box-shadow: none; }
  .cn-grabber { display: none; }
  .cn-thread-bar { padding-inline: max(16px, calc((100% - 680px) / 2)); background: var(--bg); }
  .cn-thread-bar::after { left: max(16px, calc((100% - 680px) / 2)); right: max(16px, calc((100% - 680px) / 2)); }
  .cn-thread-msgs { padding-inline: max(16px, calc((100% - 680px) / 2)); }
  .cn-compose-shell { width: min(100%, 712px); margin-inline: auto; }
  .cn-toast { max-width: 648px; margin-inline: auto; }
}

@media (max-width: 480px) {
  .cn-welcome { padding: 14px; }
  .cn-welcome > .cn-btn, .cn-welcome-actions { grid-column: 1 / -1; width: 100%; }
  .cn-welcome-actions .cn-btn { flex: 1 1 auto; }
  .cn-intent-notice { align-items: stretch; flex-direction: column; }
  .cn-intent-notice .cn-btn { width: 100%; }
  .cn-reply-composer.is-gated input { flex-basis: 100%; }
  .cn-reply-account { width: 100%; }
  .cn-profile-preview { grid-template-columns: 1fr; }
  .cn-profile-preview-actions { padding-right: 0; }
  .cn-profile-preview-actions .cn-btn { flex: 1 1 auto; }
  .cn-reaction-grid { grid-template-columns: repeat(5, 44px); }
  .cn-inline-thread { height: min(340px, 46vh); }
}
@media (max-width: 360px) {
  .cn-reaction-grid { grid-template-columns: repeat(4, 44px); }
}

/* Member picker rows */
.cn-member-row {
  display: flex; align-items: center; gap: 11px; min-height: 54px;
  padding: 6px 2px; cursor: pointer;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.cn-member-row input[type="checkbox"] {
  width: 19px; height: 19px; accent-color: var(--accent); flex: 0 0 auto;
}
.cn-member-row .cn-row-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }

/* The group task keeps its action visible while a long directory scrolls. */
.cn-group-create { display: flex; flex-direction: column; overflow: hidden; padding: 20px; max-height: min(85dvh, 720px); }
.cn-group-create .cn-grabber { flex-shrink: 0; }
.cn-group-create-body { overflow-y: auto; min-height: 0; padding: 4px; }
.cn-group-create .cn-sheet-title { font-size: 22px; margin-bottom: 8px; }
.cn-field-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.cn-group-members-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 24px 0 10px; }
.cn-group-members-head h4 { margin: 0; font-size: 14px; }
.cn-group-members-head > span { color: var(--muted); font-size: 13px; }
.cn-group-member-list { margin-top: 10px; }
.cn-group-member-list strong { font-size: 14px; }
.cn-group-member-list .cn-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-group-status { padding-block: 16px; font-size: 14px; color: var(--muted); }
.cn-group-create-footer { flex-shrink: 0; padding: 12px 4px max(0px, env(safe-area-inset-bottom)); border-top: 1px solid var(--border); }
.cn-group-create-footer .cn-sheet-actions { margin-top: 0; }
.cn-group-create-footer .cn-directory-error { margin-bottom: 12px; }

.cn-thread-heading { min-width: 0; flex: 1; }
.cn-thread-heading .cn-person-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-group-detail-name { margin: 0 0 8px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
.cn-member-static { cursor: default; }
.cn-group-management { display: flex; gap: 8px; flex-wrap: wrap; margin: 24px 0 16px; }
.cn-danger-text { color: var(--danger); }
.cn-group-closed { padding: 18px 24px max(18px, env(safe-area-inset-bottom)); text-align: center; font-size: 14px; line-height: 1.5; color: var(--muted); border-top: 1px solid var(--border); }
.cn-directory-error li { overflow-wrap: anywhere; }
.cn-list-top { padding: 30px 0 17px; }
.cn-list-title { font-size: 29px; font-weight: 680; letter-spacing: -0.045em; }
@media (max-width: 640px) {
  .cn-scroll { padding-inline: 16px; }
  .cn-list-top { padding-top: 23px; }
  .cn-list-title { font-size: 26px; }
  .cn-compose-fab { right: 18px; }
}
`
