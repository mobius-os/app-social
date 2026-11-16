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
.cn-root :where(input, textarea) { caret-color: var(--accent); }
.cn-scroll {
  flex: 1; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 14px 16px 32px;
  word-break: break-word; overflow-wrap: anywhere;
}
/* /mobius-ui:Root */
.cn-root ::selection { background: color-mix(in srgb, var(--accent) 48%, transparent); color: var(--text); }
.cn-scroll { order: 1; padding: 0 16px 24px; }
.cn-scroll.is-board { padding-bottom: 0; }
.cn-content { width: 100%; max-width: 696px; margin: 0 auto; }
.cn-screen { animation: cn-screen-in 0.26s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.cn-screen.has-dialog { animation: none; transform: none; }
@keyframes cn-screen-in {
  from { opacity: 0.4; transform: translateY(5px); }
  to { opacity: 1; transform: none; }
}

/* ── Page header: large title, account chip, full-width segmented tabs ── */
.cn-header {
  flex: 0 0 auto; position: relative; z-index: 20;
  display: flex; flex-direction: column; gap: 14px;
  padding: 28px 16px 12px;
  width: min(100%, 728px); margin-inline: auto;
  background: var(--bg);
}
.cn-header-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; }
.cn-title {
  margin: 0; font-size: 32px; line-height: 1.1; font-weight: 650; letter-spacing: -0.03em;
}
.cn-header-cog {
  width: 44px; height: 44px; margin-left: auto; padding: 0; flex: 0 0 auto;
  display: grid; place-items: center; border: 1px solid var(--border); border-radius: 50%;
  background: var(--surface); color: var(--muted); cursor: pointer;
  transition: color .15s ease, border-color .15s ease;
}
.cn-header-cog svg { width: 20px; height: 20px; }
.cn-header-cog:hover { color: var(--text); border-color: color-mix(in srgb, var(--text) 24%, var(--border)); }
/* Community settings: a large popup with a section list, like desktop chat-app settings. */
.cn-settings-scrim {
  position: fixed; inset: 0; z-index: 100; display: grid; place-items: center;
  padding: 24px; background: rgba(0, 0, 0, 0.55);
}
.cn-settings-page {
  position: relative; display: flex; width: min(960px, 100%); height: min(720px, 100%);
  overflow: hidden; border: 1px solid var(--border); border-radius: 20px; background: var(--bg);
  animation: cn-settings-in .18s ease-out both; outline: none;
}
@keyframes cn-settings-in { from { opacity: 0; transform: scale(1.01); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .cn-settings-page { animation: none; } }
.cn-settings-nav {
  flex: 0 0 auto; width: min(34%, 300px); display: flex; flex-direction: column; gap: 2px;
  padding: 36px 14px 24px;
  background: color-mix(in srgb, var(--surface) 55%, var(--bg)); overflow-y: auto;
}
.cn-settings-nav-heading {
  margin: 0 0 8px; padding: 0 12px; font-size: 13px; font-weight: 700; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cn-settings-nav-heading span { color: var(--text); }
.cn-settings-nav-item {
  min-height: 44px; padding: 0 12px; border: 0; border-radius: 10px; text-align: left;
  background: transparent; color: var(--muted); font: 550 16px/1.2 var(--font); cursor: pointer;
}
.cn-settings-nav-item:hover { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); }
.cn-settings-nav-item.is-active { background: color-mix(in srgb, var(--text) 10%, transparent); color: var(--text); }
.cn-settings-nav-item:focus-visible, .cn-settings-close button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cn-settings-main { flex: 1; min-width: 0; display: flex; gap: 20px; overflow-y: auto; padding: 36px 24px 32px 32px; }
.cn-settings-content { flex: 1; min-width: 0; max-width: 680px; }
.cn-settings-title { margin: 0; font-size: 22px; font-weight: 750; letter-spacing: -0.015em; }
.cn-settings-subtitle { margin: 4px 0 22px; color: var(--muted); font-size: 14.5px; line-height: 1.45; }
.cn-settings-section-title { margin: 26px 0 10px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.cn-settings-card {
  padding: 16px 18px; border: 1px solid var(--border); border-radius: 14px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
}
.cn-settings-card .cn-field-label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 650; }
.cn-settings-card .cn-field-label:first-child { margin-top: 0; }
.cn-settings-close { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 6px; position: sticky; top: 0; }
.cn-settings-close button {
  width: 40px; height: 40px; display: grid; place-items: center; padding: 0; cursor: pointer;
  border: 2px solid color-mix(in srgb, var(--text) 40%, transparent); border-radius: 50%;
  background: transparent; color: var(--muted);
}
.cn-settings-close button:hover { color: var(--text); border-color: var(--text); }
.cn-settings-close svg { width: 20px; height: 20px; }
.cn-settings-close span { font-size: 12px; font-weight: 700; color: var(--muted); }
.cn-role-guide { display: flex; flex-direction: column; gap: 12px; }
.cn-role-guide div { display: flex; flex-direction: column; gap: 2px; }
.cn-role-guide strong { font-size: 15px; }
.cn-role-guide span, .cn-role-guide-note { color: var(--muted); font-size: 13.5px; line-height: 1.4; }
.cn-role-guide-note { margin: 0; padding-top: 10px; border-top: 1px solid var(--border); }
.cn-permission-list.cn-settings-card { padding: 4px 14px; margin-top: 10px; }
@media (max-width: 719px) {
  .cn-settings-scrim { padding: 0; }
  .cn-settings-page { flex-direction: column; width: 100%; height: 100%; border: 0; border-radius: 0; }
  .cn-settings-nav { width: auto; flex-direction: row; align-items: center; gap: 6px; padding: 14px 64px 10px 16px; overflow-x: auto; }
  .cn-settings-nav-heading { display: none; }
  .cn-settings-nav-item { min-height: 40px; border-radius: 999px; white-space: nowrap; }
  .cn-settings-main { padding: 20px 16px 32px; }
  .cn-settings-close { position: absolute; top: 12px; right: 12px; }
  .cn-settings-close span { display: none; }
}
.cn-permissions .cn-input[type="search"] { margin-bottom: 6px; }
.cn-permission-list { list-style: none; margin: 0; padding: 0; }
.cn-permission-row {
  display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 6px 0;
}
.cn-permission-row + .cn-permission-row { border-top: 1px solid var(--border); }
.cn-permission-name { flex: 1; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 0 2px; }
.cn-permission-name strong { font-size: 14.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; }
.cn-permission-member { margin-left: 8px; color: var(--muted); font-size: 12.5px; }
.cn-role-select {
  flex: 0 0 auto; min-width: 112px; min-height: 38px; padding: 0 34px 0 14px;
  border: 1px solid var(--border); border-radius: 999px; cursor: pointer;
  -webkit-appearance: none; appearance: none;
  background: var(--surface-2, var(--surface)) no-repeat right 12px center / 12px 12px
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23999' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5'/%3E%3C/svg%3E");
  color: var(--text); font: 600 14px var(--font);
  transition: border-color .15s ease;
}
.cn-role-select:hover { border-color: color-mix(in srgb, var(--text) 28%, var(--border)); }
.cn-role-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cn-role-select:disabled { opacity: .5; cursor: default; }
.cn-handover {
  margin: 0 0 12px; padding: 12px 14px; border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
  background: color-mix(in srgb, var(--danger) 8%, var(--surface));
}
.cn-handover p { margin: 0 0 10px; font-size: 14px; line-height: 1.5; }
.cn-handover .cn-sheet-actions { margin: 0; }
.cn-header-note { margin: -2px 2px 0; color: var(--muted); font-size: 14px; line-height: 1.45; }
.cn-header-chip {
  display: inline-flex; align-items: center; gap: 8px;
  min-height: 44px; max-width: 55%; padding: 4px 14px 4px 5px; border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border); font-size: 13px; font-weight: 600;
  color: var(--text);
}
.cn-header-chip.is-loading { width: 104px; }
.cn-header-chip-avatar-skeleton, .cn-header-chip-line-skeleton {
  display: block; flex: 0 0 auto;
  background: color-mix(in srgb, var(--surface-2, var(--surface)) 84%, transparent);
  animation: cn-skeleton-pulse 1.4s ease-in-out infinite alternate;
}
.cn-header-chip-avatar-skeleton { width: 30px; height: 30px; border-radius: 50%; }
.cn-header-chip-line-skeleton { width: 46px; height: 10px; border-radius: 5px; }

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
/* Flat, divided rows: avatar, handle with the time on the right, text, actions. */
.cn-feed { padding-top: 4px; }
.cn-post {
  display: grid; grid-template-columns: 36px minmax(0, 1fr); column-gap: 12px;
  padding: 14px 0 10px;
  position: relative; cursor: pointer;
}
.cn-post + .cn-post { border-top: 1px solid var(--border); }
.cn-post > .cn-avatar, .cn-post > .cn-avatar-btn .cn-avatar-visual { width: 36px; height: 36px; font-size: 13px; }
.cn-post > .cn-avatar-btn { min-width: 44px; min-height: 44px; margin: -4px; padding: 0; }
.cn-post.is-pending { cursor: default; }
.cn-post > .cn-avatar, .cn-post > .cn-avatar-btn { grid-column: 1; grid-row: 1; align-self: start; }
.cn-post-main { grid-column: 2; min-width: 0; }
.cn-post-head { min-height: 22px; display: flex; align-items: center; gap: 8px; }
.cn-post-time { margin-left: auto; flex: 0 0 auto; font-size: 12.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cn-post-head > .cn-own-actions { background: var(--bg); }
.cn-role-label {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px; margin-left: 6px;
  border-radius: 999px; vertical-align: 1px;
  background: color-mix(in srgb, var(--text) 9%, transparent);
  color: var(--muted); font: 650 11.5px/1 var(--font); letter-spacing: .01em;
}
.cn-profile-name .cn-role-label { vertical-align: 4px; }
.cn-role-manage { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.cn-role-manage h4 { margin: 0 0 8px; color: var(--muted); font: 650 13px/1.2 var(--font); }
.cn-role-manage .cn-sheet-actions { flex-wrap: wrap; }
.cn-role-label.is-owner {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent-text, var(--accent));
}
.cn-own-actions {
  position: absolute; top: 7px; right: 0; display: flex; gap: 0;
  transition: opacity .14s ease;
}
.cn-own-actions.is-compact { position: static; margin-left: auto; align-self: center; }
.cn-own-action {
  width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--muted); cursor: pointer;
  transition: background .14s ease, color .14s ease, transform .1s ease;
}
.cn-own-actions.is-compact .cn-own-action { width: 32px; height: 32px; margin: -6px 0; }
.cn-own-action:hover { color: var(--text); background: color-mix(in srgb, var(--text) 8%, transparent); }
.cn-own-action.is-danger:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.cn-own-action:active { transform: scale(.94); }
.cn-own-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.cn-own-action:disabled { opacity: .4; cursor: default; }
.cn-own-action svg { width: 17px; height: 17px; }
.cn-own-actions.is-compact .cn-own-action svg { width: 15px; height: 15px; }
@media (hover: hover) and (pointer: fine) {
  .cn-own-actions { opacity: 0; }
  .cn-reply-row:hover .cn-own-actions,
  .cn-own-actions:focus-within { opacity: 1; }
  /* Separate rule: a browser without :has() drops only this one. */
  .cn-post:hover:not(:has(.cn-inline-replies:hover, .cn-reply-composer:hover)) .cn-post-head > .cn-own-actions { opacity: 1; }
}
.cn-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.cn-edited { margin-left: 5px; font-size: 12px; color: var(--muted); font-weight: 400; }
.cn-inline-edit { margin-top: 4px; }
.cn-inline-edit-field {
  display: block; width: 100%; min-height: 40px; max-height: 320px; resize: none; overflow-y: auto;
  padding: 9px 12px; border-radius: 12px; border: 1px solid var(--accent);
  background: var(--surface); color: var(--text);
  font: inherit; font-size: 15px; line-height: 1.45;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
}
.cn-inline-edit-field:focus { outline: none; }
.cn-inline-edit-bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.cn-inline-edit-hint { flex: 1; min-width: 0; font-size: 12px; color: var(--muted); }
.cn-inline-edit-hint kbd {
  font: inherit; font-size: 11px; padding: 1px 5px; border-radius: 5px;
  border: 1px solid var(--border); background: var(--surface-2);
}
.cn-btn.cn-btn-small { min-height: 36px; padding: 0 14px; font-size: 13.5px; }
@media (hover: none) {
  .cn-own-action, .cn-own-actions.is-compact .cn-own-action { width: 44px; height: 44px; }
  .cn-own-actions.is-compact .cn-own-action { margin: -12px 0; }
  .cn-post.is-mine .cn-post-head, .cn-post.is-moderated .cn-post-head { padding-right: 92px; }
}
@media (hover: hover) and (pointer: fine) {
  .cn-post-head > .cn-own-actions { top: 4px; }
}
@media (hover: none) {
  .cn-inline-edit-hint { visibility: hidden; }
  .cn-btn.cn-btn-small { min-height: 44px; }
}
.cn-person {
  padding: 0; border: 0; background: transparent; text-align: left; color: inherit;
  font-family: var(--font); cursor: pointer; min-height: 24px; min-width: 0;
  display: flex; align-items: baseline; gap: 4px;
}
.cn-person-name { font-size: 14px; font-weight: 700; line-height: 1.25; letter-spacing: -0.018em; }
.cn-person:disabled { cursor: default; }
.cn-meta { font-size: 13px; color: var(--muted); }
.cn-post-dot { color: var(--muted); font-size: 13px; }
.cn-post-copy {
  font-size: 15px; line-height: 1.5; margin: 4px 0 0;
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

.cn-board-chat { min-height: 100%; display: flex; flex-direction: column; }
.cn-board-join {
  display: flex; align-items: center; gap: 12px;
  max-width: 696px; margin-inline: auto; min-height: 56px; padding: 5px 5px 5px 20px;
  border: 1px solid var(--border); border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  backdrop-filter: blur(16px) saturate(140%); -webkit-backdrop-filter: blur(16px) saturate(140%);
  pointer-events: auto;
}
.cn-board-join-text { flex: 1; min-width: 0; color: var(--muted); font-size: 15px; }
.cn-board-join .cn-btn { min-height: 44px; padding: 0 20px; border-radius: 999px; }
.cn-composer-disclosure {
  margin: 7px 4px 0 56px; color: var(--muted); font-size: 12px; line-height: 1.35;
}

/* Reactions + compose */
.cn-post-actions { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 2px 0 0 -10px; max-width: 460px; }
.cn-react {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 44px; min-width: 44px; padding: 0 10px; border-radius: 999px;
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
.cn-reaction-chip {
  box-sizing: border-box; width: auto; min-width: 44px; height: 44px; padding: 0; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  border: 0; background: transparent; color: var(--muted); font: 650 12px var(--font); cursor: pointer;
  transition: transform .1s ease;
}
.cn-reaction-visual {
  min-width: 30px; height: 30px; padding: 3px 10px; border-radius: 999px;
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
/* Float without moving the post. The picker chooses the roomier side when
   the feed edge or composer would cover its choices. */
.cn-reaction-picker {
  position: absolute; z-index: 30; left: 0; top: calc(100% + 6px);
  width: max-content; max-width: 100%; padding: 10px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 12px 32px color-mix(in srgb, #000 38%, transparent);
  animation: cn-reaction-in .16s cubic-bezier(.2,.8,.2,1) both;
}
.cn-reaction-picker.is-above { top: auto; bottom: calc(100% + 6px); }
.cn-reaction-picker.is-bounded { overflow-y: auto; overscroll-behavior: contain; }
.cn-reactions.is-reply { flex-wrap: wrap; }
.cn-reactions.is-reply .cn-reaction-picker {
  position: relative; top: auto; left: auto; right: auto;
  flex-basis: 100%; width: 100%; min-width: 0; max-width: 100%;
}
.cn-reactions.is-reply .cn-reaction-grid { grid-template-columns: repeat(auto-fit, 44px); }
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
.cn-reply-icon { width: 15px; height: 15px; flex: 0 0 auto; }
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
  position: relative; width: 100%; min-width: 0; max-height: min(360px, 48vh);
  margin: 6px 0 4px; padding-left: 16px; overflow: hidden;
  display: flex; flex-direction: column;
  border: 0; border-left: 1px solid color-mix(in srgb, var(--border) 55%, var(--bg)); border-radius: 0;
  background: transparent; cursor: default;
}
/* Replies read as a quiet indented list: handle, text, no avatars or dividers. */
/* Inner room so hover states and 44px buttons aren't clipped by the scroller. */
.cn-inline-replies { flex: 0 1 auto; min-height: 0; overflow-y: auto; margin-left: -12px; padding: 4px 8px 4px 12px; overscroll-behavior: contain auto; }
.cn-inline-replies .cn-reply-row { padding: 6px 0 8px; gap: 0; }
.cn-inline-replies .cn-reply-row + .cn-reply-row { border-top: 0; }
.cn-inline-replies .cn-reactions.is-reply { margin: -6px 0 -10px -8px; }
.cn-inline-replies .cn-reply-copy p { margin-top: 2px; }
.cn-inline-replies .cn-reply-row > .cn-avatar,
.cn-inline-replies .cn-reply-row > .cn-avatar-btn { display: none; }
.cn-thread-loading { min-height: 48px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--muted); font-size: 13px; }
.cn-inline-thread .cn-reply-composer { padding: 0; background: transparent; }
.cn-confirm-sheet { max-width: 420px; }
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
  display: block; background: color-mix(in srgb, var(--surface-2, var(--surface)) 84%, transparent);
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
  width: 100%; min-height: 68px; padding: 12px 8px; display: flex; align-items: center; gap: 13px;
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
  display: block; font-size: 13.5px; color: var(--muted); margin-top: 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Chats inbox: collapsible sections, chevron rows, floating + button. */
.cn-inbox { padding-bottom: 96px; }
.cn-inbox-section + .cn-inbox-section { margin-top: 8px; }
.cn-inbox-heading { margin: 0; }
.cn-inbox-heading button {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 8px 0 0;
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  font: 600 14px/1 var(--font);
}
.cn-inbox-heading button:hover { color: var(--text); }
.cn-inbox-heading button > span:first-of-type { color: var(--text); }
.cn-inbox-count { font-variant-numeric: tabular-nums; }
.cn-inbox-chevron { width: 16px; height: 16px; transition: transform .15s ease; }
.cn-inbox-chevron.is-closed { transform: rotate(-90deg); }
.cn-inbox .cn-row { min-height: 72px; padding: 12px 4px 12px 0; gap: 14px; border-radius: 0; }
.cn-inbox .cn-row:hover, .cn-inbox .cn-row:active { background: transparent; }
.cn-inbox .cn-row:hover .cn-row-top strong { text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--text) 30%, transparent); }
.cn-inbox .cn-row + .cn-row::before { left: 0; right: 0; opacity: 1; }
.cn-inbox .cn-row-avatar > .cn-avatar { width: 36px; height: 36px; font-size: 12px; border-radius: 50%; }
.cn-inbox .cn-row-top strong { font-size: 15px; font-weight: 650; }
.cn-inbox .cn-preview { font-size: 14.5px; color: var(--text); opacity: .86; margin-top: 4px; }
/* Unread chats: bold name and preview, and a 2pt accent ring at 80% opacity around the avatar, set off by a 1pt background-coloured gap. */
.cn-inbox .cn-row.is-unread .cn-row-top strong { font-weight: 800; }
.cn-inbox .cn-row.is-unread .cn-preview { font-weight: 650; opacity: 1; }
.cn-inbox .cn-row.is-unread .cn-row-avatar > .cn-avatar { box-shadow: 0 0 0 1pt var(--bg), 0 0 0 3pt color-mix(in srgb, var(--accent) 80%, transparent); }
.cn-row-avatar { position: relative; display: inline-flex; flex: 0 0 auto; }
/* Unread count as a small round badge on the avatar's top-right corner. */
.cn-row-avatar .cn-unread-count {
  position: absolute; right: -4px; top: -4px;
  min-width: 14px; height: 14px; padding: 0 2px; border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 28%, var(--surface)); color: var(--text);
  border: 2px solid var(--bg); box-sizing: content-box; font: 650 10px/1 var(--font); /* compact badge: below the 12px floor by design */
}
.cn-row-end { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; align-self: center; }
.cn-unread-count {
  min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 22%, var(--surface)); color: var(--text);
  font: 700 12px/1 var(--font); font-variant-numeric: tabular-nums;
}
.cn-row-chevron { width: 16px; height: 16px; color: var(--muted); }
.cn-fab-wrap {
  position: fixed; z-index: 30;
  right: max(16px, calc((100% - 696px) / 2));
  bottom: calc(20px + var(--mobius-safe-bottom, 0px));
  display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
}
.cn-fab {
  width: 56px; height: 56px; padding: 0; border: 0; border-radius: 50%;
  display: grid; place-items: center; cursor: pointer;
  background: var(--accent-fill, var(--accent)); color: var(--accent-fg);
  transition: filter .14s ease, transform .1s ease;
}
.cn-fab svg { width: 24px; height: 24px; transition: transform .18s ease; }
.cn-fab[aria-expanded="true"] svg { transform: rotate(45deg); }
.cn-fab:hover { background: var(--accent-fill-hover, var(--accent-fill, var(--accent))); }
.cn-fab:active { transform: scale(.94); }
.cn-view-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0 8px; }
.cn-view-heading h2 { margin: 0; font-size: 24px; line-height: 1.2; font-weight: 700; letter-spacing: -0.025em; }
.cn-view-heading p { margin: 4px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.cn-directory-error { padding: 12px 0; color: var(--muted); font-size: 14px; }
.cn-directory-error p { margin: 0 0 8px; }
.cn-search-clear { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; min-height: 44px; padding: 0 6px; border: 0; background: transparent; color: var(--muted); font: 600 13px var(--font); cursor: pointer; }
.cn-search-status { margin: 10px 0 0; font-size: 13px; color: var(--muted); }
.cn-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.cn-dialog-head .cn-sheet-title { margin: 0; }

/* ── Search field ───────────────────────────────────────────────────────── */
.cn-search {
  min-height: 48px; border-radius: 15px;
  background: color-mix(in srgb, var(--surface-2, var(--surface)) 80%, transparent);
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
  min-height: 52px; padding: 4px 12px;
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
}
.cn-thread-bar::after {
  content: ""; position: absolute; left: 14px; right: 14px; bottom: 0; height: 1px;
  background: var(--border); opacity: 0.7;
}
/* "‹ Chats" back link on its own line above the chat's name. */
.cn-thread-back-row { flex: 0 0 auto; padding: 6px 12px 0; }
.cn-back-link {
  display: inline-flex; align-items: center; gap: 4px; min-height: 36px; padding: 0 6px 0 2px;
  border: 0; border-radius: 8px; background: transparent; cursor: pointer;
  color: var(--muted); font: 500 16px/1 var(--font);
}
.cn-back-link svg { width: 18px; height: 18px; }
.cn-back-link:hover { color: var(--text); }
.cn-back-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
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
.cn-message-log { display: flex; flex-direction: column; gap: 8px; container-type: inline-size; }
.cn-history-more {
  align-self: center; min-height: 44px; padding: 7px 13px; margin-bottom: 4px;
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
  background: color-mix(in srgb, var(--surface-2, var(--surface)) 80%, transparent);
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
  border-radius: 20px; background: var(--surface); color: var(--text); align-self: flex-start;
  border: 1px solid color-mix(in srgb, var(--text) 14%, transparent);
  white-space: pre-wrap;
  animation: cn-bubble-in 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes cn-bubble-in {
  from { opacity: 0; transform: translateY(6px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
/* Every bubble shares one dark, outlined, fully rounded look; only the side differs. */
.cn-bubble.is-mine { align-self: flex-end; }
.cn-bubble-time {
  display: block; margin-top: 3px; font-size: 10.5px; opacity: 0.62; text-align: right;
  user-select: none; -webkit-user-select: none;
}
.cn-bubble.is-failed { border-color: var(--danger); }
/* Readable text beside a danger icon. The 44px target reaches into the 8px
   list gaps on both sides but never over the bubble or reply button. */
.cn-failed-note {
  appearance: none; border: 0; background: transparent; padding: 0 4px;
  min-height: 44px; display: inline-flex; align-items: center; gap: 4px;
  font: inherit; font-size: 12px; font-weight: 650; color: var(--text); cursor: pointer;
  align-self: flex-end; margin: -8px 0;
}
.cn-failed-note svg { width: 14px; height: 14px; flex: 0 0 auto; color: var(--danger); }
.cn-failed-note:disabled { cursor: default; opacity: 0.65; }
.cn-delivery-note { display: flex; flex-direction: column; align-items: flex-end; align-self: flex-end; max-width: min(100%, 440px); }
.cn-delivery-note .cn-failed-note { margin: 0; }
.cn-delivery-reason { color: var(--muted); font-size: 14px; line-height: 1.45; padding: 0 8px 6px; text-align: right; overflow-wrap: anywhere; }
.cn-message-line {
  width: 92%; display: flex; align-items: flex-end; gap: 6px; align-self: flex-start;
}
.cn-message-line.is-mine { align-self: flex-end; justify-content: flex-end; }
.cn-message-avatar { width: 30px; min-width: 30px; min-height: 1px; display: flex; align-items: flex-end; }
.cn-message-avatar .cn-avatar { margin-bottom: 2px; }
.cn-message-line > .cn-bubble { align-self: auto; max-width: calc(100% - 50px); }
.cn-message-line.is-theirs > .cn-bubble { max-width: calc(100% - 86px); }
.cn-bubble-copy {
  display: block; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
  user-select: text; -webkit-user-select: text; cursor: text;
}
.cn-bubble-copy * { user-select: text; -webkit-user-select: text; }
.cn-bubble-copy a { color: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.cn-bubble-copy a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
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
.cn-message-line.is-mine .cn-bubble-reply { order: -1; }
.cn-message-line:hover .cn-bubble-reply,
.cn-bubble-reply:focus-visible { opacity: 1; pointer-events: auto; }
.cn-bubble-reply:hover { background: var(--surface-2, var(--surface)); color: var(--text); }
.cn-bubble-actions { display: flex; align-items: center; flex: 0 0 auto; }
.cn-message-line.is-mine .cn-bubble-actions { order: -1; }
.cn-bubble-react[aria-expanded="true"] { opacity: 1; pointer-events: auto; color: var(--accent-text, var(--accent)); }
/* Reactions get their own line, tucked under the bubble and indented past
   the avatar column; the 44px chips reach into the gap above. */
.cn-message-reactions {
  flex: 0 0 auto; gap: 2px; width: 92%; align-self: flex-start;
  margin: -12px 0 -4px; padding-left: 36px;
}
.cn-message-reactions.is-mine { align-self: flex-end; justify-content: flex-end; padding-left: 0; }
/* An unconfirmed reaction's retry sits on the reacted message's side. */
.cn-reaction-note.is-theirs { align-self: flex-start; align-items: flex-start; padding-left: 36px; }
.cn-reaction-note.is-theirs .cn-delivery-reason { text-align: left; }
.cn-reaction-note.is-theirs .cn-failed-note { align-self: flex-start; }
/* Its own width, so a one-word bubble still gets a full grid of choices. */
/* Chat messages: the full picker opens in the middle of the screen, fully visible. */
.cn-message-reactions .cn-reaction-picker {
  position: fixed; inset: 0; z-index: 120; margin: auto;
  width: min(340px, calc(100vw - 32px)); max-width: none; height: max-content; max-height: min(70vh, 520px);
  overflow-y: auto; overscroll-behavior: contain;
}
.cn-message-reactions .cn-reaction-grid { grid-template-columns: repeat(auto-fill, 44px); }
.cn-quote {
  margin: 0 0 7px; padding: 7px 9px; min-width: 0;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  color: var(--text); white-space: normal;
  user-select: text; -webkit-user-select: text; cursor: text;
}
.cn-bubble.has-attachment .cn-quote { margin: 3px 3px 5px; }
.cn-quote strong, .cn-quote span { display: block; min-width: 0; }
.cn-quote strong { font-size: 11.5px; line-height: 1.3; font-weight: 750; }
.cn-quote span {
  margin-top: 2px; font-size: 12px; line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.78;
}
.cn-file-input { display: none; }
.cn-reply-target button {
  width: 44px; height: 44px; border: 0; border-radius: 50%; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: transparent; color: var(--muted);
}
.cn-reply-target button:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text);
}
.cn-reply-target button svg { width: 18px; height: 18px; }
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
  overflow: hidden; border: 0; background: var(--surface-2, var(--surface)); color: var(--muted);
  cursor: zoom-in;
}
.cn-media:disabled { cursor: default; }
.cn-media.is-transparent { background: transparent; }
.cn-media img {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block; object-fit: cover;
}
.cn-media-state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.cn-media-state svg { width: 24px; height: 24px; opacity: 0.55; }
.cn-media-gif {
  position: absolute; bottom: 8px; left: 8px; padding: 3px 6px;
  border-radius: 5px; background: var(--surface); color: var(--text);
  font: 650 11px var(--font); pointer-events: none;
}
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
  display: flex; align-items: center; gap: 8px;
  min-width: 0; max-width: 100%; overflow-x: auto;
  margin: 0; padding: 2px 6px 4px; scrollbar-width: none;
}
.cn-selected-gallery::-webkit-scrollbar { display: none; }
.cn-selected-thumb {
  position: relative; width: 96px; height: 96px; border-radius: 14px;
  overflow: hidden; background: var(--surface-2, var(--surface));
  border: 1px solid var(--border); flex: 0 0 auto;
}
.cn-selected-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cn-selected-preview {
  width: 100%; height: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in;
}
.cn-selected-remove {
  position: absolute; top: 0; right: 0; width: 44px; height: 44px;
  padding: 0; border: 0; cursor: pointer; background: transparent; color: #fff;
  display: flex; align-items: center; justify-content: center;
}
.cn-selected-remove::before {
  content: ''; position: absolute; top: 4px; right: 4px; width: 20px; height: 20px;
  border-radius: 50%; background: rgba(0, 0, 0, 0.6);
}
.cn-selected-remove svg { position: absolute; top: 7.5px; right: 7.5px; width: 13px; height: 13px; }
.cn-selected-remove:hover::before { background: rgba(0, 0, 0, 0.8); }
.cn-selected-remove:disabled { opacity: .42; cursor: default; }
.cn-selected-preview:focus-visible, .cn-selected-remove:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 13px; }

/* Message hover toolbar: recent reactions, all reactions, Reply, More. */
.cn-message-line { position: relative; outline: none; }
.cn-bubble-wrap { position: relative; display: flex; min-width: 0; max-width: 80%; }
.cn-bubble-wrap > .cn-bubble { max-width: 100%; min-width: 0; }
.cn-msg-toolbar {
  position: absolute; z-index: 8; top: -22px; display: flex; align-items: center; gap: 2px; padding: 3px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
  box-shadow: 0 6px 18px color-mix(in srgb, #000 30%, transparent);
  opacity: 0; pointer-events: none; transition: opacity .12s ease;
}
/* Both grow inward from the conversation's edge, so they never leave it: yours
   from the bubble's top-right, theirs from the start of the message row (the
   row, not the bubble, positions it) and never wider than the conversation. */
.cn-message-line.is-theirs .cn-bubble-wrap { position: static; }
.cn-message-line.is-theirs .cn-msg-toolbar { left: 0; width: max-content; max-width: 100cqw; flex-wrap: wrap; }
.cn-message-line.is-mine .cn-msg-toolbar { right: 10px; }
.cn-message-line.is-mine .cn-msg-menu { left: auto; right: 0; }
.cn-message-line.is-mine .cn-msg-toolbar .cn-bubble-reply { order: 0; }
.cn-message-line:hover .cn-msg-toolbar, .cn-message-line:focus-within .cn-msg-toolbar, .cn-msg-toolbar.is-open {
  opacity: 1; pointer-events: auto;
}
.cn-msg-tool, .cn-msg-toolbar .cn-bubble-reply {
  width: 32px; height: 32px; display: grid; place-items: center; padding: 0; flex: 0 0 auto;
  border: 0; border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer;
  opacity: 1; pointer-events: auto;
}
.cn-msg-tool svg, .cn-msg-toolbar .cn-bubble-reply svg { width: 18px; height: 18px; }
.cn-msg-tool .cn-flat-emoji, .cn-msg-tool img { width: 20px; height: 20px; font-size: 18px; line-height: 1; }
.cn-msg-tool:hover, .cn-msg-toolbar .cn-bubble-reply:hover { background: var(--surface-2, color-mix(in srgb, var(--text) 8%, transparent)); color: var(--text); }
.cn-msg-tool.is-reacted { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.cn-msg-tool:focus-visible, .cn-msg-toolbar .cn-bubble-reply:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.cn-msg-tool:disabled { opacity: .45; cursor: default; }
.cn-msg-more { position: relative; display: flex; }
.cn-msg-menu {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 9; min-width: 160px; padding: 4px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
  box-shadow: 0 10px 28px color-mix(in srgb, #000 36%, transparent);
}
.cn-msg-menu button {
  width: 100%; min-height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 10px;
  border: 0; border-radius: 8px; background: transparent; color: var(--text); font: 500 14px var(--font); cursor: pointer; text-align: left;
}
.cn-msg-menu button svg { width: 16px; height: 16px; color: var(--muted); }
.cn-msg-menu button:hover, .cn-msg-menu button:focus-visible { background: color-mix(in srgb, var(--text) 8%, transparent); outline: none; }
.cn-bubble-edited { margin-right: 6px; font-style: italic; opacity: .8; }
/* While you edit a message, its toolbar steps aside. */
.cn-message-line.is-editing .cn-msg-toolbar { display: none; }
.cn-bubble-editor { display: flex; flex-direction: column; gap: 6px; min-width: min(320px, 60vw); }
.cn-bubble-editor textarea {
  width: 100%; resize: none; max-height: 45vh; overflow-y: auto; padding: 8px 10px; border-radius: 12px;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  background: color-mix(in srgb, var(--bg) 55%, transparent); color: var(--text);
  font: inherit; font-size: 16px; line-height: 1.4; white-space: pre-wrap;
}
.cn-bubble-editor textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.cn-bubble-editor-actions { display: flex; justify-content: flex-end; align-items: center; gap: 0; margin-bottom: -4px; }
.cn-edit-icon {
  position: relative; width: 30px; height: 32px; display: grid; place-items: center; padding: 0; cursor: pointer;
  border: 0; background: transparent; color: inherit;
}
/* The visible circle stays small; on touch the button keeps a 44px target around it. */
.cn-edit-icon::before {
  content: ""; position: absolute; left: 50%; top: 50%; width: 26px; height: 26px; transform: translate(-50%, -50%);
  border-radius: 50%; background: color-mix(in srgb, var(--text) 12%, transparent);
}
.cn-edit-icon svg { position: relative; width: 15px; height: 15px; }
.cn-edit-icon:hover::before { background: color-mix(in srgb, var(--text) 20%, transparent); }
.cn-edit-icon.is-save:hover::before { background: var(--text); opacity: .85; }
.cn-edit-icon.is-save { color: var(--bg); }
.cn-edit-icon.is-save::before { background: var(--text); }
.cn-edit-icon:disabled { opacity: .5; cursor: default; }
.cn-edit-icon:focus-visible { outline: none; }
.cn-edit-icon:focus-visible::before { outline: 2px solid var(--accent); outline-offset: 2px; }
/* On touch each button stays 44px tall; the tap areas of the two side-by-side icons
   overlap a little so the circles sit close together. */
@media (hover: none) { .cn-edit-icon { width: 44px; height: 44px; margin: 0 -6px; } }
/* A message being edited gets more room around its editor. */
.cn-bubble.is-editing { padding: 14px 16px 12px; }
.cn-bubble-editor-error { margin: 0; font-size: 13px; color: var(--danger-text, var(--danger)); }
/* Soft glow on the message being pointed at (or whose toolbar is open). */
.cn-bubble-wrap > .cn-bubble { transition: box-shadow .15s ease; }
.cn-message-line:hover .cn-bubble, .cn-message-line:focus-within .cn-bubble, .cn-bubble-wrap:has(.cn-msg-toolbar.is-open) .cn-bubble {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent), 0 0 18px color-mix(in srgb, var(--accent) 35%, transparent);
}
@media (prefers-reduced-motion: reduce) { .cn-msg-toolbar, .cn-bubble-wrap > .cn-bubble { transition: none; } }
@media (hover: none) {
  .cn-msg-tool, .cn-msg-toolbar .cn-bubble-reply { width: 44px; height: 44px; }
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

/* ── Segmented navigation: three equal pills in one rounded track ─────── */
.cn-nav {
  display: flex; align-items: stretch; gap: 4px; padding: 3px;
  border: 1px solid var(--border); border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
}
.cn-nav-item {
  flex: 1 1 0; min-width: 0; min-height: 44px; padding: 0 10px;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  border: 1px solid transparent; border-radius: 999px; background: transparent;
  color: var(--muted); font: 600 15px/1 var(--font); cursor: pointer;
  position: relative; transition: color .15s ease, background .15s ease, border-color .15s ease;
}
.cn-nav-item svg { width: 16px; height: 16px; flex: 0 0 auto; }
.cn-nav-slot { flex: 1 1 0; min-width: 0; position: relative; display: flex; }
.cn-nav-slot > .cn-nav-item { flex: 1 1 auto; }
.cn-nav-slot.has-cog > .cn-nav-item { padding-inline: 44px; }
.cn-nav-cog {
  position: absolute; top: 50%; right: 6px; transform: translateY(-50%);
  width: 34px; height: 34px; display: grid; place-items: center; padding: 0;
  border: 0; border-radius: 50%; background: transparent; color: var(--muted); cursor: pointer;
}
.cn-nav-cog svg { width: 18px; height: 18px; }
.cn-nav-cog:hover { color: var(--text); background: color-mix(in srgb, var(--text) 8%, transparent); }
.cn-nav-cog:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.cn-nav-item:hover { color: var(--text); }
.cn-nav-item.is-active {
  color: var(--text);
  background: var(--surface-2, var(--surface));
  border-color: color-mix(in srgb, var(--text) 16%, var(--border));
}
.cn-badge {
  position: absolute; top: 50%; right: 12px; transform: translateY(-50%);
  min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 8px; background: var(--accent); color: var(--accent-fg);
  font-size: 9.5px; font-weight: 750; display: flex; align-items: center; justify-content: center;
}
.cn-nav-dot {
  position: absolute; top: 50%; right: 14px; margin-top: -4.5px;
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
  background: color-mix(in srgb, var(--surface-2, var(--surface)) 72%, transparent);
  box-shadow: none;
}
.cn-intent-notice > div { min-width: 0; }
.cn-intent-notice strong, .cn-intent-notice span { display: block; }
.cn-intent-notice strong { font-size: 14px; line-height: 1.35; letter-spacing: -0.01em; }
.cn-intent-notice span { margin-top: 3px; color: var(--muted); font-size: 12.5px; line-height: 1.45; }
.cn-intent-notice .cn-btn { flex: 0 0 auto; }
.cn-intent-notice.is-error { color: var(--danger); }
.cn-intent-actions { display: flex; flex: 0 0 auto; gap: 6px; }

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
/* Long scrolling sheets skip the blur: re-blurring the page behind every scroll frame roughly doubled frame time. */
.cn-scrim.cn-scrim-plain { backdrop-filter: none; -webkit-backdrop-filter: none; }
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
.cn-post-compose { display: flex; align-items: flex-start; gap: 11px; }
.cn-post-compose .cn-avatar { margin-top: 5px; }
.cn-post-compose .cn-textarea { min-width: 0; flex: 1; min-height: 132px; }
.cn-post-sheet-actions {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 14px;
}

/* Full-app image viewer. */
.cn-lightbox {
  position: absolute; inset: 0; z-index: 300;
  display: flex; align-items: center; justify-content: center;
  padding: max(18px, env(safe-area-inset-top)) 14px max(18px, env(safe-area-inset-bottom));
  background: rgba(5, 5, 8, 0.9); animation: cn-lightbox-in 0.16s ease-out both;
}
.cn-lightbox-stage {
  position: absolute; inset: 0; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  padding: max(18px, env(safe-area-inset-top)) 14px max(76px, env(safe-area-inset-bottom));
  touch-action: none; cursor: zoom-in;
}
.cn-lightbox-stage.is-zoomed { cursor: grab; }
.cn-lightbox-stage.is-zoomed:active { cursor: grabbing; }
.cn-lightbox-stage > img {
  max-width: 100%; max-height: 100%; object-fit: contain; display: block;
  border-radius: 10px; user-select: none; will-change: transform;
  animation: cn-lightbox-image-in 0.16s ease-out both;
}
.cn-lightbox-close {
  position: absolute; z-index: 2; top: max(12px, env(safe-area-inset-top)); right: 12px;
  width: 46px; height: 46px; border: 1px solid rgba(255,255,255,0.2); border-radius: 50%;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: rgba(18,18,22,0.82); color: #fff;
}
.cn-lightbox-close:hover { background: rgba(42,42,48,0.92); }
.cn-lightbox-close svg { width: 21px; height: 21px; }
.cn-lightbox-controls {
  position: absolute; z-index: 2; left: 50%; bottom: max(14px, env(safe-area-inset-bottom));
  transform: translateX(-50%); display: flex; align-items: center; gap: 2px;
  padding: 4px; border: 1px solid rgba(255,255,255,0.18); border-radius: 25px;
  background: rgba(18,18,22,0.86); color: #fff;
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
}
.cn-lightbox-controls button {
  min-width: 44px; height: 44px; padding: 0 10px; border: 0; border-radius: 22px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: inherit; cursor: pointer; font: 650 12px var(--font);
}
.cn-lightbox-controls button:hover { background: rgba(255,255,255,0.1); }
.cn-lightbox-controls button:disabled { opacity: .35; cursor: default; }
.cn-lightbox-controls svg { width: 19px; height: 19px; }
.cn-lightbox-reset { min-width: 58px !important; font-variant-numeric: tabular-nums; }
.cn-lightbox-gallery {
  position: absolute; z-index: 2; top: max(12px, var(--mobius-safe-top, 0px)); left: 12px;
  display: flex; align-items: center; gap: 4px; padding: 2px;
  border: 1px solid rgba(255,255,255,.2); border-radius: 25px;
  background: rgba(18,18,22,.9); color: #fff;
}
.cn-lightbox-gallery button, .cn-lightbox-status button {
  min-width: 44px; min-height: 44px; border: 0; border-radius: 22px;
  background: transparent; color: inherit; cursor: pointer;
}
.cn-lightbox-gallery button:hover, .cn-lightbox-status button:hover { background: rgba(255,255,255,.1); }
.cn-lightbox-gallery button:disabled { opacity: .35; cursor: default; }
.cn-lightbox-gallery svg { width: 22px; height: 22px; }
.cn-lightbox-gallery span { min-width: 44px; text-align: center; font: 650 14px var(--font); font-variant-numeric: tabular-nums; }
.cn-lightbox-status { display: grid; gap: 12px; text-align: center; color: #fff; font-size: 16px; }
.cn-lightbox-status button { padding: 0 16px; border: 1px solid rgba(255,255,255,.3); font: inherit; }
.cn-lightbox button:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
@keyframes cn-lightbox-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes cn-lightbox-image-in { from { opacity: .7; } to { opacity: 1; } }

/* Board conversations */
.cn-reply-row {
  display: flex; align-items: flex-start; gap: 11px; padding: 13px 2px;
  animation: cn-reply-in 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.cn-reply-row + .cn-reply-row { border-top: 1px solid color-mix(in srgb, var(--border) 62%, transparent); }
.cn-reply-row.is-pending { opacity: 0.68; }
.cn-reply-copy { flex: 1; min-width: 0; }
.cn-reply-image { max-width: 100%; max-height: 180px; margin-top: 6px; border-radius: 10px; }
.cn-reply-image img { object-fit: contain; }
.cn-reply-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.cn-reply-meta strong { font-size: 13.5px; font-weight: 720; letter-spacing: -0.008em; }
.cn-reply-copy p {
  margin: 4px 0 0; font-size: 14.5px; line-height: 1.48; white-space: pre-wrap;
}
.cn-reply-composer {
  flex: 0 0 auto; display: flex; padding-top: 12px;
}
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
.cn-btn-secondary { background: var(--surface-2, var(--surface)); }
.cn-btn-secondary:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.cn-btn-ghost { background: transparent; border-color: transparent; color: var(--accent); }
.cn-btn-ghost:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.cn-btn-danger { background: var(--danger); border-color: var(--danger); color: var(--accent-fg); }
.cn-btn-icon { width: 44px; padding: 0; border-radius: 50%; font-size: 18px; }
/* /mobius-ui:Button */
.cn-btn { border-radius: 999px; font-weight: 650; }
.cn-btn-block { width: 100%; min-height: 50px; border-radius: 999px; font-size: 15px; }

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
.cn-join-access {
  max-width: 696px; margin-top: 4px; padding: 32px 20px 20px;
  border: 1px solid var(--border); border-radius: 18px; background: var(--surface);
}
.cn-join-access .cn-empty-mark {
  width: 48px; height: 48px; margin-bottom: 6px; border-radius: 50%;
  border: 0; background: color-mix(in srgb, var(--accent) 16%, var(--surface));
  color: var(--accent-text, var(--accent));
}
.cn-join-access .cn-empty-mark svg { width: 20px; height: 20px; }
.cn-join-access .cn-empty-text { max-width: 380px; }
.cn-join-access .cn-btn { align-self: stretch; min-height: 48px; margin-top: 16px; border-radius: 999px; }
.cn-join-privacy { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.cn-reply-join { margin: 10px 0 0; min-height: 44px; }

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
.cn-history-loading { flex-direction: column; gap: 10px; color: var(--muted); font-size: 13px; }

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
  .cn-header-chip { max-width: 100%; }
  .cn-scroll { padding-bottom: 32px; }
  .cn-scrim { align-items: center; padding: 24px; }
  .cn-sheet { border-radius: 16px; max-width: 540px; max-height: min(85vh, 760px); box-shadow: none; }
  .cn-grabber { display: none; }
  .cn-thread-bar { padding-inline: max(16px, calc((100% - 680px) / 2)); background: var(--bg); }
  .cn-thread-back-row { padding-inline: max(16px, calc((100% - 680px) / 2)); }
  .cn-thread-bar::after { left: max(16px, calc((100% - 680px) / 2)); right: max(16px, calc((100% - 680px) / 2)); }
  .cn-thread-msgs { padding-inline: max(16px, calc((100% - 680px) / 2)); }
  .cn-toast { max-width: 648px; margin-inline: auto; }
}

@media (max-width: 480px) {
  .cn-welcome { padding: 14px; }
  .cn-welcome > .cn-btn, .cn-welcome-actions { grid-column: 1 / -1; width: 100%; }
  .cn-welcome-actions .cn-btn { flex: 1 1 auto; }
  .cn-intent-notice { align-items: stretch; flex-direction: column; }
  .cn-intent-notice .cn-btn { width: 100%; }
  .cn-intent-actions .cn-btn { flex: 1 1 0; width: auto; }
  .cn-profile-preview { grid-template-columns: 1fr; }
  .cn-profile-preview-actions { padding-right: 0; }
  .cn-profile-preview-actions .cn-btn { flex: 1 1 auto; }
  .cn-reaction-grid { grid-template-columns: repeat(5, 44px); }
  .cn-inline-thread { max-height: min(340px, 46vh); }
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
.cn-new-chat-search { margin: 0 4px 8px; flex-shrink: 0; }
.cn-new-chat-search input::-webkit-search-cancel-button { -webkit-appearance: none; display: none; }
.cn-new-chat-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.cn-group-member-list strong { font-size: 14px; }
.cn-group-member-list .cn-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-group-status { padding-block: 16px; font-size: 14px; color: var(--muted); }
.cn-group-create-footer { flex-shrink: 0; padding: 12px 4px max(0px, env(safe-area-inset-bottom)); border-top: 1px solid var(--border); }
.cn-group-create-footer .cn-sheet-actions { margin-top: 0; }
.cn-group-create-footer .cn-directory-error { margin-bottom: 12px; }

.cn-thread-heading { min-width: 0; flex: 1; }
.cn-group-members-line { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-thread-heading .cn-person-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-group-detail-name { margin: 0 0 8px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
.cn-member-static { cursor: default; }
.cn-group-name-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cn-group-name-row .cn-group-detail-name { margin: 0; min-width: 0; }
.cn-role-tag {
  flex: 0 0 auto; padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 650;
  color: var(--muted); background: var(--surface-2); border: 1px solid var(--border);
}
.cn-role-tag.is-admin {
  color: var(--accent-text, var(--accent));
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}
.cn-member-manage { flex: 0 0 auto; min-height: 44px; }
.cn-member-sheet .cn-member-row { border-bottom: 0; }
.cn-member-action {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 14px 0; border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.cn-member-action p { margin: 0; flex: 1 1 220px; font-size: 14px; line-height: 1.45; color: var(--muted); }
.cn-member-action .cn-btn { min-height: 44px; }
.cn-group-management { display: flex; gap: 8px; flex-wrap: wrap; margin: 24px 0 16px; }
.cn-danger-text { color: var(--danger); }
.cn-group-closed { padding: 18px 24px max(18px, env(safe-area-inset-bottom)); text-align: center; font-size: 14px; line-height: 1.5; color: var(--muted); border-top: 1px solid var(--border); }
.cn-directory-error li { overflow-wrap: anywhere; }

/* One chat-matching composer across the board, replies, DMs and groups. */
.cn-thread { position: relative; }
.cn-composer-footer {
  position: absolute; z-index: 6; left: 0; right: 0;
  bottom: var(--mobius-safe-bottom, 0px); padding: 8px 12px;
  background: transparent; pointer-events: none; isolation: isolate;
}
.cn-composer-footer::before {
  content: ""; position: absolute; z-index: -1; pointer-events: none;
  left: 0; right: 0; top: -100px; bottom: calc(0px - var(--mobius-safe-bottom, 0px));
  background: linear-gradient(to bottom, transparent 0%,
    color-mix(in srgb, var(--bg) 0%, transparent) 68%,
    color-mix(in srgb, var(--bg) 12%, transparent) 76%,
    color-mix(in srgb, var(--bg) 42%, transparent) 88%, var(--bg) 98%);
}
.cn-composer { display: flex; align-items: flex-end; gap: 8px; width: 100%; max-width: 696px; margin: 0 auto; pointer-events: none; }
.cn-composer-pill {
  flex: 1; min-width: 0; min-height: 48px; padding: 4px;
  display: flex; align-items: center; gap: 4px;
  border: 1px solid var(--border); border-radius: 24px;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  backdrop-filter: blur(16px) saturate(140%);
  -webkit-backdrop-filter: blur(16px) saturate(140%);
  pointer-events: auto; transition: border-color .2s, box-shadow .2s;
}
/* Message box inside the People profile sheet. */
.cn-profile-composer { max-width: none; margin-top: 18px; pointer-events: auto; }
.cn-composer-pill:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
.cn-composer-pill.has-children { flex-direction: column; align-items: stretch; border-radius: 22px; }
.cn-composer-input-line { display: flex; flex: 1; align-items: center; gap: 2px; width: 100%; min-width: 0; }
.cn-composer-input-line textarea {
  display: block; flex: 1; min-width: 0; min-height: 24px; max-height: min(132px, 35dvh);
  padding: 4px 8px 4px 12px; overflow-y: auto; resize: none;
  background: none; border: 0; border-radius: 0; outline: 0;
  color: var(--text); font: 400 16px/1.45 var(--font); -webkit-tap-highlight-color: transparent;
}
.cn-composer-input-line textarea:focus-visible { outline: none; }
.cn-composer-input-line textarea::placeholder { color: var(--muted); }
.cn-composer-over { margin: 0; padding: 0 12px 6px; color: var(--danger); font: 500 13px/1.3 var(--font); }
/* A 44px target drawing a 40px circle; the margin keeps the pill's height. */
.cn-composer-send {
  position: relative; width: 44px; height: 44px; margin: -2px; flex: 0 0 auto; align-self: flex-end; padding: 0;
  display: grid; place-items: center; border: 0; border-radius: 50%;
  background: transparent; color: var(--accent-fg); cursor: pointer;
  transition: filter .14s, transform .1s, opacity .14s;
}
.cn-composer-send::before {
  content: ''; position: absolute; inset: 2px; border-radius: 50%; pointer-events: none;
  background: var(--accent);
}
.cn-composer-send svg { position: relative; width: 24px; height: 24px; }
.cn-composer-send svg path { stroke: currentColor; stroke-width: .24; stroke-linejoin: round; }
.cn-composer-send:hover { filter: brightness(1.07); }
.cn-composer-send:active { transform: scale(.92); }
.cn-composer-send:disabled { opacity: .42; cursor: default; filter: none; transform: none; }
.cn-composer-attach {
  width: 48px; height: 48px; flex: 0 0 auto; padding: 0;
  display: grid; place-items: center; border: 1px solid var(--border); border-radius: 50%;
  background: color-mix(in srgb, var(--surface) 60%, transparent); color: var(--text);
  backdrop-filter: blur(16px) saturate(140%);
  -webkit-backdrop-filter: blur(16px) saturate(140%);
  pointer-events: auto; cursor: pointer;
}
.cn-composer-attach svg { width: 24px; height: 24px; }
.cn-composer-attach:hover { background: var(--surface-2, var(--surface)); }
.cn-composer-attach:disabled { opacity: .45; cursor: default; }
.cn-composer-attach:focus-visible,
.cn-composer-send:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Replies share the translucent overlay; only the send circle stays compact. */
.cn-inline-thread .cn-reply-footer { bottom: 0; padding: 14px 12px 10px 16px; }
.cn-inline-thread .cn-reply-footer::before { top: -40px; bottom: 0; }
.cn-reply-composer { gap: 6px; }
.cn-reply-composer .cn-composer-pill { min-height: 44px; padding: 0; border-radius: 22px; }
.cn-reply-composer .cn-composer-input-line textarea { padding: 4px 2px 4px 10px; line-height: 1.3; }
.cn-reply-composer .cn-composer-attach { width: 46px; height: 46px; }
.cn-reply-composer .cn-composer-send { margin: 0; }
.cn-reply-composer .cn-composer-send::before { inset: 6px; }
.cn-reply-composer .cn-composer-send svg { width: 18px; height: 18px; }

/* Phones keep the same layout, a little tighter. */
@media (max-width: 719px) {
  .cn-header { padding: 16px 12px 10px; gap: 12px; }
  .cn-title { font-size: 26px; }
  .cn-nav-item { font-size: 14px; gap: 6px; padding: 0 6px; }
  /* With the admin cog, Community takes a little more width and reserves room
     on the cog's side only, so the label never runs under it. */
  .cn-nav-slot.has-cog { flex-grow: 1.45; }
  .cn-nav-slot.has-cog > .cn-nav-item { padding: 0 38px 0 10px; }
  .cn-nav-slot.has-cog > .cn-nav-item svg { display: none; }
  .cn-nav-slot.has-cog .cn-nav-cog { right: 4px; width: 32px; height: 32px; }
  .cn-badge { right: 6px; }
  .cn-nav-dot { right: 8px; }
  .cn-header-chip > span:not(.cn-avatar):not(.cn-header-chip-avatar-skeleton) { max-width: 120px; }
}
@media (max-width: 360px) {
  .cn-nav-item svg { display: none; }
}
@media (max-width: 640px) {
  .cn-scroll { padding-inline: 16px; }
}

/* Standard GIFs (KLIPY). Images load straight from KLIPY on this device. */
.cn-gif-button {
  flex: 0 0 auto; align-self: flex-end; min-width: 44px; height: 44px; margin: -2px 2px -2px 0; padding: 0 8px;
  display: grid; place-items: center; border: 0; border-radius: 22px; background: transparent;
  color: var(--muted); font: 750 12px/1 var(--font); letter-spacing: .04em; cursor: pointer;
}
.cn-gif-button:hover { color: var(--text); background: var(--surface-2, var(--surface)); }
.cn-gif-button:disabled { opacity: .42; cursor: default; background: transparent; }
.cn-gif-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cn-reply-composer .cn-gif-button { height: 40px; margin: 2px 0; }
.cn-gif-scrim { position: fixed; z-index: 200; }
.cn-gif-sheet { display: flex; flex-direction: column; gap: 10px; max-width: 560px; height: min(80vh, 640px); padding: 20px 16px; }
.cn-gif-sheet .cn-grabber { margin-bottom: 4px; }
.cn-gif-head { display: flex; align-items: center; gap: 8px; }
.cn-gif-search {
  flex: 1; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: 22px; background: var(--bg); color: var(--muted);
}
.cn-gif-search:focus-within { border-color: var(--accent); }
.cn-gif-search svg { width: 18px; height: 18px; flex: 0 0 auto; }
.cn-gif-search input {
  flex: 1; min-width: 0; border: 0; outline: none; background: transparent;
  color: var(--text); font: 16px var(--font);
}
.cn-gif-search input::placeholder { color: var(--muted); }
.cn-gif-close {
  width: 44px; height: 44px; flex: 0 0 auto; display: grid; place-items: center; padding: 0;
  border: 0; border-radius: 50%; background: transparent; color: var(--text); cursor: pointer;
}
.cn-gif-close:hover { background: var(--surface-2, var(--surface)); }
.cn-gif-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cn-gif-close svg { width: 20px; height: 20px; }
.cn-gif-heading { margin: 2px 4px 0; color: var(--muted); font-size: 12px; font-weight: 650; letter-spacing: .02em; }
.cn-gif-grid {
  flex: 1; min-height: 0; overflow-y: auto; display: grid; gap: 6px; align-content: start;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); grid-auto-rows: 112px;
}
.cn-gif-tile {
  position: relative; overflow: hidden; padding: 0; border: 0; border-radius: 10px; cursor: pointer;
  background: color-mix(in srgb, var(--text) 7%, var(--surface));
}
.cn-gif-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cn-gif-tile:hover img { filter: brightness(1.06); }
.cn-gif-tile:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; }
.cn-gif-tile.is-unavailable { cursor: default; }
.cn-gif-tile.is-loading { cursor: default; animation: cn-gif-pulse 1.2s ease-in-out infinite; }
@keyframes cn-gif-pulse { 50% { opacity: .55; } }
.cn-gif-note { flex: 1; margin: 24px 8px; text-align: center; color: var(--muted); font-size: 14px; line-height: 1.5; }
.cn-gif-note p { margin: 0 0 12px; }
.cn-gif-more { align-self: center; }
.cn-gif-powered { margin: 0; text-align: center; color: var(--muted); font-size: 12px; font-weight: 650; }
.cn-gif-frame { position: relative; display: block; width: fit-content; max-width: min(100%, 280px); margin-top: 4px; }
.cn-gif { display: block; max-width: 100%; max-height: 280px; min-width: 96px; min-height: 64px; border-radius: 14px; background: color-mix(in srgb, var(--text) 7%, transparent); }
.cn-post-body .cn-gif-frame { max-width: min(100%, 360px); margin-top: 10px; }
.cn-post-body .cn-gif { max-height: 360px; }
.cn-gif-credit {
  position: absolute; bottom: 6px; left: 6px; padding: 2px 5px; border-radius: 5px;
  background: rgba(0, 0, 0, .55); color: #fff; font: 700 10px/1.2 var(--font); letter-spacing: .04em; pointer-events: none;
}
.cn-gif-fallback { overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) {
  .cn-gif-tile.is-loading { animation: none; }
}

/* ── Group pictures ─────────────────────────────────────────────────────── */
.cn-avatar.is-group.has-picture { background: var(--surface-2); }
.cn-avatar.is-group > img { width: 100%; height: 100%; display: block; object-fit: cover; }

/* ── Group settings: Discord-style window, section sidebar on the left ─── */
.cn-gs-scrim { align-items: center; padding: 24px; }
.cn-gs {
  position: relative; display: flex; width: 100%; max-width: 860px; height: min(640px, calc(100% - 8px));
  border: 1px solid var(--border); border-radius: 16px; overflow: hidden; outline: none;
  background: var(--bg); animation: cn-gs-in .2s cubic-bezier(.2,.8,.2,1) both;
}
@keyframes cn-gs-in { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: none; } }
.cn-gs-nav {
  flex: 0 0 232px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto;
  padding: 22px 10px 18px; background: color-mix(in srgb, var(--surface) 70%, var(--bg));
  border-right: 1px solid var(--border);
}
.cn-gs-nav-head { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 0 10px 14px; }
.cn-avatar.cn-gs-nav-picture { width: 32px; height: 32px; border-radius: 10px; font-size: 11px; }
.cn-gs-nav-name {
  min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-size: 12px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
}
.cn-gs-nav-item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 8px 10px;
  border: 0; border-radius: 8px; background: transparent; color: var(--muted);
  font: 600 15px/1.2 var(--font); text-align: left; cursor: pointer;
}
.cn-gs-nav-item > span:first-child { flex: 1; }
.cn-gs-nav-item:hover { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); }
.cn-gs-nav-item.is-active { background: color-mix(in srgb, var(--text) 10%, transparent); color: var(--text); }
.cn-gs-nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.cn-gs-nav-item.is-danger { color: var(--danger-text, var(--danger)); }
.cn-gs-nav-item.is-danger:hover, .cn-gs-nav-item.is-danger.is-active { background: color-mix(in srgb, var(--danger) 12%, transparent); }
.cn-gs-nav-count { font-size: 12px; font-weight: 650; color: var(--muted); }
.cn-gs-nav-chevron, .cn-gs-nav-trailing { width: 16px; height: 16px; flex: 0 0 auto; }
.cn-gs-nav-divider { height: 1px; margin: 8px 10px; background: var(--border); }
.cn-gs-content { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-y: auto; padding: 28px 84px 24px 36px; }
.cn-gs-content-head { display: flex; align-items: center; gap: 6px; margin-bottom: 20px; }
.cn-gs-content-head h3 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
.cn-gs-back {
  width: 40px; height: 40px; margin-left: -10px; display: grid; place-items: center; border: 0; border-radius: 50%;
  background: transparent; color: var(--text); cursor: pointer;
}
.cn-gs-back svg { width: 22px; height: 22px; }
.cn-gs-close {
  position: absolute; top: 22px; right: 22px; z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 0; border: 0; background: transparent; color: var(--muted); cursor: pointer;
}
.cn-gs-close-ring {
  width: 36px; height: 36px; display: grid; place-items: center; border: 2px solid currentColor; border-radius: 50%;
}
.cn-gs-close-ring svg { width: 18px; height: 18px; }
.cn-gs-close-key { font-size: 11px; font-weight: 700; letter-spacing: .04em; }
.cn-gs-close:hover { color: var(--text); }
.cn-gs-close:focus-visible .cn-gs-close-ring { outline: 2px solid var(--accent); outline-offset: 2px; }
.cn-gs-close:disabled { opacity: .5; cursor: default; }

.cn-gs-form { display: flex; flex-direction: column; flex: 1; }
.cn-gs-overview { display: flex; gap: 28px; align-items: flex-start; }
.cn-gs-overview.is-readonly { align-items: center; gap: 18px; }
.cn-gs-picture-col { display: flex; flex-direction: column; align-items: center; gap: 8px; flex: 0 0 auto; width: 132px; }
.cn-gs-picture { position: relative; padding: 0; border: 0; border-radius: 50%; background: transparent; cursor: pointer; }
.cn-avatar.cn-gs-picture-avatar { width: 100px; height: 100px; border-radius: 50%; font-size: 30px; }
.cn-gs-picture-hover {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  border-radius: 50%; background: rgba(0,0,0,.55); color: #fff; font-size: 10.5px; font-weight: 750;
  letter-spacing: .04em; text-transform: uppercase; text-align: center; line-height: 1.15; opacity: 0; transition: opacity .15s;
}
.cn-gs-picture-hover svg { width: 18px; height: 18px; }
.cn-gs-picture:hover .cn-gs-picture-hover, .cn-gs-picture:focus-visible .cn-gs-picture-hover { opacity: 1; }
.cn-gs-picture:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.cn-gs-picture:disabled { cursor: progress; }
.cn-gs-picture-badge {
  position: absolute; right: 0; top: 0; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%;
  background: var(--accent-fill, var(--accent)); color: var(--accent-fg); border: 3px solid var(--bg);
}
.cn-gs-picture-badge svg { width: 13px; height: 13px; }
.cn-gs-picture-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: center; }
.cn-gs-fields { flex: 1; min-width: 0; }
.cn-gs-label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 750; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.cn-gs-help { margin: 8px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--muted); text-align: inherit; }
.cn-gs-picture-col .cn-gs-help { margin: 0; text-align: center; }
.cn-gs-role-note { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
.cn-gs-readonly-name { margin: 0 0 4px; font-size: 18px; font-weight: 700; }
.cn-gs-link {
  min-height: 36px; padding: 0 8px; border: 0; background: transparent; color: var(--text);
  font: 600 13.5px/1 var(--font); cursor: pointer; text-decoration: underline; text-underline-offset: 3px;
}
.cn-gs-link:disabled { opacity: .5; cursor: default; }
.cn-gs-form .cn-directory-error { margin-top: 16px; }
.cn-gs-unsaved {
  position: sticky; bottom: 0; margin-top: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 10px 10px 16px; border-radius: 10px; background: var(--surface-2, var(--surface));
  border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0,0,0,.28);
  animation: cn-gs-bar .18s ease-out both;
}
.cn-gs-unsaved > span { flex: 1; min-width: 160px; font-size: 14px; font-weight: 600; }
.cn-gs-save { background: var(--green-fill, var(--green, #23a55a)); border-color: transparent; color: #fff; }
@keyframes cn-gs-bar { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.cn-gs-danger-card {
  padding: 18px; border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border)); border-radius: 12px;
  background: color-mix(in srgb, var(--danger) 6%, transparent);
}
.cn-gs-danger-card > p { margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: var(--muted); }
.cn-gs-danger-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; flex-wrap: wrap; }

/* Members section */
.cn-gm { display: flex; flex-direction: column; }
.cn-gm-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.cn-gm-search {
  flex: 1 1 200px; display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--muted);
}
.cn-gm-search:focus-within { border-color: var(--accent); }
.cn-gm-search svg { width: 16px; height: 16px; flex: 0 0 auto; }
.cn-gm-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: 400 16px var(--font); min-height: 38px; }
.cn-gm-search input::-webkit-search-cancel-button { -webkit-appearance: none; display: none; }
.cn-gm-add svg { width: 16px; height: 16px; }
.cn-gm-count { margin: 0 0 6px; padding: 0 8px; font-size: 12px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.cn-gm-row {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 48px; padding: 6px 8px;
  border: 0; border-radius: 10px; background: transparent; color: var(--text);
  font: 600 14px/1.25 var(--font); text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none; user-select: none; -webkit-user-select: none;
}
.cn-gm-row:hover, .cn-gm-list li.is-active .cn-gm-row { background: color-mix(in srgb, var(--text) 7%, transparent); }
.cn-gm-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.cn-gm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.cn-gm-list li { position: relative; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
.cn-gm-list li:last-child { border-bottom: 0; }
.cn-gm-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.cn-gm-you { display: block; color: var(--muted); font-weight: 500; font-size: 12px; }
.cn-gm-row .cn-role-tag { padding: 2px 8px; font-size: 11.5px; }
.cn-gm-note { margin: 14px 8px 0; font-size: 13px; line-height: 1.45; color: var(--muted); }

.cn-gm-menu {
  position: fixed; z-index: 300; min-width: 196px; max-width: 260px; padding: 6px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
  box-shadow: 0 14px 36px rgba(0,0,0,.32); animation: cn-gm-menu-in .12s ease-out both;
}
@keyframes cn-gm-menu-in { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }
.cn-gm-menu button {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 8px 10px;
  border: 0; border-radius: 8px; background: transparent; color: var(--text);
  font: 500 14px/1.2 var(--font); text-align: left; cursor: pointer;
}
.cn-gm-menu button svg { width: 17px; height: 17px; flex: 0 0 auto; color: var(--muted); }
.cn-gm-menu button:hover, .cn-gm-menu button:focus-visible { background: var(--accent-fill, var(--accent)); color: var(--accent-fg); outline: none; }
.cn-gm-menu button:hover svg, .cn-gm-menu button:focus-visible svg { color: inherit; }
.cn-gm-menu button.is-danger { color: var(--danger-text, var(--danger)); }
.cn-gm-menu button.is-danger svg { color: inherit; }
.cn-gm-menu button.is-danger:hover, .cn-gm-menu button.is-danger:focus-visible { background: var(--danger-fill, var(--danger)); color: var(--accent-fg); }
.cn-gm-menu-divider { height: 1px; margin: 5px 6px; background: var(--border); }
@media (hover: none) { .cn-gm-menu button { min-height: 44px; } }

/* Small confirmation over the settings window */
.cn-gc { max-width: 420px; }
.cn-gc-title { margin: 0 0 6px; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
.cn-gc-footer { display: flex; align-items: center; gap: 8px; margin-top: 22px; flex-wrap: wrap; }
.cn-gc-spacer { flex: 1; }

/* Narrow windows: the sidebar and each section are full-height screens. */
@media (max-width: 639px) {
  .cn-gs-scrim { padding: 0; align-items: stretch; }
  .cn-gs { max-width: none; height: 100%; border: 0; border-radius: 0; }
  .cn-gs-nav { flex: 1; border-right: 0; padding: 20px 12px; background: var(--bg); }
  .cn-gs-nav { gap: 6px; }
  .cn-gs-nav-item { min-height: 52px; padding: 10px 14px; color: var(--text); background: var(--surface); border-radius: 12px; }
  .cn-gs-nav-divider { background: transparent; margin: 6px 0; }
  .cn-gs-nav-head { padding: 4px 4px 18px; }
  .cn-gs-content { padding: 14px 16px 20px; }
  .cn-gs-close { top: 16px; right: 14px; }
  .cn-gs-close-ring { width: 40px; height: 40px; border: 0; background: var(--surface); }
  .cn-gs-content-head { padding-right: 52px; margin-bottom: 16px; }
  .cn-gs-overview { flex-direction: column; align-items: stretch; gap: 20px; }
  .cn-gs-picture-col { width: auto; }
  .cn-gs-unsaved { bottom: max(8px, env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: reduce) {
  .cn-gs, .cn-gm-menu, .cn-gs-unsaved { animation: none; }
}
`
