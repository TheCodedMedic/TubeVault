// Shared storage layer used by both the YouTube content script and the side panel.
// Data shape (chrome.storage.local, key "tubevault"):
// {
//   folders:  [{ id, name, collapsed }],
//   channels: [{ id, name, url, avatar, folderId, addedAt }]   // array order = display order
// }
var TVStore = (() => {
  const KEY = 'tubevault';
  const UNSORTED = 'unsorted';

  const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);

  async function load() {
    const res = await chrome.storage.local.get(KEY);
    const data = res[KEY] || { folders: [], channels: [] };
    data.folders = data.folders || [];
    data.channels = data.channels || [];
    if (!data.folders.some((f) => f.id === UNSORTED)) {
      data.folders.unshift({ id: UNSORTED, name: 'Unsorted', collapsed: false });
    }
    return data;
  }

  async function save(data) {
    await chrome.storage.local.set({ [KEY]: data });
  }

  async function update(fn) {
    const data = await load();
    const result = fn(data);
    await save(data);
    return result;
  }

  // Normalises any channel href/path to a canonical channel URL + stable id.
  // "/@mkbhd/videos" -> { id: "/@mkbhd", url: "https://www.youtube.com/@mkbhd" }
  function normalizeChannelPath(href) {
    if (!href) return null;
    let path;
    try {
      path = new URL(href, 'https://www.youtube.com').pathname;
    } catch {
      return null;
    }
    const m = path.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/);
    if (!m) return null;
    const clean = '/' + decodeURIComponent(m[1]);
    return { id: clean.toLowerCase(), url: 'https://www.youtube.com' + clean };
  }

  return {
    UNSORTED,
    load,
    normalizeChannelPath,

    onChange(cb) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[KEY]) load().then(cb);
      });
    },

    addFolder(name) {
      return update((d) => {
        const folder = { id: uid(), name: name.trim() || 'New folder', collapsed: false };
        d.folders.push(folder);
        return folder;
      });
    },

    renameFolder(id, name) {
      return update((d) => {
        const f = d.folders.find((x) => x.id === id);
        if (f && name.trim()) f.name = name.trim();
      });
    },

    toggleFolder(id) {
      return update((d) => {
        const f = d.folders.find((x) => x.id === id);
        if (f) f.collapsed = !f.collapsed;
      });
    },

    // Deletes a folder. Its channels are deleted too, or (by default) moved to Unsorted.
    deleteFolder(id, { withChannels = false } = {}) {
      if (id === UNSORTED) return Promise.resolve();
      return update((d) => {
        d.folders = d.folders.filter((f) => f.id !== id);
        if (withChannels) d.channels = d.channels.filter((c) => c.folderId !== id);
        else d.channels.forEach((c) => {
          if (c.folderId === id) c.folderId = UNSORTED;
        });
      });
    },

    moveFolder(id, beforeId) {
      return update((d) => {
        const i = d.folders.findIndex((f) => f.id === id);
        if (i < 0) return;
        const [f] = d.folders.splice(i, 1);
        const j = beforeId ? d.folders.findIndex((x) => x.id === beforeId) : -1;
        d.folders.splice(j < 0 ? d.folders.length : j, 0, f);
      });
    },

    // Adds a channel, or moves it if it is already saved.
    saveChannel(channel, folderId) {
      return update((d) => {
        if (!d.folders.some((f) => f.id === folderId)) folderId = UNSORTED;
        const existing = d.channels.find((c) => c.id === channel.id);
        if (existing) {
          existing.folderId = folderId;
          if (channel.name) existing.name = channel.name;
          if (channel.avatar) existing.avatar = channel.avatar;
        } else {
          d.channels.push({ ...channel, folderId, addedAt: Date.now() });
        }
      });
    },

    removeChannel(id) {
      return update((d) => {
        d.channels = d.channels.filter((c) => c.id !== id);
      });
    },

    // Moves a channel into a folder, optionally placing it before another channel.
    moveChannel(id, folderId, beforeId) {
      return update((d) => {
        const i = d.channels.findIndex((c) => c.id === id);
        if (i < 0) return;
        const [c] = d.channels.splice(i, 1);
        c.folderId = folderId;
        const j = beforeId ? d.channels.findIndex((x) => x.id === beforeId) : -1;
        d.channels.splice(j < 0 ? d.channels.length : j, 0, c);
      });
    },

    replaceAll(data) {
      return save({ folders: data.folders || [], channels: data.channels || [] });
    },
  };
})();
