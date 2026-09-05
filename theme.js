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
.cn-scroll {
  flex: 1; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 14px 16px 32px;
  word-break: break-word; overflow-wrap: anywhere;
}
/* /mobius-ui:Root */
.cn-scroll { order: 1; padding: 2px 16px 88px; }
.cn-content { width: 100%; max-width: 680px; margin: 0 auto; }
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
  min-height: 68px; padding: 12px 16px;
  width: min(100%, 712px); margin-inline: auto;
  background: var(--bg);
}
.cn-header::after {
  content: ""; position: absolute; left: 16px; right: 16px; bottom: 0;
  height: 1px; background: var(--border); opacity: 0.7;
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
  margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.03em;
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
  width: 42px; height: 42px; border-radius: 50%; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 760; color: #fff; letter-spacing: -0.02em;
  position: relative; overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14);
}
.cn-avatar::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(140deg, rgba(255,255,255,0.36), transparent 56%);
  pointer-events: none;
}
.cn-avatar.has-image::after { background: linear-gradient(140deg, rgba(255,255,255,0.12), transparent 48%); }
.cn-avatar-image { width: 100%; height: 100%; display: block; object-fit: cover; }
.cn-avatar.is-small { width: 30px; height: 30px; font-size: 10px; }
.cn-avatar.is-large {
  width: 76px; height: 76px; font-size: 23px;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.16);
}
.cn-avatar.is-group {
  border-radius: 14px;
  background: linear-gradient(145deg,
    color-mix(in srgb, var(--accent) 88%, #fff 8%),
    color-mix(in srgb, var(--accent) 55%, #16102e));
  color: #fff;
}

/* ── Board: hero pulse card + compose trigger ───────────────────────────── */
.cn-post { padding: 24px 0 20px; position: relative; }
.cn-post + .cn-post::before {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: var(--border); opacity: 0.65;
}
.cn-post-head { display: flex; align-items: center; gap: 11px; }
.cn-person {
  padding: 0; border: 0; background: transparent; text-align: left; color: inherit;
  font-family: var(--font); cursor: pointer; min-height: 44px;
  display: flex; align-items: center;
}
.cn-person-name { font-size: 14.5px; font-weight: 720; line-height: 1.25; letter-spacing: -0.01em; }
.cn-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
.cn-post-copy {
  font-size: 16px; line-height: 1.6; margin: 14px 0 0;
  letter-spacing: -0.004em; white-space: pre-wrap;
}

/* Reactions + compose FAB */
.cn-post-actions { display: flex; gap: 6px; margin: 10px 0 0 -6px; }
.cn-react {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 44px; min-width: 44px; padding: 0 12px; border-radius: 12px;
  border: 0; background: transparent; color: var(--muted);
  font-family: var(--font); font-size: 12.5px; font-weight: 680; cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
}
.cn-react:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.cn-react:active { transform: scale(0.94); }
.cn-react.is-liked {
  color: #e0426d;
  background: color-mix(in srgb, #e0426d 12%, transparent);
}
.cn-react:disabled { opacity: 0.46; cursor: default; transform: none; }
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
  box-shadow: 0 0 0 1px var(--accent);
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
.cn-failed-note { font-size: 11px; color: var(--danger); align-self: flex-end; margin-top: -4px; }
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
.cn-media img {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block; object-fit: cover;
}
.cn-media-state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.cn-media-state svg { width: 24px; height: 24px; opacity: 0.55; }
.cn-message-image { max-height: 320px; border-radius: 15px; }
.cn-board-image { max-height: 520px; margin-top: 12px; border-radius: 14px; }
.cn-board-image img { object-fit: contain; }

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
.cn-bio { font-size: 14.5px; line-height: 1.5; margin: 8px 0 0; max-width: 400px; }
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
  padding: 6px 16px max(6px, env(safe-area-inset-bottom));
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border-top: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
}
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

/* Corner compose button, anchored above the tab bar (outside the scroller) */
.cn-fab {
  position: absolute; right: 16px;
  bottom: calc(76px + env(safe-area-inset-bottom));
  z-index: 30;
  width: auto; min-width: 54px; height: 54px; padding: 0 18px; gap: 8px; border-radius: 16px; border: 0;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: var(--accent);
  color: var(--accent-fg); font-size: 26px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.28);
  transition: transform 0.12s ease, filter 0.14s ease;
}
.cn-fab:hover { filter: brightness(1.07); }
.cn-fab:active { transform: scale(0.92); }

.cn-fab span { font: 650 14px/1 var(--font); }
.cn-fab svg { width: 22px; height: 22px; }
.cn-header-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── First-use and community context ────────────────────────────────────── */
.cn-welcome {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 13px;
  margin: 14px 0 12px; padding: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
  border-radius: 16px; background: color-mix(in srgb, var(--accent) 7%, var(--surface));
}
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

/* mobius-ui:Sheet v1 — keep in sync; library candidate. Diverge below the marker only. */
.cn-scrim {
  position: absolute; inset: 0; z-index: 100;
  display: flex; align-items: flex-end; justify-content: center;
  padding: 16px; background: rgba(0, 0, 0, 0.5);
}
.cn-sheet {
  width: 100%; max-width: 480px; max-height: 85vh; overflow-y: auto;
  padding: 24px; background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px 16px 0 0; box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.3);
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
.cn-post-compose { display: flex; align-items: flex-end; gap: 8px; }
.cn-post-compose .cn-textarea { min-width: 0; flex: 1; }
.cn-post-sheet-actions {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 18px;
}

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
.cn-reply-sheet { height: min(720px, 85vh); overflow: hidden; display: flex; flex-direction: column; }
.cn-reply-sheet-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  flex: 0 0 auto;
}
.cn-reply-sheet-head .cn-sheet-title { margin-bottom: 4px; font-size: 19px; }
.cn-reply-sheet-head .cn-sheet-body { margin-bottom: 12px; }
.cn-reply-parent {
  flex: 0 0 auto; max-height: 210px; overflow-y: auto; margin-bottom: 10px; padding: 13px 14px;
  background: color-mix(in srgb, var(--surface2, var(--surface)) 78%, transparent);
  border: 1px solid color-mix(in srgb, var(--border) 82%, transparent); border-radius: 16px;
  overscroll-behavior: contain;
}
.cn-reply-parent .cn-post-copy { margin-top: 9px; font-size: 14.5px; line-height: 1.46; }
.cn-reply-parent .cn-board-image { max-height: 150px; margin-top: 10px; border-radius: 11px; }
.cn-reply-list {
  flex: 1; min-height: 0; overflow-y: auto; margin: 0 -8px; padding: 6px 8px 8px;
  border-top: 1px solid color-mix(in srgb, var(--border) 62%, transparent);
  overscroll-behavior: contain;
}
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
.cn-reply-composer input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.cn-reply-composer input:disabled { opacity: 0.58; }
.cn-reply-gate {
  margin: 0; padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  color: var(--muted); font-size: 13.5px; line-height: 1.5; text-align: center;
}
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
.cn-btn { border-radius: 13px; }
.cn-btn-block { width: 100%; min-height: 50px; border-radius: 16px; font-size: 15px; }

/* mobius-ui:Input v1 — keep in sync; library candidate. Diverge below the marker only. */
.cn-input, .cn-textarea {
  display: block; width: 100%; box-sizing: border-box; min-height: 44px; padding: 11px 12px;
  background: var(--surface); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; outline: none; font-family: var(--font);
  font-size: 16px;
  line-height: 1.5; transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.cn-input::placeholder, .cn-textarea::placeholder { color: var(--muted); }
.cn-input:focus, .cn-textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
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
  font-size: 14px; line-height: 1.5; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
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

/* Wide panes get a top navigation strip; narrow panes retain thumb-reachable tabs.
   Breakpoints use the app frame, so tiled desktop panes behave like small screens. */
@media (min-width: 720px) {
  .cn-header { min-height: 80px; }
  .cn-scrim { align-items: center; padding: 24px; }
  .cn-sheet { border-radius: 16px; max-width: 540px; max-height: min(85vh, 760px); box-shadow: 0 18px 60px rgba(0,0,0,.25); }
  .cn-grabber { display: none; }
  .cn-reply-sheet { height: min(680px, 85vh); }
  .cn-nav {
    order: 0; width: min(100% - 32px, 680px); margin: 8px auto 0;
    padding: 4px 0 12px; border-top: 0; background: var(--bg);
    backdrop-filter: none; -webkit-backdrop-filter: none;
  }
  .cn-nav-item { flex: 0 1 auto; min-height: 44px; padding: 0 20px; flex-direction: row; gap: 8px; font-size: 14px; }
  .cn-nav-item svg { width: 20px; height: 20px; }
  .cn-badge { top: 0; right: 4px; }
  .cn-fab { right: max(24px, calc((100% - 680px) / 2)); bottom: 24px; }
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
`
