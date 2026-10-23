// Warm Tracker tab: channels being warmed, their Trust Score, setup checklist and daily counters.
// All writes go to the background worker (which also receives auto-tracked activity).
(() => {
  const root = document.getElementById('warm');
  const T = TVWarm.TARGETS;
  const ACCOUNT_KEY = 'tubevault:lastAccount';

  let data = { activeId: null, channels: [], days: {} };
  let account = null;
  let device = null;
  let openId = null; // channel shown in detail view
  let selectedDate = TVWarm.dateKey();
  let lastToday = selectedDate; // "today" as of the last render, to notice when a new day starts
  let adding = false;
  let addName = ''; // typed into the add form (kept so opening the month picker doesn't wipe it)
  let addGmail = '';
  let picker = null; // open month picker: { scope: 'detail' | 'add', year }

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (sec) => {
    const m = Math.floor(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  };
  const VERDICT = {
    green: { label: 'Good to start', icon: '🟢' },
    yellow: { label: 'Almost there', icon: '🟡' },
    red: { label: 'Keep warming', icon: '🔴' },
  };
  const avatar = (c, size = 36) =>
    c.avatar
      ? `<img class="w-avatar" src="${esc(c.avatar)}" referrerpolicy="no-referrer" alt="" style="width:${size}px;height:${size}px" />`
      : `<div class="w-avatar" style="width:${size}px;height:${size}px">${esc((c.name || '?').charAt(0).toUpperCase())}</div>`;

  // ---------- Tabs ----------

  function setTab(tab) {
    if (!['vault', 'warm'].includes(tab)) tab = 'vault';
    document.body.dataset.tab = tab;
    document.querySelectorAll('[data-tab-btn]').forEach((b) => b.classList.toggle('active', b.dataset.tabBtn === tab));
    try {
      localStorage.setItem('tubevault:tab', tab);
    } catch {}
  }
  document.querySelectorAll('[data-tab-btn]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tabBtn)));
  let savedTab = 'vault';
  try {
    savedTab = localStorage.getItem('tubevault:tab') || 'vault';
  } catch {}
  setTab(savedTab);

  // ---------- Rendering ----------

  function render() {
    // Don't wipe a field the user is typing in; render again when they leave it.
    if (root.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), select')) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    const channel = data.channels.find((c) => c.id === openId);
    root.innerHTML = statusHtml() + (channel ? detailHtml(channel) : listHtml());
  }
  let pendingRender = false;
  root.addEventListener('focusout', () => setTimeout(() => pendingRender && render(), 0));

  function trackedChannelFor(acc) {
    if (!acc?.signedIn) return null;
    return TVWarm.matchChannel(data.channels, acc);
  }

  // ---------- Is tracking actually running? ----------
  // Tracking happens inside the YouTube tab (not in this sidebar). This asks that tab and says what it sees.

  let live = null;

  async function pollStatus() {
    if (document.body.dataset.tab !== 'warm' || document.hidden) return;
    let next = { kind: 'idle' };
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url || '';
      if (!tab || (url && !/^https:\/\/(www|studio)\.youtube\.com\//.test(url))) next = { kind: 'other' };
      else if (/^https:\/\/studio\.youtube\.com\//.test(url)) next = { kind: 'studio' };
      else {
        try {
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'tubevault:ping' });
          next = r?.alive ? { kind: 'alive', ...r, tabId: tab.id } : { kind: 'dead', tabId: tab.id };
        } catch {
          next = { kind: 'dead', tabId: tab.id };
        }
      }
    } catch {}
    if (JSON.stringify(next) !== JSON.stringify(live)) {
      live = next;
      render();
    }
  }

  function agoText(ms) {
    if (!ms) return 'nothing counted yet';
    const s = Math.round((Date.now() - ms) / 1000);
    return s < 60 ? `counted ${Math.max(s, 1)}s ago` : s < 3600 ? `counted ${Math.round(s / 60)} min ago` : `counted ${Math.round(s / 3600)}h ago`;
  }

  function statusHtml() {
    if (!live || live.kind === 'idle') return '';
    if (live.kind === 'other') return `<div class="w-status muted">Open YouTube to track. Tracking runs inside youtube.com tabs, so this sidebar doesn't need to be open.</div>`;
    if (live.kind === 'studio') return `<div class="w-status muted">YouTube Studio isn't tracked. Watch, subscribe and comment on youtube.com.</div>`;
    if (live.kind === 'dead') {
      return `<div class="w-status warn"><b>⚠ Not tracking on this tab.</b> TubeVault isn't running in it (usually because the extension was updated after the tab opened).
        <button type="button" class="primary small" data-action="reload-tab">Reload tab</button></div>`;
    }
    if (!live.signedIn) return `<div class="w-status warn"><b>⚠ Not tracking:</b> this tab isn't signed in to YouTube.</div>`;
    const who = esc(live.account?.name || live.account?.handle || 'your channel');
    if (live.matched === false) {
      return `<div class="w-status warn"><b>⚠ Not counting:</b> you're signed in as <b>${who}</b>, which isn't in the Warm Tracker. Add it below, then it counts.</div>`;
    }
    const state = live.playing ? 'video playing, counting watch time' : 'nothing playing';
    return `<div class="w-status ok">● Tracking <b>${who}</b> · ${state} · ${agoText(live.lastCountedAt)}</div>`;
  }

  function accountBanner() {
    const fresh = account && Date.now() - account.at < 24 * 3600 * 1000;
    if (!fresh || !account.signedIn) {
      return `<div class="w-banner">Open YouTube while signed in to the channel you're warming. Activity is tracked automatically.</div>`;
    }
    if (!account.handle && !account.name && !account.ytChannelId) {
      const options = data.channels
        .map((c) => `<option value="${c.id}" ${c.id === data.activeId ? 'selected' : ''}>${esc(c.name)}</option>`)
        .join('');
      return `<div class="w-banner">Signed in on YouTube, but TubeVault couldn't read which channel.
        ${data.channels.length ? `Counting activity for: <select data-action="set-active">${options}</select>` : 'Add a channel below to start tracking.'}</div>`;
    }
    const who = esc(account.name || account.handle);
    const sub = account.name && account.handle ? `<span class="muted">${esc(account.handle)}</span>` : '';
    const tracked = trackedChannelFor(account);
    const pic = avatar({ name: account.name || account.handle, avatar: account.avatar }, 32);
    if (tracked) {
      if (live?.kind === 'alive') return ''; // the status line above already says it
      return `<div class="w-banner ok w-acct">${pic}<div>● Tracking <b>${who}</b> right now ${sub}</div></div>`;
    }
    return `<div class="w-banner w-acct">${pic}<div>Signed in as <b>${who}</b> ${sub}
      <button type="button" class="primary small" data-action="add-signed-in">+ Add to Warm Tracker</button></div></div>`;
  }

  // ---------- Month picker (replaces the browser's native month input) ----------

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const GMAIL_START = 2004; // Gmail launched in 2004
  const fmtMonth = (ym) => (/^\d{4}-\d{2}$/.test(ym || '') ? `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}` : '');

  function monthPicker(scope, value) {
    const open = picker?.scope === scope;
    const trigger = `<button type="button" class="mp-trigger ${value ? '' : 'empty'}" data-action="mp-toggle" data-scope="${scope}" aria-expanded="${open}">
      <span>${value ? esc(fmtMonth(value)) : 'Pick month'}</span><span class="mp-caret">${open ? '▴' : '▾'}</span></button>`;
    if (!open) return `<div class="mp">${trigger}</div>`;
    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;
    const y = picker.year;
    const cells = MONTHS.map((name, i) => {
      const v = `${y}-${String(i + 1).padStart(2, '0')}`;
      const future = y > curY || (y === curY && i + 1 > curM);
      return `<button type="button" class="mp-m ${v === value ? 'sel' : ''}" data-action="mp-pick" data-value="${v}" ${future ? 'disabled' : ''}>${name.slice(0, 3)}</button>`;
    }).join('');
    return `<div class="mp">${trigger}
      <div class="mp-pop" role="dialog" aria-label="Choose month and year">
        <div class="mp-head">
          <button type="button" data-action="mp-year" data-delta="-1" aria-label="Previous year" ${y <= GMAIL_START ? 'disabled' : ''}>‹</button>
          <b>${y}</b>
          <button type="button" data-action="mp-year" data-delta="1" aria-label="Next year" ${y >= curY ? 'disabled' : ''}>›</button>
        </div>
        <div class="mp-grid">${cells}</div>
        <div class="mp-foot">
          <button type="button" class="w-link" data-action="mp-clear">Clear</button>
          <button type="button" class="w-link" data-action="mp-pick" data-value="${curY}-${String(curM).padStart(2, '0')}">This month</button>
        </div>
      </div></div>`;
  }

  // ---------- Time zone for "today" ----------

  let zoneList = null;
  function timeZoneRow(selected) {
    const browser = TVWarm.browserTimeZone();
    zoneList = zoneList || (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [browser]);
    const opts = [`<option value="" ${!selected ? 'selected' : ''}>Browser time (${esc(browser)})</option>`]
      .concat(zoneList.map((z) => `<option value="${esc(z)}" ${z === selected ? 'selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`))
      .join('');
    const active = TVWarm.activeTimeZone();
    return `<label class="w-reminder w-tz">🕛 New day starts at midnight in
        <select data-action="time-zone">${opts}</select>
        <span class="muted">it's ${TVWarm.timeIn(active)} there</span></label>
      ${!selected ? `<div class="w-hint">Using this browser's clock. If this profile's time zone is set to another country (e.g. to match a proxy), pick your own time zone so the day resets at your midnight.</div>` : ''}`;
  }

  // "Today: Fri 23 Oct · resets at midnight Africa/Lagos (07:30 now)"
  function dayLine() {
    const tz = TVWarm.activeTimeZone();
    const today = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date());
    return `Today: <b>${esc(today)}</b> · resets at midnight ${esc(tz.replace(/_/g, ' '))} (${TVWarm.timeIn(tz)} now)`;
  }

  function listHtml() {
    const today = TVWarm.dateKey();
    const cards = data.channels
      .map((c) => {
        const s = TVWarm.score(data, c);
        const t = s.days.find((d) => d.key === today)?.totals;
        return `<button type="button" class="w-card" data-action="open" data-id="${c.id}">
          ${avatar(c)}
          <div class="w-card-main">
            <div class="w-card-name">${esc(c.name)}</div>
            <div class="muted">${s.doneDays}/${T.days} days done · today ${fmtTime(t?.watchSec || 0)} watched</div>
          </div>
          <div class="w-score ${s.verdict}" title="${VERDICT[s.verdict].label}">${s.total}</div>
        </button>`;
      })
      .join('');

    const form = adding
      ? `<form class="w-add" data-form="add">
          <input name="name" placeholder="Channel name" value="${esc(addName)}" required />
          <div class="muted">When was the Gmail created?</div>
          ${monthPicker('add', addGmail)}
          <div class="row"><button type="submit" class="primary">Add channel</button><button type="button" data-action="cancel-add">Cancel</button></div>
        </form>`
      : `<button type="button" class="w-link" data-action="show-add">+ Add a channel manually</button>`;

    const set = data.settings || TVWarm.DEFAULT_SETTINGS;
    const reminder = data.channels.length
      ? `<label class="w-reminder"><input type="checkbox" data-action="reminder" ${set.reminder ? 'checked' : ''} />
          🔔 Remind me at <input type="time" data-action="reminder-time" value="${esc(set.reminderTime)}" /> if today's warm-up isn't done</label>`
      : '';

    const tzRow = data.channels.length ? timeZoneRow(set.timeZone) : '';

    return `${accountBanner()}
      ${cards || `<div class="w-empty">No channels yet. Sign in to your new channel on YouTube and add it here, then warm it up for ${T.days} days.</div>`}
      ${form}
      ${reminder}
      ${tzRow}`;
  }

  // A daily task: light green once the minimum is reached (counts for today), full green at the goal.
  // The tick on the bar marks the minimum.
  function counter(field, label, value, min, goal, extra = '', { optional = false, over = false } = {}) {
    const level = over ? 'over' : TVWarm.levelOf(value, min, goal);
    const tick = goal > min ? `<i class="w-tick" style="left:${(min / goal) * 100}%" title="Minimum: ${min}"></i>` : '';
    const minNote = optional ? 'optional' : goal > min ? `min ${min}` : '';
    return `<div class="w-counter ${level}">
      <div class="w-counter-top">
        <span class="w-counter-label">${label}</span>
        <span class="w-counter-value">${value} / ${goal}+${minNote ? ` <small>${minNote}</small>` : ''}</span>
        <span class="w-steppers">
          <button type="button" data-action="adjust" data-field="${field}" data-delta="-1">−</button>
          <button type="button" data-action="adjust" data-field="${field}" data-delta="1">+</button>
        </span>
      </div>
      <div class="w-bar ${level}"><span style="width:${Math.min(100, (value / goal) * 100)}%"></span>${tick}</div>
      ${extra}
    </div>`;
  }

  // Watch time: auto-tracked, corrected with a slider (5-minute steps). Marks at 30m (the minimum) and 1h;
  // light green from 30 minutes, full green at the 2h goal.
  const watchLevel = (minutes) => TVWarm.levelOf(minutes * 60, T.watchMinSec, T.watchSec);
  function watchRow(sec) {
    const min = Math.round(sec / 60);
    const max = Math.max(240, Math.ceil(min / 60) * 60);
    const pct = (m) => (m / max) * 100;
    return `<div class="w-counter ${watchLevel(min)}">
      <div class="w-counter-top">
        <span class="w-counter-label">Watch videos</span>
        <span class="w-counter-value" data-watch-label>${fmtTime(sec)} / 2h <small>min 30m</small></span>
      </div>
      <input type="range" class="w-slider ${watchLevel(min)}" data-action="watch-slider" min="0" max="${max}" step="5" value="${min}"
        style="--fill:${pct(min)}%; --t30:${pct(30)}%; --t60:${pct(60)}%; --goal:${pct(120)}%" aria-label="Watch time in minutes" />
      <div class="w-slider-scale muted">
        <span style="left:0">0</span><span style="left:${pct(30)}%">30m</span><span style="left:${pct(60)}%">1h</span>
        <span style="left:${pct(120)}%">2h goal</span><span style="left:100%">${max / 60}h</span>
      </div>
    </div>`;
  }

  // ---------- First Upload Tracker ----------

  const relTime = (ms) => {
    const h = Math.round(Math.abs(ms) / 3600000);
    return h < 1 ? 'under 1h' : h < 48 ? `${h}h` : `${Math.round(h / 24)} days`;
  };

  function uploadsHtml(c, s) {
    const uploads = c.uploads || [];
    const access = TVWarm.uploadsAccess(c, s.verdict);
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    if (access.state === 'locked') {
      return `<h3>First uploads 🔒</h3>
        <div class="w-locked">
          <b>Locked: day ${access.day} of the warm-up.</b>
          <p class="muted">It opens by itself on day ${TVWarm.AUTO_DAY} (in ${plural(access.autoIn, 'day')}) or once the channel is Good to start.
            Not warming for days, or not a new channel? You can unlock it now.</p>
          <p class="muted">Once open, TubeVault finds your uploads by itself and tracks them at 8h, 24h, 48h and 72h.</p>
          <div class="w-lock-actions">
            <button type="button" class="primary small" data-action="force-unlock">Unlock now</button>
            <button type="button" class="small" data-action="not-new">This channel isn't new</button>
          </div>
        </div>`;
    }
    const decision = TVWarm.uploadsDecision(uploads);
    const sourceOptions = (sel) =>
      `<option value="">Top traffic source…</option>` +
      TVWarm.SOURCES.map((o) => `<option value="${o.key}" ${o.key === sel ? 'selected' : ''}>${esc(o.label)}</option>`).join('');

    const cards = uploads
      .map((u) => {
        const v = TVWarm.uploadVerdict(u);
        const age = Date.now() - u.publishedAt;
        const rows = TVWarm.CHECKPOINTS.map((h) => {
          const due = u.publishedAt + h * 3600000;
          const ck = u.checks?.[h] || {};
          if (Date.now() < due) {
            return `<div class="u-row future"><span class="u-h">${h}h</span><span class="muted">in ${relTime(due - Date.now())}</span></div>`;
          }
          const num = (f, ph, step = '1') =>
            `<input type="number" min="0" step="${step}" placeholder="${ph}" value="${ck[f] ?? ''}" data-action="check" data-upload="${u.id}" data-hours="${h}" data-field="${f}" />`;
          return `<div class="u-row">
            <span class="u-h">${h}h<a class="u-studio" href="https://studio.youtube.com/video/${esc(u.videoId)}/analytics/tab-reach_viewers/period-default" target="_blank" rel="noopener" title="Open this video's Reach analytics in YouTube Studio">Open in Studio ↗</a></span>
            <div class="u-fields">
              <label>Views ${num('views', '0')}${ck.autoViews ? '<small>auto</small>' : ''}</label>
              <label>Impressions ${num('impressions', '0')}</label>
              <label>CTR % ${num('ctr', '0.0', '0.1')}</label>
              <select data-action="check" data-upload="${u.id}" data-hours="${h}" data-field="source">${sourceOptions(ck.source)}</select>
            </div>
          </div>`;
        }).join('');
        return `<div class="u-card">
          <div class="u-top">
            <a class="u-title" href="https://www.youtube.com/watch?v=${esc(u.videoId)}" target="_blank" rel="noopener">${esc(u.title)}</a>
            <button type="button" class="w-x" title="Remove" data-action="del-upload" data-upload="${u.id}">✕</button>
          </div>
          <div class="muted u-meta">Published ${relTime(age)} ago${u.lastViews != null ? ` · ${u.lastViews.toLocaleString()} views now` : ''}
            · <label class="u-collab"><input type="checkbox" data-action="collab" data-upload="${u.id}" ${u.collab ? 'checked' : ''} /> Collaboration used</label></div>
          <div class="u-verdict ${v.key}">${esc(v.label)}</div>
          ${rows}
        </div>`;
      })
      .join('');

    const needsLink = !c.handle && !c.ytChannelId;
    const mins = c.lastSync ? Math.round((Date.now() - c.lastSync) / 60000) : null;
    const synced = mins == null ? 'Not checked yet' : mins < 1 ? 'Last checked just now' : mins < 60 ? `Last checked ${mins} min ago` : `Last checked ${relTime(Date.now() - c.lastSync)} ago`;
    return `<h3>First uploads</h3>
      <div class="u-auto">
        <div>
          <b>Auto-tracking is on.</b>${c.forceUnlocked ? ` <span class="muted">(${esc(access.why)})</span>` : ''}
          <div class="muted">TubeVault checks your channel every 30 minutes, starts tracking new uploads and fills in their views. ${synced}.</div>
        </div>
        <button type="button" class="primary small" data-action="sync-uploads" ${needsLink ? 'disabled' : ''}>↻ Refresh</button>
      </div>
      ${c.forceUnlocked ? `<button type="button" class="w-link" data-action="relock">🔒 Lock first uploads again</button>` : ''}
      ${needsLink ? `<form class="u-add" data-form="channel-link"><input name="link" placeholder="Your channel link or @handle" /><button type="submit" class="primary small">Save</button></form>` : ''}
      ${!uploads.length && !needsLink ? `<div class="w-hint">No uploads since ${esc(c.startDate)} yet. Publish your first video and it'll appear here, or press Refresh.</div>` : ''}
      <div class="w-hint">Impressions, CTR and traffic source are only visible in YouTube Studio: use <b>Open in Studio</b> on a check-in and copy them over.</div>
      ${decision ? `<div class="u-decision ${decision.key}">${esc(decision.label)}</div>` : ''}
      ${cards}
      <details class="u-manual">
        <summary>Video not showing up? Add it yourself</summary>
        <form class="u-add" data-form="upload">
          <input name="url" placeholder="Paste the video link" />
          <button type="submit" class="primary small">Track</button>
        </form>
        <button type="button" class="w-link" data-action="upload-current">+ Track the video open in my current tab</button>
      </details>`;
  }

  const parseVideoId = (url) => {
    const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/) || String(url).match(/^([\w-]{11})$/);
    return m ? m[1] : null;
  };

  async function trackUpload(videoId, title) {
    const r = await send({ type: 'warm:addUpload', id: openId, videoId, title });
    if (!r?.result) flash('That video is already being tracked (or the link is invalid).');
  }

  function flash(msg) {
    const el = document.createElement('div');
    el.className = 'w-flash';
    el.textContent = msg;
    root.prepend(el);
    setTimeout(() => el.remove(), 4000);
  }

  function detailHtml(c) {
    const s = TVWarm.score(data, c);
    const v = VERDICT[s.verdict];
    const dayMap = data.days[c.id] || {};
    const day = dayMap[selectedDate] || TVWarm.emptyDay();
    const st = TVWarm.dayStatus(day);
    const t = st.totals;

    // Day chips: every day from the start date to today, plus any day with data.
    const keys = new Set(Object.keys(dayMap));
    for (let k = c.startDate, today = TVWarm.dateKey(); k <= today; k = TVWarm.addDays(k, 1)) keys.add(k);
    keys.add(selectedDate);
    const chips = [...keys]
      .sort()
      .map((k, i) => {
        const ds = dayMap[k] ? TVWarm.dayStatus(dayMap[k]) : null;
        const label = k === TVWarm.dateKey() ? 'Today' : `Day ${i + 1}`;
        return `<button type="button" class="w-chip ${k === selectedDate ? 'sel' : ''} ${ds?.done ? 'done' : ds?.active ? 'partial' : ''}" data-action="pick-day" data-date="${k}" title="${k}">${ds?.done ? '✓ ' : ''}${label}</button>`;
      })
      .join('');

    const setup = TVWarm.SETUP_ITEMS.map(
      (i) => `<label class="w-check">
        <input type="checkbox" data-action="setup" data-key="${i.key}" ${c.setup?.[i.key] ? 'checked' : ''} />
        <span>${esc(i.label)}${i.must ? ' <em>required</em>' : ''}${i.hint ? `<small>${esc(i.hint)}</small>` : ''}</span>
      </label>`
    ).join('');

    const ageMonths = TVWarm.gmailAgeMonths(c.gmailCreated);
    const ageText = ageMonths == null ? 'not set' : ageMonths < 12 ? `${ageMonths} month${ageMonths === 1 ? '' : 's'} old` : `${Math.floor(ageMonths / 12)}+ year${ageMonths >= 24 ? 's' : ''} old`;

    const subNames = Object.values(day.subs);
    const devices = Object.keys(day.devices);
    const deviceText = !devices.length
      ? (st.active ? 'Unknown (added by hand)' : '—')
      : devices.map((id) => (id === device?.id ? 'This computer' : 'Another computer')).join(', ');

    const breakdown = [
      ['Gmail age', s.parts.gmail, 20],
      ['Account security', s.parts.security, 10],
      ['Channel basics', s.parts.basics, 10],
      ['Warm-up days', s.parts.warm, 56],
      ['Same device', s.parts.device, 4],
    ]
      .map(([l, p, max]) => `<div class="w-break"><span>${l}</span><div class="w-bar"><span style="width:${(p / max) * 100}%"></span></div><b>${p}/${max}</b></div>`)
      .join('');

    return `
      <button type="button" class="w-link back" data-action="back">← All channels</button>
      <section class="w-head">
        ${avatar(c, 48)}
        <div class="w-head-main">
          <div class="w-card-name">${esc(c.name)}</div>
          <div class="muted">${esc(c.handle || 'No handle')} · started ${esc(c.startDate)}</div>
        </div>
        <div class="w-big-score ${s.verdict}">${s.total}<small>/100</small></div>
      </section>
      <div class="w-verdict ${s.verdict}">${v.icon} <b>${v.label}</b>
        ${s.missing.length ? `<ul>${s.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
        ${s.verdict === 'green' ? `<p class="w-tip">💡 Tip for your first uploads: if you have a second channel (or a friend's), use YouTube's <b>Collaboration</b> feature. Invite it as a co-creator so the video is also shown to that channel's subscribers. Optional.</p>` : ''}
      </div>

      <h3>Score breakdown</h3>
      ${breakdown}

      <h3>Daily warm-up</h3>
      <div class="w-hint">${dayLine()}</div>
      <div class="w-chips">${chips}</div>
      <div class="w-day">
        ${watchRow(t.watchSec)}
        ${counter('subs', 'Subscribe to channels', t.subs, T.subsMin, T.subsTarget,
          `<div class="w-hint">💡 Tip: favour channels run by real people over AI channels.</div>` +
          (st.subsOver ? `<div class="w-warn">More than ${T.subsMax} today: subscribes don't count for this day.</div>` : '') +
          (st.tooFast ? `<div class="w-warn">${T.fastSubs}+ subscribes within 2 minutes. Spread them out across your watching session.</div>` : '') +
          (subNames.length ? `<div class="w-names">${subNames.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''), { over: st.subsOver })}
        ${counter('comments', 'Comment (full sentences)', t.comments, T.commentsMin, T.commentsTarget,
          (t.shortComments ? `<div class="w-warn">${t.shortComments} comment${t.shortComments === 1 ? ' was' : 's were'} too short (under ${T.minCommentWords} words), not counted.</div>` : '') +
          (t.dupComments ? `<div class="w-warn">${t.dupComments} copy-pasted comment${t.dupComments === 1 ? '' : 's'} (same text as before), not counted.</div>` : ''))}
        ${counter('likes', 'Like videos you watched', t.likes, T.likesMin, T.likesTarget)}
        ${counter('searches', 'Search on YouTube', t.searches, T.searchesMin, T.searchesTarget,
          day.searches.length ? `<div class="w-names">${day.searches.map((q) => `<span>🔍 ${esc(q)}</span>`).join('')}</div>` : '')}
        ${counter('watchLater', 'Add a video to Watch later', t.watchLater, T.watchLaterMin, T.watchLaterMin, '', { optional: true })}
        <div class="w-device muted">Device: ${deviceText} · Same device ${s.devices.sameDays}/${T.days} days</div>
      </div>

      <h3>One-time setup</h3>
      <div class="w-gmail"><span>Gmail created</span>${monthPicker('detail', c.gmailCreated)}<span class="muted">${ageText}</span></div>
      <div class="w-setup">${setup}</div>

      ${uploadsHtml(c, s)}

      <h3>Settings</h3>
      <label class="w-check"><input type="checkbox" data-action="make-active" ${data.activeId === c.id ? 'checked' : ''} />
        <span>Count activity for this channel when TubeVault can't tell which account is signed in</span></label>
      <button type="button" class="w-link danger" data-action="delete">Remove from Warm Tracker</button>
    `;
  }

  // ---------- Actions ----------

  root.addEventListener('click', async (e) => {
    if (picker && !e.target.closest('.mp')) {
      picker = null;
      render();
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'mp-toggle') {
      document.activeElement?.blur?.(); // leave the name field so the picker can draw
      const scope = el.dataset.scope;
      const current = scope === 'add' ? addGmail : data.channels.find((c) => c.id === openId)?.gmailCreated;
      picker = picker?.scope === scope ? null : { scope, year: /^\d{4}/.test(current || '') ? Number(current.slice(0, 4)) : new Date().getFullYear() };
      render();
    } else if (action === 'mp-year') {
      picker.year = Math.min(new Date().getFullYear(), Math.max(GMAIL_START, picker.year + Number(el.dataset.delta)));
      render();
    } else if (action === 'mp-pick' || action === 'mp-clear') {
      const value = action === 'mp-clear' ? '' : el.dataset.value;
      const scope = picker?.scope;
      picker = null;
      if (scope === 'add') {
        addGmail = value;
        render();
      } else {
        await send({ type: 'warm:updateChannel', id: openId, patch: { gmailCreated: value } });
        render();
      }
    } else if (action === 'open') {
      openId = el.dataset.id;
      selectedDate = TVWarm.dateKey();
      render();
    } else if (action === 'back') {
      openId = null;
      render();
    } else if (action === 'show-add') {
      adding = true;
      render();
      root.querySelector('[name=name]')?.focus();
    } else if (action === 'cancel-add') {
      adding = false;
      addName = '';
      addGmail = '';
      render();
    } else if (action === 'add-signed-in') {
      const id = (await send({ type: 'warm:addChannel', channel: { name: account.name || account.handle, handle: account.handle, ytChannelId: account.ytChannelId, avatar: account.avatar } }))?.result;
      if (id) openId = id;
    } else if (action === 'pick-day') {
      selectedDate = el.dataset.date;
      render();
    } else if (action === 'adjust') {
      send({ type: 'warm:adjust', id: openId, date: selectedDate, field: el.dataset.field, delta: Number(el.dataset.delta) });
    } else if (action === 'del-upload') {
      if (confirm('Stop tracking this video?')) send({ type: 'warm:deleteUpload', id: openId, uploadId: el.dataset.upload });
    } else if (action === 'reload-tab') {
      if (live?.tabId) chrome.tabs.reload(live.tabId);
      live = { kind: 'idle' };
      render();
      setTimeout(pollStatus, 3500);
    } else if (action === 'force-unlock' || action === 'not-new') {
      await send({ type: 'warm:updateChannel', id: openId, patch: action === 'not-new' ? { forceUnlocked: true, notNew: true } : { forceUnlocked: true } });
      send({ type: 'warm:syncUploads', id: openId });
    } else if (action === 'relock') {
      send({ type: 'warm:updateChannel', id: openId, patch: { forceUnlocked: false, notNew: false } });
    } else if (action === 'sync-uploads') {
      el.disabled = true;
      el.textContent = 'Checking…';
      const r = (await send({ type: 'warm:syncUploads', id: openId }))?.result;
      if (r?.error) flash(r.error);
      else flash(r?.added ? `Found ${r.added} new upload${r.added === 1 ? '' : 's'}.` : 'No new uploads yet. Views are up to date.');
      render();
    } else if (action === 'upload-current') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let v = null;
      try {
        v = await chrome.tabs.sendMessage(tab.id, { type: 'tubevault:getVideo' });
      } catch {}
      if (v?.videoId) trackUpload(v.videoId, v.title);
      else flash('Open the video on YouTube first (refresh the tab if you just installed TubeVault).');
    } else if (action === 'delete') {
      const c = data.channels.find((x) => x.id === openId);
      if (c && confirm(`Remove ${c.name} and all its warm-up history from the Warm Tracker?`)) {
        await send({ type: 'warm:deleteChannel', id: openId });
        openId = null;
        render();
      }
    }
  });

  root.addEventListener('input', (e) => {
    if (e.target.name === 'name' && e.target.closest('[data-form=add]')) addName = e.target.value;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picker) {
      picker = null;
      render();
    }
  });

  // Live label while dragging; save when released.
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.action !== 'watch-slider') return;
    const label = root.querySelector('[data-watch-label]');
    if (label) label.innerHTML = `${fmtTime(el.value * 60)} / 2h <small>min 30m</small>`;
    el.style.setProperty('--fill', `${(el.value / el.max) * 100}%`);
    const level = watchLevel(Number(el.value));
    for (const node of [el, el.closest('.w-counter')]) {
      node.classList.remove('min', 'full');
      if (level) node.classList.add(level);
    }
  });

  root.addEventListener('change', (e) => {
    const el = e.target;
    const action = el.dataset.action;
    if (action === 'check') {
      const f = el.dataset.field;
      const value = f === 'source' ? el.value : el.value === '' ? null : Number(el.value);
      const patch = { [f]: value };
      if (f === 'views') patch.autoViews = false;
      send({ type: 'warm:setCheck', id: openId, uploadId: el.dataset.upload, hours: Number(el.dataset.hours), patch });
    } else if (action === 'collab') {
      send({ type: 'warm:updateUpload', id: openId, uploadId: el.dataset.upload, patch: { collab: el.checked } });
    } else if (action === 'reminder') {
      send({ type: 'warm:settings', patch: { reminder: el.checked } });
    } else if (action === 'time-zone') {
      send({ type: 'warm:settings', patch: { timeZone: el.value } });
      el.blur();
    } else if (action === 'reminder-time') {
      if (el.value) send({ type: 'warm:settings', patch: { reminderTime: el.value } });
    } else if (action === 'watch-slider') {
      send({ type: 'warm:setWatch', id: openId, date: selectedDate, minutes: Number(el.value) });
      el.blur(); // let the view refresh again
    } else if (action === 'setup') {
      send({ type: 'warm:updateChannel', id: openId, patch: { setup: { [el.dataset.key]: el.checked } } });
    } else if (action === 'make-active') {
      send({ type: 'warm:setActive', id: el.checked ? openId : null });
    } else if (action === 'set-active') {
      send({ type: 'warm:setActive', id: el.value });
    }
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.form === 'channel-link') {
      const v = f.link.value.trim();
      const uc = (v.match(/channel\/(UC[\w-]{22})/) || v.match(/^(UC[\w-]{22})$/) || [])[1];
      const handle = (v.match(/(@[\w.-]+)/) || [])[1];
      if (!uc && !handle) return flash('Paste a link like youtube.com/@yourchannel');
      await send({ type: 'warm:updateChannel', id: openId, patch: uc ? { ytChannelId: uc } : { handle } });
      const r = (await send({ type: 'warm:syncUploads', id: openId }))?.result;
      if (r?.error) flash(r.error);
      return;
    }
    if (f.dataset.form === 'upload') {
      const id = parseVideoId(f.url.value.trim());
      if (!id) return flash("That doesn't look like a YouTube video link.");
      f.url.value = '';
      return trackUpload(id);
    }
    if (f.dataset.form !== 'add') return;
    const name = f.name.value.trim();
    if (!name) return;
    const id = (await send({ type: 'warm:addChannel', channel: { name, gmailCreated: addGmail } }))?.result;
    adding = false;
    addName = '';
    addGmail = '';
    if (id) openId = id;
    render();
  });

  // ---------- Refresh: detect the signed-in channel on the current tab ----------

  const detectBtn = document.getElementById('detect');
  const ORIGINS = ['https://www.youtube.com/*', 'https://studio.youtube.com/*'];

  // Runs the detector in the tab. Tries chrome.scripting first (works on tabs opened before a reload),
  // then the content script already on the page.
  async function detectInTab(tab) {
    let lastError = '';
    if (chrome.scripting?.executeScript) {
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: tvDetectAccount });
        if (res?.result) return { ...res.result, page: true };
      } catch (e) {
        lastError = e?.message || String(e);
      }
    } else {
      lastError = 'scripting permission missing';
    }
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'tubevault:detect' });
      if (r) return { ...r, page: true };
    } catch (e) {
      lastError = lastError || e?.message || String(e);
    }
    return { error: lastError };
  }

  function explain(err, url) {
    const e = String(err || '');
    if (/permission|Cannot access|host/i.test(e)) {
      return 'TubeVault needs updated access. Open chrome://extensions and click reload ↻ on TubeVault, then reload this YouTube tab.';
    }
    if (/Receiving end does not exist|Could not establish connection/i.test(e)) {
      return 'Reload this YouTube tab once (TubeVault was updated after it opened), then press ↻ again.';
    }
    if (url && !/^https:\/\/(www|studio)\.youtube\.com\//.test(url)) return 'Open YouTube or YouTube Studio in this tab, then press ↻ again.';
    return e ? `Couldn't read this tab (${e}). Reload it and press ↻ again.` : "Couldn't read this tab. Reload it and press ↻ again.";
  }

  detectBtn.addEventListener('click', async () => {
    detectBtn.classList.add('spin');
    setTab('warm');
    try {
      // Make sure we have access to YouTube + Studio (asks once if Chrome hasn't granted it yet).
      const has = await chrome.permissions.contains({ origins: ORIGINS }).catch(() => true);
      if (!has) await chrome.permissions.request({ origins: ORIGINS }).catch(() => {});

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return flash('No tab found.');
      // tab.url is only visible for sites TubeVault can access; if it's visible and not YouTube, say so.
      if (tab.url && !/^https:\/\/(www|studio)\.youtube\.com\//.test(tab.url)) return flash(explain('', tab.url));

      const acc = await detectInTab(tab);
      if (!acc || acc.error) return flash(acc?.page ? acc.error || "Couldn't read the channel. Reload the tab and try again." : explain(acc?.error, tab.url));

      const full = (await send({ type: 'warm:account', account: acc }))?.result || acc;
      await refresh();
      const tracked = trackedChannelFor(full);
      openId = tracked ? tracked.id : null;
      render();
      if (full.changes?.length) flash(describeChanges(full.changes, full.name || full.handle));
      else flash(tracked ? `Signed in as ${full.name || full.handle}. Tracking this channel, profile is up to date.` : `Found ${full.name || full.handle} (from ${acc.source}).`);
    } catch (e) {
      flash(explain(e?.message || e));
    } finally {
      detectBtn.classList.remove('spin');
    }
  });

  // "Updated Paper Balance: username and picture."
  function describeChanges(changes, name) {
    const labels = [...new Set(changes.map((c) => c.label))];
    const list = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
    return `Updated ${name}: ${list} changed on YouTube.`;
  }

  // Quietly keeps tracked channels in sync whenever the sidebar opens:
  // 1) the YouTube tab you're on (if any) tells us who is signed in, 2) every tracked channel's public profile is re-read.
  async function autoSync() {
    const notes = [];
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && (!tab.url || /^https:\/\/(www|studio)\.youtube\.com\//.test(tab.url))) {
        const acc = await detectInTab(tab);
        if (acc && !acc.error && acc.signedIn !== false) {
          const full = (await send({ type: 'warm:account', account: acc }))?.result;
          if (full?.changes?.length) notes.push(describeChanges(full.changes, full.name || full.handle));
        }
      }
    } catch {}
    try {
      const updated = (await send({ type: 'warm:syncProfiles' }))?.result || [];
      for (const u of updated) notes.push(describeChanges(u.changes, u.name));
    } catch {}
    await refresh();
    if (notes.length) flash(notes.join(' '));
  }

  // ---------- Boot ----------

  // If the view was on "today", keep it on today when the day changes (midnight, or a new time zone).
  function rollToday() {
    const today = TVWarm.dateKey();
    if (selectedDate === lastToday && today !== lastToday) selectedDate = today;
    lastToday = today;
  }

  async function refresh() {
    data = await TVWarm.load(); // also applies the chosen time zone
    rollToday();
    const res = await chrome.storage.local.get(ACCOUNT_KEY);
    account = res[ACCOUNT_KEY] || null;
    if (openId && !data.channels.some((c) => c.id === openId)) openId = null;
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[TVWarm.KEY] || changes[ACCOUNT_KEY])) refresh();
  });
  send({ type: 'warm:device' }).then((r) => {
    device = r?.result || null;
    render();
  }).catch(() => {});
  refresh().then(autoSync);
  pollStatus();
  setInterval(pollStatus, 3000);
  chrome.tabs.onActivated.addListener(() => setTimeout(pollStatus, 300));
  chrome.tabs.onUpdated.addListener((_id, info) => info.status === 'complete' && setTimeout(pollStatus, 1500));
  document.querySelectorAll('[data-tab-btn]').forEach((b) => b.addEventListener('click', () => setTimeout(pollStatus, 100)));
  // Keep "today" and the watch timer fresh while the panel is open.
  setInterval(() => {
    rollToday();
    render();
  }, 30 * 1000);
  // Coming back to the sidebar after a while (e.g. the next morning): catch up at once.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
