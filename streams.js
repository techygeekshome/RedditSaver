// Page Saver: reads HLS (.m3u8) and DASH (.mpd) playlists, picks the best quality,
// downloads the pieces and joins them into one MP4 with buildMp4 (mp4.js).
// Streams that are copy-protected (DRM or encrypted) and live streams are refused.
/* global buildMp4, muxjs */
/* exported resolveStream, saveStream, previewStream, parseM3U8, parseMpd */

const STREAM_CONCURRENCY = 6;

function resolveUrl(u, base) {
  return new URL(u, base).href;
}

async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      // Give up on a piece that hangs (2 minutes), and on a playlist after 20 seconds.
      const limit = AbortSignal.timeout(opts.headers ? 120000 : (opts.isList ? 20000 : 120000));
      const signal = opts.signal && AbortSignal.any ? AbortSignal.any([opts.signal, limit]) : (opts.signal || limit);
      const { isList, ...rest } = opts; void isList;
      const r = await fetch(url, { credentials: 'include', ...rest, signal });
      if (r.ok || r.status === 206) return r;
      last = new Error('HTTP ' + r.status);
      if (r.status === 403 || r.status === 404 || r.status === 410) break;
    } catch (e) { last = e; }
    if (opts.signal && opts.signal.aborted) break;
    await new Promise((res) => setTimeout(res, 600 * (i + 1)));
  }
  throw last || new Error('download failed');
}

async function getText(url, signal) {
  const r = await fetchRetry(url, { signal, isList: true });
  return { text: await r.text(), url: r.url || url };
}

async function getBytes(part, signal) {
  const headers = part.range ? { Range: `bytes=${part.range[0]}-${part.range[1]}` } : undefined;
  const r = await fetchRetry(part.url, { headers, signal });
  let u8 = new Uint8Array(await r.arrayBuffer());
  // A server that ignores Range sends the whole file: cut the piece out ourselves.
  if (part.range && r.status === 200 && u8.length > part.range[1] - part.range[0] + 1) {
    u8 = u8.slice(part.range[0], part.range[1] + 1);
  }
  return u8;
}

// ---------- HLS ----------

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

function parseM3U8(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('not a playlist');
  const res = { master: false, variants: [], media: [], segments: [], encrypted: false, drm: false, live: true, vod: false, duration: 0 };
  let inf = null, stream = null, map = null, range = null;
  const lastEnd = {};
  const parseRange = (s, url) => {
    const [len, off] = s.split('@').map(Number);
    const start = Number.isFinite(off) ? off : (lastEnd[url] || 0);
    lastEnd[url] = start + len;
    return [start, start + len - 1];
  };
  for (const line of lines) {
    const colon = line.indexOf(':');
    const tag = colon > 0 ? line.slice(0, colon) : line;
    const val = colon > 0 ? line.slice(colon + 1) : '';
    if (tag === '#EXT-X-STREAM-INF') { res.master = true; stream = parseAttrs(val); continue; }
    if (tag === '#EXT-X-MEDIA') {
      const a = parseAttrs(val);
      if (a.URI) a.URI = resolveUrl(a.URI, base);
      res.media.push(a);
      res.master = true;
      continue;
    }
    if (tag === '#EXT-X-KEY' || tag === '#EXT-X-SESSION-KEY') {
      const a = parseAttrs(val);
      if (a.METHOD && a.METHOD !== 'NONE') {
        res.encrypted = true;
        if (a.METHOD !== 'AES-128' || (a.KEYFORMAT && a.KEYFORMAT !== 'identity')) res.drm = true;
      }
      continue;
    }
    if (tag === '#EXT-X-MAP') {
      const a = parseAttrs(val);
      const url = resolveUrl(a.URI, base);
      map = { url, range: a.BYTERANGE ? parseRange(a.BYTERANGE, url) : null };
      continue;
    }
    if (tag === '#EXTINF') { inf = parseFloat(val) || 0; continue; }
    if (tag === '#EXT-X-BYTERANGE') { range = val; continue; }
    if (tag === '#EXT-X-ENDLIST') { res.live = false; continue; }
    if (tag === '#EXT-X-PLAYLIST-TYPE') { if (val === 'VOD') res.vod = true; continue; }
    if (line.startsWith('#')) continue;
    const url = resolveUrl(line, base);
    if (stream) { res.variants.push({ ...stream, url }); stream = null; continue; }
    res.segments.push({ url, range: range != null ? parseRange(range, url) : null, dur: inf || 0, map });
    res.duration += inf || 0;
    inf = null; range = null;
  }
  if (res.vod) res.live = false;
  return res;
}

function resArea(v) {
  const m = /(\d+)x(\d+)/.exec(v.RESOLUTION || '');
  return m ? Number(m[1]) * Number(m[2]) : 0;
}
const audioOnly = (v) => v.CODECS && !/avc|hvc|hev|av01|vp0?9|vp8|mp4v/i.test(v.CODECS);

// Splits a playlist into runs that share the same init segment (ad breaks often
// switch to another one) and keeps the longest run.
function mainRun(pl) {
  const runs = [];
  for (const s of pl.segments) {
    const last = runs[runs.length - 1];
    if (last && last.map === s.map) last.segs.push(s); else runs.push({ map: s.map, segs: [s] });
  }
  runs.sort((a, b) => b.segs.reduce((t, s) => t + s.dur, 0) - a.segs.reduce((t, s) => t + s.dur, 0));
  return runs[0] || { map: null, segs: [] };
}

async function resolveHls(url, signal) {
  const { text, url: finalUrl } = await getText(url, signal);
  let pl = parseM3U8(text, finalUrl);
  const out = { kind: 'hls', url, width: 0, height: 0, bandwidth: 0, duration: 0, protected: false, live: false, covers: [finalUrl, url] };
  let audioPl = null;
  if (pl.master) {
    if (pl.drm) out.protected = true;
    const vids = pl.variants.filter((v) => !audioOnly(v));
    const list = (vids.length ? vids : pl.variants).slice().sort((a, b) => resArea(b) - resArea(a) || Number(b.BANDWIDTH || 0) - Number(a.BANDWIDTH || 0));
    if (!list.length) throw new Error('no video in playlist');
    const best = list[0];
    out.covers.push(...pl.variants.map((v) => v.url));
    const m = /(\d+)x(\d+)/.exec(best.RESOLUTION || '');
    if (m) { out.width = Number(m[1]); out.height = Number(m[2]); }
    out.bandwidth = Number(best.BANDWIDTH || 0);
    if (best.AUDIO) {
      const group = pl.media.filter((x) => x.TYPE === 'AUDIO' && x['GROUP-ID'] === best.AUDIO && x.URI);
      const pick = group.find((x) => x.DEFAULT === 'YES') || group.find((x) => x.AUTOSELECT === 'YES') || group[0];
      if (pick) {
        out.covers.push(...group.map((x) => x.URI));
        audioPl = parseM3U8((await getText(pick.URI, signal)).text, pick.URI);
      }
    }
    const v = await getText(best.url, signal);
    pl = parseM3U8(v.text, v.url);
  }
  if (pl.drm || (audioPl && audioPl.drm)) out.protected = true;
  if (pl.encrypted || (audioPl && audioPl.encrypted)) out.protected = true;
  if (pl.live) out.live = true;
  out.duration = pl.duration;
  if (!out.bandwidth && pl.duration) out.bandwidth = 0;
  const v = mainRun(pl);
  out.video = { init: v.map, parts: v.segs.map((s) => ({ url: s.url, range: s.range })) };
  if (audioPl) {
    const a = mainRun(audioPl);
    out.audio = { init: a.map, parts: a.segs.map((s) => ({ url: s.url, range: s.range })) };
  }
  out.covers.push(...out.video.parts.map((p) => p.url));
  return out;
}

// ---------- DASH ----------

function isoDuration(s) {
  const m = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)W)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(String(s || '').trim());
  if (!m) return 0;
  const n = (i) => Number(m[i] || 0);
  return n(1) * 31536000 + n(2) * 2592000 + n(3) * 604800 + n(4) * 86400 + n(5) * 3600 + n(6) * 60 + n(7);
}

const kids = (el, name) => (el ? Array.from(el.childNodes).filter((n) => n.nodeType === 1 && (n.localName || n.nodeName.replace(/^.*:/, '')) === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;

function fillTemplate(t, rep, number, time) {
  return t.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (_, k, w) => {
    const v = String(k === 'RepresentationID' ? rep.id : k === 'Number' ? number : k === 'Bandwidth' ? rep.bandwidth : time);
    return w ? v.padStart(Number(w), '0') : v;
  }).replace(/\$\$/g, '$');
}

function rangeOf(s) {
  if (!s) return null;
  const [a, b] = s.split('-').map(Number);
  return [a, b];
}

function parseMpd(text, base, XmlParser) {
  const P = XmlParser || DOMParser;
  const doc = new P().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || (mpd.localName || mpd.nodeName) !== 'MPD') throw new Error('not a DASH manifest');
  const live = mpd.getAttribute('type') === 'dynamic';
  const total = isoDuration(mpd.getAttribute('mediaPresentationDuration'));
  let baseUrl = base;
  const b0 = kid(mpd, 'BaseURL');
  if (b0) baseUrl = resolveUrl(b0.textContent.trim(), baseUrl);

  const periods = kids(mpd, 'Period');
  let best = null;
  for (let pi = 0; pi < periods.length; pi++) {
    const period = periods[pi];
    let pDur = isoDuration(period.getAttribute('duration'));
    if (!pDur) {
      const start = isoDuration(period.getAttribute('start'));
      const next = periods[pi + 1] ? isoDuration(periods[pi + 1].getAttribute('start')) : total;
      pDur = Math.max(0, (next || total) - start) || total;
    }
    let pBase = baseUrl;
    const pb = kid(period, 'BaseURL');
    if (pb) pBase = resolveUrl(pb.textContent.trim(), pBase);
    const reps = [];
    for (const as of kids(period, 'AdaptationSet')) {
      let aBase = pBase;
      const ab = kid(as, 'BaseURL');
      if (ab) aBase = resolveUrl(ab.textContent.trim(), aBase);
      const asProt = kids(as, 'ContentProtection').length > 0;
      for (const r of kids(as, 'Representation')) {
        const attr = (k) => r.getAttribute(k) || as.getAttribute(k) || '';
        const mime = attr('mimeType');
        const codecs = attr('codecs');
        let type = as.getAttribute('contentType') || r.getAttribute('contentType') || mime.split('/')[0];
        if (!type || type === 'application') type = /avc|hvc|hev|av01|vp0?9/i.test(codecs) ? 'video' : /mp4a|opus|ac-3|ec-3|flac/i.test(codecs) ? 'audio' : type;
        if (type !== 'video' && type !== 'audio') continue;
        if (/webm/.test(mime)) continue; // WebM pieces can't be joined into MP4 here
        let rBase = aBase;
        const rb = kid(r, 'BaseURL');
        if (rb) rBase = resolveUrl(rb.textContent.trim(), rBase);
        const rep = {
          id: r.getAttribute('id') || '', type, codecs, base: rBase,
          bandwidth: Number(attr('bandwidth') || 0), width: Number(attr('width') || 0), height: Number(attr('height') || 0),
          protected: asProt || kids(r, 'ContentProtection').length > 0,
          lang: attr('lang'), role: (kid(as, 'Role') && kid(as, 'Role').getAttribute('value')) || ''
        };
        // Segment info: the nearest definition wins (Representation, then AdaptationSet, then Period).
        const chain = [r, as, period];
        const pickEl = (name) => chain.map((e) => kid(e, name)).filter(Boolean);
        const tpls = pickEl('SegmentTemplate');
        const lists = pickEl('SegmentList');
        if (tpls.length) {
          const ta = (k) => { for (const t of tpls) if (t.hasAttribute(k)) return t.getAttribute(k); return null; };
          const tl = tpls.map((t) => kid(t, 'SegmentTimeline')).find(Boolean);
          const timescale = Number(ta('timescale') || 1);
          const startNumber = Number(ta('startNumber') || 1);
          const media = ta('media');
          const init = ta('initialization');
          const pto = Number(ta('presentationTimeOffset') || 0);
          const parts = [];
          if (tl) {
            let t = 0, n = startNumber;
            const ss = kids(tl, 'S');
            ss.forEach((s, i) => {
              if (s.hasAttribute('t')) t = Number(s.getAttribute('t'));
              const d = Number(s.getAttribute('d'));
              let rpt = Number(s.getAttribute('r') || 0);
              if (rpt < 0) {
                const end = ss[i + 1] && ss[i + 1].hasAttribute('t') ? Number(ss[i + 1].getAttribute('t')) : pto + pDur * timescale;
                rpt = Math.max(0, Math.ceil((end - t) / d) - 1);
              }
              for (let k = 0; k <= rpt; k++) { parts.push({ url: resolveUrl(fillTemplate(media, rep, n, t), rBase) }); t += d; n++; }
            });
          } else {
            const dur = Number(ta('duration') || 0);
            const count = dur ? Math.ceil((pDur * timescale) / dur) : 0;
            for (let k = 0; k < count; k++) parts.push({ url: resolveUrl(fillTemplate(media, rep, startNumber + k, pto + k * dur), rBase) });
          }
          rep.init = init ? { url: resolveUrl(fillTemplate(init, rep, startNumber, 0), rBase) } : null;
          rep.parts = parts;
        } else if (lists.length) {
          const sl = lists[0];
          const ini = kid(sl, 'Initialization');
          rep.init = ini ? { url: resolveUrl(ini.getAttribute('sourceURL') || '', rBase), range: rangeOf(ini.getAttribute('range')) } : null;
          rep.parts = kids(sl, 'SegmentURL').map((s) => ({
            url: s.getAttribute('media') ? resolveUrl(s.getAttribute('media'), rBase) : rBase,
            range: rangeOf(s.getAttribute('mediaRange'))
          }));
        } else {
          // SegmentBase or nothing: the whole thing is one file.
          rep.init = null;
          rep.parts = [{ url: rBase }];
        }
        reps.push(rep);
      }
    }
    const vids = reps.filter((r) => r.type === 'video');
    if (!vids.length) continue;
    if (!best || pDur > best.duration) best = { reps, duration: pDur };
  }
  if (!best) throw new Error('no video in manifest');
  return { live, duration: best.duration || total, reps: best.reps };
}

async function resolveDash(url, signal) {
  const { text, url: finalUrl } = await getText(url, signal);
  const m = parseMpd(text, finalUrl);
  const vids = m.reps.filter((r) => r.type === 'video');
  const clear = vids.filter((r) => !r.protected);
  const pool = clear.length ? clear : vids;
  pool.sort((a, b) => b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth);
  const v = pool[0];
  const auds = m.reps.filter((r) => r.type === 'audio' && !r.protected);
  auds.sort((a, b) => (b.role === 'main') - (a.role === 'main') || b.bandwidth - a.bandwidth);
  const a = auds[0] || null;
  const out = {
    kind: 'dash', url, width: v.width, height: v.height, bandwidth: v.bandwidth + (a ? a.bandwidth : 0),
    duration: m.duration, protected: !clear.length, live: m.live, covers: [url, finalUrl],
    video: { init: v.init, parts: v.parts },
    audio: a ? { init: a.init, parts: a.parts } : null
  };
  out.covers.push(...v.parts.map((p) => p.url));
  return out;
}

async function resolveStream(item, signal) {
  return item.src === 'dash' ? resolveDash(item.url, signal) : resolveHls(item.url, signal);
}

// ---------- Downloading ----------

function looksTs(u8) {
  return u8.length > 188 && u8[0] === 0x47 && (u8.length < 377 || u8[188] === 0x47);
}
function looksAdts(u8) {
  return (u8[0] === 0xff && (u8[1] & 0xf6) === 0xf0) || (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33);
}

function transmux(pieces) {
  const tm = new muxjs.Transmuxer({ remux: true });
  let init = null;
  const out = [];
  tm.on('data', (seg) => {
    if (seg.initSegment && (!init || seg.initSegment.length > init.length)) init = seg.initSegment.slice();
    if (seg.data && seg.data.length) out.push(seg.data.slice());
  });
  for (const p of pieces) { tm.push(p); tm.flush(); }
  if (!init) throw new Error('this stream uses a video format that can\'t be converted');
  return { init, pieces: out };
}

async function downloadTrack(track, signal, onPiece) {
  const parts = track.parts;
  const pieces = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      if (signal && signal.aborted) throw new Error('cancelled');
      const i = next++;
      pieces[i] = await getBytes(parts[i], signal);
      onPiece();
    }
  };
  const initP = track.init ? getBytes(track.init, signal) : Promise.resolve(null);
  await Promise.all(Array.from({ length: Math.min(STREAM_CONCURRENCY, parts.length) }, worker));
  const init = await initP;
  if (!init && pieces.length && (looksTs(pieces[0]) || looksAdts(pieces[0]))) return transmux(pieces);
  return { init, pieces };
}

// Downloads and joins a resolved stream. onProgress(done, total).
async function saveStream(info, onProgress, signal) {
  const tracks = [info.video, info.audio].filter(Boolean);
  const total = tracks.reduce((s, t) => s + t.parts.length + (t.init ? 1 : 0), 0);
  let done = 0;
  const tick = () => { done++; if (onProgress) onProgress(done, total); };
  const streams = [];
  for (const t of tracks) {
    const st = await downloadTrack(t, signal, tick);
    if (t.init) tick();
    streams.push(st);
  }
  return buildMp4(streams);
}

// A few seconds of the video only, joined into a tiny MP4 for the preview picture.
async function previewStream(info, signal) {
  const t = info.video;
  if (!t || !t.parts.length) return null;
  const first = await getBytes(t.parts[0], signal);
  const init = t.init ? await getBytes(t.init, signal) : null;
  let st = { init, pieces: [first] };
  if (!init && (looksTs(first) || looksAdts(first))) st = transmux([first]);
  return buildMp4([st]).blob;
}

if (typeof module !== 'undefined') module.exports = { parseM3U8, parseMpd, isoDuration, fillTemplate, resolveStream, saveStream };
