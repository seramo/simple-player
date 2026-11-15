'use strict';

const VENDOR = 'assets/vendor/';
const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|ogv|ogg|avi|3gp|ts|mpe?g|wmv|flv|mp3|m4a|aac|wav|flac|opus|oga)$/i;
const SUB_EXT = /\.(srt|vtt)$/i;
const MAX_VOL = 3;
// movi-player 0.4.1 (FFmpeg WASM), self-hosted with its Google Fonts @import removed
const PRO_ENGINE = VENDOR + 'movi/movi-player.js?v=0.4.1';
const PRO_SIZE = '3.5 MB';

const $ = (s) => document.querySelector(s);

const player = new Plyr('#video', {
  iconUrl: VENDOR + 'plyr.svg?v=3.7.8',
  blankVideo: VENDOR + 'blank.mp4?v=3.7.8',
  // no 'volume': our own slider replaces it, see injectControls
  controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'],
  settings: ['captions', 'speed'],
  speed: { selected: 1, options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] },
  keyboard: { focused: true, global: true },
  tooltips: { controls: true, seek: true },
  captions: { active: true, update: true },
  seekTime: 5,
  ratio: '16:9',
});

const state = {
  list: [],
  index: -1,
  loop: false,
  vol: 1, // 0..3, anything above 1 is Web Audio gain on top of full media volume
  hls: null,
  pro: null, // <movi-player> element while the Pro engine is in use
};

const audio = { ctx: null, gain: null, hooked: new WeakSet() };

const current = () => state.list[state.index];

// ---------- helpers ----------

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

const baseName = (name) => name.replace(/\.[^.]+$/, '').toLowerCase();
const clock = (s) => new Date(s * 1000).toISOString().slice(s >= 3600 ? 11 : 14, 19);
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
  state.list.forEach((it) => it.local && URL.revokeObjectURL(it.url));
  state.list = items;
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
    size: f.size,
    url: URL.createObjectURL(f),
    file: f,
    local: true,
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
  setList([{ name, url: url.href, local: false, subs: [] }]);
}

// ---------- playback ----------

function play(i) {
  const item = state.list[i];
  if (!item) return;
  state.index = i;
  $('#msg').hidden = true;
  state.hls?.destroy();
  state.hls = null;
  stopPro();

  const isHls = /\.m3u8($|\?)/i.test(item.url);
  // Plyr rebuilds the <video> element on every source change
  player.source = { type: 'video', title: item.name, sources: isHls ? [] : [{ src: item.url }] };
  const media = player.media;
  // a failing <source> child fires error on itself, not on <video>
  media.querySelector('source')?.addEventListener('error', showError);
  if (isHls) loadHls(media, item.url);

  player.loop = state.loop;
  item.subs.forEach((f) => addTrack(f, false));
  setVol(state.vol);

  $('#empty').hidden = true;
  $('#videoWrap').hidden = false;
  $('#bar').hidden = false;
  render();
  player.play()?.catch(() => {});
}

function loadHls(media, url) {
  if (media.canPlayType('application/vnd.apple.mpegurl')) {
    media.src = url;
    return;
  }
  const start = () => {
    if (!window.Hls?.isSupported()) { media.src = url; return; }
    state.hls = new Hls();
    state.hls.on(Hls.Events.ERROR, (_, d) => d.fatal && showError());
    state.hls.loadSource(url);
    state.hls.attachMedia(media);
    media.play().catch(() => {});
  };
  if (window.Hls) return start();
  const script = document.createElement('script');
  script.src = VENDOR + 'hls.min.js?v=1.5.17';
  script.onload = start;
  script.onerror = () => toast('Could not load the stream player.');
  document.head.append(script);
}

function showError() {
  if (state.pro) return;
  const msg = $('#msg');
  if (current()?.local) {
    msg.innerHTML = `<p><b>Your browser can't play this file.</b>It uses a codec your browser doesn't support, like HEVC, AC3 or DTS.
      <button type="button" class="pro-btn">Play with Pro engine</button><small>Downloads a ${PRO_SIZE} decoder once.</small></p>`;
    msg.querySelector('button').onclick = playPro;
  } else {
    msg.innerHTML = "<p><b>This link didn't play.</b>It may be blocked by the site, need a login, or not be a direct video link.</p>";
  }
  msg.hidden = false;
}

// ---------- Pro engine (decodes in the page with FFmpeg WASM, for files the browser can't play) ----------

async function playPro() {
  const item = current();
  if (!item?.file || state.pro) return;
  const msg = $('#msg');
  msg.innerHTML = `<p><b>Loading Pro engine...</b>${PRO_SIZE}, only the first time.</p>`;
  msg.hidden = false;
  player.pause();
  try {
    await import(new URL(PRO_ENGINE, document.baseURI).href);
  } catch {
    msg.innerHTML = '<p><b>The Pro engine could not load.</b>Check your connection and try again.</p>';
    return;
  }
  if (current() !== item) return; // user switched video while it loaded

  const el = document.createElement('movi-player');
  el.className = 'pro';
  el.setAttribute('controls', '');
  el.setAttribute('sw', 'auto'); // fall back to software decoding without asking
  el.setAttribute('themecolor', getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  el.addEventListener('ended', () => { if (!state.loop) play(state.index + 1); });
  $('#stage').append(el);
  el.src = item.file;
  state.pro = el;

  msg.hidden = true;
  $('#videoWrap').hidden = true;
  $('#stage').classList.add('pro-on');
  render();
  el.play?.()?.catch?.(() => {});
}

function stopPro() {
  if (!state.pro) return;
  state.pro.pause?.();
  state.pro.remove();
  state.pro = null;
  $('#stage').classList.remove('pro-on');
  $('#videoWrap').hidden = false;
}

function setLoop(on) {
  state.loop = on;
  player.loop = on;
  $('#videoWrap').classList.toggle('looping', on);
}

// ---------- subtitles ----------

async function toVtt(file) {
  if (file.vtt) return file.vtt;
  const buf = await file.arrayBuffer();
  let text;
  // shortcut: non-UTF-8 files fall back to Windows-1252, add an encoding picker if users need Arabic/Cyrillic legacy files
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/^WEBVTT/.test(text)) text = 'WEBVTT\n\n' + text.replace(/(\d{1,2}:\d\d:\d\d),(\d{3})/g, '$1.$2');
  file.vtt = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
  return file.vtt;
}

async function addTrack(file, announce) {
  const media = player.media;
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = baseName(file.name);
  track.srclang = (file.name.match(/[._-]([a-z]{2})\.(srt|vtt)$/i) || [])[1] || 'und';
  track.src = await toVtt(file);
  if (media !== player.media) return; // video changed while reading
  media.append(track);
  // wait for Plyr's own addtrack handler to register the track
  setTimeout(() => {
    player.currentTrack = media.textTracks.length - 1;
    player.toggleCaptions(true);
  });
  if (announce) toast('Subtitles added: ' + track.label);
}

function addSub(file) {
  current().subs.push(file);
  addTrack(file, true);
}

// ---------- volume (VLC style, up to 300%) ----------

function applyBoost() {
  const boost = current()?.local ? Math.max(state.vol, 1) : 1;
  if (boost > 1 && !audio.hooked.has(player.media)) {
    audio.ctx ??= new AudioContext();
    if (!audio.gain) {
      audio.gain = audio.ctx.createGain();
      audio.gain.connect(audio.ctx.destination);
    }
    audio.ctx.createMediaElementSource(player.media).connect(audio.gain);
    audio.hooked.add(player.media);
  }
  if (audio.gain) audio.gain.gain.value = boost;
  audio.ctx?.resume();
}

function setVol(v) {
  v = Math.round(Math.min(MAX_VOL, Math.max(0, v)) * 100) / 100;
  // remote media without CORS goes silent through Web Audio, so boost is local-only
  if (v > 1 && current() && !current().local) {
    if (state.vol <= 1) toast('Volume above 100% works with files from your device.');
    v = 1;
  }
  state.vol = v;
  player.volume = Math.min(v, 1);
  applyBoost();
  drawVol();
}

function drawVol() {
  const el = player.elements.controls?.querySelector('.sp-vol');
  if (!el) return;
  const pct = Math.round(state.vol * 100);
  const input = el.querySelector('input');
  el.style.setProperty('--p', (state.vol / MAX_VOL) * 100 + '%');
  el.classList.toggle('muted', player.muted);
  input.value = pct;
  input.setAttribute('aria-valuetext', pct + '%');
  el.querySelector('output').textContent = pct + '%';
}

// ---------- screenshot ----------

function screenshot() {
  const v = player.media;
  if (!v?.videoWidth) return toast('Nothing to capture yet.');
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0);
  try {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${baseName(current().name)}-${clock(v.currentTime).replace(/:/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Screenshot saved');
    });
  } catch {
    toast("This site doesn't allow screenshots of its video.");
  }
}

// ---------- custom control bar buttons ----------

const ICONS = {
  prev: '<path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>',
  next: '<path d="M6 18l8.5-6L6 6zM16 6v12h2V6z"/>',
  open: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  sub: '<path fill-rule="evenodd" d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm3 8v2h6v-2zm8 0v2h4v-2zm-8-4v2h12v-2z"/>',
  shot: '<path fill-rule="evenodd" d="M9 4 7.5 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2.5L15 4zm3 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/>',
  loop: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/>',
};

function controlButton(name, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'plyr__controls__item plyr__control sp-' + name;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg><span class="plyr__tooltip">${label}</span>`;
  b.onclick = onClick;
  return b;
}

// Plyr rebuilds its control bar on every source change, so this runs on each 'ready'
function injectControls() {
  const bar = player.elements.controls;
  if (!bar || bar.querySelector('.sp-vol')) return;

  bar.querySelector('[data-plyr="play"]').after(
    controlButton('prev', 'Previous (P)', () => play(state.index - 1)),
    controlButton('next', 'Next (N)', () => play(state.index + 1)),
  );

  const volume = bar.querySelector('.plyr__volume');
  volume.insertAdjacentHTML('beforeend',
    '<div class="sp-vol"><span class="sp-tri"></span><input type="range" min="0" max="300" step="5" aria-label="Volume"><output></output></div>');
  volume.querySelector('.sp-vol input').oninput = (e) => {
    player.muted = false;
    setVol(e.target.value / 100);
  };

  bar.querySelector('.plyr__menu').before(
    controlButton('open', 'Open files (O)', () => $('#fileInput').click()),
    controlButton('sub', 'Add subtitles', () => $('#subInput').click()),
    controlButton('shot', 'Screenshot (S)', screenshot),
    controlButton('loop', 'Loop (L)', () => setLoop(!state.loop)),
  );
  drawVol();
}

// ---------- playlist ----------

function render() {
  const { list, index } = state;
  const item = current();
  $('#now').textContent = list.length > 1 ? `${index + 1}/${list.length} - ${item.name}` : item.name;
  document.title = item.name + ' - Simple Player';
  $('#videoWrap').classList.toggle('multi', list.length > 1);
  $('#proBtn').hidden = !item.local || !!state.pro;
  $('#proBtn').classList.remove('nudge');

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

const resumeKey = () => current() && 'sp:' + current().name + ':' + (current().size || '');
let lastSave = 0;

player.on('ready', injectControls);

player.on('volumechange', () => {
  if (player.volume < 1 || state.vol <= 1) state.vol = player.volume;
  applyBoost();
  drawVol();
});

player.on('loadedmetadata', () => {
  // e.g. HEVC in an MKV: the browser opens the file but can't decode the picture
  if (current()?.local && player.media.videoWidth === 0 && /^video\//.test(current().file?.type || 'video/')) showError();
  const t = +store.get(resumeKey());
  if (t > 5 && t < player.duration - 10) {
    player.currentTime = t;
    toast('Resumed at ' + clock(t));
  }
});

player.on('timeupdate', () => {
  const now = Date.now();
  if (now - lastSave < 3000 || !player.duration) return;
  lastSave = now;
  store.set(resumeKey(), Math.floor(player.currentTime));
});

// Chrome plays MKV with AC3/DTS audio silently instead of failing, so point to the Pro engine
player.on('playing', () => {
  const item = current();
  const media = player.media;
  if (!item?.local || item.audioChecked || !('webkitAudioDecodedByteCount' in media)) return;
  item.audioChecked = true;
  setTimeout(() => {
    if (current() !== item || state.pro || media.webkitAudioDecodedByteCount > 0 || media.currentTime === 0) return;
    $('#proBtn').classList.add('nudge');
    toast('No sound? Try the Pro engine below the player.');
  }, 2000);
});

player.on('ended', () => {
  store.del(resumeKey());
  if (!state.loop && state.index < state.list.length - 1) play(state.index + 1);
});

player.on('error', () => { if (current() && !state.hls) showError(); });

// ---------- page inputs ----------

$('#openBtn').onclick = () => $('#fileInput').click();
$('#folderBtn').onclick = () => $('#folderInput').click();
$('#proBtn').onclick = playPro;
$('#urlForm').onsubmit = (e) => { e.preventDefault(); openUrl($('#urlInput').value); };

for (const id of ['#fileInput', '#folderInput']) {
  $(id).onchange = (e) => { openFiles(e.target.files); e.target.value = ''; };
}

$('#subInput').onchange = (e) => {
  if (!current()) return toast('Open a video first, then add subtitles.');
  [...e.target.files].forEach(addSub);
  e.target.value = '';
};

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

// capture phase, so volume keys are handled before Plyr and can go past 100%
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
  const key = e.key.toLowerCase();
  if (key === 'o') return $('#fileInput').click();
  if (!current()) return;

  switch (key) {
    case 'arrowup':
    case 'arrowdown':
      e.preventDefault();
      e.stopImmediatePropagation();
      player.muted = false;
      setVol(state.vol + (key === 'arrowup' ? 0.05 : -0.05));
      toast('Volume ' + Math.round(state.vol * 100) + '%');
      break;
    case 'n': play(state.index + 1); break;
    case 'p': play(state.index - 1); break;
    case 's': screenshot(); break;
    case 'l': setTimeout(() => setLoop(player.loop)); break; // Plyr toggles loop on L itself
  }
}, true);
