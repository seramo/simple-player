'use strict';

const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|ogv|ogg|avi|3gp|ts|mts|m2ts|mpe?g|wmv|flv|mp3|m4a|aac|wav|flac|opus|oga)$/i;
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

const PLAYER_JS = 'assets/vendor/movi/movi-player.js?v=0.4.1';

const $ = (s) => document.querySelector(s);
const player = $('#player'); // <movi-player>, defined once PLAYER_JS has loaded

// a few MB: fetched after the page has loaded, or right away if a video is opened first
let playerRequested = false;
function loadPlayer() {
  if (playerRequested) return;
  playerRequested = true;
  const s = document.createElement('script');
  s.type = 'module';
  s.src = PLAYER_JS;
  s.onerror = () => {
    playerRequested = false;
    $('#loading').classList.remove('visible');
    toast('The player could not load. Check your connection.');
  };
  document.head.append(s);
}
if (document.readyState === 'complete') loadPlayer();
else addEventListener('load', loadPlayer);

const state = {
  list: [],
  index: -1,
};

const current = () => state.list[state.index];

// ---------- helpers ----------

const baseName = (name) => name.replace(/\.[^.]+$/, '').toLowerCase();
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
  state.list = items;
  // the player draws Next / Previous and owns Shift+N / Shift+P; we load each item ourselves.
  // Waits for the element: a property set before it upgrades would hide its setter.
  customElements.whenDefined('movi-player').then(() => {
    player.playlist = items.length > 1 ? items.map((it) => ({ title: it.name })) : [];
  });
  play(0);
}

function openFiles(files) {
  files = [...files];
  const subs = files.filter((f) => SUB_EXT.test(f.name));
  const videos = files
    .filter((f) => !SUB_EXT.test(f.name) && (VIDEO_EXT.test(f.name) || /^(video|audio)\//.test(f.type)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

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
  $('#stage').classList.add('on');
  render();

  // the player bundle may still be downloading if the file was picked right away
  const ready = !!customElements.get('movi-player');
  const undo = preparing(ready ? 'Opening your video' : 'Loading the player');
  // no await when ready: play() must stay inside the click, or the browser blocks autoplay
  if (!ready) {
    loadPlayer();
    await customElements.whenDefined('movi-player');
    if (current() !== item) return undo();
  }

  if (item.file) player.setFile ? player.setFile(item.file) : (player.src = item.file);
  else player.src = item.url;
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
  const events = ['loadeddata', 'canplay', 'error'];
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
  player.addSubtitleFile(file);
  toast('Subtitles added: ' + baseName(file.name));
}

// ---------- playlist ----------

function render() {
  const { list, index } = state;
  const item = current();
  $('#now').textContent = list.length > 1 ? `${index + 1}/${list.length} - ${item.name}` : item.name;
  document.title = item.name + ' - Simple Player';
  $('#bar').hidden = false;

  const playlist = $('#playlist');
  playlist.hidden = list.length < 2;
  playlist.replaceChildren(...list.map((it, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const span = document.createElement('span');
    li.className = i === index ? 'on' : '';
    b.type = 'button';
    b.onclick = () => play(i);
    span.textContent = it.name;
    b.append(span);
    li.append(b);
    return li;
  }));
}

// ---------- player events ----------

customElements.whenDefined('movi-player').then(() => {
  player.addControl({
    id: 'open',
    label: 'Open files',
    icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
    placement: 'top',
    onSelect: () => $('#fileInput').click(),
  });
});

// Next / Previous in the bar: the player only asks, we load the item
player.addEventListener('itemchange', (e) => {
  e.preventDefault();
  play(e.detail.index);
});

player.addEventListener('ended', () => {
  if (!player.loop && state.index < state.list.length - 1) play(state.index + 1);
});

player.addEventListener('error', () => { if (current()) showError(); });

// ---------- page inputs ----------

$('#openBtn').onclick = () => $('#fileInput').click();
$('#folderBtn').onclick = () => $('#folderInput').click();
$('#urlForm').onsubmit = (e) => { e.preventDefault(); openUrl($('#urlInput').value); };

for (const id of ['#fileInput', '#folderInput']) {
  $(id).onchange = (e) => { openFiles(e.target.files); e.target.value = ''; };
}

// drag and drop anywhere, folders included
let dragDepth = 0;
const endDrag = () => { dragDepth = 0; document.body.classList.remove('dragging'); };

addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
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
    if (entry.isFile) return out.push(await new Promise((res, rej) => entry.file(res, rej)));
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
  if (e.key.toLowerCase() === 'o') $('#fileInput').click();
});
