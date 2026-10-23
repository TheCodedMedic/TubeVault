// Warm Tracker data + Trust Score. Shared by the background worker (which does all writes)
// and the side panel (which reads, scores and renders).
// Data shape (chrome.storage.local, key "tubevault:warm"):
// {
//   activeId,                       // channel credited when the signed-in account can't be detected
//   channels: [{ id, name, handle, avatar, gmailCreated: 'YYYY-MM', startDate: 'YYYY-MM-DD',
//                forceUnlocked, notNew,   // first uploads unlocked by hand / "this isn't a new channel"
//                setup: { twoStep, name, pic, phone, features, idVerified, madeForKids, vidiq } }],
//   days: { [channelId]: { 'YYYY-MM-DD': Day } }
// }
//   settings: { reminder: true, reminderTime: '19:00' }
// Channel also has uploads: [{ id, videoId, title, publishedAt, collab, checks: { '8': Check, ... } }]
//   Check = { views, impressions, ctr, source, autoViews }
// Day = { watchSec, subs: { [channelKey]: name }, subsAt: { [channelKey]: time },
//         comments: [{ at, words, sig, dup }], likes: { [videoId]: 1 }, watchLater: { [videoId]: 1 },
//         searches: [query], devices: { [deviceId]: 1 }, adj: { watchMin, subs, comments, likes, searches, watchLater } }
var TVWarm = (() => {
  const KEY = 'tubevault:warm';

  // Each daily task has a minimum (counts for the day, bar turns light green) and a goal (full green).
  const TARGETS = {
    watchMinSec: 30 * 60,
    watchSec: 2 * 3600, // goal
    subsMin: 1,
    subsTarget: 3,
    subsMax: 5, // more than this in a day looks spammy and doesn't count
    commentsMin: 3,
    commentsTarget: 5,
    likesMin: 2,
    likesTarget: 3,
    searchesMin: 1, // different searches a day
    searchesTarget: 1,
    watchLaterMin: 1, // optional: shown, but not needed for the day
    days: 7,
    minCommentWords: 6, // shorter comments are flagged and don't count
    fastSubs: 3, // this many subscribes...
    fastSubsMs: 2 * 60 * 1000, // ...within 2 minutes looks rushed
  };

  // First Upload Tracker: check-ins after publishing (hours).
  const CHECKPOINTS = [8, 24, 48, 72];
  const SOURCES = [
    { key: 'browse', label: 'Browse features (Home)', pushed: true },
    { key: 'suggested', label: 'Suggested videos', pushed: true },
    { key: 'subscriptions', label: 'Subscriptions feed', pushed: true },
    { key: 'shorts', label: 'Shorts feed', pushed: true },
    { key: 'search', label: 'YouTube search', pushed: false },
    { key: 'direct', label: 'Direct or unknown', pushed: false },
    { key: 'external', label: 'External', pushed: false },
    { key: 'other', label: 'Other', pushed: false },
  ];
  const TASK_COUNT = 5; // required daily tasks: watch, subscribe, comment, like, search (Watch later is optional)
  const DEFAULT_SETTINGS = { reminder: true, reminderTime: '19:00' };

  const SETUP_ITEMS = [
    { key: 'twoStep', label: '2-step verification on the Gmail', points: 5, must: true },
    { key: 'name', label: 'Channel name set', points: 2 },
    { key: 'pic', label: 'Profile picture set', points: 2 },
    { key: 'phone', label: 'Phone number verified', points: 5, must: true, hint: 'Studio → Settings → Channel → Feature eligibility' },
    { key: 'features', label: 'Intermediate + advanced features on', points: 2, hint: 'Studio → Settings → Channel → Feature eligibility' },
    { key: 'madeForKids', label: '"Made for Kids" set to No', points: 2, hint: 'Studio → Settings → Channel → Advanced settings' },
    { key: 'idVerified', label: 'ID verification (if you can)', points: 1 },
    { key: 'vidiq', label: 'VidIQ extension connected to this channel', points: 1, hint: 'Ticks itself when TubeVault sees VidIQ running on YouTube' },
  ];

  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);

  const emptyDay = () => ({ watchSec: 0, subs: {}, subsAt: {}, comments: [], likes: {}, searches: [], watchLater: {}, devices: {}, adj: {} });

  async function load() {
    const res = await chrome.storage.local.get(KEY);
    const d = res[KEY] || {};
    return {
      activeId: d.activeId || null,
      channels: d.channels || [],
      days: d.days || {},
      settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
    };
  }

  const save = (data) => chrome.storage.local.set({ [KEY]: data });

  function getDay(data, channelId, key) {
    data.days[channelId] = data.days[channelId] || {};
    return (data.days[channelId][key] = data.days[channelId][key] || emptyDay());
  }

  // Auto counts + manual adjustments, never below zero.
  function totals(day) {
    const adj = day.adj || {};
    const full = day.comments.filter((c) => c.words >= TARGETS.minCommentWords && !c.dup).length;
    const dupComments = day.comments.filter((c) => c.dup).length;
    const add = (n, a) => Math.max(0, n + (a || 0));
    return {
      watchSec: Math.max(0, day.watchSec + (adj.watchMin || 0) * 60),
      subs: add(Object.keys(day.subs).length, adj.subs),
      comments: add(full, adj.comments),
      shortComments: day.comments.length - full - dupComments,
      dupComments,
      likes: add(Object.keys(day.likes).length, adj.likes),
      searches: add(day.searches.length, adj.searches),
      watchLater: add(Object.keys(day.watchLater || {}).length, adj.watchLater),
    };
  }

  // True when TARGETS.fastSubs subscribes landed within TARGETS.fastSubsMs.
  function subsTooFast(day) {
    const times = Object.values(day.subsAt || {}).sort((a, b) => a - b);
    for (let i = 0; i + TARGETS.fastSubs - 1 < times.length; i++) {
      if (times[i + TARGETS.fastSubs - 1] - times[i] <= TARGETS.fastSubsMs) return true;
    }
    return false;
  }

  // Normalised fingerprint of a comment, to catch the same text posted twice.
  function commentSig(text) {
    const norm = String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    let h = 5381;
    for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // 'full' at the goal, 'min' at the minimum, '' below it. Drives the bar colours.
  const levelOf = (value, min, goal) => (value >= goal ? 'full' : value >= min ? 'min' : '');

  // Points for one task: reaching the minimum earns 75%, the rest comes on the way to the goal.
  function credit(value, min, goal) {
    if (value < min) return 0.75 * (value / min);
    return goal > min ? 0.75 + 0.25 * Math.min((value - min) / (goal - min), 1) : 1;
  }

  function dayStatus(day) {
    const t = totals(day);
    const subsOver = t.subs > TARGETS.subsMax;
    const parts = {
      watch: credit(t.watchSec, TARGETS.watchMinSec, TARGETS.watchSec) * 3,
      subs: subsOver ? 0 : credit(t.subs, TARGETS.subsMin, TARGETS.subsTarget) * 1.5,
      comments: credit(t.comments, TARGETS.commentsMin, TARGETS.commentsTarget) * 1.5,
      likes: credit(t.likes, TARGETS.likesMin, TARGETS.likesTarget) * 1,
      search: credit(t.searches, TARGETS.searchesMin, TARGETS.searchesTarget) * 1,
    };
    const points = Object.values(parts).reduce((a, b) => a + b, 0);
    const active = t.watchSec > 0 || t.subs || t.comments || t.likes || t.searches || t.watchLater;
    const tasks = [
      t.watchSec >= TARGETS.watchMinSec,
      t.subs >= TARGETS.subsMin && !subsOver,
      t.comments >= TARGETS.commentsMin,
      t.likes >= TARGETS.likesMin,
      t.searches >= TARGETS.searchesMin,
    ].filter(Boolean).length;
    const done = tasks === TASK_COUNT; // the day turns green once every required minimum is met
    return { totals: t, parts, points, done, subsOver, tooFast: subsTooFast(day), tasks, active: !!active };
  }

  function gmailAgeMonths(ym) {
    if (!/^\d{4}-\d{2}$/.test(ym || '')) return null;
    const [y, m] = ym.split('-').map(Number);
    const now = new Date();
    return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  }

  function gmailPoints(ym) {
    const m = gmailAgeMonths(ym);
    if (m == null || m < 1) return 0;
    if (m < 6) return 8;
    if (m < 12) return 14;
    return 20;
  }

  // Device consistency: days whose only device is the most-used device.
  function deviceStats(days) {
    const counts = {};
    const activeDays = days.filter((d) => Object.keys(d.devices).length);
    for (const d of activeDays) for (const id of Object.keys(d.devices)) counts[id] = (counts[id] || 0) + 1;
    const main = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    const sameDays = main ? activeDays.filter((d) => Object.keys(d.devices).length === 1 && d.devices[main]).length : 0;
    return { main, sameDays: Math.min(sameDays, TARGETS.days), deviceCount: Object.keys(counts).length };
  }

  function score(data, channel) {
    const dayMap = data.days[channel.id] || {};
    const keys = Object.keys(dayMap).sort();
    const statuses = keys.map((k) => ({ key: k, ...dayStatus(dayMap[k]) }));
    const best = [...statuses].sort((a, b) => b.points - a.points).slice(0, TARGETS.days);
    const doneDays = statuses.filter((s) => s.done).length;
    const devices = deviceStats(keys.map((k) => dayMap[k]));

    const setup = channel.setup || {};
    const security = (setup.twoStep ? 5 : 0) + (setup.phone ? 5 : 0);
    const basics = SETUP_ITEMS.filter((i) => !['twoStep', 'phone'].includes(i.key) && setup[i.key]).reduce((a, i) => a + i.points, 0);
    const gmail = gmailPoints(channel.gmailCreated);
    const warm = best.reduce((a, s) => a + s.points, 0);
    const device = (devices.sameDays / TARGETS.days) * 4;
    const total = Math.round(gmail + security + basics + warm + device);

    const missing = [];
    if (!setup.twoStep) missing.push('Turn on 2-step verification');
    if (!setup.phone) missing.push('Verify your phone number');
    if (doneDays < TARGETS.days) missing.push(`Complete ${TARGETS.days - doneDays} more warm-up day${TARGETS.days - doneDays === 1 ? '' : 's'}`);

    let verdict = 'red';
    if (total >= 80 && !missing.length) verdict = 'green';
    else if (total >= 60) verdict = 'yellow';

    return {
      total,
      verdict,
      missing,
      doneDays,
      devices,
      parts: { gmail, security, basics, warm: Math.round(warm * 10) / 10, device: Math.round(device * 10) / 10 },
      days: statuses,
    };
  }

  // ---------- First Upload Tracker ----------

  // The latest check-in that has a traffic source filled in.
  function latestCheck(upload) {
    for (const h of [...CHECKPOINTS].reverse()) {
      const c = upload.checks?.[h];
      if (c && (c.source || c.impressions != null || c.views != null)) return { hours: h, ...c };
    }
    return null;
  }

  // Follows the playbook: Browse/Suggested = pushed; only Search/Direct = not pushed.
  function uploadVerdict(upload) {
    const c = latestCheck(upload);
    if (!c) return { key: 'waiting', label: 'Waiting for the first check-in' };
    const src = SOURCES.find((s) => s.key === c.source);
    if (c.impressions >= 1000 && c.ctr != null && c.ctr < 2) {
      return { key: 'clicks', label: 'Shown, but few clicks: improve the title and thumbnail' };
    }
    if (src?.pushed) return { key: 'pushed', label: 'YouTube is pushing it' };
    if (src) return { key: 'notpushed', label: 'Not being pushed (only search/direct)' };
    if (c.impressions != null && c.impressions < 50) return { key: 'notpushed', label: 'Almost no impressions' };
    return { key: 'waiting', label: 'Add the top traffic source to judge it' };
  }

  // Finds the tracked channel for a signed-in account.
  // The channel ID never changes, so it wins. Name and @username can change, so they are only used
  // for channels we don't have an ID for yet (or when the account's ID isn't known).
  function matchChannel(channels, acc) {
    if (!acc) return null;
    const low = (v) => String(v || '').trim().toLowerCase();
    const h = low(acc.handle);
    const n = low(acc.name);
    const same = (c) => (h && low(c.handle) === h) || (n && low(c.name) === n);
    if (acc.ytChannelId) {
      return channels.find((c) => c.ytChannelId === acc.ytChannelId) || channels.find((c) => !c.ytChannelId && same(c)) || null;
    }
    return channels.find(same) || null;
  }

  // Same picture even if YouTube returned a different size of it (…=s88 vs …=s900).
  const imageBase = (u) => String(u || '').split('=')[0];

  // Brings a tracked channel up to date with what YouTube shows now. Returns what changed.
  function applyProfile(channel, info) {
    const changes = [];
    const set = (field, label, value) => {
      if (value && value !== channel[field]) {
        changes.push({ field, label, from: channel[field] || '', to: value });
        channel[field] = value;
      }
    };
    if (info?.ytChannelId && !channel.ytChannelId) channel.ytChannelId = info.ytChannelId;
    set('name', 'name', (info?.name || '').trim());
    set('handle', 'username', (info?.handle || '').trim());
    if (info?.avatar && imageBase(info.avatar) !== imageBase(channel.avatar)) set('avatar', 'picture', info.avatar);
    if (changes.length) channel.profileChangedAt = Date.now();
    return changes;
  }

  // Day number of the warm-up (start date = day 1).
  function dayNumber(channel) {
    const start = new Date(channel.startDate + 'T00:00');
    const today = new Date(dateKey() + 'T00:00');
    return Math.floor((today - start) / 86400000) + 1;
  }

  // First uploads: locked while warming. It opens by itself on day 7 or once the channel is Good to start,
  // and can be unlocked by hand at any time (e.g. someone not warming for days, or an existing channel).
  const AUTO_DAY = 7;
  function uploadsAccess(channel, verdict) {
    const day = dayNumber(channel);
    if (channel.forceUnlocked) return { state: 'unlocked', day, why: channel.notNew ? 'Existing channel' : 'Unlocked by hand' };
    if (verdict === 'green') return { state: 'unlocked', day, why: 'Good to start' };
    if (day >= AUTO_DAY) return { state: 'unlocked', day, why: `Day ${AUTO_DAY} reached` };
    return { state: 'locked', day, autoIn: AUTO_DAY - day };
  }

  // Parses YouTube's public channel feed (latest 15 videos). Regex-based so it also works in the service worker.
  function parseFeed(xml) {
    const decode = (t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map((e) => ({
      videoId: (e.match(/<yt:videoId>([^<]+)</) || [])[1],
      title: decode((e.match(/<title>([^<]*)</) || [])[1] || ''),
      publishedAt: Date.parse((e.match(/<published>([^<]+)</) || [])[1]) || null,
      views: Number((e.match(/<media:statistics views="(\d+)"/) || [])[1] ?? NaN),
    })).filter((v) => v.videoId);
  }

  // Overall call once uploads have been tracked.
  function uploadsDecision(uploads) {
    const judged = (uploads || []).map(uploadVerdict).filter((v) => v.key !== 'waiting');
    if (!judged.length) return null;
    if (judged.some((v) => v.key === 'pushed')) {
      return { key: 'pushed', label: 'The channel is working. Keep posting on a steady schedule.' };
    }
    if (judged.length < 3) {
      return { key: 'unsure', label: 'Not pushed yet. Post 1–2 more videos before deciding.' };
    }
    return {
      key: 'notpushed',
      label: 'Not being pushed after 3 videos. Re-check Made for Kids, restrictions and phone verification, try the Collaboration feature, or keep warming.',
    };
  }

  return { levelOf, applyProfile, matchChannel, dayNumber, uploadsAccess, parseFeed, AUTO_DAY, TASK_COUNT, CHECKPOINTS, SOURCES, DEFAULT_SETTINGS, subsTooFast, commentSig, latestCheck, uploadVerdict, uploadsDecision,
    KEY, TARGETS, SETUP_ITEMS, dateKey, uid, emptyDay, load, save, getDay, totals, dayStatus, gmailAgeMonths, score };
})();
