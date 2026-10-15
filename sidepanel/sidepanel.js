const $ = (sel) => document.querySelector(sel);
const foldersEl = $('#folders');

let data = { folders: [], channels: [] };
let query = '';
let editing = false; // pause re-renders while a folder is being renamed
let drag = null; // { kind: 'channel' | 'folder', id }

// ---------- Rendering ----------

function render() {
  if (editing) return;
  const q = query.toLowerCase();
  const matches = (c) => !q || c.name.toLowerCase().includes(q);
  $('#total').textContent = `${data.channels.length} channel${data.channels.length === 1 ? '' : 's'}`;

  foldersEl.replaceChildren(
    ...data.folders
      .map((folder) => {
        const channels = data.channels.filter((c) => c.folderId === folder.id);
        const shown = channels.filter(matches);
        if (q && !shown.length) return null;
        return folderEl(folder, channels.length, shown, !!q);
      })
      .filter(Boolean)
  );

  if (q && !foldersEl.children.length) {
    foldersEl.innerHTML = '<div class="empty">No channels match.</div>';
  }
}

function folderEl(folder, total, channels, forceOpen) {
  const el = document.createElement('section');
  el.className = 'folder' + (folder.collapsed && !forceOpen ? ' collapsed' : '');
  el.dataset.folderId = folder.id;

  const head = document.createElement('div');
  head.className = 'folder-head';
  head.draggable = folder.id !== TVStore.UNSORTED;
  head.innerHTML = `
    <span class="caret">▼</span>
    <span class="folder-icon">${folder.id === TVStore.UNSORTED ? '📥' : '📁'}</span>
    <span class="folder-name"></span>
    ${folder.id === TVStore.UNSORTED ? '' : '<button class="icon-btn rename" title="Rename">✎</button><button class="icon-btn delete" title="Delete folder">🗑</button>'}
    <span class="count">${total}</span>`;
  head.querySelector('.folder-name').textContent = folder.name;

  head.addEventListener('click', (e) => {
    if (e.target.closest('.icon-btn, input')) return;
    TVStore.toggleFolder(folder.id);
  });
  head.querySelector('.rename')?.addEventListener('click', () => startRename(head, folder));
  head.querySelector('.folder-name').addEventListener('dblclick', (e) => {
    if (folder.id === TVStore.UNSORTED) return;
    e.stopPropagation();
    startRename(head, folder);
  });
  head.querySelector('.delete')?.addEventListener('click', () => {
    const msg = total
      ? `Delete "${folder.name}"? Its ${total} channel${total === 1 ? '' : 's'} will move to Unsorted.`
      : `Delete "${folder.name}"?`;
    if (confirm(msg)) TVStore.deleteFolder(folder.id);
  });

  head.addEventListener('dragstart', (e) => {
    drag = { kind: 'folder', id: folder.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', folder.name);
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  head.addEventListener('dragend', endDrag);

  const list = document.createElement('div');
  list.className = 'channels';
  if (channels.length) list.append(...channels.map(channelEl));
  else list.innerHTML = '<div class="empty">Drag channels here</div>';

  el.append(head, list);

  // Drop zone for both channels (into this folder) and folders (reorder).
  el.addEventListener('dragover', (e) => {
    if (!drag) return;
    if (drag.kind === 'folder' && (drag.id === folder.id || folder.id === TVStore.UNSORTED)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearIndicators();
    el.classList.add('drop-target');
    if (drag.kind === 'channel') {
      const row = e.target.closest('.channel');
      if (row && row.dataset.channelId !== drag.id) row.classList.add('insert-before');
    }
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!drag) return;
    if (drag.kind === 'channel') {
      const row = e.target.closest('.channel');
      const beforeId = row && row.dataset.channelId !== drag.id ? row.dataset.channelId : null;
      TVStore.moveChannel(drag.id, folder.id, beforeId);
    } else {
      // Top half of a folder: drop before it. Bottom half: drop after it.
      const rect = el.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      const idx = data.folders.findIndex((f) => f.id === folder.id);
      const beforeId = after ? data.folders[idx + 1]?.id ?? null : folder.id;
      if (beforeId !== drag.id) TVStore.moveFolder(drag.id, beforeId);
    }
    endDrag();
  });

  return el;
}

function channelEl(ch) {
  const row = document.createElement('div');
  row.className = 'channel';
  row.draggable = true;
  row.dataset.channelId = ch.id;
  row.title = ch.url;

  const avatar = ch.avatar ? document.createElement('img') : document.createElement('div');
  avatar.className = 'avatar';
  const initial = () => (ch.name || '?').trim().charAt(0).toUpperCase();
  if (ch.avatar) {
    avatar.src = ch.avatar;
    avatar.alt = '';
    avatar.referrerPolicy = 'no-referrer';
    avatar.addEventListener('error', () => {
      const fallback = document.createElement('div');
      fallback.className = 'avatar';
      fallback.textContent = initial();
      avatar.replaceWith(fallback);
    });
  } else {
    avatar.textContent = initial();
  }

  const name = document.createElement('span');
  name.className = 'channel-name';
  name.textContent = ch.name;

  const remove = document.createElement('button');
  remove.className = 'icon-btn';
  remove.title = 'Remove channel';
  remove.textContent = '✕';
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    TVStore.removeChannel(ch.id);
  });

  row.append(avatar, name, remove);

  // Click: open in this tab. Cmd/Ctrl-click or middle-click: new background tab.
  row.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) chrome.tabs.create({ url: ch.url, active: false });
    else chrome.tabs.update({ url: ch.url });
  });
  row.addEventListener('auxclick', (e) => {
    if (e.button === 1) chrome.tabs.create({ url: ch.url, active: false });
  });

  row.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    drag = { kind: 'channel', id: ch.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/uri-list', ch.url);
    e.dataTransfer.setData('text/plain', ch.url);
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  row.addEventListener('dragend', endDrag);

  return row;
}

function clearIndicators() {
  document.querySelectorAll('.drop-target, .insert-before').forEach((el) => el.classList.remove('drop-target', 'insert-before'));
}

function endDrag() {
  drag = null;
  clearIndicators();
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
}

function startRename(head, folder) {
  editing = true;
  const nameEl = head.querySelector('.folder-name');
  const input = document.createElement('input');
  input.value = folder.name;
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  const finish = async (commit) => {
    if (!editing) return;
    editing = false;
    if (commit) await TVStore.renameFolder(folder.id, input.value);
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------- Header actions ----------

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// Layout: list, grid (wrapping cards) or icons (compact avatars). Remembered per browser.
function setView(view) {
  if (!['list', 'grid', 'icons'].includes(view)) view = 'list';
  document.body.classList.remove('view-list', 'view-grid', 'view-icons');
  document.body.classList.add(`view-${view}`);
  document.querySelectorAll('.view-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  try {
    localStorage.setItem('tubevault:view', view);
  } catch {}
}
let savedView = 'list';
try {
  savedView = localStorage.getItem('tubevault:view') || 'list';
} catch {}
setView(savedView);
document.querySelectorAll('.view-switch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

$('#search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  render();
});

$('#new-folder').addEventListener('click', () => {
  const form = $('#folder-form');
  form.hidden = !form.hidden;
  if (!form.hidden) $('#folder-name').focus();
});

$('#folder-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#folder-name').value.trim();
  if (!name) return;
  await TVStore.addFolder(name);
  $('#folder-name').value = '';
  $('#folder-form').hidden = true;
});

$('#add-current').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let channel = null;
  try {
    channel = await chrome.tabs.sendMessage(tab.id, { type: 'tubevault:getChannel' });
  } catch {
    // No content script on this tab (not YouTube, or YouTube tab opened before install).
  }
  if (!channel) {
    toast('Open a YouTube channel, video or Short first (refresh the tab if you just installed TubeVault).');
    return;
  }
  const existing = data.channels.find((c) => c.id === channel.id);
  if (existing) {
    const folder = data.folders.find((f) => f.id === existing.folderId);
    toast(`${channel.name} is already in "${folder?.name}".`);
    return;
  }
  await TVStore.saveChannel(channel, TVStore.UNSORTED);
  toast(`Added ${channel.name} to Unsorted — drag it into a folder.`);
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tubevault-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.folders) || !Array.isArray(imported.channels)) throw new Error('bad file');
    if (confirm(`Replace your current vault with ${imported.channels.length} channels from this backup?`)) {
      await TVStore.replaceAll(imported);
      toast('Backup imported.');
    }
  } catch {
    toast("That file isn't a TubeVault backup.");
  }
});

// ---------- Boot ----------

TVStore.load().then((d) => {
  data = d;
  render();
});
TVStore.onChange((d) => {
  data = d;
  render();
});
