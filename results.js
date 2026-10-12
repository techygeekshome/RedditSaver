// Results page shared by Bluesky Saver and Reddit Saver. The site file (site.js) reads
// the posts and hands over their pictures and videos; this page shows them in a grid,
// removes duplicates, and saves the chosen ones as one ZIP (or a single video).
/* global SITE, HOSTMAP, makeZip, resolveStream, saveStream */
const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const THUMB_CONCURRENCY = 6;
const FULL_CONCURRENCY = 4;
const NEAR_DUP_DISTANCE = 20;
const NEAR_DUP_PIXEL_DIFF = 1.0;
const NEAR_DUP_MIN_CORRELATION = 0.985;
const ZIP_PART_LIMIT = 1.8e9;
const SETTINGS_KEY = SITE.key + '_settings';

// The local test build points the site's addresses at a test server. Releases leave this empty.
const mapUrl = (u) => {
  for (const k of Object.keys(HOSTMAP)) if (u.startsWith(k)) return HOSTMAP[k] + u.slice(k.length);
  return u;
};
if (Object.keys(HOSTMAP).length) {
  const realFetch = self.fetch.bind(self);
  self.fetch = (u, o) => realFetch(mapUrl(typeof u === 'string' ? u : u.url || String(u)), o);
}

const state = {
  job: null, items: [], keys: new Set(), loaded: 0, total: 0, listing: false, busy: false, show: 'all',
  run: 0, abort: null, status: '', loadError: '', dirty: false, frac: 0,
  settings: { minSide: 0, nearDup: true, showRemoved: false },
  opts: {}
};
for (const o of SITE.options) state.opts[o.id] = o.value;

init();

// ---------- Start ----------
async function init() {
  $('brand').textContent = SITE.name;
  document.title = SITE.name;
  $('legal').textContent = SITE.legal;
  const help = qs.get('help');
  if (help) return showHelp(help);
  const key = qs.get('job');
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith('job_') && k !== key && Date.now() - Number(k.slice(4)) > 86400000);
  if (old.length) chrome.storage.local.remove(old);
  const job = all[key];
  if (!job) return showHelp('expired');
  state.job = job;
  const saved = all[SETTINGS_KEY] || {};
  for (const k of ['minSide', 'nearDup']) if (k in saved) state.settings[k] = saved[k];
  for (const o of SITE.options) if (saved.opts && o.id in saved.opts) state.opts[o.id] = saved.opts[o.id];
  setTitle(SITE.describe(job));
  $('legal').hidden = false;
  buildOptions();
  setupControls();
  run();
}

function setTitle(t) {
  $('title').textContent = t;
  document.title = t + ' | ' + SITE.name;
}

function showHelp(kind) {
  const h = SITE.help[kind] || SITE.help.how;
  $('title').textContent = h[0];
  $('helpTitle').textContent = kind === 'how' ? 'How to use' : 'What to do';
  $('helpText').textContent = h[1];
  $('help').hidden = false;
}

function saveSettings() {
  chrome.storage.local.set({ [SETTINGS_KEY]: { minSide: state.settings.minSide, nearDup: state.settings.nearDup, opts: state.opts } });
}

// ---------- Site options (sort, how many posts...) ----------
function buildOptions() {
  const box = $('opts');
  const list = SITE.options.filter((o) => !o.when || o.when(state.job));
  if (!list.length) return;
  box.hidden = false;
  box.append(el('span', 'lbl', 'Posts'));
  for (const o of list) {
    const lab = el('label', o.type === 'check' ? 'tog' : '');
    let input;
    if (o.type === 'check') {
      input = el('input'); input.type = 'checkbox'; input.checked = !!state.opts[o.id];
      lab.append(input, ' ' + o.label);
    } else {
      input = el('select');
      for (const [v, t] of o.choices) { const op = el('option', '', t); op.value = String(v); input.append(op); }
      input.value = String(state.opts[o.id]);
      lab.append(o.label, input);
    }
    input.id = 'opt_' + o.id;
    input.onchange = () => {
      state.opts[o.id] = o.type === 'check' ? input.checked : (typeof o.value === 'number' ? Number(input.value) : input.value);
      saveSettings();
      showDependent();
      if (o.reload) { state.dirty = true; updateRunButton(); }
    };
    o.lab = lab;
    box.append(lab);
  }
  box.append(el('span', 'spacer'));
  const b = el('button', 'stop', 'Stop');
  b.id = 'stop';
  b.onclick = () => {
    if (state.listing) { state.abort.abort(); return; }
    run();
  };
  box.append(b);
  showDependent();
}

function showDependent() {
  for (const o of SITE.options) if (o.lab && o.showIf) o.lab.hidden = !o.showIf(state.opts);
}

function updateRunButton() {
  const b = $('stop');
  if (!b) return;
  if (state.listing) { b.textContent = 'Stop'; b.className = 'stop'; b.hidden = false; return; }
  b.className = state.dirty ? 'primary' : 'ghost';
  b.textContent = state.dirty ? 'Load again with these settings' : 'Load again';
  b.hidden = state.busy;
}

// ---------- Reading the posts ----------
const thumbs = makeQueue(THUMB_CONCURRENCY, (it) => (it.kind === 'image' ? loadImage(it) : loadVideo(it)));

async function run() {
  if (state.abort) state.abort.abort();
  const runId = ++state.run;
  state.abort = new AbortController();
  thumbs.clear();
  for (const it of state.items) if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
  state.items = []; state.keys = new Set(); state.loaded = 0; state.total = 0;
  state.loadError = ''; state.status = 'Reading posts...'; state.dirty = false; state.frac = 0;
  $('grid').textContent = '';
  $('help').hidden = true;
  state.listing = true;
  updateRunButton();
  updateStats();
  const ctx = {
    job: state.job,
    opts: { ...state.opts },
    signal: state.abort.signal,
    emit: (list) => { if (runId === state.run) addItems(list, runId); },
    status: (text, frac) => {
      if (runId !== state.run) return;
      state.status = text;
      if (frac != null) state.frac = frac;
      updateStats();
    },
    title: (t) => { if (runId === state.run) setTitle(t); }
  };
  try {
    await SITE.load(ctx);
  } catch (e) {
    if (!state.abort.signal.aborted) {
      console.error(e);
      state.loadError = e.message || String(e);
    } else if (runId === state.run) state.status += ' (stopped)';
  }
  if (runId !== state.run) return;
  state.listing = false;
  state.frac = 1;
  updateRunButton();
  updateStats();
  await thumbs.drain();
  if (runId !== state.run) return;
  applyFilters();
  if (!state.items.length) {
    if (state.loadError) showHelp2('Couldn\'t read the posts', SITE.explainError(state.loadError));
    else showHelp('empty');
  }
}

function showHelp2(title, text) {
  $('helpTitle').textContent = title;
  $('helpText').textContent = text;
  $('help').hidden = false;
}

function addItems(list, runId) {
  const grid = $('grid');
  const frag = document.createDocumentFragment();
  for (const raw of list) {
    if (state.keys.has(raw.key)) continue;
    state.keys.add(raw.key);
    const it = {
      ...raw, run: runId, status: 'pending', removed: '', selected: true, force: false, hide: false, el: null,
      hash: null, mini: null, tw: 0, th: 0
    };
    if (!state.items.length) $('controls').hidden = false;
    state.items.push(it);
    state.total++;
    frag.append(buildCard(it));
    thumbs.push(it);
  }
  grid.append(frag);
  updateStats();
}

function makeQueue(n, fn) {
  const q = [];
  let active = 0;
  let waiters = [];
  const pump = () => {
    while (active < n && q.length) {
      const it = q.shift();
      active++;
      fn(it).catch((e) => { it.status = 'failed'; it.error = String(e.message || e); }).finally(() => {
        active--;
        if (it.run === state.run) { state.loaded++; updateCard(it); updateStatsSoon(); }
        pump();
        if (!active && !q.length) { const w = waiters; waiters = []; w.forEach((r) => r()); }
      });
    }
  };
  return {
    push(it) { q.push(it); pump(); },
    clear() { q.length = 0; },
    drain() { return !active && !q.length ? Promise.resolve() : new Promise((r) => waiters.push(r)); }
  };
}

// ---------- Controls ----------
function setupControls() {
  const s = state.settings;
  $('minSide').value = String(s.minSide);
  $('nearDup').checked = s.nearDup;
  $('showRemoved').checked = s.showRemoved;
  $('minSide').onchange = (e) => { s.minSide = Number(e.target.value); saveSettings(); applyFilters(); };
  $('nearDup').onchange = (e) => { s.nearDup = e.target.checked; saveSettings(); applyFilters(); };
  $('showRemoved').onchange = (e) => { s.showRemoved = e.target.checked; state.items.forEach(updateCard); };
  for (const b of document.querySelectorAll('.seg button')) {
    b.onclick = () => {
      state.show = b.dataset.show;
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      state.items.forEach(updateCard);
    };
  }
  const visible = (i) => !i.hide && (state.show === 'all' || state.show === i.kind) && (!i.removed || state.settings.showRemoved);
  $('all').onclick = () => { state.items.filter(visible).forEach((i) => { if (i.removed) i.force = true; else i.selected = true; updateCard(i); }); updateStats(); };
  $('none').onclick = () => { state.items.filter(visible).forEach((i) => { i.selected = false; i.force = false; updateCard(i); }); updateStats(); };
  $('retry').onclick = retryFailed;
  $('dl').onclick = downloadZip;
}

// ---------- Grid ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function buildCard(it) {
  const card = el('label', 'card');
  const cb = el('input');
  cb.type = 'checkbox';
  const thumb = el('div', 'thumb');
  const meta = el('div', 'meta');
  meta.append(el('span', 'dim', 'Loading'), el('span', 'tag', ''));
  card.append(cb, thumb, meta);
  if (it.kind === 'video') {
    card.append(el('span', 'vid', it.gif ? 'GIF VIDEO' : 'VIDEO'));
    thumb.append(el('span', 'ph', '▶'));
    const info = el('div', 'vinfo', '');
    const prog = el('div', 'prog'); prog.append(el('div')); prog.hidden = true;
    const bar = el('div', 'vbar');
    const save = el('button', 'ghost', 'Save this video');
    save.disabled = true;
    save.onclick = (e) => { e.preventDefault(); e.stopPropagation(); saveOne(it); };
    bar.append(save);
    card.append(info, prog, bar);
    it.saveBtn = save;
  }
  if (it.caption) card.append(el('div', 'post', it.caption));
  const tip = [it.alt, it.caption].filter(Boolean).join('\n\n');
  if (tip) card.title = tip.slice(0, 600);
  cb.onchange = () => {
    if (it.removed) it.force = cb.checked; else it.selected = cb.checked;
    updateCard(it);
    updateStats();
  };
  it.el = card;
  return card;
}

const usable = (it) => it.status === 'ok';
const included = (it) => usable(it) && !it.hide && (it.removed ? it.force : it.selected);

function fmtTime(s) {
  if (!s || !Number.isFinite(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

function updateCard(it) {
  const card = it.el;
  if (!card) return;
  const thumb = card.querySelector('.thumb');
  if (it.thumbUrl && !thumb.querySelector('img')) {
    const img = el('img');
    img.loading = 'lazy';
    img.src = it.thumbUrl;
    img.alt = it.alt || '';
    thumb.textContent = '';
    thumb.append(img);
  }
  let dim = 'Loading';
  if (it.status === 'ok') {
    if (it.kind === 'image') dim = it.w ? `${it.w} x ${it.h}` : 'Image';
    else dim = it.h ? `${Math.min(it.w || it.h, it.h)}p` : 'Video';
  } else if (it.status === 'failed') dim = '';
  card.querySelector('.dim').textContent = dim;
  card.querySelector('.tag').textContent = it.status === 'failed' ? 'Failed' : it.removed || '';
  if (it.kind === 'video') {
    const bits = [];
    if (it.w && it.h) bits.push(`${it.w} x ${it.h}`);
    if (it.dur) bits.push(fmtTime(it.dur));
    bits.push(it.src === 'file' ? 'video file' : it.src === 'hls' ? 'HLS stream' : 'DASH stream');
    if (it.audio === false) bits.push('no sound');
    card.querySelector('.vinfo').textContent = it.status === 'failed' ? (it.error || 'Couldn\'t read this video') : bits.join(' · ');
    if (it.saveBtn && !it.saving) it.saveBtn.disabled = it.status !== 'ok' || state.busy;
  }
  card.classList.toggle('failed', it.status === 'failed');
  card.classList.toggle('removed', !!it.removed);
  card.classList.toggle('on', included(it));
  const hidden = it.hide || (state.show !== 'all' && state.show !== it.kind) || (!!it.removed && !it.force && !state.settings.showRemoved);
  card.classList.toggle('hidden', hidden);
  const cb = card.querySelector('input');
  cb.checked = included(it);
  cb.disabled = it.status !== 'ok';
}

let statsTimer = 0;
function updateStatsSoon() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = 0; updateStats(); }, 120);
}

function updateStats() {
  const vis = state.items.filter((i) => !i.hide);
  const imgs = vis.filter((i) => i.kind === 'image');
  const vids = vis.filter((i) => i.kind === 'video');
  $('nImg').textContent = imgs.filter((i) => usable(i) && (!i.removed || i.force)).length;
  $('nVid').textContent = vids.filter(usable).length;
  const chosen = vis.filter(included);
  const cv = chosen.filter((i) => i.kind === 'video').length;
  const ci = chosen.length - cv;
  const failed = vis.filter((i) => i.status === 'failed').length;
  const removed = vis.filter((i) => usable(i) && i.removed && !i.force).length;
  const bits = [];
  if (state.status) bits.push(state.status);
  bits.push(`${imgs.length} images`, `${vids.length} videos`);
  if (state.loaded < state.total) bits.push(`checking ${state.loaded}/${state.total}`);
  if (removed) bits.push(`${removed} hidden by filters`);
  if (failed) bits.push(`${failed} failed`);
  bits.push(`${chosen.length} selected`);
  if (state.loadError && state.items.length) bits.push('stopped early: ' + state.loadError);
  $('stats').textContent = bits.join(' · ');
  const f = state.listing ? state.frac * 0.6 : 0.6 + (state.total ? (state.loaded / state.total) * 0.4 : 0.4);
  $('bar').style.width = Math.round(Math.min(1, f) * 100) + '%';
  const busyLoading = state.listing || state.loaded < state.total;
  $('retry').hidden = !failed || busyLoading || state.busy;
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (!state.busy) $('dl').textContent = `Download ZIP (${[ci ? pl(ci, 'image') : '', cv ? pl(cv, 'video') : ''].filter(Boolean).join(' + ') || 0})`;
  $('dl').disabled = state.busy || !chosen.length || busyLoading;
}

// ---------- Images ----------
async function decodeSize(blob) {
  try {
    const b = await createImageBitmap(blob);
    return { w: b.width, h: b.height, bmp: b };
  } catch (e) {
    return new Promise((res) => {
      const img = new Image();
      const u = URL.createObjectURL(blob);
      img.onload = () => { res({ w: img.naturalWidth, h: img.naturalHeight, bmp: null }); URL.revokeObjectURL(u); };
      img.onerror = () => { res(null); URL.revokeObjectURL(u); };
      img.src = u;
    });
  }
}

async function fetchBlob(url, want, timeout = 60000) {
  const r = await fetch(url, { credentials: SITE.credentials, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  if (!blob.size) throw new Error('empty');
  const t = (blob.type || '').toLowerCase();
  if (want && t && !t.startsWith(want + '/') && !/octet-stream|binary/.test(t)) throw new Error('not an ' + want);
  return blob;
}

async function loadImage(it) {
  const tries = [it.thumb, ...it.cands].filter(Boolean);
  let blob = null, d = null, used = '';
  for (const u of tries.slice(0, 3)) {
    try {
      blob = await fetchBlob(u, 'image', 30000);
      d = await decodeSize(blob);
      if (d) { used = u; break; }
    } catch (e) { blob = null; }
  }
  if (!blob || !d) { it.status = 'failed'; it.error = 'Couldn\'t load this picture'; return; }
  it.tw = d.w; it.th = d.h;
  if (used !== it.thumb) {
    // No small preview: this was the full picture, keep it for the ZIP.
    it.full = { blob, url: used };
    it.w = d.w; it.h = d.h;
  }
  if (d.bmp) {
    try {
      let small;
      try { small = await createImageBitmap(d.bmp, { resizeWidth: 256, resizeHeight: 256, resizeQuality: 'high' }); } catch (e) {
        const c = new OffscreenCanvas(256, 256);
        c.getContext('2d').drawImage(d.bmp, 0, 0, 256, 256);
        small = await createImageBitmap(c);
      }
      it.hash = dhash(small);
      it.mini = miniGray(small);
      small.close();
    } catch (e) { /* no fingerprint: never treated as a near-duplicate */ }
    d.bmp.close();
  }
  it.thumbUrl = URL.createObjectURL(blob);
  it.status = 'ok';
}

async function loadVideo(it) {
  if (it.poster) {
    try {
      const blob = await fetchBlob(it.poster, 'image', 20000);
      it.thumbUrl = URL.createObjectURL(blob);
    } catch (e) { /* the play symbol stays */ }
  }
  it.status = 'ok';
}

function extFrom(type, url) {
  const map = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv' };
  if (map[type]) return map[type];
  const m = /\.(\w{3,4})(?:[?#@]|$)/.exec(new URL(url, location.href).pathname);
  if (m && !/^(m3u8|mpd)$/i.test(m[1])) return m[1].toLowerCase().replace('jpeg', 'jpg');
  return /^video/.test(type) ? 'mp4' : 'jpg';
}

async function fullImage(it) {
  if (it.full) return it.full;
  let last = null;
  const cands = SITE.cands ? await SITE.cands(it, state.opts) : it.cands;
  for (const u of cands) {
    try {
      const blob = await fetchBlob(u, 'image', 120000);
      return { blob, url: u };
    } catch (e) { last = e; }
  }
  throw last || new Error('no address');
}

const hashCanvas = new OffscreenCanvas(9, 8);
const hashCtx = hashCanvas.getContext('2d', { willReadFrequently: true });
function dhash(bmp) {
  hashCtx.fillStyle = '#fff';
  hashCtx.fillRect(0, 0, 9, 8);
  hashCtx.drawImage(bmp, 0, 0, 9, 8);
  const d = hashCtx.getImageData(0, 0, 9, 8).data;
  let hi = 0, lo = 0, bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * 4, j = i + 4;
      const a = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const b = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
      if (a > b) { if (bit < 32) hi |= 1 << bit; else lo |= 1 << (bit - 32); }
      bit++;
    }
  }
  return [hi >>> 0, lo >>> 0];
}
const miniCanvas = new OffscreenCanvas(256, 256);
const miniCtx = miniCanvas.getContext('2d', { willReadFrequently: true });
function miniGray(bmp256) {
  miniCtx.fillStyle = '#fff';
  miniCtx.fillRect(0, 0, 256, 256);
  miniCtx.drawImage(bmp256, 0, 0, 256, 256);
  const d = miniCtx.getImageData(0, 0, 256, 256).data;
  const g = new Float32Array(1024);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    g[(y >> 3) * 32 + (x >> 3)] += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 64;
  }
  return g;
}
function looksSame(a, b) {
  let mad = 0, ma = 0, mb = 0;
  for (let i = 0; i < 1024; i++) { mad += Math.abs(a[i] - b[i]); ma += a[i]; mb += b[i]; }
  if (mad / 1024 > NEAR_DUP_PIXEL_DIFF * 4) return false; // previews are re-compressed, so allow a little more
  ma /= 1024; mb /= 1024;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < 1024; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  if (!saa || !sbb) return saa === sbb;
  return sab / Math.sqrt(saa * sbb) >= NEAR_DUP_MIN_CORRELATION;
}
function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
const distance = (a, b) => popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]);

// ---------- Filters ----------
function applyFilters() {
  const s = state.settings;
  const ok = state.items.filter((i) => i.kind === 'image' && i.status === 'ok');
  ok.forEach((i) => { i.removed = ''; });
  const seen = new Set();
  for (const it of ok) { if (it.dupKey && seen.has(it.dupKey)) it.removed = 'Duplicate'; else if (it.dupKey) seen.add(it.dupKey); }
  if (s.nearDup) {
    const area = (i) => (i.w * i.h) || (i.tw * i.th);
    const pool = ok.filter((i) => !i.removed && i.hash && i.tw && i.th).sort((a, b) => area(b) - area(a));
    const kept = [];
    for (const it of pool) {
      const ar = it.tw / it.th;
      const twin = kept.find((k) => Math.abs(k.tw / k.th - ar) / ar < 0.05 && distance(k.hash, it.hash) <= NEAR_DUP_DISTANCE && (!k.mini || !it.mini || looksSame(k.mini, it.mini)));
      if (twin) it.removed = 'Near-duplicate'; else kept.push(it);
    }
  }
  if (s.minSide > 0) for (const it of ok) if (!it.removed && it.w && Math.min(it.w, it.h) < s.minSide) it.removed = 'Too small';
  state.items.forEach(updateCard);
  updateStats();
}

async function retryFailed() {
  const failed = state.items.filter((i) => i.status === 'failed' && !i.hide);
  state.loaded -= failed.length;
  failed.forEach((i) => { i.status = 'pending'; delete i.full; updateCard(i); thumbs.push(i); });
  updateStats();
  await thumbs.drain();
  applyFilters();
}

// ---------- Videos ----------
async function videoBlob(it, onProgress) {
  const sources = SITE.videoSources ? await SITE.videoSources(it, state.opts) : [{ src: it.src, url: it.url }, ...(it.alts || [])];
  let last = null;
  for (const s of sources) {
    try {
      // A site's own way of putting a video together (Reddit: video file + sound file).
      if (s.src === 'custom') return await s.get(onProgress);
      if (s.src === 'file') {
        const r = await fetch(s.url, { credentials: SITE.credentials });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const type = (r.headers.get('content-type') || '').split(';')[0];
        if (type && !/^video\/|octet-stream|binary/.test(type)) throw new Error('not a video');
        const total = Number(r.headers.get('content-length') || 0);
        if (!r.body || !total) { const b = await r.blob(); return { blob: b, ext: extFrom(b.type, s.url) }; }
        const reader = r.body.getReader();
        const parts = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.length;
          onProgress(got, total);
        }
        return { blob: new Blob(parts, { type: type || 'video/mp4' }), ext: extFrom(type, s.url) };
      }
      const info = await resolveStream({ src: s.src, url: s.url });
      if (info.protected) throw new Error('This video is protected and can\'t be saved');
      if (info.live) throw new Error('Live streams can\'t be saved');
      if (info.width && !it.w) { it.w = info.width; it.h = info.height; }
      const res = await saveStream(info, onProgress);
      return { blob: res.blob, ext: 'mp4' };
    } catch (e) { console.warn('video source failed', s.url, e); last = e; }
  }
  throw last || new Error('no video address');
}

function setProgress(it, frac) {
  const p = it.el && it.el.querySelector('.prog');
  if (!p) return;
  p.hidden = frac == null;
  if (frac != null) p.firstChild.style.width = Math.round(frac * 100) + '%';
}

async function saveOne(it) {
  if (it.saving) return;
  it.saving = true;
  const btn = it.saveBtn;
  btn.disabled = true;
  try {
    btn.textContent = 'Saving...';
    const v = await videoBlob(it, (a, b) => { setProgress(it, b ? a / b : null); btn.textContent = b ? `Saving ${Math.round((a / b) * 100)}%` : 'Saving...'; });
    await chrome.downloads.download({ url: URL.createObjectURL(v.blob), filename: safeName(SITE.fileBase(it)) + '.' + v.ext, saveAs: false });
    btn.textContent = 'Saved';
  } catch (e) {
    console.error(e);
    btn.textContent = 'Failed, try again';
    it.error = e.message;
  } finally {
    setProgress(it, null);
    it.saving = false;
    setTimeout(() => { btn.textContent = 'Save this video'; btn.disabled = it.status !== 'ok'; }, 4000);
  }
}

// ---------- Download ----------
function safeName(s) {
  return (String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120)) || 'file';
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function downloadZip() {
  const list = state.items.filter(included);
  if (!list.length) return;
  state.busy = true;
  updateStats();
  updateRunButton();
  state.items.forEach(updateCard);
  const dl = $('dl');
  const files = [];
  const rows = [];
  let failed = 0;
  try {
    const vids = list.filter((i) => i.kind === 'video');
    const imgs = list.filter((i) => i.kind === 'image');
    const both = vids.length && imgs.length;
    const used = new Set();
    const unique = (name, ext) => {
      let n = name + '.' + ext, k = 2;
      while (used.has(n)) n = `${name}_${k++}.${ext}`;
      used.add(n);
      return n;
    };
    // Pictures first, a few at a time.
    let done = 0;
    const got = new Map();
    await new Promise((resolve) => {
      let next = 0, active = 0;
      const pump = () => {
        if (next >= imgs.length && !active) return resolve();
        while (active < FULL_CONCURRENCY && next < imgs.length) {
          const it = imgs[next++];
          active++;
          fullImage(it).then((f) => got.set(it, f), (e) => { console.warn(e); it.status = 'failed'; it.error = String(e.message || e); updateCard(it); failed++; })
            .finally(() => { active--; done++; dl.textContent = `Saving image ${done}/${imgs.length}...`; pump(); });
        }
      };
      pump();
    });
    for (const it of imgs) {
      const f = got.get(it);
      if (!f) continue;
      const name = (both ? 'images/' : '') + unique(safeName(SITE.fileBase(it)), extFrom(f.blob.type, f.url));
      files.push({ name, blob: f.blob });
      rows.push([name, ...SITE.csvRow(it)]);
    }
    let vn = 0;
    for (const it of vids) {
      vn++;
      dl.textContent = `Saving video ${vn}/${vids.length}...`;
      try {
        const v = await videoBlob(it, (a, b) => { setProgress(it, b ? a / b : null); dl.textContent = `Saving video ${vn}/${vids.length}${b ? ' (' + Math.round((a / b) * 100) + '%)' : ''}...`; });
        const name = (both ? 'videos/' : '') + unique(safeName(SITE.fileBase(it)), v.ext);
        files.push({ name, blob: v.blob });
        rows.push([name, ...SITE.csvRow(it)]);
      } catch (e) { console.error(e); failed++; it.error = e.message; }
      setProgress(it, null);
    }
    if (!files.length) throw new Error('none of the selected files could be downloaded');
    if (state.opts.csv) {
      const lines = [['file', ...SITE.csvColumns], ...rows].map((r) => r.map(csvCell).join(','));
      files.push({ name: 'posts.csv', blob: new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv' }) });
    }
    const groups = [];
    let cur = [], size = 0;
    for (const f of files) {
      if (cur.length && size + f.blob.size > ZIP_PART_LIMIT) { groups.push(cur); cur = []; size = 0; }
      cur.push(f); size += f.blob.size;
    }
    if (cur.length) groups.push(cur);
    const base = safeName(SITE.zipName(state.job));
    for (let g = 0; g < groups.length; g++) {
      const label = groups.length > 1 ? ` part ${g + 1}/${groups.length}` : '';
      const zip = await makeZip(groups[g], (i, t) => { dl.textContent = `Zipping${label} ${i}/${t}...`; });
      await chrome.downloads.download({ url: URL.createObjectURL(zip), filename: base + (groups.length > 1 ? `-part${g + 1}` : '') + '.zip', saveAs: false });
    }
    dl.textContent = failed ? `Downloaded (${failed} failed)` : 'Downloaded';
  } catch (e) {
    console.error(e);
    dl.textContent = 'Download failed: ' + e.message;
  }
  setTimeout(() => { state.busy = false; updateStats(); updateRunButton(); state.items.forEach(updateCard); }, 3500);
}
