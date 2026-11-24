/*
 * browse-ui.js — the Songs panel's browse controls: the tabs and the rankings table
 * (M6, plan §5.7 / §5.9). Since 2026-11-24 (Rae) the queue is a fourth tab, after Rankings: the
 * Queue panel is gone. This module only draws the tab (and its count, setCount); the queue view
 * itself (#queue-view: the list, Clear all) is app.js / library-ui's, like #song-list.
 *
 * It owns ONLY: the tabs inside tabsEl and the rankings view inside paneEl. It does NOT draw songs
 * or artists — the virtual list (#song-list, library-ui.js) does (R8). It never persists anything
 * (view state resets on reload). It never touches the overlay stack: "Clear" only calls
 * onClearRankings. The songbook / type chips and the sort select that used to sit under the tabs
 * were removed (2026-11-24): the list always shows every song, in Relevance order. The player /
 * difficulty chips inside the rankings view are the rankings' own filters and stay.
 *
 * Implementation notes:
 *   - Every element is built once and then only updated: the tabs at the first render(), the
 *     rankings view's shell the first time it is shown. Only the rankings chips (when the players /
 *     difficulties change) and the table's rows are rebuilt. When a rebuild removes the focused
 *     chip, focus moves to the chip with the same value, else the view's next sensible stop, else
 *     the selected tab — never to <body>.
 *   - One delegated listener per container, added at construction (click / keydown).
 *     No inline handlers, no inline styles, no innerHTML: every string goes through textContent.
 *   - The DOM surface used: createElement, setAttribute, textContent, appendChild,
 *     replaceChildren (else textContent + appendChild), addEventListener, hidden, parentElement.
 *     Feature-detected: doc.activeElement, el.focus, el.contains, scrollTop / clientHeight /
 *     scrollHeight, getBoundingClientRect, Intl.DateTimeFormat.
 *   - Callbacks fire only on a real change (a click on the selected tab reports nothing).
 *     setTab(id) for the tab already shown is a no-op. render() and reset() fire no callbacks;
 *     read `tab` after them.
 *   - The rankings table scrolls inside its own region (.rank-scroll, tabindex 0, role region):
 *     with focus on it ArrowUp / ArrowDown scroll it and are prevented; at the top / bottom they
 *     are released, so the D-pad router moves on (to the chips above, to Clear below).
 */

import { DIFFICULTIES } from "../rankings.js";

export const BROWSE_TABS = Object.freeze([
  Object.freeze({ id: "all", label: "All" }),
  Object.freeze({ id: "artists", label: "Artists" }),
  Object.freeze({ id: "rankings", label: "Rankings" }),
  Object.freeze({ id: "queue", label: "Queue" }),
]);

const TAB_IDS = BROWSE_TABS.map((t) => t.id);
const MAX_ROWS = 50;
const LIST_ID = "song-list";                       // what the All / Artists tabs control
const QUEUE_ID = "queue-view";                     // what the Queue tab controls (o.queueId overrides)
const EMPTY_TEXT = "No rankings yet — finish a song with scoring on.";
const NO_MATCH_TEXT = "No rankings match this filter.";

const DIFF_LABEL = Object.freeze({ easy: "Easy", normal: "Normal", hard: "Hard" });
const diffLabel = (d) => (Object.prototype.hasOwnProperty.call(DIFF_LABEL, d) ? DIFF_LABEL[d] : String(d));

const report = (e) => { try { console.error(e); } catch { /* no console */ } };
const parentOf = (n) => (n && (n.parentElement || n.parentNode)) || null;

/** Distinct non-empty strings of an array (or any non-string iterable), first-seen order. */
function strings(v) {
  if (!v || typeof v === "string" || typeof v[Symbol.iterator] !== "function") return [];
  const out = [];
  const seen = new Set();
  for (const s of v) {
    if (typeof s !== "string" || s === "" || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// "Short, local" dates, plus the full date + time for the tooltip. Formatters made on first use.
let shortDate = null;
let longDate = null;
function formatDate(at) {
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  let short = iso.slice(0, 10);
  let long = iso;
  try {
    shortDate ||= new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
    longDate ||= new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
    short = shortDate.format(d);
    long = longDate.format(d);
  } catch { /* no Intl: the ISO forms stand */ }
  return { short, long, iso };
}

/**
 * @param {object} o
 * @param {HTMLElement} o.tabsEl   #browse-tabs   (role=tablist; this module fills it and unhides it)
 * @param {HTMLElement} o.paneEl   #browse-pane   (the rankings view; shown only on the Rankings tab)
 * @param {(f: {player: string, difficulty: string}) => {rows: object[], players: string[], difficulties: string[]}} o.getRankings
 * @param {(id: string) => void} [o.onTab]            after the tab changed (by a click, a key or setTab)
 * @param {() => void} [o.onClearRankings]             the rankings view's "Clear" button
 * @param {string} [o.queueId]  the queue view's id, for the Queue tab's aria-controls ("queue-view")
 * @param {Document} [o.doc]
 * @returns {{
 *   render(): void,          // build the tabs (once) and unhide tabsEl; keeps the current tab
 *   setTab(id: string): void,// programmatic switch (home tiles); calls onTab
 *   readonly tab: string,    // "all" | "artists" | "rankings" | "queue"
 *   setCount(id: string, n: number): void, // a count after a tab's name ("Queue 3"); 0 = none
 *   refreshPane(): void,     // re-render the rankings view (a new ranking, a clear)
 *   reset(): void,           // tab all, rankings filters All (no callbacks fired)
 * }}
 *
 * Tabs: <button role="tab" aria-selected aria-controls> in BROWSE_TABS order; a roving tabindex
 *   (selected = 0, others -1); ArrowLeft/ArrowRight move AND select (automatic activation) and call
 *   preventDefault; at the first/last tab the arrow is NOT prevented (the D-pad router moves on).
 *   Click selects.
 * Rankings view (paneEl): player chips (All + rankingPlayers) and difficulty chips (All + present
 *   difficulties), a table of at most 50 rows: # · Player · Song (title, artist under it) · Score ·
 *   Difficulty · Date (short, local), and a "Clear" button (hidden when there are no rows). An empty
 *   state when there are no rankings: "No rankings yet — finish a song with scoring on.". All text
 *   via textContent. paneEl is hidden on All/Artists; #song-list visibility is lane I's (it hides
 *   the list on Rankings).
 */
export function createBrowseUI(o = {}) {
  const opts = o || {};
  const { tabsEl, paneEl, getRankings, onTab, onClearRankings } = opts;
  for (const [name, el] of [["tabsEl", tabsEl], ["paneEl", paneEl]]) {
    if (!el || typeof el.appendChild !== "function" || typeof el.addEventListener !== "function") {
      throw new TypeError(`createBrowseUI: \`${name}\` is required`);
    }
  }

  // --- state (view state only: nothing here is ever persisted) -------------------------------
  let tab = "all";
  let player = "";             // rankings filter, "" = all players
  let difficulty = "";         // rankings filter, "" = every difficulty
  let rendered = false;        // render() has run (tabs built, tabsEl unhidden)

  // Every interactive element this module made → what it is. The delegated listeners and the
  // focus keeper both read it, so a stale element (from before a rebuild) is never acted on.
  const owned = new Map();     // element → { kind: "tab"|"player"|"diff"|"clear"|"region", value }
  const tabBtn = new Map();    // tab id → button
  const countEl = new Map();   // tab id → its <span class="tab-count"> (the Queue tab)
  const counts = new Map();    // tab id → the count set before or after the tabs were built

  // --- small DOM helpers ---------------------------------------------------------------------
  const docRef = () => opts.doc || tabsEl.ownerDocument || globalThis.document || null;
  const D = () => {
    const d = docRef();
    if (!d || typeof d.createElement !== "function") throw new TypeError("createBrowseUI: no document to render into");
    return d;
  };
  const add = (parent, child) => { parent.appendChild(child); return child; };
  const make = (d, tag, className, text) => {
    const n = d.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  };
  const replace = (el, children) => {
    if (typeof el.replaceChildren === "function") el.replaceChildren(...children);
    else { el.textContent = ""; for (const c of children) el.appendChild(c); }
  };
  const press = (el, on) => el.setAttribute("aria-pressed", on ? "true" : "false");
  const call = (fn, ...args) => {
    if (typeof fn !== "function") return;
    try { fn(...args); } catch (e) { report(e); }
  };
  const keyOf = (info) => `${info.kind}\u0001${info.value}`;

  function contains(root, node) {
    if (!root || !node) return false;
    if (typeof root.contains === "function") {
      try { return !!root.contains(node); } catch { /* fall through to the walk */ }
    }
    for (let n = node; n; n = parentOf(n)) if (n === root) return true;
    return false;
  }
  /** Is `el` attached under `root` with no hidden element on the way (root's own state included)? */
  function shownIn(el, root) {
    for (let n = el; n; n = parentOf(n)) {
      if (n.hidden === true) return false;
      if (n === root) return true;
    }
    return false;
  }
  function activeEl() {
    const d = docRef();
    try { return (d && d.activeElement) || null; } catch { return null; }
  }
  function focusEl(el) {
    if (!el || typeof el.focus !== "function") return false;
    try { el.focus({ preventScroll: true }); } catch {
      try { el.focus(); } catch { return false; }
    }
    return true;
  }
  /** Walk up from an event target to the nearest element of ours of one of `kinds`. */
  function findOwned(target, ...kindsWanted) {
    for (let n = target; n; n = parentOf(n)) {
      const info = owned.get(n);
      if (info) return kindsWanted.includes(info.kind) ? n : null;
    }
    return null;
  }
  function forget(elements) { for (const el of elements) owned.delete(el); }

  // Focus keeping across a rebuild: remember what had focus inside `root`, and afterwards, if it
  // is gone or hidden, focus its replacement (same kind + value), else the first usable fallback.
  function snapshot(root) {
    const a = activeEl();
    if (!a || a === root || !contains(root, a)) return null;
    const info = owned.get(a);
    return { el: a, key: info ? keyOf(info) : null };
  }
  function settle(snap, root, fallbacks) {
    if (!snap) return;
    if (shownIn(snap.el, root) && activeEl() === snap.el) return;      // untouched
    let target = null;
    if (snap.key) {
      for (const [el, info] of owned) if (keyOf(info) === snap.key && shownIn(el, root)) { target = el; break; }
    }
    if (!target) target = fallbacks.map((f) => f()).find(Boolean) || null;
    if (target) focusEl(target);
  }
  const selectedTabIfShown = () => {
    const b = tabBtn.get(tab);
    return b && shownIn(b, tabsEl) && tabsEl.hidden !== true ? b : null;
  };

  // --- tabs ------------------------------------------------------------------------------------
  let tabsBuilt = false;
  function buildTabs() {
    if (tabsBuilt) return;
    tabsBuilt = true;
    const d = D();
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "Browse");
    const paneId = paneEl.id || "browse-pane";
    const buttons = BROWSE_TABS.map((t) => {
      const b = make(d, "button", "browse-tab", t.label);
      b.setAttribute("type", "button");
      b.setAttribute("role", "tab");
      b.setAttribute("id", `browse-tab-${t.id}`);
      b.setAttribute("data-tab", t.id);
      b.setAttribute("aria-controls", t.id === "rankings" ? paneId : t.id === "queue" ? (opts.queueId || QUEUE_ID) : LIST_ID);
      if (t.id === "queue") {
        const c = add(b, make(d, "span", "tab-count", ""));
        countEl.set(t.id, c);
        paintCount(t.id);
      }
      tabBtn.set(t.id, b);
      owned.set(b, { kind: "tab", value: t.id });
      return b;
    });
    replace(tabsEl, buttons);
  }
  function paintCount(id) {
    const c = countEl.get(id);
    if (!c) return;
    const n = counts.get(id) || 0;
    const text = n > 0 ? String(n) : "";
    if (c.textContent !== text) c.textContent = text;
  }
  function paintTabs() {
    for (const [id, b] of tabBtn) {
      const on = id === tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("tabindex", on ? "0" : "-1");
    }
  }

  /** Show what the current tab shows; render the rankings view when it is the one. */
  function applyTab() {
    if (tabsBuilt) paintTabs();
    const before = snapshot(paneEl);
    paneEl.hidden = tab !== "rankings";
    if (tab === "rankings") renderPane();
    // focus left in the rankings view when it goes away moves to the selected tab
    if (before && paneEl.hidden) settle(before, paneEl, [selectedTabIfShown]);
  }

  function selectTab(id, { focus = false } = {}) {
    if (!TAB_IDS.includes(id)) return false;
    if (id === tab) {
      if (focus) focusEl(tabBtn.get(id));
      return false;
    }
    tab = id;
    applyTab();
    if (focus) focusEl(tabBtn.get(id));
    call(onTab, id);
    return true;
  }

  // ArrowLeft / ArrowRight (TV: keyCode 37 / 39 when the key has no name) → -1 / +1.
  function arrowStep(ev) {
    const key = ev.key;
    if (key === "ArrowLeft" || key === "Left") return -1;
    if (key === "ArrowRight" || key === "Right") return 1;
    if (key == null || key === "" || key === "Unidentified") {
      if (ev.keyCode === 37) return -1;
      if (ev.keyCode === 39) return 1;
    }
    return 0;
  }
  function verticalStep(ev) {
    const key = ev.key;
    if (key === "ArrowUp" || key === "Up") return -1;
    if (key === "ArrowDown" || key === "Down") return 1;
    if (key == null || key === "" || key === "Unidentified") {
      if (ev.keyCode === 38) return -1;
      if (ev.keyCode === 40) return 1;
    }
    return 0;
  }
  const chord = (ev) => !!(ev.ctrlKey || ev.metaKey || ev.altKey);

  tabsEl.addEventListener("click", (ev) => {
    const b = findOwned(ev && ev.target, "tab");
    if (b) selectTab(owned.get(b).value);
  });
  tabsEl.addEventListener("keydown", (ev) => {
    if (!ev || ev.defaultPrevented || chord(ev)) return;
    const step = arrowStep(ev);
    if (!step) return;
    const b = findOwned(ev.target, "tab");
    if (!b) return;
    const next = TAB_IDS.indexOf(owned.get(b).value) + step;
    if (next < 0 || next >= TAB_IDS.length) return;   // the edge: not ours, the router moves on
    ev.preventDefault();
    selectTab(TAB_IDS[next], { focus: true });
  });

  // --- chips (the rankings view's player / difficulty filters) -------------------------------
  function labelledGroup(d, className, labelId, text) {
    const g = make(d, "div", `chip-group ${className}`);
    g.setAttribute("role", "group");
    g.setAttribute("aria-labelledby", labelId);
    const label = make(d, "span", "chip-label", text);
    label.setAttribute("id", labelId);
    return [g, label];
  }

  function chip(d, kind, value, label, { title = "" } = {}) {
    const b = make(d, "button", "chip", label);
    b.setAttribute("type", "button");
    if (title) b.setAttribute("title", title);
    press(b, false);
    owned.set(b, { kind, value });
    return b;
  }

  // --- the rankings view -----------------------------------------------------------------------
  let paneBuilt = false;
  let rankFilters = null;
  let playerGroup = null;
  let diffGroup = null;
  let playerLabel = null;
  let diffGroupLabel = null;
  let emptyEl = null;
  let region = null;
  let tbody = null;
  let foot = null;
  let clearBtn = null;
  let paneSig = null;          // the players / difficulties the pane chips were last built from

  function buildPane() {
    if (paneBuilt) return;
    paneBuilt = true;
    const d = D();
    paneEl.setAttribute("role", "tabpanel");
    paneEl.setAttribute("aria-labelledby", "browse-tab-rankings");

    rankFilters = make(d, "div", "rank-filters");
    [playerGroup, playerLabel] = labelledGroup(d, "chip-group-player", "browse-lbl-player", "Player");
    [diffGroup, diffGroupLabel] = labelledGroup(d, "chip-group-diff", "browse-lbl-diff", "Difficulty");
    add(rankFilters, playerGroup);
    add(rankFilters, diffGroup);

    emptyEl = make(d, "p", "rank-empty");
    emptyEl.hidden = true;

    region = make(d, "div", "rank-scroll");
    region.setAttribute("tabindex", "0");
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", "Rankings table");
    owned.set(region, { kind: "region", value: "" });
    // Explicit roles: the stylesheet lays rows out as grids, and some engines drop a table's
    // semantics once its display changes.
    const table = make(d, "table", "rank-table");
    table.setAttribute("role", "table");
    table.setAttribute("aria-label", "Top 50");
    const thead = make(d, "thead");
    thead.setAttribute("role", "rowgroup");
    const hr = make(d, "tr", "rank-head");
    hr.setAttribute("role", "row");
    for (const [cls, text, name] of [
      ["rk-pos", "#", "Rank"], ["rk-player", "Player"], ["rk-song", "Song"],
      ["rk-score", "Score"], ["rk-diff", "Difficulty"], ["rk-date", "Date"],
    ]) {
      const th = make(d, "th", cls, text);
      th.setAttribute("scope", "col");
      th.setAttribute("role", "columnheader");
      if (name) th.setAttribute("aria-label", name);
      add(hr, th);
    }
    add(thead, hr);
    tbody = make(d, "tbody");
    tbody.setAttribute("role", "rowgroup");
    add(table, thead);
    add(table, tbody);
    add(region, table);

    foot = make(d, "div", "rank-foot");
    clearBtn = make(d, "button", "rank-clear", "Clear");
    clearBtn.setAttribute("type", "button");
    clearBtn.setAttribute("data-act", "clear-rankings");
    clearBtn.setAttribute("aria-label", "Clear rankings");
    owned.set(clearBtn, { kind: "clear", value: "" });
    add(foot, clearBtn);

    replace(paneEl, [rankFilters, emptyEl, region, foot]);
  }

  function queryRankings() {
    let r = null;
    if (typeof getRankings === "function") {
      try { r = getRankings({ player, difficulty }); } catch (e) { report(e); }
    }
    const rows = r && Array.isArray(r.rows) ? r.rows.filter((x) => x && typeof x === "object").slice(0, MAX_ROWS) : [];
    const diffs = strings(r && r.difficulties);
    return {
      rows,
      players: strings(r && r.players),
      // DIFFICULTIES order first, then anything unexpected in the order given
      difficulties: [...DIFFICULTIES.filter((x) => diffs.includes(x)), ...diffs.filter((x) => !DIFFICULTIES.includes(x))],
    };
  }

  function rebuildPaneChips(res) {
    const sig = JSON.stringify([res.players, res.difficulties]);
    if (sig === paneSig) return false;
    paneSig = sig;
    const d = D();
    const old = [];
    for (const [el, info] of owned) if (info.kind === "player" || info.kind === "diff") old.push(el);
    forget(old);
    const playerChips = res.players.length
      ? [chip(d, "player", "", "All"), ...res.players.map((p) => chip(d, "player", p, p, { title: p }))]
      : [];
    // One difficulty present ("Normal" for everyone until M9) offers no choice: no chips at all,
    // rather than "All · Normal" (§4.0 keep it clean — integration amendment).
    const diffChips = res.difficulties.length > 1
      ? [chip(d, "diff", "", "All"), ...res.difficulties.map((x) => chip(d, "diff", x, diffLabel(x)))]
      : [];
    for (const c of diffChips) if (owned.get(c).value) c.setAttribute("data-difficulty", owned.get(c).value);
    replace(playerGroup, [playerLabel, ...playerChips]);
    replace(diffGroup, [diffGroupLabel, ...diffChips]);
    playerGroup.hidden = playerChips.length === 0;
    diffGroup.hidden = diffChips.length === 0;
    return true;
  }

  function paintPaneChips() {
    for (const [el, info] of owned) {
      if (info.kind === "player") press(el, info.value === player);
      else if (info.kind === "diff") press(el, info.value === difficulty);
    }
  }

  function cell(d, tr, cls, text) {
    const td = make(d, "td", cls, text);
    td.setAttribute("role", "cell");
    add(tr, td);
    return td;
  }
  function rowEl(d, e, i) {
    const tr = make(d, "tr", "rank-row");
    tr.setAttribute("role", "row");
    cell(d, tr, "rk-pos", String(i + 1));
    const who = typeof e.player === "string" && e.player ? e.player : "—";
    cell(d, tr, "rk-player", who).setAttribute("title", who);
    const songTd = cell(d, tr, "rk-song");
    const title = typeof e.song === "string" && e.song ? e.song : "(untitled)";
    add(songTd, make(d, "span", "rk-title", title)).setAttribute("title", title);
    if (typeof e.artist === "string" && e.artist) add(songTd, make(d, "span", "rk-artist", e.artist));
    const score = typeof e.score === "number" && Number.isFinite(e.score) ? String(Math.round(e.score)) : "–";
    cell(d, tr, "rk-score", score);
    cell(d, tr, "rk-diff", typeof e.difficulty === "string" && e.difficulty ? diffLabel(e.difficulty) : "");
    const dateTd = cell(d, tr, "rk-date");
    const when = formatDate(e.at);
    if (when) {
      const t = make(d, "time", "", when.short);
      t.setAttribute("datetime", when.iso);
      t.setAttribute("title", when.long);
      add(dateTd, t);
    }
    return tr;
  }

  function renderPane({ filterChanged = false } = {}) {
    buildPane();
    const snap = snapshot(paneEl);
    let res = queryRankings();
    // a filter whose value has gone (a clear, a pruned list) falls back to All
    let fixed = false;
    if (player && !res.players.includes(player)) { player = ""; fixed = true; }
    if (difficulty && !res.difficulties.includes(difficulty)) { difficulty = ""; fixed = true; }
    if (fixed) res = queryRankings();

    const d = D();
    const any = res.players.length > 0 || res.rows.length > 0;
    rebuildPaneChips(res);
    paintPaneChips();
    rankFilters.hidden = !any;

    replace(tbody, res.rows.map((e, i) => rowEl(d, e, i)));
    const hasRows = res.rows.length > 0;
    region.hidden = !hasRows;
    if (filterChanged && typeof region.scrollTop === "number") region.scrollTop = 0;
    emptyEl.textContent = any ? NO_MATCH_TEXT : EMPTY_TEXT;
    emptyEl.hidden = hasRows;
    clearBtn.hidden = !hasRows;
    foot.hidden = !hasRows;

    const firstShown = (kind) => {
      for (const [el, info] of owned) if (info.kind === kind && shownIn(el, paneEl)) return el;
      return null;
    };
    settle(snap, paneEl, [
      () => firstShown("player"),
      () => firstShown("diff"),
      () => (shownIn(region, paneEl) ? region : null),
      selectedTabIfShown,
    ]);
  }

  paneEl.addEventListener("click", (ev) => {
    const b = findOwned(ev && ev.target, "player", "diff", "clear");
    if (!b) return;
    const { kind, value } = owned.get(b);
    if (kind === "clear") { call(onClearRankings); return; }
    if (kind === "player") {
      if (value === player) return;
      player = value;
    } else {
      if (value === difficulty) return;
      difficulty = value;
    }
    renderPane({ filterChanged: true });
  });

  // The table's own scroll region: Up / Down scroll it, released at its top / bottom edge.
  paneEl.addEventListener("keydown", (ev) => {
    if (!ev || ev.defaultPrevented || chord(ev) || !region || ev.target !== region) return;
    const step = verticalStep(ev);
    if (!step) return;
    const top = region.scrollTop;
    const view = region.clientHeight;
    const full = region.scrollHeight;
    if (![top, view, full].every((v) => typeof v === "number" && Number.isFinite(v))) return;
    const max = Math.max(0, full - view);
    if (step < 0 ? top <= 0 : top >= max - 1) return;   // at the edge: the router moves on
    ev.preventDefault();
    let rowH = 0;
    const first = tbody && (tbody.firstElementChild || (tbody.children && tbody.children[0]));
    if (first && typeof first.getBoundingClientRect === "function") {
      try { rowH = first.getBoundingClientRect().height || 0; } catch { rowH = 0; }
    }
    const by = rowH > 0 ? rowH : Math.max(1, Math.round(view / 4));
    region.scrollTop = Math.max(0, Math.min(max, top + step * by));
  });

  // --- the public surface --------------------------------------------------------------------
  function render() {
    buildTabs();
    rendered = true;
    tabsEl.hidden = false;
    applyTab();
  }

  function setTab(id) {
    if (!TAB_IDS.includes(id)) return;
    if (!rendered) render();
    selectTab(id);
  }

  function refreshPane() {
    if (tab === "rankings") renderPane();
  }

  function setCount(id, n) {
    if (!TAB_IDS.includes(id)) return;
    const v = Math.max(0, Math.floor(Number(n)) || 0);
    counts.set(id, v);
    paintCount(id);
  }

  function reset() {
    tab = "all";
    player = "";
    difficulty = "";
    paintPaneChips();
    applyTab();
  }

  return {
    render,
    setTab,
    get tab() { return tab; },
    setCount,
    refreshPane,
    reset,
  };
}
