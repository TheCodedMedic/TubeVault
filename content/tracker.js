// Warm Tracker: watches what you do on YouTube and reports it to the background worker,
// which credits it to the channel you're signed in as.
(() => {
  // After the extension is reloaded/updated, tabs that were already open keep a dead copy of this script
  // (its connection to the extension is gone). A fresh copy tells any older copy to shut down.
  window.__tvInstance = window.__tvInstance || Math.random().toString(36).slice(2); // set by content.js on the same load
  document.querySelectorAll('tubevault-toast').forEach((e) => e.remove());
  document.dispatchEvent(new CustomEvent('tubevault:takeover'));
  // A copy of this script left over from before an extension update can't be reached or stopped, and it keeps
  // its own button on the page. Every element we create carries this run's id, and anything with another
  // id is hidden, so only one button is ever visible.
  const instance = window.__tvInstance;
  let hide = document.getElementById('tubevault-hide-old');
  if (!hide) {
    hide = document.createElement('style');
    hide.id = 'tubevault-hide-old';
    document.documentElement.append(hide);
  }
  hide.textContent = `tubevault-button:not([data-tv="${instance}"]), tubevault-toast:not([data-tv="${instance}"]) { display: none !important; }`;

  const timers = [];
  let dead = false;
  const shutdown = () => {
    dead = true;
    timers.forEach(clearInterval);
    document.querySelectorAll('tubevault-toast').forEach((e) => e.remove());
  };
  document.addEventListener('tubevault:takeover', shutdown);

  // Status the sidebar can read: did the background credit our activity to a tracked channel?
  let matched = null;
  let lastCountedAt = 0;
  const COUNTED = /^warm:(watch|sub|like|comment|search|watchLater)$/;

  function send(msg) {
    if (dead) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage({ ...msg, account }).then(
        (r) => {
          if (COUNTED.test(msg.type) && r?.ok && r.result !== null) {
            matched = r.result !== false;
            if (matched && msg.type === 'warm:watch') lastCountedAt = Date.now();
          }
          return r;
        },
        () => null
      );
    } catch {
      // "Extension context invalidated": the extension was reloaded and this copy is orphaned.
      shutdown();
      return Promise.resolve(null);
    }
  }

  // Small on-page notice for warm-up warnings (subscribing too fast, copy-paste comments).
  const toastHost = document.createElement('tubevault-toast');
  toastHost.dataset.tv = instance;
  const toastRoot = toastHost.attachShadow({ mode: 'open' });
  toastRoot.innerHTML = `<style>
    .t { position: fixed; left: 20px; bottom: 20px; z-index: 2147483000; max-width: 340px; padding: 12px 14px;
         border-radius: 12px; background: #212121; color: #fff; font: 14px/1.4 Roboto, Arial, sans-serif;
         box-shadow: 0 6px 24px rgba(0,0,0,.35); border-left: 4px solid #ff0033; opacity: 0; transform: translateY(8px);
         transition: opacity .2s, transform .2s; pointer-events: none; }
    .t.show { opacity: 1; transform: none; }
    b { color: #ff7a8a; }
  </style><div class="t"></div>`;
  const toastEl = toastRoot.querySelector('.t');
  let toastTimer;
  function toast(html) {
    if (!toastHost.isConnected) document.documentElement.append(toastHost);
    toastEl.innerHTML = `<b>TubeVault</b> · ${html}`;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 6000);
  }

  // ---------- Who is signed in ----------

  let account = null; // { signedIn, handle, name, avatar }

  const isSignedIn = () =>
    !!document.querySelector('ytd-topbar-menu-button-renderer #avatar-btn, button#avatar-btn') &&
    !document.querySelector('ytd-masthead a[href*="ServiceLogin"]');

  // Finds the selected account in YouTube's account switcher data.
  function findSelected(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.isSelected === true && (node.accountName || node.channelHandle)) return node;
    for (const v of Object.values(node)) {
      const hit = findSelected(v);
      if (hit) return hit;
    }
    return null;
  }
  const txt = (t) => (typeof t === 'string' ? t : t?.simpleText || t?.runs?.map((r) => r.text).join('') || '');

  async function detectAccount(retries = 3) {
    let found = null;
    try {
      const res = await fetch('/getAccountSwitcherEndpoint', { credentials: 'include' });
      const body = (await res.text()).replace(/^\)\]\}'\s*/, '');
      const sel = findSelected(JSON.parse(body));
      if (sel) {
        found = {
          signedIn: true,
          name: txt(sel.accountName),
          handle: txt(sel.channelHandle),
          avatar: sel.accountPhoto?.thumbnails?.slice(-1)[0]?.url || '',
          ytChannelId: (JSON.stringify(sel).match(/UC[\w-]{22}/) || [])[0] || '',
        };
      }
    } catch {
      // Endpoint changed or blocked: fall back to "signed in, unknown account".
    }
    if (!found && !isSignedIn()) {
      // The top bar may not have rendered yet on first load.
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 3000));
        return detectAccount(retries - 1);
      }
      account = { signedIn: false };
      return account;
    }
    account = found || { signedIn: true };
    send({ type: 'warm:account' }).then((r) => {
      if (r?.ok) matched = !!r.result?.channelId;
    });
    return account;
  }

  // Re-check every few minutes and on navigation, in case the user switches account.
  let lastDetect = 0;
  const refreshAccount = () => {
    if (Date.now() - lastDetect < 60 * 1000) return;
    lastDetect = Date.now();
    detectAccount();
  };

  // ---------- Watch time ----------
  // Every few seconds, report the interval during which a video was really playing (no ads).
  // The background merges intervals from all tabs, so overlapping videos count once.

  let lastTick = null;
  // Any video that is really playing counts: not hover previews, not ads. (Shorts keep several <video>
  // elements on the page, so looking only at the first one is not enough.)
  const isPlaying = (v) =>
    !v.paused &&
    !v.ended &&
    v.readyState > 2 &&
    !v.closest('ytd-video-preview, #inline-preview-player, ytd-miniplayer-preview') &&
    !v.closest('.html5-video-player')?.classList.contains('ad-showing');
  const playing = () => [...document.querySelectorAll('video')].some(isPlaying);

  function tick() {
    const now = Date.now();
    if (playing() && account?.signedIn) {
      if (lastTick) send({ type: 'warm:watch', from: lastTick, to: now });
      lastTick = now;
    } else {
      lastTick = null;
    }
  }
  timers.push(setInterval(tick, 5000));
  // When playback stops, close the interval right away so the last seconds aren't lost.
  const flush = () => {
    if (lastTick && account?.signedIn) send({ type: 'warm:watch', from: lastTick, to: Date.now() });
    lastTick = playing() ? Date.now() : null;
  };
  for (const ev of ['pause', 'ended', 'waiting']) document.addEventListener(ev, flush, true);
  document.addEventListener('playing', () => { if (!lastTick) lastTick = Date.now(); }, true);

  // ---------- Subscribe / like / comment clicks ----------

  // The channel a subscribe button belongs to.
  function channelFor(btn) {
    const box = btn.closest('ytd-channel-renderer, ytd-video-owner-renderer, #owner, ytd-reel-video-renderer, yt-page-header-renderer, #page-header, ytd-c4-tabbed-header-renderer');
    const link = box?.querySelector('a[href^="/@"], a[href^="/channel/"]');
    let href = link?.getAttribute('href');
    let name = (box?.querySelector('ytd-channel-name a, #channel-name #text, h1, #text')?.textContent || '').trim();
    if (!href && /^\/(@|channel\/)/.test(location.pathname)) href = location.pathname;
    const norm = href && TVStore.normalizeChannelPath(href);
    return norm ? { key: norm.id, name: name || norm.url.split('/').pop() } : null;
  }

  const subState = (btn) => {
    const host = btn.closest('ytd-subscribe-button-renderer');
    if (host?.hasAttribute('subscribed')) return true;
    const label = `${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''}`.toLowerCase();
    return /unsubscribe|subscribed/.test(label);
  };

  const pressed = (btn) => btn.getAttribute('aria-pressed') === 'true';

  const videoId = () => {
    const u = new URL(location.href);
    return u.searchParams.get('v') || (location.pathname.match(/^\/shorts\/([\w-]+)/) || [])[1] || null;
  };

  // After a click, wait for YouTube to update the button, then report the real state.
  function after(ms, fn) {
    setTimeout(fn, ms);
  }

  // ---------- Watch later ----------
  // YouTube has several ways to add a video: the clock on a thumbnail, the player's own button, the Save
  // dialog and the ⋮ menu. They all say "Watch later", so recognise the click by that label.

  const RENDERERS = 'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytd-rich-grid-media';
  const WL = /watch\s*later/i;
  // Links to the Watch later playlist (sidebar, playlist page) are navigation, not adding a video.
  const NAV = 'a[href], ytd-guide-renderer, ytd-mini-guide-renderer, tp-yt-app-drawer, #guide, ytd-playlist-header-renderer, ytd-playlist-sidebar-renderer';
  const ROW = 'ytd-menu-service-item-renderer, yt-list-item-view-model, ytd-playlist-add-to-option-renderer, tp-yt-paper-item, [role="menuitem"], [role="checkbox"], [role="option"], label';

  let ctxVideo = null; // the video whose ⋮ menu was just opened { id, at }

  function videoIdIn(el) {
    const link = el.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    const m = link?.getAttribute('href')?.match(/[?&]v=([\w-]{11})|\/shorts\/([\w-]{11})/);
    return m ? m[1] || m[2] : null;
  }

  function isWatchLaterEl(el) {
    if (!(el instanceof Element) || el.closest(NAV)) return false;
    if (el.classList.contains('ytp-watch-later-button')) return true;
    if (WL.test(el.getAttribute('aria-label') || '') || WL.test(el.getAttribute('data-tooltip-title') || '')) return true;
    if (el.matches(ROW)) {
      const t = (el.textContent || '').trim();
      return t.length < 60 && WL.test(t);
    }
    return false;
  }

  // Which video was it? The one in the same card; else the one whose ⋮ menu was just opened; else this page's.
  function videoForWatchLater(el) {
    const card = el.closest(RENDERERS);
    if (card) return videoIdIn(card) || videoId();
    if (ctxVideo && Date.now() - ctxVideo.at < 15000) return ctxVideo.id;
    return videoId();
  }

  // On or off after the click? Checkboxes and toggles say so; if the page doesn't, report "unknown".
  function watchLaterState(el) {
    for (const n of [el, ...el.querySelectorAll('input, [aria-checked], [aria-pressed]')]) {
      const v = n.getAttribute('aria-checked') ?? n.getAttribute('aria-pressed');
      if (v === 'true') return true;
      if (v === 'false') return false;
      if (n.type === 'checkbox') return n.checked;
    }
    const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip-title') || ''} ${el.textContent || ''}`.toLowerCase();
    if (/removed/.test(label)) return false;
    if (/added|remove from|in watch later/.test(label)) return true;
    return undefined;
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!account?.signedIn) return;
      const target = e.target;

      // Remember which video a ⋮ menu belongs to (its menu items live outside the video's card).
      const moreBtn = target.closest?.('button');
      if (moreBtn && /action menu|more actions|more options/i.test(moreBtn.getAttribute('aria-label') || '')) {
        const card = moreBtn.closest(RENDERERS);
        const id = card && videoIdIn(card);
        if (id) ctxVideo = { id, at: Date.now() };
      }

      // Watch later
      const wlEl = e.composedPath().slice(0, 10).find(isWatchLaterEl);
      if (wlEl) {
        const id = videoForWatchLater(wlEl);
        setTimeout(() => send({ type: 'warm:watchLater', videoId: id, added: wlEl.isConnected ? watchLaterState(wlEl) : undefined }), 700);
        return;
      }

      // Subscribe / unsubscribe (also the "Unsubscribe" confirm dialog).
      const subBtn = target.closest('ytd-subscribe-button-renderer button, yt-subscribe-button-view-model button');
      if (subBtn) {
        const before = subState(subBtn);
        const ch = channelFor(subBtn);
        if (ch) {
          after(1500, () => {
            const now = subState(subBtn);
            if (now === before) return;
            send({ type: 'warm:sub', key: ch.key, name: ch.name, subscribed: now }).then((r) => {
              const res = r?.result;
              if (!res || !now) return;
              if (res.over) toast(`That's ${res.subs} subscribes today. Keep it to <b>5 max</b> per day.`);
              else if (res.tooFast) toast(`You subscribed to several channels in under 2 minutes. <b>Slow down</b>: spread subscribes across your watching session.`);
            });
          });
          lastSubTarget = { btn: subBtn, ch, at: Date.now() };
        }
        return;
      }
      if (target.closest('yt-confirm-dialog-renderer #confirm-button, yt-dialog-view-model button') && lastSubTarget && Date.now() - lastSubTarget.at < 30000) {
        const { btn, ch } = lastSubTarget;
        after(1500, () => {
          if (!subState(btn)) send({ type: 'warm:sub', key: ch.key, name: ch.name, subscribed: false });
        });
        return;
      }

      // Like (not dislike).
      const likeBtn = target.closest('like-button-view-model button, #like-button button, ytd-toggle-button-renderer#like-button button');
      if (likeBtn) {
        const id = videoId();
        if (!id) return;
        after(800, () => send({ type: 'warm:like', videoId: id, liked: pressed(likeBtn) }));
        return;
      }

      // Posting a comment or reply.
      const submit = target.closest('ytd-commentbox #submit-button, ytd-commentbox ytd-button-renderer#submit-button');
      if (submit) {
        const box = submit.closest('ytd-commentbox');
        const text = (box?.querySelector('#contenteditable-root')?.innerText || '').trim();
        if (!text) return;
        const words = text.split(/\s+/).filter(Boolean).length;
        send({ type: 'warm:comment', words, sig: TVWarm.commentSig(text) }).then((r) => {
          const res = r?.result;
          if (res?.dup) toast(`You've posted this <b>same comment before</b>. Copy-paste comments don't count. Write something specific to this video.`);
          else if (res?.short) toast(`Short comment: under ${TVWarm.TARGETS.minCommentWords} words doesn't count. Write a <b>full sentence</b>.`);
        });
      }
    },
    true
  );
  let lastSubTarget = null;

  // ---------- Searches ----------

  function checkSearch() {
    if (location.pathname !== '/results') return;
    const q = new URL(location.href).searchParams.get('search_query');
    if (q && account?.signedIn) send({ type: 'warm:search', query: q.trim().toLowerCase() });
  }

  // The sidebar's First Upload Tracker asks for the video on screen.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (dead) return;
    if (msg?.type === 'tubevault:ping') {
      sendResponse({
        alive: true,
        signedIn: !!account?.signedIn,
        account: account?.signedIn ? { name: account.name || '', handle: account.handle || '', ytChannelId: account.ytChannelId || '' } : null,
        matched,
        playing: playing(),
        lastCountedAt,
      });
      return;
    }
    if (msg?.type !== 'tubevault:getVideo') return;
    const id = videoId();
    const title = (document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata')?.textContent || document.title.replace(/ - YouTube$/, '')).trim();
    sendResponse(id ? { videoId: id, title } : null);
  });

  // ---------- VidIQ ----------
  // VidIQ injects its own panels into YouTube pages. If we see them while signed in, the
  // setup item "VidIQ extension connected" is ticked for this channel.
  let vidiqReported = false;
  function checkVidiq() {
    if (vidiqReported || !account?.signedIn) return;
    const found = document.querySelector('[id*="vidiq" i], [class*="vidiq" i], [data-vidiq], iframe[src*="vidiq" i]');
    if (found) {
      vidiqReported = true;
      send({ type: 'warm:vidiq' });
    }
  }
  timers.push(setInterval(checkVidiq, 10 * 1000));

  // ---------- Boot ----------

  window.addEventListener('yt-navigate-finish', () => {
    refreshAccount();
    checkSearch();
  });
  detectAccount().then(checkSearch);
  timers.push(setInterval(refreshAccount, 5 * 60 * 1000));
})();
