'use strict';

const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|ogv|ogg|avi|3gp|ts|mts|m2ts|mpe?g|wmv|flv|mp3|m4a|aac|wav|flac|opus|oga)$/i;
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

const $ = (s) => document.querySelector(s);
const player = $('#player');
const MOVI_MODULE = '../vendor/movi/movi-player.js?v=0.4.2';
let moviPromise;
let moviRetries = 0;

function loadMovi() {
  if (!moviPromise) {
    // Browsers can cache a failed module fetch for the document. Use a fresh URL on retry.
    const url = moviRetries ? MOVI_MODULE + '&retry=' + moviRetries : MOVI_MODULE;
    moviPromise = import(url).then((Movi) => {
      setupPlayer();
      return Movi;
    }, (error) => {
      moviRetries++;
      moviPromise = undefined;
      throw error;
    });
  }
  return moviPromise;
}

function warmUpPlayer() {
  loadMovi().catch(() => {}); // Playback will retry and show any error to the user.
}

const state = {
  list: [],
  index: -1,
  shuffle: false,
  repeat: 'off', // off | all | one
};

const current = () => state.list[state.index];

// ---------- helpers ----------

const baseName = (name) => name.replace(/\.[^.]+$/, '').toLowerCase();
const pathOf = (f) => f.webkitRelativePath || f.name;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
// folders first at every depth, then files, like a file explorer; playback follows the same order
function treeOrder(a, b) {
  const pa = pathOf(a).split('/');
  const pb = pathOf(b).split('/');
  for (let i = 0; ; i++) {
    if (i >= pa.length || i >= pb.length) return pa.length - pb.length;
    const dirA = i < pa.length - 1;
    const dirB = i < pb.length - 1;
    if (dirA !== dirB) return dirA ? -1 : 1;
    const c = natural(pa[i], pb[i]);
    if (c) return c;
  }
}
const clock = (s) => new Date(s * 1000).toISOString().slice(s >= 3600 ? 11 : 14, 19);
const quality = (h) => (h >= 2160 ? '4K' : h ? Math.min(h, 1440) + 'p' : '');
const isTyping = (el) => el.closest?.('input, textarea, select');

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------- sources ----------

function setList(items) {
  state.list.forEach((it) => it.thumb && URL.revokeObjectURL(it.thumb));
  state.list = items;
  buildPlaylist();
  if (customElements.get('movi-player')) setPlayerPlaylist();
  play(0);
}

function setPlayerPlaylist() {
  // The player draws Next / Previous and owns Shift+N / Shift+P.
  const { list } = state;
  player.playlist = list.length > 1 ? list.map((it) => ({ title: it.name })) : [];
}

function openFiles(files) {
  files = [...files];
  const subs = files.filter((f) => SUB_EXT.test(f.name));
  const videos = files
    .filter((f) => !SUB_EXT.test(f.name) && (VIDEO_EXT.test(f.name) || /^(video|audio)\//.test(f.type)))
    .sort(treeOrder);

  if (!videos.length) {
    if (subs.length && current()) subs.forEach(addSub);
    else toast(subs.length ? 'Open a video first, then add subtitles.' : 'No video files found.');
    return;
  }

  const items = videos.map((f) => ({
    name: f.name,
    file: f,
    subs: subs.filter((s) => baseName(s.name).startsWith(baseName(f.name))),
  }));
  if (items.length === 1 && !items[0].subs.length) items[0].subs = subs;
  setList(items);
}

function openUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { return toast("That doesn't look like a link."); }
  if (!/^https?:$/.test(url.protocol)) return toast('Use an http or https link.');
  const name = decodeURIComponent(url.pathname.split('/').pop()) || url.hostname;
  setList([{ name, url: url.href, subs: [] }]);
}

// ---------- playback ----------

async function play(i) {
  const item = state.list[i];
  if (!item) return;
  state.index = i;
  $('#msg').hidden = true;
  $('#closeBtn').hidden = true;
  $('#stage').classList.add('on');
  showCurrent();

  const ready = !!customElements.get('movi-player');
  const undo = preparing(ready ? 'Opening your video' : 'Loading the player');
  // no await when ready: play() must stay inside the click, or the browser blocks autoplay
  if (!ready) {
    try {
      await loadMovi();
    } catch {
      if (current() !== item) return;
      undo();
      $('#msg').innerHTML = "<p><b>The player couldn't load.</b>Close this video and try again.</p>";
      $('#msg').hidden = false;
      $('#closeBtn').hidden = false;
      return;
    }
    if (current() !== item) return;
    setPlayerPlaylist();
  }

  if (item.file) player.setFile ? player.setFile(item.file) : (player.src = item.file);
  else player.src = item.url;
  player.loop = state.repeat === 'one';
  // after the source: a src the element didn't write itself resets the index
  if (state.list.length > 1) player.playlistIndex = i;
  item.subs.forEach((f) => player.addSubtitleFile(f));
  clearWhenReady(undo);
  player.play()?.catch(() => {});
}

// "Preparing" sweep over the stage while the player or the file loads
function preparing(text) {
  const el = $('#loading');
  el.querySelector('span').textContent = text;
  el.classList.add('visible');
  return () => el.classList.remove('visible');
}

function clearWhenReady(undo) {
  // playing / timeupdate too: the player can start before it sends loadeddata
  const events = ['loadeddata', 'canplay', 'playing', 'timeupdate', 'error'];
  const finish = () => {
    clearTimeout(timer);
    events.forEach((t) => player.removeEventListener(t, finish));
    undo();
  };
  events.forEach((t) => player.addEventListener(t, finish));
  const timer = setTimeout(finish, 12000);
}

function showError() {
  if (current()?.file) return; // the player shows its own message for local files
  $('#msg').innerHTML = "<p><b>This link didn't play.</b>It may be blocked by the site, need a login, or not be a direct video link.</p>";
  $('#msg').hidden = false;
}

function addSub(file) {
  current().subs.push(file);
  if (customElements.get('movi-player')) player.addSubtitleFile(file);
  toast('Subtitles added: ' + baseName(file.name));
}

// ---------- playlist ----------

function showCurrent() {
  const { list, index } = state;
  const item = current();
  $('#now').textContent = list.length > 1 ? `${index + 1}/${list.length} - ${item.name}` : item.name;
  document.title = item.name + ' - Simple Player';
  $('#bar').hidden = false;

  const on = $('#playlist .on');
  on?.classList.remove('on');
  const li = $(`#playlist li[data-i="${index}"]`);
  if (!li) return;
  li.classList.add('on');
  // open the folders it sits in
  for (let f = li.parentElement.closest('.folder'); f; f = f.parentElement.closest('.folder')) {
    f.firstElementChild.setAttribute('aria-expanded', true);
  }
  // scroll inside the list only, never the page (the list is the offsetParent)
  const box = $('#playlist');
  const top = li.offsetTop;
  if (top < box.scrollTop || top + li.offsetHeight > box.scrollTop + box.clientHeight) {
    box.scrollTo({ top: top - box.clientHeight / 2 + li.offsetHeight / 2, behavior: 'smooth' });
  }
}

function buildPlaylist() {
  const { list } = state;
  $('#plist').hidden = list.length < 2;
  if (list.length < 2) return;

  // folders of each item; the opened folder itself is dropped, the header shows its name
  const dirs = list.map((it) => pathOf(it.file || it).split('/').slice(0, -1));
  const top = dirs[0][0];
  const shared = top && dirs.every((d) => d[0] === top);
  $('#plistTitle').textContent = shared ? top : 'Playlist';
  $('#plistCount').textContent = list.length;
  $('#plistSearch').value = '';
  $('#playlist').classList.remove('searching');

  // items arrive in tree order, so a stack of open folders is enough to nest them
  const root = document.createElement('ol');
  const open = [];
  const folders = [];
  list.forEach((it, i) => {
    const path = dirs[i].slice(shared ? 1 : 0);
    let k = 0;
    while (k < open.length && k < path.length && open[k].name === path[k]) k++;
    open.length = k;
    for (; k < path.length; k++) {
      const li = document.createElement('li');
      li.className = 'folder';
      li.innerHTML = `<button type="button" class="folder-row" aria-expanded="true">
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>
        <svg class="ficon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>
        <span class="fname"></span><span class="count"></span></button><ol class="children"></ol>`;
      li.querySelector('.fname').textContent = path[k];
      const row = li.firstElementChild;
      row.onclick = () => row.setAttribute('aria-expanded', row.getAttribute('aria-expanded') !== 'true');
      (open.at(-1)?.ol || root).append(li);
      const f = { name: path[k], ol: li.lastElementChild, count: li.querySelector('.count'), n: 0 };
      open.push(f);
      folders.push(f);
    }
    open.forEach((f) => f.n++);

    const li = document.createElement('li');
    li.dataset.i = i;
    li.innerHTML = `<button type="button"><span class="thumb"><img alt="" hidden><span class="n">${i + 1}</span><span class="dur"></span></span>
      <span class="info"><span class="name"></span><span class="meta"></span></span></button>`;
    li.querySelector('.name').textContent = it.name.replace(/\.[^.]+$/, '');
    li.querySelector('button').onclick = () => play(i);
    (open.at(-1)?.ol || root).append(li);
  });
  folders.forEach((f) => { f.count.textContent = f.n; });
  $('#playlist').replaceChildren(...root.children);
  makeThumbs(list);
}

function drawMeta(i) {
  const it = state.list[i];
  const li = $(`#playlist li[data-i="${i}"]`);
  if (!li || state.list !== it.list) return;
  if (it.duration) li.querySelector('.dur').textContent = clock(Math.round(it.duration));
  li.querySelector('.meta').textContent = [quality(it.height), it.file.name.split('.').pop().toUpperCase()].filter(Boolean).join(' · ');
  if (it.thumb) {
    const img = li.querySelector('img');
    img.src = it.thumb;
    img.hidden = false;
  }
}

// thumbnails and duration, one file at a time, with the player's own decoder (so MKV and HEVC work too)
let thumbWasm;
async function makeThumbs(list) {
  let Movi;
  try {
    Movi = await loadMovi();
    thumbWasm ??= Movi.loadWasmModuleNew();
    await thumbWasm;
  } catch { return; }
  for (const [i, it] of list.entries()) {
    if (state.list !== list) return; // a new list was opened
    it.list = list;
    try { await thumbOf(Movi, it); } catch {}
    drawMeta(i);
  }
}

async function thumbOf(Movi, it) {
  const b = new Movi.ThumbnailBindings(await thumbWasm);
  try {
    b.setDataSource(new Movi.FileSource(it.file));
    await b.create(it.file.size);
    if (!(await b.open())) return;
    const { width: w, height: h, duration } = b.getStreamInfo() || {};
    Object.assign(it, { duration, height: h });
    // shortcut: rotated (portrait phone) videos get a sideways thumbnail, read the track rotation if users notice
    if (!w || !h || !duration || !((await b.readKeyframe(duration * 0.1)) > 0)) return;
    const rgba = b.decodeCurrentPacket(w, h);
    if (!rgba) return;
    const full = document.createElement('canvas');
    full.width = w;
    full.height = h;
    full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
    const out = document.createElement('canvas');
    out.width = 320;
    out.height = 180;
    const s = Math.min(320 / w, 180 / h);
    out.getContext('2d').drawImage(full, (320 - w * s) / 2, (180 - h * s) / 2, w * s, h * s);
    const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.75));
    if (blob) it.thumb = URL.createObjectURL(blob);
  } finally {
    b.destroy?.();
  }
}

// next or previous item, following shuffle and repeat; -1 when there is none
function step(dir) {
  const n = state.list.length;
  if (state.shuffle && dir > 0 && n > 1) {
    let i;
    do i = Math.floor(Math.random() * n); while (i === state.index);
    return i;
  }
  const i = state.index + dir;
  if (i >= 0 && i < n) return i;
  return state.repeat === 'all' ? (i + n) % n : -1;
}

function setRepeat(mode) {
  state.repeat = mode;
  // only once defined: a property set before the element upgrades would hide its setter
  if (customElements.get('movi-player')) player.loop = mode === 'one';
  const b = $('#repeatBtn');
  b.dataset.mode = mode;
  b.setAttribute('aria-pressed', mode !== 'off');
  b.title = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this video' }[mode];
}

$('#shuffleBtn').onclick = (e) => {
  state.shuffle = !state.shuffle;
  e.currentTarget.setAttribute('aria-pressed', state.shuffle);
};
$('#repeatBtn').onclick = () => setRepeat({ off: 'all', all: 'one', one: 'off' }[state.repeat]);

$('#plistToggle').onclick = (e) => {
  const open = $('#plistBody').hidden;
  $('#plistBody').hidden = !open;
  e.currentTarget.setAttribute('aria-expanded', open);
  e.currentTarget.title = open ? 'Hide list' : 'Show list';
};

$('#plistSearch').oninput = (e) => {
  const q = e.target.value.trim().toLowerCase();
  // while searching, folders flatten out and only matching files show
  $('#playlist').classList.toggle('searching', !!q);
  for (const li of $('#playlist').querySelectorAll('li[data-i]')) {
    li.hidden = !!q && !state.list[li.dataset.i].name.toLowerCase().includes(q);
  }
};

// ---------- player events ----------

function setupPlayer() {
  // the page has its own empty screen; the player's "Nothing to Play" only flashes before a file loads
  const hideEmpty = document.createElement('style');
  hideEmpty.textContent = '.movi-empty-state{display:none!important}';
  player.shadowRoot?.append(hideEmpty);
  player.addControl({
    id: 'close',
    label: 'Close video',
    icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
    placement: 'top',
    onSelect: closeVideo,
  });
}

// back to the page as first loaded, so a new file, folder or link can be picked
const startTitle = document.title;
function closeVideo() {
  if (document.fullscreenElement) document.exitFullscreen();
  setList([]);
  if (customElements.get('movi-player')) player.src = null; // saves the resume point
  $('#stage').classList.remove('on');
  $('#bar').hidden = true;
  $('#msg').hidden = true;
  $('#closeBtn').hidden = true;
  $('#loading').classList.remove('visible');
  $('#urlInput').value = '';
  document.title = startTitle;
}

// Next / Previous in the bar: the player only asks, we pick the item (shuffle, repeat) and load it
player.addEventListener('itemchange', (e) => {
  e.preventDefault();
  const i = step(e.detail.index < state.index ? -1 : 1);
  if (i >= 0) play(i);
});

player.addEventListener('ended', () => {
  if (!$('#autoplay').checked) return;
  const i = step(1);
  if (i >= 0) play(i);
});

// L on the player toggles its loop: keep the repeat button in step
player.addEventListener('loopchange', () => {
  if (player.loop !== (state.repeat === 'one')) setRepeat(player.loop ? 'one' : 'off');
});

player.addEventListener('error', () => {
  if (!current()) return;
  $('#closeBtn').hidden = false;
  showError();
});

// ---------- page inputs ----------

function pickFiles(input) {
  $(input).click();
  warmUpPlayer();
}

$('#openBtn').onclick = () => pickFiles('#fileInput');
$('#closeBtn').onclick = closeVideo;
$('#folderBtn').onclick = () => pickFiles('#folderInput');
$('#urlInput').addEventListener('focus', warmUpPlayer);
$('#urlForm').onsubmit = (e) => { e.preventDefault(); openUrl($('#urlInput').value); };

for (const id of ['#fileInput', '#folderInput']) {
  $(id).onchange = (e) => { openFiles(e.target.files); e.target.value = ''; };
}

// drag and drop anywhere, folders included
let dragDepth = 0;
const endDrag = () => { dragDepth = 0; document.body.classList.remove('dragging'); };

addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  if (!dragDepth) warmUpPlayer();
  dragDepth++;
  document.body.classList.add('dragging');
});
addEventListener('dragleave', () => { if (--dragDepth <= 0) endDrag(); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  endDrag();
  // grab entries synchronously, the DataTransfer is emptied after the first await
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = entries.length ? await readEntries(entries) : [...e.dataTransfer.files];
  if (files.length) openFiles(files);
});

async function readEntries(entries) {
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      // keep the folder path, like a folder picked with the button
      try { Object.defineProperty(f, 'webkitRelativePath', { value: entry.fullPath.slice(1) }); } catch {}
      return out.push(f);
    }
    const reader = entry.createReader();
    for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length;) {
      for (const child of batch) await walk(child);
    }
  };
  await Promise.all(entries.map(walk));
  return out;
}

// paste a link or a file anywhere on the page
addEventListener('paste', (e) => {
  if (isTyping(e.target)) return;
  if (e.clipboardData.files.length) return openFiles(e.clipboardData.files);
  const text = e.clipboardData.getData('text');
  if (/^\s*https?:\/\//i.test(text)) openUrl(text);
});

// every other shortcut belongs to the player (press ? on it to see them)
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
  if (e.key.toLowerCase() === 'o') pickFiles('#fileInput');
});
