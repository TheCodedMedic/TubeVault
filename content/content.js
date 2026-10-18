// Injects a "+" button on YouTube channel, video and Shorts pages.
// Whatever page you're on, the saved link is always the channel page.
(() => {
  // Replace any dead copy left in the tab by a previous version of the extension (see tracker.js).
  window.__tvInstance = Math.random().toString(36).slice(2); // new id for this run (tracker.js reads it too)
  document.querySelectorAll('tubevault-button').forEach((e) => e.remove());
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

  const text = (el) => (el?.textContent || '').trim();
  const visible = (sel) => document.querySelector(`${sel}:not([hidden])`) || null;

  // Bigger avatar than the 48px thumbnails YouTube uses on watch pages.
  const upscale = (src) => (src && src.startsWith('http') ? src.replace(/=s\d+(-[^?]*)?/, '=s176-c-k-c0x00ffffff-no-rj') : '');

  function build(href, name, avatar) {
    const norm = TVStore.normalizeChannelPath(href);
    if (!norm) return null;
    return { id: norm.id, url: norm.url, name: name || norm.url.split('/').pop(), avatar: upscale(avatar) };
  }

  // Works out which channel the current page belongs to.
  function detectChannel() {
    const path = location.pathname;

    if (path === '/watch') {
      const root = visible('ytd-watch-flexy') || document;
      const link = root.querySelector('ytd-watch-metadata #owner ytd-channel-name a, #owner #channel-name a');
      const img = root.querySelector('ytd-watch-metadata #owner #avatar img, #owner yt-img-shadow img');
      return link ? build(link.getAttribute('href'), text(link), img?.src) : null;
    }

    if (path.startsWith('/shorts/')) {
      const reel = document.querySelector('ytd-reel-video-renderer[is-active]') || document;
      const link = reel.querySelector('yt-reel-channel-bar-view-model a[href^="/@"], .ytReelChannelBarViewModelChannelName a, a[href^="/@"]');
      const img = reel.querySelector('yt-reel-channel-bar-view-model img, yt-decorated-avatar-view-model img');
      return link ? build(link.getAttribute('href'), text(link).replace(/^@/, ''), img?.src) : null;
    }

    const m = path.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/);
    if (m) {
      const root = visible('ytd-browse') || document;
      const name =
        text(root.querySelector('yt-page-header-renderer h1, #page-header h1')) ||
        text(root.querySelector('ytd-c4-tabbed-header-renderer #channel-name #text, #channel-header #channel-name #text')) ||
        document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
      const img = root.querySelector(
        'yt-page-header-renderer yt-avatar-shape img, #page-header yt-avatar-shape img, yt-decorated-avatar-view-model img, #channel-header #avatar img'
      );
      return build('/' + m[1], name, img?.src);
    }
    return null;
  }

  // Where the button sits; falls back to a floating button if YouTube's layout changes.
  function findAnchor() {
    const path = location.pathname;
    if (path === '/watch') {
      return (visible('ytd-watch-flexy') || document).querySelector('ytd-watch-metadata #owner');
    }
    if (/^\/(@|channel\/|c\/|user\/)/.test(path)) {
      const root = visible('ytd-browse') || document;
      return root.querySelector('yt-page-header-renderer yt-flexible-actions-view-model, #page-header yt-flexible-actions-view-model, #channel-header #buttons');
    }
    return null;
  }

  // ---------- UI (inside a shadow root so YouTube's CSS can't break it) ----------

  const host = document.createElement('tubevault-button');
  host.dataset.tv = instance;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { display: inline-flex; align-items: center; margin-left: 8px; font-family: Roboto, Arial, sans-serif; }
      :host(.floating) { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; margin: 0; }
      .btn {
        display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px 0 10px;
        border: none; border-radius: 18px; cursor: pointer; font: 500 14px Roboto, Arial, sans-serif;
        background: #ff0033; color: #fff; white-space: nowrap;
      }
      .btn:hover { filter: brightness(1.08); }
      .btn.saved { background: #272727; color: #fff; }
      :host(.floating) .btn { box-shadow: 0 4px 16px rgba(0,0,0,.35); }
      .plus { font-size: 20px; line-height: 1; font-weight: 400; }
      .menu {
        position: fixed; z-index: 2147483001; min-width: 220px; max-height: 360px; overflow: auto;
        background: #fff; color: #0f0f0f; border-radius: 12px; padding: 8px 0;
        box-shadow: 0 8px 28px rgba(0,0,0,.28); font-size: 14px; display: none;
      }
      .menu.open { display: block; }
      .title { padding: 6px 16px 8px; font-size: 12px; color: #606060; text-transform: uppercase; letter-spacing: .04em; }
      .item { display: flex; align-items: center; gap: 10px; padding: 9px 16px; cursor: pointer; }
      .item:hover { background: #f2f2f2; }
      .check { width: 16px; color: #ff0033; font-weight: 700; }
      .sep { height: 1px; background: #e5e5e5; margin: 6px 0; }
      .new { display: flex; gap: 6px; padding: 6px 12px; }
      .new input { flex: 1; min-width: 0; padding: 7px 10px; border: 1px solid #ccc; border-radius: 8px; font: inherit; }
      .new button { border: none; border-radius: 8px; padding: 0 12px; background: #0f0f0f; color: #fff; cursor: pointer; font: inherit; }
      .remove { color: #cc0000; }
      @media (prefers-color-scheme: dark) {
        .menu { background: #282828; color: #f1f1f1; }
        .item:hover { background: #3a3a3a; }
        .title { color: #aaa; }
        .sep { background: #3f3f3f; }
        .new input { background: #1f1f1f; color: #f1f1f1; border-color: #555; }
        .new button { background: #f1f1f1; color: #0f0f0f; }
      }
    </style>
    <button class="btn" type="button"><span class="plus">+</span><span class="label">TubeVault</span></button>
    <div class="menu" role="menu"></div>
  `;
  const btn = shadow.querySelector('.btn');
  const label = shadow.querySelector('.label');
  const plus = shadow.querySelector('.plus');
  const menu = shadow.querySelector('.menu');

  let current = null; // channel detected on this page
  let data = { folders: [], channels: [] };

  const savedEntry = () => current && data.channels.find((c) => c.id === current.id);

  function renderButton() {
    const saved = savedEntry();
    const folder = saved && data.folders.find((f) => f.id === saved.folderId);
    btn.classList.toggle('saved', !!saved);
    plus.textContent = saved ? '✓' : '+';
    label.textContent = saved ? folder?.name || 'Saved' : 'TubeVault';
    btn.title = saved ? `Saved in "${folder?.name}" — click to move` : `Save ${current?.name || 'channel'} to TubeVault`;
  }

  function renderMenu() {
    const saved = savedEntry();
    menu.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = saved ? 'Move to folder' : 'Save to folder';
    menu.append(title);

    for (const f of data.folders) {
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = `<span class="check">${saved?.folderId === f.id ? '✓' : ''}</span><span></span>`;
      item.lastChild.textContent = f.name;
      item.addEventListener('click', () => saveTo(f.id));
      menu.append(item);
    }

    menu.append(Object.assign(document.createElement('div'), { className: 'sep' }));
    const form = document.createElement('form');
    form.className = 'new';
    form.innerHTML = `<input placeholder="New folder (niche)…" /><button type="submit">Add</button>`;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.querySelector('input').value.trim();
      if (!name) return;
      const folder = await TVStore.addFolder(name);
      saveTo(folder.id);
    });
    // Stop YouTube's keyboard shortcuts (k, f, m…) firing while typing.
    form.addEventListener('keydown', (e) => e.stopPropagation());
    menu.append(form);

    if (saved) {
      const rm = document.createElement('div');
      rm.className = 'item remove';
      rm.innerHTML = '<span class="check">✕</span><span>Remove from TubeVault</span>';
      rm.addEventListener('click', async () => {
        await TVStore.removeChannel(saved.id);
        closeMenu();
      });
      menu.append(rm);
    }
  }

  async function saveTo(folderId) {
    const ch = detectChannel() || current; // re-read in case the page changed
    if (!ch) return;
    await TVStore.saveChannel(ch, folderId);
    closeMenu();
  }

  function openMenu() {
    current = detectChannel() || current;
    renderMenu();
    menu.classList.add('open');
    const r = btn.getBoundingClientRect();
    const w = 240;
    const h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    menu.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
  }
  const closeMenu = () => menu.classList.remove('open');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('open') ? closeMenu() : openMenu();
  });
  document.addEventListener('click', (e) => {
    if (!e.composedPath().includes(host)) closeMenu();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

  // ---------- Keep the button in sync with YouTube's single-page navigation ----------

  function sync() {
    const ch = detectChannel();
    if (!ch) {
      current = null;
      closeMenu();
      host.remove();
      return;
    }
    if (current?.id !== ch.id) closeMenu();
    current = ch;

    const anchor = findAnchor();
    if (anchor) {
      host.classList.remove('floating');
      if (host.parentNode !== anchor) anchor.append(host);
    } else {
      host.classList.add('floating');
      if (host.parentNode !== document.body) document.body.append(host);
    }
    renderButton();
  }

  let timer = null;
  // Throttle (not debounce): YouTube mutates the DOM constantly while a video plays.
  const scheduleSync = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      sync();
    }, 300);
  };

  const observer = new MutationObserver((mutations) => {
    // Ignore mutations caused by our own button.
    if (mutations.every((m) => m.target === host || host.contains(m.target))) return;
    scheduleSync();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', scheduleSync);
  document.addEventListener('tubevault:takeover', () => {
    observer.disconnect();
    window.removeEventListener('yt-navigate-finish', scheduleSync);
    clearTimeout(timer);
    host.remove();
  });

  TVStore.load().then((d) => {
    data = d;
    sync();
  });
  TVStore.onChange((d) => {
    data = d;
    renderButton();
    if (menu.classList.contains('open')) renderMenu();
  });

  // The side panel's "Add current channel" button asks us what channel is on screen.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'tubevault:getChannel') sendResponse(detectChannel());
  });
})();
