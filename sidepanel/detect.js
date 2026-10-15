// Injected into the current YouTube / YouTube Studio tab by the sidebar's refresh button
// (chrome.scripting), so it works even on tabs opened before the extension was (re)loaded.
// Must be self-contained: it runs inside the page, not in the sidebar.
async function tvDetectAccount() {
  const txt = (el) => (el?.textContent || '').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ucFrom = (s) => (String(s || '').match(/(UC[\w-]{22})/) || [])[1] || '';
  const handleFrom = (s) => (String(s || '').match(/\/(@[\w.-]+)/) || [])[1] || '';
  const imgSrc = (el) => (el?.src && el.src.startsWith('http') ? el.src : '');

  // ---------- YouTube Studio: the channel ID is in the URL ----------
  if (location.hostname === 'studio.youtube.com') {
    const id = ucFrom(location.pathname) || ucFrom(document.querySelector('a[href*="/channel/UC"]')?.getAttribute('href'));
    const name =
      txt(document.querySelector('ytcp-navigation-drawer #entity-name')) ||
      txt(document.querySelector('#entity-name')) ||
      txt(document.querySelector('.entity-name'));
    const avatar = imgSrc(document.querySelector('ytcp-navigation-drawer img')) || imgSrc(document.querySelector('#avatar-btn img'));
    if (!id && !name) return { error: 'Open YouTube Studio fully, then press refresh again.' };
    return { signedIn: true, ytChannelId: id, name, handle: '', avatar, source: 'YouTube Studio' };
  }

  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return { error: 'Open YouTube or YouTube Studio in this tab first.' };

  const avatarBtn = document.querySelector('ytd-topbar-menu-button-renderer button#avatar-btn, button#avatar-btn');
  if (!avatarBtn) return { signedIn: false, error: "You're not signed in to YouTube in this tab." };
  const topAvatar = imgSrc(avatarBtn.querySelector('img'));

  // ---------- 1. YouTube's account switcher data ----------
  try {
    const res = await fetch('/getAccountSwitcherEndpoint', { credentials: 'include' });
    const json = JSON.parse((await res.text()).replace(/^\)\]\}'\s*/, ''));
    const t = (v) => (typeof v === 'string' ? v : v?.simpleText || v?.runs?.map((r) => r.text).join('') || '');
    const find = (n) => {
      if (!n || typeof n !== 'object') return null;
      if (n.isSelected === true && (n.accountName || n.channelHandle)) return n;
      for (const v of Object.values(n)) {
        const hit = find(v);
        if (hit) return hit;
      }
      return null;
    };
    const sel = find(json);
    if (sel && (t(sel.accountName) || t(sel.channelHandle))) {
      return {
        signedIn: true,
        name: t(sel.accountName),
        handle: t(sel.channelHandle),
        ytChannelId: ucFrom(JSON.stringify(sel)),
        avatar: sel.accountPhoto?.thumbnails?.slice(-1)[0]?.url || topAvatar,
        source: 'YouTube account',
      };
    }
  } catch {
    // fall through to the next method
  }

  // ---------- 2. Your own channel page shows "Manage videos" links into Studio ----------
  const page = document.querySelector('ytd-browse:not([hidden])');
  const studioLink = page?.querySelector('a[href*="studio.youtube.com/channel/UC"]');
  if (studioLink && /^\/(@|channel\/)/.test(location.pathname)) {
    return {
      signedIn: true,
      ytChannelId: ucFrom(studioLink.href),
      handle: handleFrom(location.pathname),
      name: txt(page.querySelector('yt-page-header-renderer h1, #page-header h1')),
      avatar: imgSrc(page.querySelector('yt-page-header-renderer yt-avatar-shape img')) || topAvatar,
      source: 'your channel page',
    };
  }

  // ---------- 3. Open the account menu for a moment and read it ----------
  const readMenu = () => {
    const header = document.querySelector('ytd-active-account-header-renderer');
    if (!header || !txt(header.querySelector('#account-name'))) return null;
    const yourChannel = [...document.querySelectorAll('ytd-multi-page-menu-renderer a[href]')].find((a) =>
      /^\/(@|channel\/UC)/.test(a.getAttribute('href') || '')
    );
    const href = yourChannel?.getAttribute('href') || '';
    return {
      signedIn: true,
      name: txt(header.querySelector('#account-name')),
      handle: txt(header.querySelector('#channel-handle')) || handleFrom(href),
      ytChannelId: ucFrom(href),
      avatar: imgSrc(header.querySelector('img')) || topAvatar,
      source: 'YouTube account menu',
    };
  };
  let found = readMenu();
  if (!found) {
    avatarBtn.click();
    for (let i = 0; i < 30 && !found; i++) {
      await sleep(100);
      found = readMenu();
    }
    // Close the menu again.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    if (document.querySelector('tp-yt-iron-dropdown:not([aria-hidden="true"]) ytd-multi-page-menu-renderer')) avatarBtn.click();
  }
  if (found) return found;

  return { signedIn: true, avatar: topAvatar, error: "Signed in, but couldn't read the channel name. Try from YouTube Studio." };
}

// When loaded as a content script (YouTube / Studio pages), answer the sidebar's refresh button.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && /(^|\.)youtube\.com$/.test(location.hostname)) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'tubevault:detect') return;
    tvDetectAccount().then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  });
}
