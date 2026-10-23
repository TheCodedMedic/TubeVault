importScripts('shared/warm.js');

// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  setupAlarms();
  injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  setupAlarms();
});

// Tabs opened before the extension was installed/reloaded don't get its scripts automatically (they keep a
// dead copy of the old version, or none). Put fresh copies in so tracking works without refreshing the tab.
const PAGE_SCRIPTS = ['shared/store.js', 'shared/warm.js', 'sidepanel/detect.js', 'content/content.js', 'content/tracker.js'];
async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://studio.youtube.com/*'] });
    for (const tab of tabs) {
      const studio = new URL(tab.url).hostname === 'studio.youtube.com';
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: studio ? ['sidepanel/detect.js'] : PAGE_SCRIPTS })
        .catch(() => {}); // e.g. a discarded or still-loading tab: it will load the scripts normally
    }
  } catch {}
}

// ---------- Device identity (for the "same device" check) ----------

const DEVICE_KEY = 'tubevault:device';
async function getDevice() {
  const res = await chrome.storage.local.get(DEVICE_KEY);
  if (res[DEVICE_KEY]) return res[DEVICE_KEY];
  const platform = navigator.userAgentData?.platform || 'Computer';
  const device = { id: TVWarm.uid(), label: `${platform} · ${Math.random().toString(36).slice(2, 6)}` };
  await chrome.storage.local.set({ [DEVICE_KEY]: device });
  return device;
}

// ---------- Write queue: every Warm Tracker change runs one at a time ----------

let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(async () => {
    const data = await TVWarm.load();
    const result = await fn(data);
    await TVWarm.save(data);
    updateBadge(data);
    return result;
  });
  queue = run.catch((e) => console.error('[TubeVault]', e));
  return run;
}

// Which tracked channel gets credit for activity from this YouTube account.
// Detected account → matching channel (or nothing if it isn't tracked).
// Account unknown but signed in → the channel picked as "active" in the sidebar.
function resolveChannel(data, account) {
  if (!account || !account.signedIn) return null;
  if (account.ytChannelId || account.handle || account.name) {
    const match = TVWarm.matchChannel(data.channels, account);
    return match ? match.id : null;
  }
  return data.activeId && data.channels.some((c) => c.id === data.activeId) ? data.activeId : null;
}

async function withDay(account, fn) {
  const device = await getDevice();
  return mutate((data) => {
    const id = resolveChannel(data, account);
    if (!id) return false;
    const day = TVWarm.getDay(data, id, TVWarm.dateKey());
    day.devices[device.id] = 1;
    data.channels.find((c) => c.id === id).lastTrackedAt = Date.now();
    const result = fn(day, data, id);
    return result === undefined ? true : result;
  });
}

// ---------- Watch clock ----------
// Tabs report playing intervals [from, to]. Per channel we only count time past `coveredUntil`,
// so two videos playing at once count once (clock time, not added up).
const coveredUntil = {};
const MAX_GAP_MS = 90 * 1000; // background tabs may tick as slowly as once a minute

function addWatch(account, from, to) {
  if (!(to > from) || to - from > MAX_GAP_MS || to > Date.now() + 5000) return Promise.resolve(null); // ignored, not "unmatched"
  return withDay(account, (day, data, id) => {
    const start = Math.max(from, coveredUntil[id] || 0);
    if (to > start) {
      day.watchSec = Math.round((day.watchSec + (to - start) / 1000) * 10) / 10;
      coveredUntil[id] = to;
    }
  });
}

// ---------- Messages ----------

const LAST_ACCOUNT = 'tubevault:lastAccount';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('warm:')) return;
  handle(msg)
    .then((r) => sendResponse({ ok: true, result: r }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});

async function handle(msg) {
  const a = msg.account;
  switch (msg.type) {
    // --- from YouTube tabs ---
    case 'warm:account': {
      // Fill in anything missing from the channel ID, then bring the tracked channel up to date
      // (name, @username and picture can all change; the channel ID never does).
      let acc = { ...a };
      if (acc.ytChannelId && (!acc.name || !acc.handle || !acc.avatar)) {
        const info = await lookupChannel(acc.ytChannelId);
        if (info) acc = { ...acc, name: acc.name || info.name, handle: acc.handle || info.handle, avatar: acc.avatar || info.avatar };
      }
      let changes = [];
      let channelId = null;
      await mutate((data) => {
        const c = TVWarm.matchChannel(data.channels, acc);
        if (!c) return;
        channelId = c.id;
        c.profileCheckedAt = Date.now();
        changes = TVWarm.applyProfile(c, acc);
      });
      await chrome.storage.local.set({ [LAST_ACCOUNT]: { ...acc, at: Date.now() } });
      return { ...acc, changes, channelId };
    }
    case 'warm:syncProfiles': // sidebar opened / new day: refresh every tracked channel's public profile
      return refreshProfiles({ minAgeMs: msg.minAgeMs ?? 5 * 60 * 1000 });
    case 'warm:watch':
      return addWatch(a, msg.from, msg.to);
    case 'warm:sub':
      return withDay(a, (day) => {
        day.subsAt = day.subsAt || {};
        if (msg.subscribed) {
          day.subs[msg.key] = msg.name || msg.key;
          day.subsAt[msg.key] = Date.now();
        } else {
          delete day.subs[msg.key];
          delete day.subsAt[msg.key];
        }
        // Feedback shown on the YouTube page.
        const st = TVWarm.dayStatus(day);
        return { subs: st.totals.subs, tooFast: msg.subscribed && st.tooFast, over: st.subsOver };
      });
    case 'warm:like':
      return withDay(a, (day) => {
        if (msg.liked) day.likes[msg.videoId] = 1;
        else delete day.likes[msg.videoId];
      });
    case 'warm:comment':
      return withDay(a, (day, data, id) => {
        // Same text already posted on this channel (any day) = copy-paste.
        const dup = !!msg.sig && Object.values(data.days[id] || {}).some((d) => d.comments.some((c) => c.sig === msg.sig));
        day.comments.push({ at: Date.now(), words: msg.words, sig: msg.sig, dup });
        return { dup, short: msg.words < TVWarm.TARGETS.minCommentWords };
      });
    case 'warm:vidiq': // VidIQ seen on YouTube while signed in to this channel
      return mutate((data) => {
        const id = resolveChannel(data, a);
        const c = data.channels.find((x) => x.id === id);
        if (c && !c.setup?.vidiq) c.setup = { ...c.setup, vidiq: true };
        return !!c;
      });
    case 'warm:watchLater': // a video was added to (or removed from) Watch later
      return withDay(a, (day) => {
        day.watchLater = day.watchLater || {};
        const key = msg.videoId || `wl-${Date.now()}`;
        // When the page doesn't show whether it's now on or off, a second click on the same video means "removed".
        const added = msg.added ?? !day.watchLater[key];
        if (added) day.watchLater[key] = 1;
        else delete day.watchLater[key];
        return { added, count: Object.keys(day.watchLater).length };
      });
    case 'warm:search':
      return withDay(a, (day) => {
        if (!day.searches.includes(msg.query)) day.searches.push(msg.query);
      });

    // --- from the side panel ---
    case 'warm:addChannel':
      return mutate((data) => {
        const ch = msg.channel;
        const existing = TVWarm.matchChannel(data.channels, ch);
        if (existing && (ch.ytChannelId || ch.handle)) return existing.id;
        const channel = {
          id: TVWarm.uid(),
          name: ch.name || ch.handle || 'New channel',
          handle: ch.handle || '',
          ytChannelId: ch.ytChannelId || '',
          avatar: ch.avatar || '',
          gmailCreated: ch.gmailCreated || '',
          startDate: TVWarm.dateKey(),
          setup: { name: !!(ch.name && ch.ytChannelId) || !!ch.handle },
        };
        data.channels.push(channel);
        if (!data.activeId) data.activeId = channel.id;
        return channel.id;
      });
    case 'warm:updateChannel':
      return mutate((data) => {
        const c = data.channels.find((x) => x.id === msg.id);
        if (!c) return;
        const { setup, ...rest } = msg.patch;
        Object.assign(c, rest);
        if (setup) c.setup = { ...c.setup, ...setup };
      });
    case 'warm:deleteChannel':
      return mutate((data) => {
        data.channels = data.channels.filter((c) => c.id !== msg.id);
        delete data.days[msg.id];
        if (data.activeId === msg.id) data.activeId = data.channels[0]?.id || null;
      });
    case 'warm:setActive':
      return mutate((data) => {
        data.activeId = msg.id;
      });
    case 'warm:adjust': // manual +/- on a day's counter
      return mutate((data) => {
        const day = TVWarm.getDay(data, msg.id, msg.date);
        day.adj = day.adj || {};
        day.adj[msg.field] = (day.adj[msg.field] || 0) + msg.delta;
        // Never let the adjusted total go below zero.
        const t = TVWarm.totals(day);
        const shown = msg.field === 'watchMin' ? t.watchSec / 60 : t[msg.field];
        if (shown <= 0) {
          const auto = TVWarm.totals({ ...day, adj: { ...day.adj, [msg.field]: 0 } });
          day.adj[msg.field] = -(msg.field === 'watchMin' ? auto.watchSec / 60 : auto[msg.field]);
        }
      });
    case 'warm:setWatch': // slider: set the day's total watch time, keeping auto-tracked time underneath
      return mutate((data) => {
        const day = TVWarm.getDay(data, msg.id, msg.date);
        day.adj = day.adj || {};
        day.adj.watchMin = Math.max(0, msg.minutes) - day.watchSec / 60;
      });
    case 'warm:settings':
      await mutate((data) => {
        data.settings = { ...data.settings, ...msg.patch };
      });
      return setupAlarms();

    // --- First Upload Tracker ---
    case 'warm:addUpload': {
      const info = await fetchVideo(msg.videoId);
      return mutate((data) => {
        const c = data.channels.find((x) => x.id === msg.id);
        if (!c) return null;
        c.uploads = c.uploads || [];
        if (c.uploads.some((u) => u.videoId === msg.videoId)) return null;
        const upload = {
          id: TVWarm.uid(),
          videoId: msg.videoId,
          title: info?.title || msg.title || msg.videoId,
          publishedAt: info?.publishedAt || Date.now(),
          collab: false,
          checks: {},
          lastViews: info?.views ?? null,
        };
        c.uploads.push(upload);
        return upload.id;
      });
    }
    case 'warm:updateUpload':
      return mutate((data) => {
        const u = findUpload(data, msg.id, msg.uploadId);
        if (u) Object.assign(u, msg.patch);
      });
    case 'warm:setCheck':
      return mutate((data) => {
        const u = findUpload(data, msg.id, msg.uploadId);
        if (!u) return;
        u.checks = u.checks || {};
        u.checks[msg.hours] = { ...(u.checks[msg.hours] || {}), ...msg.patch };
      });
    case 'warm:deleteUpload':
      return mutate((data) => {
        const c = data.channels.find((x) => x.id === msg.id);
        if (c) c.uploads = (c.uploads || []).filter((u) => u.id !== msg.uploadId);
      });
    case 'warm:refreshViews':
      return checkUploads(true);
    case 'warm:syncUploads': // the Refresh button: find new uploads now
      return syncUploads(msg.id, { manual: true });
    case 'warm:device':
      return getDevice();
  }
}

// ---------- First Upload Tracker: video info + automatic check-ins ----------

function findUpload(data, channelId, uploadId) {
  return data.channels.find((c) => c.id === channelId)?.uploads?.find((u) => u.id === uploadId) || null;
}

// Reads public info (title, views, publish date) from the video's page. Returns null if blocked.
async function fetchVideo(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, { credentials: 'include' });
    const html = await res.text();
    const details = html.match(/"videoDetails":\{"videoId":"[^"]+","title":"((?:[^"\\]|\\.)*)"/);
    const views = html.match(/"videoDetails":\{.*?"viewCount":"(\d+)"/s);
    const published = html.match(/"(?:publishDate|uploadDate)":"([^"]+)"/);
    if (!details && !views) return null;
    return {
      title: details ? JSON.parse(`"${details[1]}"`) : null,
      views: views ? Number(views[1]) : null,
      publishedAt: published ? Date.parse(published[1]) || null : null,
    };
  } catch {
    return null;
  }
}

// Fills in views for check-ins that are due, and sends one notification per video for the latest one.
async function checkUploads(force = false) {
  const data = await TVWarm.load();
  for (const c of data.channels) {
    for (const u of c.uploads || []) {
      const ageH = (Date.now() - u.publishedAt) / 3600000;
      const due = TVWarm.CHECKPOINTS.filter((h) => ageH >= h && !u.checks?.[h]?.notified);
      if (!due.length && !force) continue;
      if (ageH > 80 && !force && !due.length) continue;
      // Views were just refreshed from the channel feed? Use them; otherwise read the video page.
      const fresh = u.viewsAt && Date.now() - u.viewsAt < 10 * 60 * 1000;
      const info = fresh ? { views: u.lastViews } : await fetchVideo(u.videoId);
      await mutate((d) => {
        const up = findUpload(d, c.id, u.id);
        if (!up) return;
        if (info?.views != null) {
          up.lastViews = info.views;
          up.viewsAt = Date.now();
        }
        up.checks = up.checks || {};
        for (const h of due) {
          const check = (up.checks[h] = up.checks[h] || {});
          // Only the latest due check-in gets today's views; earlier ones that were missed stay blank.
          if (h === due[due.length - 1] && info?.views != null && check.views == null) {
            check.views = info.views;
            check.autoViews = true;
          }
          check.notified = true;
        }
        if (!due.length) return;
        const h = due[due.length - 1];
        chrome.notifications.create(`upload-${up.id}-${h}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: `${h}h check-in: ${up.title}`,
          message: 'Open YouTube Studio → Analytics → Reach and add impressions, CTR and the top traffic source in TubeVault.',
        });
      });
    }
  }
}

// ---------- Channel lookup by ID ----------

// Public name, @handle and picture for a UC... channel ID.
async function lookupChannel(ytId) {
  const out = {};
  try {
    const html = await (await fetch(`https://www.youtube.com/channel/${ytId}?hl=en`, { credentials: 'include' })).text();
    const meta = (p) => (html.match(new RegExp(`<meta property="og:${p}" content="([^"]*)"`)) || [])[1];
    const decode = (t) => t && t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    out.name = decode(meta('title')) || '';
    out.avatar = meta('image') || '';
    out.handle = (html.match(/"vanityChannelUrl":"https?:\/\/www\.youtube\.com\/(@[^"]+)"/) || html.match(/"canonicalBaseUrl":"\/(@[^"]+)"/) || [])[1] || '';
  } catch {}
  if (!out.name) {
    // Fallback: the channel feed's title is the channel name.
    try {
      const xml = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ytId}`)).text();
      out.name = ((xml.match(/<title>([^<]*)<\/title>/) || [])[1] || '').replace(/&amp;/g, '&');
    } catch {}
  }
  return out.name || out.handle ? out : null;
}

// Re-reads each tracked channel's public name, @username and picture from YouTube and updates
// whatever changed. Works without a YouTube tab open, using the permanent channel ID.
async function refreshProfiles({ minAgeMs = 6 * 3600 * 1000 } = {}) {
  const data = await TVWarm.load();
  const updated = [];
  for (const c of data.channels) {
    // Only channels with a permanent ID. An old @username could now point at someone else, so never guess from it;
    // the ID is learned the next time you're signed in to the channel and press ↻.
    if (!c.ytChannelId) continue;
    if (Date.now() - (c.profileCheckedAt || 0) < minAgeMs) continue;
    const info = await lookupChannel(c.ytChannelId);
    await mutate((d) => {
      const ch = d.channels.find((x) => x.id === c.id);
      if (!ch) return;
      ch.profileCheckedAt = Date.now();
      if (!info) return;
      const changes = TVWarm.applyProfile(ch, info);
      if (changes.length) updated.push({ id: ch.id, name: ch.name, changes });
    });
  }
  return updated;
}

// ---------- Automatic upload tracking (channel feed) ----------

const MAX_AUTO_UPLOADS = 5; // the "first uploads" we follow automatically

// The channel's UC... id, needed for its public feed. Found from the @handle page once, then saved.
async function channelYtId(channel) {
  if (channel.ytChannelId) return channel.ytChannelId;
  if (!channel.handle) return null;
  try {
    const html = await (await fetch(`https://www.youtube.com/${encodeURIComponent(channel.handle).replace('%40', '@')}`, { credentials: 'include' })).text();
    const id = (html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || [])[1] || null;
    if (id) await mutate((d) => {
      const c = d.channels.find((x) => x.id === channel.id);
      if (c) c.ytChannelId = id;
    });
    return id;
  } catch {
    return null;
  }
}

// Finds videos published since the warm-up started, starts tracking them, and refreshes their views.
async function syncUploads(id, { manual = false } = {}) {
  const data = await TVWarm.load();
  const channel = data.channels.find((c) => c.id === id);
  if (!channel) return { error: 'Channel not found.' };
  const access = TVWarm.uploadsAccess(channel, TVWarm.score(data, channel).verdict);
  if (access.state !== 'unlocked') return { error: 'First uploads are still locked.' };

  const ytId = await channelYtId(channel);
  if (!ytId) return { error: channel.handle ? `Couldn't find ${channel.handle} on YouTube.` : 'Add your channel link first.' };

  let entries;
  try {
    entries = TVWarm.parseFeed(await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ytId}`)).text());
  } catch {
    return { error: "Couldn't reach YouTube. Try again in a minute." };
  }
  const since = new Date(channel.startDate + 'T00:00').getTime();

  const added = await mutate((d) => {
    const c = d.channels.find((x) => x.id === id);
    if (!c) return [];
    c.uploads = c.uploads || [];
    c.lastSync = Date.now();
    const newOnes = [];
    // Oldest first, so "first uploads" really are the first ones.
    for (const e of [...entries].sort((a, b) => a.publishedAt - b.publishedAt)) {
      let up = c.uploads.find((u) => u.videoId === e.videoId);
      if (!up && e.publishedAt >= since && c.uploads.length < MAX_AUTO_UPLOADS) {
        up = { id: TVWarm.uid(), videoId: e.videoId, title: e.title, publishedAt: e.publishedAt, collab: false, checks: {}, auto: true };
        c.uploads.push(up);
        newOnes.push(up);
      }
      if (up && Number.isFinite(e.views)) {
        up.lastViews = e.views;
        up.viewsAt = Date.now();
        if (e.title) up.title = e.title;
      }
    }
    return newOnes;
  });

  for (const up of added) {
    chrome.notifications.create(`upload-new-${up.id}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `Now tracking: ${up.title}`,
      message: 'TubeVault found your new upload. Check-ins at 8h, 24h, 48h and 72h.',
    });
  }
  await checkUploads(); // fill any check-ins that are already due
  return { added: added.length, found: entries.length, manual };
}

async function syncAllUploads() {
  const data = await TVWarm.load();
  for (const c of data.channels) {
    if (TVWarm.uploadsAccess(c, TVWarm.score(data, c).verdict).state === 'unlocked') await syncUploads(c.id);
  }
}

// ---------- Toolbar badge: today's progress for the channel being warmed ----------

async function updateBadge(data) {
  data = data || (await TVWarm.load());
  const acc = (await chrome.storage.local.get(LAST_ACCOUNT))[LAST_ACCOUNT];
  const id = resolveChannel(data, acc) || data.activeId;
  const channel = data.channels.find((c) => c.id === id);
  if (!channel) return chrome.action.setBadgeText({ text: '' });
  const st = TVWarm.dayStatus(data.days[id]?.[TVWarm.dateKey()] || TVWarm.emptyDay());
  const done = st.done;
  chrome.action.setBadgeText({ text: done ? '✓' : `${st.tasks}/${TVWarm.TASK_COUNT}` });
  chrome.action.setBadgeBackgroundColor({ color: done ? '#1e9e4a' : st.done ? '#d79b00' : '#e5243b' });
  chrome.action.setTitle({ title: `TubeVault: ${channel.name}, ${st.tasks}/${TVWarm.TASK_COUNT} warm-up tasks done today` });
}

// ---------- Alarms: daily reminder + periodic checks ----------

async function setupAlarms() {
  const { settings } = await TVWarm.load();
  await chrome.alarms.clear('warm-reminder');
  if (settings.reminder) {
    const [h, m] = (settings.reminderTime || '19:00').split(':').map(Number);
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    chrome.alarms.create('warm-reminder', { when: next.getTime(), periodInMinutes: 24 * 60 });
  }
  chrome.alarms.create('warm-tick', { periodInMinutes: 30 });
  updateBadge();
}

async function sendReminder() {
  const data = await TVWarm.load();
  const lines = [];
  for (const c of data.channels) {
    const s = TVWarm.score(data, c);
    if (s.doneDays >= TVWarm.TARGETS.days) continue; // finished warming
    const st = TVWarm.dayStatus(data.days[c.id]?.[TVWarm.dateKey()] || TVWarm.emptyDay());
    if (st.done) continue;
    const t = st.totals;
    const left = [];
    const mins = Math.ceil((TVWarm.TARGETS.watchMinSec - t.watchSec) / 60);
    if (mins > 0) left.push(`${mins} min watching`);
    const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
    if (t.subs < TVWarm.TARGETS.subsMin) left.push(n(TVWarm.TARGETS.subsMin - t.subs, 'subscribe'));
    if (t.comments < TVWarm.TARGETS.commentsMin) left.push(n(TVWarm.TARGETS.commentsMin - t.comments, 'comment'));
    if (t.likes < TVWarm.TARGETS.likesMin) left.push(n(TVWarm.TARGETS.likesMin - t.likes, 'like'));
    if (t.searches < TVWarm.TARGETS.searchesMin) left.push(n(TVWarm.TARGETS.searchesMin - t.searches, 'search'));
    lines.push(`${c.name}: ${left.join(', ')} left`);
  }
  if (!lines.length) return;
  chrome.notifications.create(`reminder-${TVWarm.dateKey()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Warm-up not done yet today',
    message: lines.join('\n'),
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'warm-reminder') sendReminder();
  if (alarm.name === 'warm-tick') {
    updateBadge(); // also rolls the badge over at midnight
    refreshProfiles() // new day, new name/picture? picked up here even if no YouTube tab is open
      .then(() => syncAllUploads())
      .then(() => checkUploads());
  }
});

// Clicking a notification opens YouTube (the side panel can only be opened from a click on the icon).
chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  if (id.startsWith('upload-')) chrome.tabs.create({ url: 'https://studio.youtube.com/' });
  else chrome.tabs.create({ url: 'https://www.youtube.com/' });
});

// Badge follows the signed-in account.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LAST_ACCOUNT]) updateBadge();
});
