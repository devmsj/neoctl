export const WEB_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>neo web</title>
  <link rel="stylesheet" href="/vendor/highlight-theme.css" />
  <script defer src="/vendor/highlight.min.js"></script>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07080b;
      --panel: #0b0d12;
      --text: #e5e7eb;
      --muted: #858b98;
      --cyan: #22d3ee;
      --green: #22c55e;
      --purple: #a855f7;
      --gold: #d4b04c;
      --red: #ef4444;
      --yellow: #eab308;
      --line: #161a23;
      --page-max-width: 1120px;
      --page-gutter: max(18px, calc((100vw - var(--page-max-width)) / 2));
      --topbar-gutter: max(14px, calc((100vw - var(--page-max-width)) / 2));
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body { background: radial-gradient(circle at top, #101522 0, var(--bg) 42rem); color: var(--text); font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    #app { height: 100%; display: flex; flex-direction: column; }
    .topbar { height: 34px; display: flex; align-items: center; gap: 12px; padding: 0 var(--topbar-gutter); border-bottom: 1px solid var(--line); color: var(--muted); background: rgba(7, 8, 11, .75); backdrop-filter: blur(12px); }
    .brand { color: var(--cyan); font-weight: 700; letter-spacing: .08em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; background: transparent; padding: 0; font: inherit; cursor: pointer; text-align: left; }
    .brand:hover, .brand:focus-visible { color: #67e8f9; text-decoration: underline; text-underline-offset: 3px; outline: none; }
    .brand.session-title { letter-spacing: 0; }
    #connection { flex: 0 0 auto; color: var(--yellow); }
    #transcriptWrap { position: relative; flex: 1; min-height: 0; }
    #transcript { height: 100%; overflow: auto; padding: 22px var(--page-gutter) 10px; scroll-behavior: smooth; }
    .scroll-bottom-zone { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; padding: 0 var(--page-gutter); display: flex; align-items: flex-end; opacity: 0; pointer-events: none; transition: opacity .14s ease; z-index: 2; }
    .scroll-bottom-zone.available { opacity: 1; pointer-events: auto; }
    #scrollBottom { width: 100%; height: 12px; border: 1px solid rgba(34, 211, 238, .42); border-radius: 999px 999px 0 0; background: linear-gradient(90deg, rgba(34, 211, 238, .06), rgba(34, 211, 238, .22), rgba(34, 211, 238, .06)); color: var(--cyan); font: inherit; font-size: 10px; line-height: 10px; letter-spacing: .12em; text-transform: uppercase; cursor: pointer; box-shadow: 0 0 18px rgba(34, 211, 238, .2), inset 0 1px 0 rgba(255,255,255,.08); text-shadow: 0 0 10px currentColor; }
    #scrollBottom:hover, #scrollBottom:focus-visible { border-color: rgba(34, 211, 238, .82); box-shadow: 0 0 22px rgba(34, 211, 238, .42), inset 0 1px 0 rgba(255,255,255,.18); outline: none; }
    .block { display: flex; gap: 8px; margin-top: 16px; align-items: flex-start; }
    .block:first-child { margin-top: 0; }
    .marker { width: 18px; flex: 0 0 18px; user-select: none; line-height: 1.45; }
    .marker.circle { position: relative; overflow: hidden; text-indent: -999px; }
    .marker.circle::before { content: ""; position: absolute; left: 0; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
    .marker.diamond { font-size: 1em; }
    .content { position: relative; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
    .content.plain { white-space: pre-wrap; }
    .content.summary { color: #d7dce5; }
    .kind-tool.collapsible .content { padding-right: 78px; }
    .tool-body { position: relative; }
    .kind-tool.collapsed .tool-body { max-height: calc(1.45em * 6); overflow: hidden; opacity: .72; mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,.84) 42%, rgba(0,0,0,.42) 76%, rgba(0,0,0,0) 100%); -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,.84) 42%, rgba(0,0,0,.42) 76%, rgba(0,0,0,0) 100%); }
    .message-image { display: block; margin-top: 8px; max-width: min(100%, 760px); }
    .message-image img { display: block; max-width: 100%; max-height: 70vh; border: 1px solid #202635; border-radius: 10px; background: #0c1018; box-shadow: 0 10px 30px rgba(0,0,0,.28); object-fit: contain; }
    .message-image figcaption { margin-top: 5px; color: var(--muted); font-size: 12px; line-height: 1.35; font-weight: 400; }
    .tool-toggle { position: absolute; top: 0; right: 0; opacity: 0; pointer-events: none; border: 1px solid #263043; border-radius: 999px; padding: 1px 8px; background: rgba(15, 23, 42, .92); color: var(--muted); font: inherit; font-size: 11px; line-height: 17px; cursor: pointer; transition: opacity .12s ease, color .12s ease, border-color .12s ease; }
    .kind-tool.collapsible:hover .tool-toggle, .kind-tool.collapsible:focus-within .tool-toggle { opacity: 1; pointer-events: auto; }
    .tool-toggle:hover { color: var(--cyan); border-color: #31556b; }
    .markdown { color: var(--text); }
    .markdown > :first-child { margin-top: 0; }
    .markdown > :last-child { margin-bottom: 0; }
    .markdown p { margin: 0 0 .72em; }
    .markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 1em 0 .45em; line-height: 1.25; color: #f3f4f6; font-weight: 700; }
    .markdown h1 { font-size: 1.34em; padding-bottom: .22em; border-bottom: 1px solid #222837; }
    .markdown h2 { font-size: 1.18em; }
    .markdown h3 { font-size: 1.06em; }
    .markdown ul, .markdown ol { margin: .35em 0 .78em; padding-left: 2.1em; }
    .markdown li { margin: .18em 0; }
    .markdown li > p { margin: .25em 0; }
    .markdown blockquote { margin: .75em 0; padding: .2em 0 .2em 1em; border-left: 3px solid #334155; color: #bac2cf; background: rgba(148, 163, 184, .05); }
    .markdown pre { position: relative; margin: .85em 0; padding: 12px 14px; overflow: auto; border: 1px solid #202635; border-radius: 8px; background: #0c1018; color: #d8dee9; white-space: pre; box-shadow: inset 0 1px 0 rgba(255,255,255,.025); }
    .markdown pre[data-lang]::before { content: attr(data-lang); position: sticky; left: 100%; float: right; margin: -5px -7px 4px 12px; padding: 1px 6px; border: 1px solid #263043; border-radius: 999px; background: rgba(15, 23, 42, .92); color: #94a3b8; font-size: 11px; line-height: 16px; text-transform: lowercase; }
    .markdown code { padding: .12em .34em; border: 1px solid #222838; border-radius: 5px; background: #0c1018; color: #facc15; font: .94em ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .markdown pre code, .markdown pre code.hljs { display: block; padding: 0; border: 0; border-radius: 0; background: transparent; color: inherit; font-size: 1em; overflow: visible; }
    .markdown .hljs { background: transparent; color: inherit; }
    .markdown table { display: block; width: max-content; max-width: 100%; overflow: auto; margin: .85em 0; border-collapse: collapse; }
    .markdown th, .markdown td { padding: 6px 10px; border: 1px solid #263043; }
    .markdown th { background: #111827; color: #f3f4f6; font-weight: 700; }
    .markdown tr:nth-child(2n) td { background: rgba(148, 163, 184, .045); }
    .markdown hr { border: 0; border-top: 1px solid #222837; margin: 1em 0; }
    .markdown a { color: var(--cyan); text-decoration: none; }
    .markdown a:hover { text-decoration: underline; }
    .markdown strong { color: #f8fafc; }
    .markdown del { color: var(--muted); }
    .markdown input[type="checkbox"] { vertical-align: -2px; margin-right: .4em; accent-color: var(--cyan); }
    .title { color: var(--muted); font-weight: 700; margin-bottom: 2px; }
    .body-title { color: var(--text); font-weight: 700; margin-bottom: .35em; }
    .title.success::after { content: " ✓"; color: var(--green); }
    .title.failure::after { content: " ✕"; color: var(--red); }
    .kind-user .marker, .kind-user .content { color: var(--cyan); }
    .kind-assistant .marker { color: var(--green); }
    .kind-thinking .marker, .kind-thinking .title, .kind-thinking .content { color: var(--purple); }
    .kind-tool .marker, .kind-tool .title { color: var(--gold); }
    .kind-error .marker, .kind-error .title, .kind-error .content { color: var(--red); }
    .kind-system .marker { color: #fff; }
    .kind-meta .marker, .kind-meta .content { color: var(--muted); }
    .live .marker { animation: pulse 900ms ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .35; } }
    .ansi { color: #d1d5db; }
    .diff { color: #d1d5db; }
    .diff-line { display: block; }
    .diff-add { color: var(--green); }
    .diff-del { color: var(--red); }
    .diff-hunk { color: var(--cyan); }
    .diff-meta { color: var(--muted); }
    #status { flex: 0 0 auto; min-height: 28px; padding: 4px var(--page-gutter); color: var(--muted); border-top: 1px solid var(--line); display: flex; flex-direction: column; align-items: stretch; gap: 2px; overflow: hidden; white-space: nowrap; }
    .status-main, .status-bg-row { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .status-bg-row { color: var(--yellow); font-size: 12px; }
    .phase { font-weight: 700; color: var(--green); }
    .phase.active { color: var(--cyan); text-shadow: 0 0 12px currentColor; animation: shimmer 1.35s linear infinite; }
    .phase.thinking { color: var(--purple); }
    .phase.tools { color: var(--gold); }
    .phase.stopped { color: var(--yellow); }
    .sep { color: var(--muted); padding: 0 7px; }
    .token-hot { font-weight: 700; }
    .token-input-hot { color: var(--green); }
    .token-output-hot { color: var(--cyan); }
    .token-error-hot { color: var(--red); }
    @keyframes shimmer { 0%, 100% { filter: brightness(.9); } 45% { filter: brightness(1.9); } }
    #queued { display: none; padding: 0 var(--page-gutter) 4px; color: var(--yellow); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #panel { display: none; flex: 0 0 auto; padding: 12px var(--page-gutter); border-top: 1px solid var(--line); background: rgba(7, 8, 11, .97); color: var(--muted); max-height: min(58vh, 560px); overflow: auto; }
    #app.sessions-page #transcriptWrap, #app.sessions-page #status, #app.sessions-page #queued, #app.sessions-page #composerWrap { display: none; }
    #app.sessions-page #panel { flex: 1 1 auto; max-height: none; border-top: 0; padding-top: 18px; }
    #app.sessions-page .topbar { display: none; }
    #panel.open { display: block; }
    .panel-title { color: var(--cyan); font-weight: 700; margin-bottom: 6px; }
    .panel-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
    .panel-subtitle { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .session-list { display: grid; gap: 8px; }
    .session-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 10px 12px; border: 1px solid #1f2937; border-radius: 12px; background: linear-gradient(180deg, rgba(15, 23, 42, .72), rgba(11, 13, 18, .82)); color: var(--text); cursor: pointer; }
    .session-card.selected { border-color: rgba(34, 211, 238, .78); box-shadow: 0 0 0 1px rgba(34, 211, 238, .18), 0 0 22px rgba(34, 211, 238, .12); }
    .session-card.running { border-color: rgba(34, 197, 94, .58); }
    .session-card.current { background: linear-gradient(180deg, rgba(8, 47, 73, .56), rgba(15, 23, 42, .82)); }
    .session-main { min-width: 0; }
    .session-title-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .session-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .session-badge { border: 1px solid #263043; border-radius: 999px; padding: 1px 7px; color: var(--muted); font-size: 11px; line-height: 17px; background: rgba(15, 23, 42, .72); }
    .session-badge.running { color: #bbf7d0; border-color: rgba(34, 197, 94, .45); background: rgba(22, 101, 52, .22); }
    .session-badge.current { color: #a5f3fc; border-color: rgba(34, 211, 238, .45); background: rgba(8, 145, 178, .16); }
    .session-meta { margin-top: 7px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .session-actions { display: flex; align-items: center; gap: 6px; }
    .panel-muted { color: var(--muted); }
    .panel-toolbar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .panel-actions button, .login-actions button, .panel-close, .panel-primary { border: 1px solid #263043; border-radius: 999px; background: rgba(15, 23, 42, .92); color: var(--muted); font: inherit; font-size: 11px; cursor: pointer; min-height: 24px; padding: 2px 9px; }
    .panel-actions button:disabled, .login-actions button:disabled, .panel-close:disabled, .panel-primary:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }
    .panel-primary { width: 34px; height: 34px; min-height: 34px; padding: 0; border-radius: 50%; color: #020617; border-color: rgba(34, 211, 238, .72); background: linear-gradient(90deg, var(--cyan), #67e8f9); font-weight: 700; font-size: 22px; line-height: 30px; }
    .panel-actions button:hover, .login-actions button:hover, .panel-close:hover, .panel-primary:hover { color: var(--cyan); border-color: #31556b; box-shadow: 0 0 14px rgba(34, 211, 238, .18); }
    .panel-primary:hover { color: #020617; }
    .panel-actions button.danger:hover { color: var(--red); border-color: rgba(239, 68, 68, .5); box-shadow: 0 0 14px rgba(239, 68, 68, .14); }
    @media (max-width: 640px) {
      :root { --page-gutter: 12px; --topbar-gutter: 12px; }
      .topbar { height: 40px; }
      #panel { max-height: 72vh; padding-top: 10px; }
      .panel-header { align-items: center; }
      .session-card { grid-template-columns: 1fr; padding: 12px; }
      .session-actions { justify-content: stretch; }
      .session-actions .panel-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; }
      .session-actions button { margin: 0; min-height: 36px; }
      .session-title-line { align-items: flex-start; }
    }
    .login-grid { display: grid; grid-template-columns: minmax(12ch, 22ch) 1fr; gap: 6px 10px; align-items: center; }
    .login-grid label { color: var(--muted); }
    .login-grid input, .login-grid select { min-width: 0; border: 1px solid #263043; border-radius: 6px; padding: 4px 6px; background: #0b1020; color: var(--text); font: inherit; }
    .login-grid input:focus, .login-grid select:focus { outline: none; border-color: #31556b; box-shadow: 0 0 14px rgba(34, 211, 238, .16); }
    .login-actions { margin-top: 8px; display: flex; gap: 6px; justify-content: flex-end; }
    #composerWrap { flex: 0 0 auto; padding: 0 var(--page-gutter) 16px; background: rgba(7, 8, 11, .92); }
    #completions { display: none; margin-left: 26px; margin-bottom: 6px; color: var(--muted); max-width: calc(var(--page-max-width) - 26px); }
    .completion-title { color: var(--cyan); font-weight: 700; }
    .completion-row { display: grid; grid-template-columns: 4ch minmax(10ch, 32ch) 1fr; gap: 1ch; min-height: 20px; align-items: center; }
    .completion-row.selected .num { background: var(--cyan); color: #020617; }
    .completion-row .name { color: var(--cyan); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .completion-row.reasoning .name { color: var(--purple); }
    .completion-row .desc { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .completion-footer { color: var(--muted); }
    #composer { display: flex; gap: 8px; align-items: flex-start; }
    #prompt { color: var(--cyan); flex: 0 0 auto; padding-top: 7px; }
    #input { flex: 1; min-height: 32px; max-height: 35vh; resize: none; border: 0; outline: 0; padding: 7px 0; background: transparent; color: var(--text); font: inherit; line-height: 1.45; caret-color: var(--cyan); }
    #input.command { color: var(--cyan); }
    #input.locked { color: var(--muted); }
  </style>
</head>
<body>
<div id="app">
  <div class="topbar"><button id="brand" class="brand" type="button" title="Open sessions">neo web</button><span id="connection" hidden>connecting…</span></div>
  <div id="transcriptWrap"><div id="transcript"></div><div id="scrollBottomZone" class="scroll-bottom-zone"><button id="scrollBottom" type="button" aria-label="Scroll to bottom">bottom</button></div></div>
  <div id="status"></div>
  <div id="queued"></div>
  <div id="panel"></div>
  <div id="composerWrap">
    <div id="completions"></div>
    <div id="composer"><div id="prompt">●</div><textarea id="input" spellcheck="false" autofocus></textarea></div>
  </div>
</div>
<script type="module">
import { marked } from '/vendor/marked.esm.js';
marked.setOptions({ gfm: true, breaks: false, async: false });
const TOOL_COLLAPSED_LINES = 6;
const STATUS_PHASE_MIN_DISPLAY_MS = 2000;
const TOKEN_PULSE_MS = 900;
const ANIMATED_NUMBER_INTERVAL_MS = 50;
const ANIMATED_NUMBER_MIN_DURATION_MS = 180;
const ANIMATED_NUMBER_MAX_DURATION_MS = 700;
const ANIMATED_NUMBER_DURATION_SCALE_MS = 130;
const state = { lines: [], status: { phase: 'ready', streamedOutputTokens: 0 }, busy: false, queuedInput: undefined, backgroundTaskCount: 0, backgroundTasks: [], backgroundSessionRunCount: 0, runningSessionIds: [], session: undefined, catalog: { commands: [], modelIds: [], reasoning: [] }, interactive: {}, history: [], historyIndex: undefined, completionIndex: 0, expandedToolLines: new Set(), panel: undefined, panelSelection: 0, attachments: [], attachmentCounter: 0, view: location.pathname === '/sessions' ? 'sessions' : 'chat' };
const animatedNumbers = { input: { target: undefined, display: undefined, timer: undefined }, output: { target: undefined, display: undefined, timer: undefined } };
const renderedLineKeys = new Map();
const statusNodes = {};
const phaseDisplay = { value: state.status.phase, displayedAt: Date.now(), pending: undefined, timer: undefined };
let renderPending = false;
const transcript = document.getElementById('transcript');
const scrollBottomZone = document.getElementById('scrollBottomZone');
const scrollBottom = document.getElementById('scrollBottom');
const statusEl = document.getElementById('status');
const queuedEl = document.getElementById('queued');
const panelEl = document.getElementById('panel');
const input = document.getElementById('input');
const completionsEl = document.getElementById('completions');
const brand = document.getElementById('brand');
const connection = document.getElementById('connection');

const sessionsPage = () => state.view === 'sessions';
const openSessionsOnLoad = state.view === 'sessions';
const es = new EventSource('/events');
es.addEventListener('open', () => {
  connection.hidden = true;
  connection.textContent = '';
});
es.addEventListener('error', () => {
  connection.hidden = false;
  connection.textContent = 'reconnecting…';
});
es.addEventListener('sync', (event) => {
  const payload = JSON.parse(event.data);
  state.lines = payload.lines || [];
  state.status = payload.status || state.status;
  state.busy = !!payload.busy;
  state.queuedInput = payload.queuedInput;
  state.backgroundTaskCount = payload.backgroundTaskCount || 0;
  state.backgroundTasks = payload.backgroundTasks || [];
  state.backgroundSessionRunCount = payload.backgroundSessionRunCount || 0;
  state.runningSessionIds = payload.runningSessionIds || state.runningSessionIds || [];
  state.session = payload.session;
  if (payload.catalog) state.catalog = payload.catalog;
  if (payload.interactive) state.interactive = payload.interactive;
  updateInputPlaceholder();
  scheduleRender();
});

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}
function render() { renderTranscript(); renderStatus(); renderTitle(); renderQueued(); renderPanel(); renderCompletions(); updateInputPlaceholder(); updateScrollBottomAffordance(); input.classList.toggle('locked', state.busy && state.queuedInput !== undefined); }
function renderTranscript() {
  const atBottom = isTranscriptAtBottom();
  const seen = new Set();
  let cursor = transcript.firstElementChild;
  for (const line of state.lines) {
    const id = String(line.id);
    seen.add(id);
    let element = transcript.querySelector('[data-line-id="' + cssEscape(id) + '"]');
    const key = lineRenderKey(line);
    if (!element) {
      element = document.createElement('div');
      element.setAttribute('data-line-id', id);
      updateLineElement(element, line);
      renderedLineKeys.set(id, key);
    } else if (renderedLineKeys.get(id) !== key) {
      updateLineElement(element, line);
      renderedLineKeys.set(id, key);
    }
    if (element !== cursor) transcript.insertBefore(element, cursor);
    cursor = element.nextElementSibling;
  }
  for (const child of Array.from(transcript.children)) {
    const id = child.getAttribute('data-line-id');
    if (!seen.has(id)) { renderedLineKeys.delete(id); child.remove(); }
  }
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}
function isTranscriptAtBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
}
function updateScrollBottomAffordance() {
  scrollBottomZone.classList.toggle('available', !isTranscriptAtBottom());
}
function updateLineElement(element, line) {
  const kind = line.kind || 'system';
  const marker = markerForLine(line, kind);
  const markerCls = marker === '●' ? 'circle' : 'diamond';
  const expanded = state.expandedToolLines.has(line.id);
  const collapsible = kind === 'tool' && line.collapsible !== false && hasMoreThanLines(line.text || '', TOOL_COLLAPSED_LINES);
  const collapsed = collapsible && !expanded;
  const title = line.title ? '<div class="title ' + (line.titleStatus || '') + '">' + esc(line.title) + '</div>' : '';
  const bodyTitle = line.bodyTitle ? '<div class="body-title">' + esc(line.bodyTitle) + '</div>' : '';
  const markdown = shouldRenderMarkdown(line);
  const cls = ['block', 'kind-' + kind, line.live ? 'live' : '', line.previewStyle === 'summary' ? 'summary-block' : '', collapsible ? 'collapsible' : '', collapsed ? 'collapsed' : '', expanded ? 'expanded' : ''].filter(Boolean).join(' ');
  const contentCls = ['content', markdown ? 'markdown' : 'plain', line.previewStyle === 'summary' ? 'summary' : ''].filter(Boolean).join(' ');
  const body = '<div class="tool-body">' + bodyTitle + renderText(line.text || '', line.format, markdown) + renderLineImage(line.image) + '</div>';
  const toggle = collapsible ? '<button class="tool-toggle" type="button" data-line-id="' + String(line.id) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' + (expanded ? 'collapse' : 'expand') + '</button>' : '';
  element.className = cls;
  element.innerHTML = '<div class="marker ' + markerCls + '">' + marker + '</div><div class="' + contentCls + '">' + title + body + toggle + '</div>';
}
function lineRenderKey(line) {
  const kind = line.kind || 'system';
  const expanded = state.expandedToolLines.has(line.id);
  const collapsible = kind === 'tool' && line.collapsible !== false && hasMoreThanLines(line.text || '', TOOL_COLLAPSED_LINES);
  const image = line.image ? [line.image.src || '', line.image.label || '', line.image.mimeType || ''].join('\u001e') : '';
  return [kind, line.text || '', line.title || '', line.bodyTitle || '', line.titleStatus || '', line.format || '', line.previewStyle || '', line.summaryMaxLines || '', line.live ? '1' : '0', line.pendingReplacement ? '1' : '0', collapsible ? '1' : '0', expanded ? '1' : '0', image].join('\u001f');
}
function markerForLine(line, kind) {
  if (kind === 'tool') return line.live || line.pendingReplacement ? '◇' : '◆';
  if (kind === 'thinking') return '◆';
  return '●';
}
function shouldRenderMarkdown(line) {
  if (line.format === 'ansi' || line.format === 'plain' || line.format === 'diff') return false;
  return line.kind === 'assistant' || line.kind === 'thinking' || line.kind === 'system' || line.kind === 'tool';
}
function hasMoreThanLines(text, maxLines) {
  if (!text) return false;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 && ++lines > maxLines) return true;
  }
  return false;
}
function renderText(text, format, markdown) {
  if (format === 'ansi') return '<span class="ansi">' + esc(stripAnsi(text)) + '</span>';
  if (format === 'diff') return renderDiffText(text);
  if (!markdown) return linkify(esc(text));
  return sanitizeMarkdownHtml(marked.parse(text || ''));
}
function renderLineImage(image) {
  if (!image || !safeImageSrc(image.src)) return '';
  const label = image.label || 'generated image';
  return '<figure class="message-image"><img src="' + esc(image.src) + '" alt="' + esc(label) + '" loading="lazy" decoding="async" /><figcaption>' + esc(label) + '</figcaption></figure>';
}
function renderDiffText(text) {
  const lines = String(text || '').split('\n');
  return '<span class="diff">' + lines.map((line) => {
    const cls = diffLineClass(line);
    return '<span class="diff-line ' + cls + '">' + esc(line) + '</span>';
  }).join('') + '</span>';
}
function diffLineClass(line) {
  const pipeIndex = line.indexOf('│ ');
  const diffMarker = pipeIndex >= 0 ? line.slice(pipeIndex + 2, pipeIndex + 3) : line.slice(0, 1);
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('create ') || line.startsWith('edit ') || line.startsWith('write ') || line.startsWith('failed ') || line === 'no changes') return 'diff-meta';
  if (diffMarker === '+') return 'diff-add';
  if (diffMarker === '-') return 'diff-del';
  return 'diff-meta';
}
function renderStatus() {
  ensureStatusNodes();
  const s = state.status || {};
  const displayPhase = minimumDisplayPhase(s.phase || 'ready');
  const phase = phaseLabel(displayPhase);
  const ctx = contextParts(s.metrics);
  const inputTokens = compactNumber(animatedNumber('input', (s.usage && s.usage.inputTokens) ?? (s.metrics && s.metrics.estimatedInputTokens)));
  const outputTokens = compactNumber(animatedNumber('output', (s.usage && s.usage.outputTokens) ?? s.streamedOutputTokens));
  const model = truncateMiddle((s.metrics && s.metrics.model) || 'model?', window.innerWidth > 900 ? 26 : 14);
  const phaseActive = isActivePhase(displayPhase);
  const phaseClass = ['phase', phaseActive ? 'active' : '', displayPhase === 'thinking' ? 'thinking' : '', displayPhase === 'running_tools' ? 'tools' : '', displayPhase === 'stopped' ? 'stopped' : ''].filter(Boolean).join(' ');
  setText(statusNodes.phase, phase);
  if (statusNodes.phase.className !== phaseClass) statusNodes.phase.className = phaseClass;
  setText(statusNodes.model, model);
  setText(statusNodes.ctxPercent, ctx.percent);
  const ctxColor = contextColor(s.metrics);
  if (statusNodes.ctxPercent.style.color !== ctxColor) statusNodes.ctxPercent.style.color = ctxColor;
  const now = Date.now();
  const retryPending = retryCooldownActive(s, now);
  const inputArrowClass = retryPending ? 'token-hot token-error-hot' : tokenArrowHotClass(s.inputTokenUpdatedAt, now, 'token-input-hot');
  if (statusNodes.inputArrow.className !== inputArrowClass) statusNodes.inputArrow.className = inputArrowClass;
  setText(statusNodes.inputTokens, inputTokens);
  const outputArrowClass = modelOutputPending(s, now) ? '' : tokenArrowHotClass(s.outputTokenUpdatedAt, now, 'token-output-hot');
  if (statusNodes.outputArrow.className !== outputArrowClass) statusNodes.outputArrow.className = outputArrowClass;
  setText(statusNodes.outputTokens, outputTokens);
  renderBackgroundTasks();
}
function renderBackgroundTasks() {
  const tasks = state.backgroundTasks || [];
  const rows = statusNodes.backgroundRows;
  if (!rows) return;
  rows.innerHTML = '';
  if (!tasks.length) { rows.style.display = 'none'; return; }
  rows.style.display = '';
  const summary = document.createElement('div');
  summary.className = 'status-bg-row';
  summary.textContent = '◇ background tools: ' + tasks.length + ' task' + (tasks.length === 1 ? '' : 's');
  rows.appendChild(summary);
  for (const task of tasks.slice(0, 2)) {
    const row = document.createElement('div');
    row.className = 'status-bg-row';
    row.textContent = '  ' + task.type + ':' + truncateMiddle(task.description || task.agentId || task.taskId, Math.max(12, Math.floor(window.innerWidth / 18))) + ' · ' + task.status + ' · ' + formatElapsed(Date.now() - Date.parse(task.createdAt || new Date().toISOString()));
    rows.appendChild(row);
  }
}
function ensureStatusNodes() {
  if (statusNodes.phase) return;
  statusEl.innerHTML = '<div class="status-main"><span data-part="phase"></span><span class="sep">·</span><span data-part="model"></span><span class="sep">·</span><span data-part="ctxPercent"></span><span class="sep">·</span><span data-part="inputArrow">↑</span> <span data-part="inputTokens"></span><span class="sep">·</span><span data-part="outputArrow">↓</span> <span data-part="outputTokens"></span></div><div data-part="backgroundRows"></div>';
  for (const node of statusEl.querySelectorAll('[data-part]')) statusNodes[node.getAttribute('data-part')] = node;
}
function minimumDisplayPhase(target) {
  if (phaseDisplay.timer) {
    clearTimeout(phaseDisplay.timer);
    phaseDisplay.timer = undefined;
  }
  if (Object.is(target, phaseDisplay.value)) {
    phaseDisplay.pending = undefined;
    return phaseDisplay.value;
  }
  const applyPending = () => {
    const next = phaseDisplay.pending;
    if (next === undefined || Object.is(next, phaseDisplay.value)) {
      phaseDisplay.pending = undefined;
      return;
    }
    phaseDisplay.value = next;
    phaseDisplay.displayedAt = Date.now();
    phaseDisplay.pending = undefined;
    phaseDisplay.timer = undefined;
    scheduleRender();
  };
  phaseDisplay.pending = target;
  const remainingMs = STATUS_PHASE_MIN_DISPLAY_MS - (Date.now() - phaseDisplay.displayedAt);
  if (remainingMs <= 0) applyPending();
  else phaseDisplay.timer = setTimeout(applyPending, remainingMs);
  return phaseDisplay.value;
}
function setText(node, text) {
  text = String(text);
  if (node.textContent !== text) node.textContent = text;
}
function renderTitle() {
  const title = sessionDisplayTitle(state.session);
  const prefix = isActivePhase((state.status || {}).phase) || state.backgroundTaskCount > 0 ? '● ' : '✓ ';
  if (title) {
    const value = prefix + title;
    setText(brand, value);
    brand.classList.add('session-title');
    if (document.title !== value) document.title = value;
  } else {
    setText(brand, 'neo web');
    brand.classList.remove('session-title');
    if (document.title !== 'neo web') document.title = 'neo web';
  }
}
function sessionDisplayTitle(session) {
  const title = session && typeof session.title === 'string' ? session.title.trim() : '';
  return title && title !== 'neo' ? title : '';
}
function tokenArrowHotClass(updatedAt, now, hotClass) {
  return updatedAt !== undefined && now - updatedAt <= TOKEN_PULSE_MS ? 'token-hot ' + hotClass : '';
}
function retryCooldownActive(status, now) {
  return status && status.retryCooldownUntil !== undefined && now < status.retryCooldownUntil;
}
function modelOutputPending(status, now) {
  if (retryCooldownActive(status, now)) return true;
  if (!status || status.phase !== 'calling_model') return false;
  return tokenArrowHotClass(status.outputTokenUpdatedAt, now, 'token-output-hot') === '';
}
function animatedNumber(key, target) {
  const item = animatedNumbers[key];
  if (target === undefined || target === null || !Number.isFinite(Number(target))) {
    if (item.timer) clearInterval(item.timer);
    item.timer = undefined;
    item.target = undefined;
    item.display = undefined;
    return undefined;
  }
  target = Number(target);
  if (item.display === undefined || item.target === undefined) {
    item.target = target;
    item.display = target;
    return item.display;
  }
  if (Object.is(item.target, target)) return item.display;
  if (item.timer) clearInterval(item.timer);
  const from = Number(item.display);
  const delta = target - from;
  const startedAt = Date.now();
  const durationMs = animatedNumberDurationMs(Math.abs(delta));
  item.target = target;
  item.timer = setInterval(() => {
    const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
    const eased = easeOutCubic(progress);
    item.display = progress >= 1 ? target : from + delta * eased;
    if (progress >= 1) { clearInterval(item.timer); item.timer = undefined; }
    scheduleRender();
  }, ANIMATED_NUMBER_INTERVAL_MS);
  return item.display;
}
function animatedNumberDurationMs(delta) {
  if (!Number.isFinite(delta) || delta <= 0) return ANIMATED_NUMBER_MIN_DURATION_MS;
  const scaled = ANIMATED_NUMBER_MIN_DURATION_MS + Math.log10(delta + 1) * ANIMATED_NUMBER_DURATION_SCALE_MS;
  return Math.min(ANIMATED_NUMBER_MAX_DURATION_MS, Math.max(ANIMATED_NUMBER_MIN_DURATION_MS, scaled));
}
function easeOutCubic(progress) {
  const clamped = Math.max(0, Math.min(1, progress));
  return 1 - Math.pow(1 - clamped, 3);
}
function renderQueued() {
  if (!state.queuedInput) { if (queuedEl.style.display !== 'none') queuedEl.style.display = 'none'; return; }
  if (queuedEl.style.display !== 'block') queuedEl.style.display = 'block';
  setText(queuedEl, 'pending next: ' + state.queuedInput.replace(/\s+/g, ' ').trim() + '  (Esc/Ctrl+C to clear)');
}
function renderPanel() {
  document.getElementById('app').classList.toggle('sessions-page', sessionsPage());
  if (!state.panel) { panelEl.className = ''; panelEl.innerHTML = ''; return; }
  panelEl.className = 'open';
  if (state.panel === 'sessions') renderSessionsPanel();
  else if (state.panel === 'login') renderLoginPanel();
}
async function openSessionsPanel() {
  state.view = 'sessions';
  state.panel = 'sessions';
  state.panelSelection = 0;
  history.replaceState(null, '', '/sessions');
  renderPanel();
  panelEl.className = 'open';
  panelEl.innerHTML = '<div class="panel-title">Sessions</div><div class="panel-muted">loading…</div>';
  const res = await fetch('/api/sessions');
  const body = await res.json();
  state.sessions = body.sessions || [];
  state.runningSessionIds = body.runningSessionIds || [];
  renderPanel();
}
function renderSessionsPanel() {
  const sessions = state.sessions || [];
  const selected = Math.max(0, Math.min(state.panelSelection, sessions.length - 1));
  state.panelSelection = selected;
  const currentSessionId = state.session && state.session.sessionId;
  const header = '<div class="panel-header"><div><div class="panel-title">Sessions</div><div class="panel-subtitle">Manage saved sessions.</div></div><div class="panel-toolbar"><button class="panel-primary" data-action="new-session" title="New session" aria-label="New session">+</button></div></div>';
  const body = sessions.length ? '<div class="session-list">' + sessions.map((s, i) => renderSessionCard(s, i, selected, currentSessionId)).join('') + '</div>' : '<div class="panel-muted">No saved sessions found. Tap + to start a new session.</div>';
  panelEl.innerHTML = header + body + '<div class="panel-muted" style="margin-top:8px">↑/↓ select · Enter enter · Delete remove</div>';
}
function renderSessionCard(s, i, selected, currentSessionId) {
  const isCurrent = s.sessionId === currentSessionId;
  const isRunning = (state.runningSessionIds || []).includes(s.sessionId) || (isCurrent && (state.busy || isActivePhase((state.status || {}).phase)));
  const badges = [
    isRunning ? '<span class="session-badge running">● running</span>' : '',
    isCurrent ? '<span class="session-badge current">current</span>' : '',
    '<span class="session-badge">' + esc(s.messages) + ' messages</span>',
  ].filter(Boolean).join('');
  const classes = ['session-card', i === selected ? 'selected' : '', isCurrent ? 'current' : '', isRunning ? 'running' : ''].filter(Boolean).join(' ');
  return '<div class="' + classes + '" data-session-index="' + i + '"><div class="session-main"><div class="session-title-line"><span class="session-name">' + esc(s.title || '(untitled)') + '</span></div><div class="session-badges">' + badges + '</div><div class="session-meta">' + esc(truncateMiddle(s.sessionId, 28)) + ' · updated ' + esc(s.updatedAt || 'unknown') + '</div></div><div class="session-actions"><span class="panel-actions"><button data-action="enter" data-session-id="' + esc(s.sessionId) + '">enter</button><button class="danger" data-action="delete" data-session-id="' + esc(s.sessionId) + '">delete</button></span></div></div>';
}
function showChatView() {
  state.view = 'chat';
  state.panel = undefined;
  history.replaceState(null, '', '/');
  renderPanel();
  input.focus();
}
async function enterSession(sessionId) {
  const result = await postJson('/api/sessions/resume', { sessionId });
  if (result.ok) showChatView();
}
async function createAndEnterSession() {
  const result = await postJson('/api/sessions/new', {});
  if (result.ok) showChatView();
}
async function openSessionsPanelAfterDelete(sessionId) {
  const session = (state.sessions || []).find(s => s.sessionId === sessionId);
  const label = session ? (session.title || session.sessionId) : sessionId;
  if (!confirm('Delete session "' + label + '"? This cannot be undone.')) return;
  await postJson('/api/sessions/delete', { sessionId });
  await openSessionsPanel();
}
async function openLoginPanel() {
  state.panel = 'login';
  panelEl.className = 'open';
  panelEl.innerHTML = '<div class="panel-title">Provider login</div><div class="panel-muted">loading…</div>';
  const res = await fetch('/api/login');
  state.login = await res.json();
  renderPanel();
}
function renderLoginPanel() {
  const login = state.login || state.interactive.login;
  if (!login) { panelEl.innerHTML = '<div class="panel-title">Provider login</div><div class="panel-muted">Login config unavailable.</div>'; return; }
  const fields = login.fields || [];
  panelEl.innerHTML = '<div class="panel-title">Provider login <span class="panel-muted">' + esc(login.envPath || '') + '</span></div><div class="login-grid"><label>Provider</label><select data-login-provider>' + (login.providers || []).map(p => '<option value="' + esc(p) + '" ' + (p === login.provider ? 'selected' : '') + '>' + esc(p) + '</option>').join('') + '</select>' + fields.map(field => '<label>' + esc(field.label) + (field.required ? ' *' : '') + '</label>' + loginFieldControl(field, login.values && login.values[field.key])).join('') + '</div><div class="login-actions"><button data-action="login-save">save</button><button data-action="panel-close">cancel</button></div><div class="panel-muted">Shared runtime fields save as MODEL_*; provider fields save as OPENAI_* / ANTHROPIC_*.</div>';
}
function loginFieldControl(field, value) {
  value = value || '';
  if (field.options && field.options.length) return '<select data-login-field="' + esc(field.key) + '">' + field.options.map(option => '<option value="' + esc(option) + '" ' + (option === value ? 'selected' : '') + '>' + esc(option || '<default>') + '</option>').join('') + '</select>';
  return '<input data-login-field="' + esc(field.key) + '" type="' + (field.secret ? 'password' : 'text') + '" value="' + esc(value) + '" placeholder="' + esc(field.placeholder || '') + '">';
}
function completions() {
  const text = input.value;
  const cursor = input.selectionStart || 0;
  const prefix = text.slice(0, cursor);
  const suffix = text.slice(cursor);
  if (!prefix.startsWith('/') || /\r|\n/.test(prefix) || /\S/.test(suffix)) return [];
  if (prefix.startsWith('/model') && (prefix.length === 6 || prefix[6] === ' ')) return modelCompletions(prefix);
  if (prefix.length > 1 && !/^\/[\w-]*$/.test(prefix)) return [];
  const normalized = prefix.toLowerCase();
  return (state.catalog.commands || []).flatMap(c => [c.name].concat(c.aliases || []).map(name => ({ value: name, insertText: name, description: c.description, arguments: c.arguments, kind: 'command' }))).filter(c => c.value.toLowerCase().startsWith(normalized));
}
function modelCompletions(prefix) {
  const hasTrailingSpace = /\s$/.test(prefix);
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  const args = tokens.slice(1);
  if (args.length >= 2 && !hasTrailingSpace) return reasoningCompletions(args[0] || '', args[1] || '');
  if (args.length >= 2) return [];
  if (args.length === 1 && hasTrailingSpace) return reasoningCompletions(args[0] || '', '');
  const current = args[0] || '';
  const models = (state.catalog.modelIds || []).filter(id => id.toLowerCase().includes(current.toLowerCase())).slice(0, 80).map(id => ({ value: id, insertText: '/model ' + id, description: 'model id', arguments: 'optional', kind: 'model' }));
  const reasoning = reasoningCompletions('', current);
  return models.concat(reasoning);
}
function reasoningCompletions(modelId, current) { return (state.catalog.reasoning || []).filter(x => x.startsWith((current || '').toLowerCase())).map(x => ({ value: x, insertText: modelId ? '/model ' + modelId + ' ' + x : '/model ' + x, description: x === 'default' ? 'use env/provider default' : x === 'off' ? 'send no reasoning config' : 'reasoning effort: ' + x, arguments: 'optional', kind: 'reasoning' })); }
function renderCompletions() {
  const list = completions();
  input.classList.toggle('command', input.value.startsWith('/'));
  if (!list.length || state.busy && state.queuedInput !== undefined) { completionsEl.style.display = 'none'; return; }
  const selected = Math.max(0, Math.min(state.completionIndex, list.length - 1));
  state.completionIndex = selected;
  const pageSize = 10;
  const pageStart = Math.floor(selected / pageSize) * pageSize;
  const visible = list.slice(pageStart, pageStart + pageSize);
  const pageCount = Math.ceil(list.length / pageSize);
  const title = pageCount > 1 ? 'Completions (' + list.length + ') page ' + (Math.floor(pageStart / pageSize) + 1) + '/' + pageCount : 'Completions (' + list.length + ')';
  completionsEl.style.display = 'block';
  completionsEl.innerHTML = '<div class="completion-title">' + esc(title) + '</div>' + visible.map((c, i) => '<div class="completion-row ' + (c.kind || '') + ' ' + (i + pageStart === selected ? 'selected' : '') + '"><span class="num">' + (i + pageStart + 1) + '.</span><span class="name">' + esc(c.value) + '</span><span class="desc">' + esc(c.description || '') + '</span></div>').join('') + '<div class="completion-footer">↑/↓ select · ←/→ page · Tab complete</div>';
}
function selectedCompletion() { const list = completions(); return list.length ? list[Math.max(0, Math.min(state.completionIndex, list.length - 1))] : undefined; }
function completeSelection() { const c = selectedCompletion(); if (!c) return false; const cursor = input.selectionStart || 0; input.value = c.insertText + input.value.slice(cursor); input.selectionStart = input.selectionEnd = c.insertText.length; autosize(); renderCompletions(); return true; }
function updateInputPlaceholder() { input.placeholder = 'Type a message, or /help for commands'; }
async function postJson(url, body) { const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await res.json(); if (!value.ok && value.error) alert(value.error); return value; }
async function saveLoginPanel() {
  const login = state.login;
  if (!login) return;
  const values = {};
  for (const el of panelEl.querySelectorAll('[data-login-field]')) values[el.getAttribute('data-login-field')] = el.value;
  const provider = panelEl.querySelector('[data-login-provider]')?.value || login.provider;
  const result = await postJson('/api/login', { provider, values });
  if (result.ok) { state.panel = undefined; renderPanel(); }
}
function attachmentsForText(text) { return state.attachments.filter(attachment => text.includes(attachment.label)); }
function insertAtCursor(value) { const start = input.selectionStart || 0, end = input.selectionEnd || start; input.value = input.value.slice(0, start) + value + input.value.slice(end); input.selectionStart = input.selectionEnd = start + value.length; autosize(); renderCompletions(); }
async function fileToDataUrlPayload(file) {
  const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(reader.error || new Error('read failed')); reader.readAsDataURL(file); });
  const comma = dataUrl.indexOf(',');
  return { mimeType: file.type || 'image/png', data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl };
}
async function handlePaste(e) {
  const files = Array.from(e.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  for (const file of files) {
    const id = ++state.attachmentCounter;
    const label = '[img#' + id + ']';
    const payload = await fileToDataUrlPayload(file);
    state.attachments.push({ kind: 'image', label, mimeType: payload.mimeType, data: payload.data });
    insertAtCursor(label);
  }
}
async function submit() {
  const text = input.value;
  if (text.trim() === '/sessions') { input.value = ''; autosize(); renderCompletions(); await openSessionsPanel(); return; }
  if (text.trim() === '/login') { input.value = ''; autosize(); renderCompletions(); await openLoginPanel(); return; }
  if (text.trim() === '/new') {
    input.value = '';
    state.attachments = [];
    autosize();
    renderCompletions();
    const result = await postJson('/api/sessions/new', {});
    if (!result.ok && result.error) alert(result.error);
    return;
  }
  const attachments = attachmentsForText(text);
  if (!text.trim() && attachments.length === 0) return;
  state.history = [text].concat(state.history.filter(x => x !== text)).slice(0, 100);
  state.historyIndex = undefined;
  input.value = '';
  state.attachments = [];
  if (state.busy) {
    state.queuedInput = text;
  }
  autosize();
  renderCompletions();
  const res = await fetch('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, attachments }) });
  const body = await res.json();
  if (!body.ok && body.error) alert(body.error);
}
transcript.addEventListener('scroll', updateScrollBottomAffordance, { passive: true });
scrollBottom.addEventListener('click', () => { transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' }); updateScrollBottomAffordance(); });
brand.addEventListener('click', () => { void openSessionsPanel(); });
panelEl.addEventListener('click', async (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  const action = button.getAttribute('data-action');
  if (action === 'panel-close') { state.panel = undefined; renderPanel(); input.focus(); return; }
  if (action === 'new-session') { await createAndEnterSession(); return; }
  if (action === 'enter') { await enterSession(button.getAttribute('data-session-id')); return; }
  if (action === 'delete') { await openSessionsPanelAfterDelete(button.getAttribute('data-session-id')); return; }
  if (action === 'login-save') { await saveLoginPanel(); return; }
});
panelEl.addEventListener('change', async (e) => {
  const provider = e.target.closest('[data-login-provider]');
  if (!provider) return;
  const res = await fetch('/api/login?provider=' + encodeURIComponent(provider.value));
  state.login = await res.json();
  renderPanel();
});
transcript.addEventListener('click', (e) => {
  const button = e.target.closest('.tool-toggle');
  if (!button) return;
  const id = Number(button.getAttribute('data-line-id'));
  if (!Number.isFinite(id)) return;
  if (state.expandedToolLines.has(id)) state.expandedToolLines.delete(id);
  else state.expandedToolLines.add(id);
  const line = state.lines.find(x => x.id === id);
  const element = transcript.querySelector('[data-line-id="' + cssEscape(String(id)) + '"]');
  if (line && element) {
    updateLineElement(element, line);
    renderedLineKeys.set(String(id), lineRenderKey(line));
  }
});
function handleSessionsKey(e) {
  if (state.panel !== 'sessions') return false;
  const countSessions = (state.sessions || []).length;
  if (e.key === 'Escape') { e.preventDefault(); showChatView(); return true; }
  if (e.key === 'ArrowUp' && countSessions) { e.preventDefault(); state.panelSelection = (state.panelSelection + countSessions - 1) % countSessions; renderPanel(); return true; }
  if (e.key === 'ArrowDown' && countSessions) { e.preventDefault(); state.panelSelection = (state.panelSelection + 1) % countSessions; renderPanel(); return true; }
  if (e.key === 'Enter' && countSessions) { e.preventDefault(); const s = state.sessions[state.panelSelection]; if (s) void enterSession(s.sessionId); return true; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && countSessions) { e.preventDefault(); const s = state.sessions[state.panelSelection]; if (s) openSessionsPanelAfterDelete(s.sessionId); return true; }
  return false;
}
input.addEventListener('keydown', (e) => {
  const count = completions().length;
  if (handleSessionsKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const c = selectedCompletion(); if (c && c.kind === 'command' && c.arguments !== 'none') { completeSelection(); input.value += ' '; input.selectionStart = input.selectionEnd = input.value.length; return; } submit(); return; }
  if (e.key === 'Tab') { if (completeSelection()) e.preventDefault(); return; }
  if (e.key === 'ArrowUp' && count) { e.preventDefault(); state.completionIndex = (state.completionIndex + count - 1) % count; renderCompletions(); return; }
  if (e.key === 'ArrowDown' && count) { e.preventDefault(); state.completionIndex = (state.completionIndex + 1) % count; renderCompletions(); return; }
  if (e.key === 'ArrowLeft' && count > 10) { e.preventDefault(); state.completionIndex = (state.completionIndex + count - 10) % count; renderCompletions(); return; }
  if (e.key === 'ArrowRight' && count > 10) { e.preventDefault(); state.completionIndex = (state.completionIndex + 10) % count; renderCompletions(); return; }
  if (e.key === 'ArrowUp' && !input.value && state.history.length) { e.preventDefault(); state.historyIndex = Math.min(state.history.length - 1, (state.historyIndex ?? -1) + 1); input.value = state.history[state.historyIndex] || ''; autosize(); return; }
  if (e.key === 'ArrowDown' && state.historyIndex !== undefined) { e.preventDefault(); state.historyIndex -= 1; if (state.historyIndex < 0) { state.historyIndex = undefined; input.value = ''; } else input.value = state.history[state.historyIndex] || ''; autosize(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { if (input.value) { input.value = ''; autosize(); renderCompletions(); } else if (state.queuedInput) { state.queuedInput = undefined; scheduleRender(); fetch('/api/queue/cancel', { method: 'POST' }); } else fetch('/api/interrupt', { method: 'POST' }); }
  if (e.key === 'Escape') { state.completionIndex = 0; if (state.queuedInput) { state.queuedInput = undefined; scheduleRender(); fetch('/api/queue/cancel', { method: 'POST' }); } else renderCompletions(); }
});
document.addEventListener('keydown', (e) => {
  if (e.target === input || e.target.closest('input, textarea, select')) return;
  handleSessionsKey(e);
});
input.addEventListener('input', () => { state.completionIndex = 0; state.attachments = attachmentsForText(input.value); autosize(); renderCompletions(); });
input.addEventListener('paste', (e) => { void handlePaste(e); });
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * .35) + 'px'; updateScrollBottomAffordance(); }
function phaseLabel(phase) { if (phase === 'calling_model') return 'model'; if (phase === 'thinking') return 'think'; if (phase === 'running_tools') return 'tools'; if (phase === 'injecting_context') return 'context'; return phase || 'ready'; }
function isActivePhase(phase) { return ['running', 'preparing', 'calling_model', 'thinking', 'running_tools', 'compacting', 'injecting_context'].includes(phase); }
function contextParts(metrics) { if (!metrics) return { percent: '?' }; return { percent: metrics.contextUsageRatio === undefined ? '?' : (metrics.contextUsageRatio * 100).toFixed(1) + '%' }; }
function contextColor(metrics) { const r = metrics && metrics.contextUsageRatio; if (r === undefined) return 'var(--muted)'; if (r >= .9) return 'var(--red)'; if (r >= .75) return 'var(--yellow)'; return 'var(--muted)'; }
function compactNumber(value) { if (value === undefined || value === null) return '?'; const n = Math.max(0, Math.round(value)); if (n >= 1000000) return trimFixed(n / 1000000) + 'm'; if (n >= 10000) return Math.round(n / 1000) + 'k'; if (n >= 1000) return trimFixed(n / 1000) + 'k'; return String(n); }
function formatElapsed(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); if (seconds < 60) return seconds + 's'; const minutes = Math.floor(seconds / 60); const rem = String(seconds % 60).padStart(2, '0'); if (minutes < 60) return minutes + 'm' + rem + 's'; return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm'; }
function trimFixed(v) { return v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ''); }
function truncateMiddle(value, max) { value = String(value); if (value.length <= max) return value; if (max <= 3) return value.slice(0, max); const l = Math.ceil((max - 3) / 2), r = Math.floor((max - 3) / 2); return value.slice(0, l) + '...' + value.slice(value.length - r); }
function stripAnsi(value) { return String(value).replace(/\x1b\[[0-9;]*m/g, ''); }
function cssEscape(value) { return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
function sanitizeMarkdownHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html);
  const allowed = new Set(['A', 'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DEL', 'S', 'INPUT', 'TASK-LIST']);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!allowed.has(node.tagName)) {
      node.replaceWith(document.createTextNode(node.textContent || ''));
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      const keep = (node.tagName === 'A' && name === 'href' && safeHref(value)) ||
        (node.tagName === 'A' && name === 'title') ||
        (node.tagName === 'CODE' && name === 'class' && /^language-[\w-]+$/.test(value)) ||
        (node.tagName === 'INPUT' && (name === 'type' || name === 'checked' || name === 'disabled'));
      if (!keep) node.removeAttribute(attr.name);
    }
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noreferrer noopener');
    }
    if (node.tagName === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') node.remove();
      else node.setAttribute('disabled', '');
    }
  }
  highlightMarkdownCodeBlocks(template.content);
  return template.innerHTML;
}
function highlightMarkdownCodeBlocks(root) {
  const highlighter = window.hljs;
  for (const code of root.querySelectorAll('pre > code')) {
    const language = normalizeCodeLanguage(code.className);
    const pre = code.parentElement;
    if (pre && language) pre.setAttribute('data-lang', language);
    if (!highlighter) continue;
    try {
      const source = code.textContent || '';
      const canUseLanguage = language && highlighter.getLanguage(language);
      const result = canUseLanguage
        ? highlighter.highlight(source, { language, ignoreIllegals: true })
        : source.length <= 20000
          ? highlighter.highlightAuto(source)
          : undefined;
      if (!result) continue;
      code.innerHTML = result.value;
      code.className = ['hljs', result.language ? 'language-' + result.language : language ? 'language-' + language : ''].filter(Boolean).join(' ');
      if (pre && result.language && !pre.hasAttribute('data-lang')) pre.setAttribute('data-lang', result.language);
    } catch {
      code.textContent = code.textContent || '';
    }
  }
}
function normalizeCodeLanguage(className) {
  const match = /(?:^|\s)language-([\w-]+)/.exec(className || '') || /(?:^|\s)lang-([\w-]+)/.exec(className || '');
  if (!match) return '';
  const value = match[1].toLowerCase();
  const aliases = { cjs: 'javascript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript', py: 'python', python3: 'python', sh: 'bash', shell: 'bash', ts: 'typescript', tsx: 'typescript', yml: 'yaml' };
  return aliases[value] || value;
}
function safeHref(value) {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch { return false; }
}
function safeImageSrc(value) {
  if (typeof value !== 'string') return false;
  if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(value)) return true;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}
function esc(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function linkify(value) { return value.replace(/(https?:\/\/[^\s<]+)/g, '<a style="color:var(--cyan)" target="_blank" href="$1">$1</a>'); }
document.getElementById('app').classList.toggle('sessions-page', sessionsPage());
updateInputPlaceholder();
autosize();
if (openSessionsOnLoad) void openSessionsPanel();
</script>
</body>
</html>`;

