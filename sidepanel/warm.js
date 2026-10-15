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
  let adding = false;

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
    root.innerHTML = channel ? detailHtml(channel) : listHtml();
  }
  let pendingRender = false;
  root.addEventListener('focusout', () => setTimeout(() => pendingRender && render(), 0));

  function trackedChannelFor(acc) {
    if (!acc?.signedIn) return null;
    return TVWarm.matchChannel(data.channels, acc);
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
      return `<div class="w-banner ok w-acct">${pic}<div>● Tracking <b>${who}</b> right now ${sub}</div></div>`;
    }
    return `<div class="w-banner w-acct">${pic}<div>Signed in as <b>${who}</b> ${sub}
      <button type="button" class="primary small" data-action="add-signed-in">+ Add to Warm Tracker</button></div></div>`;
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
          <input name="name" placeholder="Channel name" required />
          <label class="muted">When was the Gmail created? <input name="gmail" type="month" /></label>
          <div class="row"><button type="submit" class="primary">Add channel</button><button type="button" data-action="cancel-add">Cancel</button></div>
        </form>`
      : `<button type="button" class="w-link" data-action="show-add">+ Add a channel manually</button>`;

    const set = data.settings || TVWarm.DEFAULT_SETTINGS;
    const reminder = data.channels.length
      ? `<label class="w-reminder"><input type="checkbox" data-action="reminder" ${set.reminder ? 'checked' : ''} />
          🔔 Remind me at <input type="time" data-action="reminder-time" value="${esc(set.reminderTime)}" /> if today's warm-up isn't done</label>`
      : '';

    return `${accountBanner()}
      ${cards || `<div class="w-empty">No channels yet. Sign in to your new channel on YouTube and add it here, then warm it up for ${T.days} days.</div>`}
      ${form}
      ${reminder}`;
  }

  function counter(field, label, value, target, display, extra = '') {
    return `<div class="w-counter">
      <div class="w-counter-top">
        <span class="w-counter-label">${label}</span>
        <span class="w-counter-value">${display}</span>
        <span class="w-steppers">
          <button type="button" data-action="adjust" data-field="${field}" data-delta="${field === 'watchMin' ? -15 : -1}">−</button>
          <button type="button" data-action="adjust" data-field="${field}" data-delta="${field === 'watchMin' ? 15 : 1}">+</button>
        </span>
      </div>
      <div class="w-bar"><span style="width:${Math.min(100, (value / target) * 100)}%"></span></div>
      ${extra}
    </div>`;
  }

  // Watch time: auto-tracked, corrected with a slider (5-minute steps) instead of big +/- jumps.
  function watchRow(sec) {
    const min = Math.round(sec / 60);
    const max = Math.max(240, Math.ceil(min / 60) * 60);
    return `<div class="w-counter">
      <div class="w-counter-top">
        <span class="w-counter-label">Watch niche videos</span>
        <span class="w-counter-value" data-watch-label>${fmtTime(sec)} / 2h</span>
      </div>
      <input type="range" class="w-slider" data-action="watch-slider" min="0" max="${max}" step="5" value="${min}"
        style="--fill:${(min / max) * 100}%; --goal:${(120 / max) * 100}%" aria-label="Watch time in minutes" />
      <div class="w-slider-scale muted"><span>0</span><span>2h goal</span><span>${max / 60}h</span></div>
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
          <b>Locked: you're on day ${access.day} of the warm-up.</b>
          <p class="muted">You can unlock it early on day ${TVWarm.FORCE_DAY} (in ${plural(access.forceIn, 'day')}). It opens by itself on day ${TVWarm.AUTO_DAY}, or as soon as the channel is Good to start.</p>
          <p class="muted">Once open, TubeVault finds your uploads by itself and tracks them at 8h, 24h, 48h and 72h.</p>
        </div>`;
    }
    if (access.state === 'can-force') {
      return `<h3>First uploads 🔒</h3>
        <div class="w-locked">
          <b>Day ${access.day}: you can start tracking uploads now.</b>
          <p class="muted">Or keep warming. It unlocks by itself on day ${TVWarm.AUTO_DAY} (in ${plural(access.autoIn, 'day')}).</p>
          <button type="button" class="primary small" data-action="force-unlock">Unlock now</button>
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
          <b>Auto-tracking is on.</b>
          <div class="muted">TubeVault checks your channel every 30 minutes, starts tracking new uploads and fills in their views. ${synced}.</div>
        </div>
        <button type="button" class="primary small" data-action="sync-uploads" ${needsLink ? 'disabled' : ''}>↻ Refresh</button>
      </div>
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
    for (let d = new Date(c.startDate + 'T12:00'); TVWarm.dateKey(d) <= TVWarm.dateKey(); d.setDate(d.getDate() + 1)) keys.add(TVWarm.dateKey(d));
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
      <div class="w-chips">${chips}</div>
      <div class="w-day">
        ${watchRow(t.watchSec)}
        ${counter('subs', 'Subscribe to niche channels', t.subs, T.subsMin, `${t.subs} / ${T.subsMin}–${T.subsMax}`,
          `<div class="w-hint">💡 Tip: favour channels run by real people over AI channels.</div>` +
          (st.subsOver ? `<div class="w-warn">More than ${T.subsMax} today: subscribes don't count for this day.</div>` : '') +
          (st.tooFast ? `<div class="w-warn">${T.fastSubs}+ subscribes within 2 minutes. Spread them out across your watching session.</div>` : '') +
          (subNames.length ? `<div class="w-names">${subNames.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''))}
        ${counter('comments', 'Comment (full sentences)', t.comments, T.commentsMin, `${t.comments} / ${T.commentsMin}–${T.commentsTarget}`,
          (t.shortComments ? `<div class="w-warn">${t.shortComments} comment${t.shortComments === 1 ? ' was' : 's were'} too short (under ${T.minCommentWords} words), not counted.</div>` : '') +
          (t.dupComments ? `<div class="w-warn">${t.dupComments} copy-pasted comment${t.dupComments === 1 ? '' : 's'} (same text as before), not counted.</div>` : ''))}
        ${counter('likes', 'Like videos you watched', t.likes, T.likesMin, `${t.likes} / ${T.likesMin}–${T.likesTarget}`)}
        ${counter('searches', 'Search your niche', t.searches, T.searchesMin, `${t.searches} / 1`,
          day.searches.length ? `<div class="w-names">${day.searches.map((q) => `<span>🔍 ${esc(q)}</span>`).join('')}</div>` : '')}
        <div class="w-device muted">Device: ${deviceText} · Same device ${s.devices.sameDays}/${T.days} days</div>
      </div>

      <h3>One-time setup</h3>
      <label class="w-gmail">Gmail created <input type="month" data-action="gmail" value="${esc(c.gmailCreated)}" /> <span class="muted">${ageText}</span></label>
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
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'open') {
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
    } else if (action === 'force-unlock') {
      send({ type: 'warm:updateChannel', id: openId, patch: { forceUnlocked: true } }).then(() => send({ type: 'warm:syncUploads', id: openId }));
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

  // Live label while dragging; save when released.
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.action !== 'watch-slider') return;
    const label = root.querySelector('[data-watch-label]');
    if (label) label.textContent = `${fmtTime(el.value * 60)} / 2h`;
    el.style.setProperty('--fill', `${(el.value / el.max) * 100}%`);
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
    } else if (action === 'reminder-time') {
      if (el.value) send({ type: 'warm:settings', patch: { reminderTime: el.value } });
    } else if (action === 'watch-slider') {
      send({ type: 'warm:setWatch', id: openId, date: selectedDate, minutes: Number(el.value) });
      el.blur(); // let the view refresh again
    } else if (action === 'setup') {
      send({ type: 'warm:updateChannel', id: openId, patch: { setup: { [el.dataset.key]: el.checked } } });
    } else if (action === 'gmail') {
      send({ type: 'warm:updateChannel', id: openId, patch: { gmailCreated: el.value } });
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
    const id = (await send({ type: 'warm:addChannel', channel: { name, gmailCreated: f.gmail.value } }))?.result;
    adding = false;
    if (id) openId = id;
    render();
  });

  // ---------- Refresh: detect the signed-in channel on the current tab ----------

  const detectBtn = document.getElementById('detect');
  detectBtn.addEventListener('click', async () => {
    detectBtn.classList.add('spin');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url || !/^https:\/\/(www|studio)\.youtube\.com\//.test(tab.url)) {
        setTab('warm');
        return flash('Open YouTube or YouTube Studio in this tab, then press ↻ again.');
      }
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: tvDetectAccount });
      const acc = res?.result;
      setTab('warm');
      if (!acc || acc.error) return flash(acc?.error || "Couldn't read this page. Reload the tab and try again.");
      const full = (await send({ type: 'warm:account', account: acc }))?.result || acc;
      await refresh();
      const tracked = trackedChannelFor(full);
      if (tracked) {
        openId = tracked.id;
        render();
        flash(`Signed in as ${full.name || full.handle}. Tracking this channel.`);
      } else {
        openId = null;
        render();
        flash(`Found ${full.name || full.handle} (from ${acc.source}).`);
      }
    } catch (e) {
      flash("Couldn't read this tab. Reload it and press ↻ again.");
    } finally {
      detectBtn.classList.remove('spin');
    }
  });

  // ---------- Boot ----------

  async function refresh() {
    data = await TVWarm.load();
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
  refresh();
  // Keep "today" and the watch timer fresh while the panel is open.
  setInterval(() => {
    if (selectedDate < TVWarm.dateKey() && selectedDate === lastToday) selectedDate = TVWarm.dateKey();
    lastToday = TVWarm.dateKey();
    render();
  }, 30 * 1000);
  let lastToday = TVWarm.dateKey();
})();
