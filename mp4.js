// Page Saver: joins downloaded stream pieces into one normal MP4 file.
//
// Input: one or more "streams". Each stream is an init segment (ftyp + moov) and the
// media pieces that follow it (moof + mdat pairs), as delivered by HLS or DASH. A
// stream can hold one track (video only, audio only) or several.
// Output: a regular, non-fragmented MP4 (moov first, so it starts playing at once and
// seeks properly in any player), with every video and audio track from all streams.
/* exported buildMp4, mp4Info */

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf']);

function boxType(u8, p) {
  return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
}

// Lists the boxes between start and end. Each: { type, start, hdr, end }.
function readBoxes(u8, start = 0, end = u8.length) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = boxType(u8, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || p + size > end) {
      // A cut-off final box: keep what is there so a short last piece still counts.
      out.push({ type, start: p, hdr, end, truncated: true });
      break;
    }
    out.push({ type, start: p, hdr, end: p + size });
    p += size;
  }
  return out;
}

// Tree of boxes for the containers we need to look inside.
function parseTree(u8, start = 0, end = u8.length) {
  return readBoxes(u8, start, end).map((b) => {
    const node = { type: b.type, u8, start: b.start, hdr: b.hdr, end: b.end };
    if (MP4_CONTAINERS.has(b.type)) node.kids = parseTree(u8, b.start + b.hdr, b.end);
    return node;
  });
}

const find = (nodes, type) => (nodes || []).find((n) => n.type === type);
const findAll = (nodes, type) => (nodes || []).filter((n) => n.type === type);
const pathFind = (node, ...types) => types.reduce((n, t) => n && find(n.kids, t), node);
function payload(node) {
  return node.u8.subarray(node.start + node.hdr, node.end);
}
function dvOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

// ---------- Reading ----------

function readTrack(trak, trexById) {
  const tkhd = payload(pathFind(trak, 'tkhd'));
  const tv = dvOf(tkhd);
  const ver = tkhd[0];
  const id = tv.getUint32(ver === 1 ? 20 : 12);
  const mdhd = payload(pathFind(trak, 'mdia', 'mdhd'));
  const mv = dvOf(mdhd);
  const timescale = mv.getUint32(mdhd[0] === 1 ? 20 : 12);
  const hdlr = payload(pathFind(trak, 'mdia', 'hdlr'));
  const handler = boxType(hdlr, 8);
  let mediaTime = null;
  const elst = pathFind(trak, 'edts', 'elst');
  if (elst) {
    const e = payload(elst);
    const ev = dvOf(e);
    const n = ev.getUint32(4);
    for (let i = 0, p = 8; i < n; i++) {
      const mt = e[0] === 1 ? Number(ev.getBigInt64(p + 8)) : ev.getInt32(p + 4);
      p += e[0] === 1 ? 20 : 12;
      if (mt >= 0) { mediaTime = mt; break; }
    }
  }
  return {
    id, timescale, handler, trak, mediaTime,
    trex: trexById.get(id) || { sdi: 1, dur: 0, size: 0, flags: 0 },
    samples: [], chunks: [], firstDecode: null, fromStbl: false
  };
}

function readInit(u8) {
  const tree = parseTree(u8);
  const moov = find(tree, 'moov');
  if (!moov) throw new Error('no moov box');
  const trexById = new Map();
  for (const trex of findAll(pathFind(moov, 'mvex') ? pathFind(moov, 'mvex').kids : [], 'trex')) {
    const v = dvOf(payload(trex));
    trexById.set(v.getUint32(4), { sdi: v.getUint32(8), dur: v.getUint32(12), size: v.getUint32(16), flags: v.getUint32(20) });
  }
  return findAll(moov.kids, 'trak').map((t) => readTrack(t, trexById));
}

// Reads every moof/mdat pair in a buffer and adds the samples to the matching tracks.
function readFragments(u8, tracksById) {
  const tops = readBoxes(u8);
  for (const top of tops) {
    if (top.type !== 'moof') continue;
    const moof = { kids: parseTree(u8, top.start + top.hdr, top.end) };
    let prevEnd = top.start;
    for (const traf of findAll(moof.kids, 'traf')) {
      const th = payload(find(traf.kids, 'tfhd'));
      const tv = dvOf(th);
      const tfFlags = tv.getUint32(0) & 0xffffff;
      let p = 4;
      const trackId = tv.getUint32(p); p += 4;
      const tr = tracksById.get(trackId);
      let base = null;
      if (tfFlags & 0x01) { base = Number(tv.getBigUint64(p)); p += 8; }
      let sdi = tr ? tr.trex.sdi : 1;
      if (tfFlags & 0x02) { sdi = tv.getUint32(p); p += 4; }
      let defDur = tr ? tr.trex.dur : 0, defSize = tr ? tr.trex.size : 0, defFlags = tr ? tr.trex.flags : 0;
      if (tfFlags & 0x08) { defDur = tv.getUint32(p); p += 4; }
      if (tfFlags & 0x10) { defSize = tv.getUint32(p); p += 4; }
      if (tfFlags & 0x20) { defFlags = tv.getUint32(p); p += 4; }
      if (base == null) base = (tfFlags & 0x20000) ? top.start : prevEnd;
      if (!tr) continue;

      const tfdt = find(traf.kids, 'tfdt');
      if (tfdt && tr.firstDecode == null) {
        const d = payload(tfdt);
        tr.firstDecode = d[0] === 1 ? Number(dvOf(d).getBigUint64(4)) : dvOf(d).getUint32(4);
      }
      let dataPos = base;
      for (const trun of findAll(traf.kids, 'trun')) {
        const r = payload(trun);
        const rv = dvOf(r);
        const ver = r[0];
        const rf = rv.getUint32(0) & 0xffffff;
        const count = rv.getUint32(4);
        let q = 8;
        if (rf & 0x01) { dataPos = base + rv.getInt32(q); q += 4; }
        let firstFlags = null;
        if (rf & 0x04) { firstFlags = rv.getUint32(q); q += 4; }
        const chunkStart = dataPos;
        const startIdx = tr.samples.length;
        for (let i = 0; i < count; i++) {
          let dur = defDur, size = defSize, flags = i === 0 && firstFlags != null ? firstFlags : defFlags, cto = 0;
          if (rf & 0x100) { dur = rv.getUint32(q); q += 4; }
          if (rf & 0x200) { size = rv.getUint32(q); q += 4; }
          if (rf & 0x400) { flags = rv.getUint32(q); if (i === 0 && firstFlags != null) flags = firstFlags; q += 4; }
          if (rf & 0x800) { cto = ver === 0 ? rv.getUint32(q) : rv.getInt32(q); q += 4; }
          tr.samples.push({ dur, size, sync: !((flags >>> 16) & 1), cto, sdi });
          dataPos += size;
        }
        // Keep whatever sample data is really there (a cut-off last piece is trimmed).
        const end = Math.min(dataPos, u8.length);
        if (end <= chunkStart) { tr.samples.length = startIdx; continue; }
        let kept = startIdx, acc = chunkStart;
        while (kept < tr.samples.length && acc + tr.samples[kept].size <= end) acc += tr.samples[kept++].size;
        tr.samples.length = kept;
        if (kept > startIdx) tr.chunks.push({ data: u8.subarray(chunkStart, acc), first: startIdx, count: kept - startIdx, sdi });
      }
      prevEnd = dataPos;
    }
  }
}

// A stream that is already a normal MP4 (all samples listed in the moov).
function readProgressive(u8, tracks) {
  for (const tr of tracks) {
    const stbl = pathFind(tr.trak, 'mdia', 'minf', 'stbl');
    if (!stbl) continue;
    const get = (t) => { const n = find(stbl.kids, t); return n ? dvOf(payload(n)) : null; };
    const stsz = get('stsz'), stts = get('stts'), stsc = get('stsc');
    const stco = get('stco'), co64 = get('co64'), ctts = get('ctts'), stss = get('stss');
    if (!stsz || !stts || !stsc || !(stco || co64)) continue;
    const n = stsz.getUint32(8);
    if (!n) continue;
    const fixed = stsz.getUint32(4);
    const sizes = Array.from({ length: n }, (_, i) => fixed || stsz.getUint32(12 + i * 4));
    const durs = [];
    for (let i = 0, e = stts.getUint32(4); i < e; i++) {
      const c = stts.getUint32(8 + i * 8), d = stts.getUint32(12 + i * 8);
      for (let k = 0; k < c; k++) durs.push(d);
    }
    const ctos = [];
    if (ctts) {
      const v1 = ctts.getUint8(0) === 1;
      for (let i = 0, e = ctts.getUint32(4); i < e; i++) {
        const c = ctts.getUint32(8 + i * 8), o = v1 ? ctts.getInt32(12 + i * 8) : ctts.getUint32(12 + i * 8);
        for (let k = 0; k < c; k++) ctos.push(o);
      }
    }
    let syncSet = null;
    if (stss) { syncSet = new Set(); for (let i = 0, e = stss.getUint32(4); i < e; i++) syncSet.add(stss.getUint32(8 + i * 4) - 1); }
    const chunkCount = co64 ? co64.getUint32(4) : stco.getUint32(4);
    const offsets = Array.from({ length: chunkCount }, (_, i) => co64 ? Number(co64.getBigUint64(8 + i * 8)) : stco.getUint32(8 + i * 4));
    const scEntries = stsc.getUint32(4);
    const perChunk = [];
    for (let i = 0; i < scEntries; i++) {
      const first = stsc.getUint32(8 + i * 12) - 1, spc = stsc.getUint32(12 + i * 12), sdi = stsc.getUint32(16 + i * 12);
      const next = i + 1 < scEntries ? stsc.getUint32(8 + (i + 1) * 12) - 1 : chunkCount;
      for (let c = first; c < next; c++) perChunk[c] = { spc, sdi };
    }
    let s = 0;
    for (let c = 0; c < chunkCount && s < n; c++) {
      const { spc, sdi } = perChunk[c] || { spc: 1, sdi: 1 };
      const start = offsets[c];
      let len = 0;
      const firstIdx = tr.samples.length;
      for (let k = 0; k < spc && s < n; k++, s++) {
        tr.samples.push({ dur: durs[s] || 0, size: sizes[s], sync: syncSet ? syncSet.has(s) : true, cto: ctos[s] || 0, sdi });
        len += sizes[s];
      }
      tr.chunks.push({ data: u8.subarray(start, start + len), first: firstIdx, count: tr.samples.length - firstIdx, sdi });
    }
    tr.firstDecode = 0;
    tr.fromStbl = true;
  }
}

// ---------- Writing ----------

function u32(n) { const b = new Uint8Array(4); dvOf(b).setUint32(0, n); return b; }
function concat(parts) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function box(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  const v = dvOf(out);
  v.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}
function fullBox(type, version, flags, ...parts) {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...parts);
}
function rawNode(n) { return n.u8.subarray(n.start, n.end); }

function makeStbl(tr, stsd, chunkOffsets) {
  const S = tr.samples;
  // stts: runs of equal durations
  const stts = [];
  for (const s of S) {
    const last = stts[stts.length - 1];
    if (last && last[1] === s.dur) last[0]++; else stts.push([1, s.dur]);
  }
  const sttsBuf = new Uint8Array(4 + stts.length * 8); const sv = dvOf(sttsBuf);
  sv.setUint32(0, stts.length);
  stts.forEach(([c, d], i) => { sv.setUint32(4 + i * 8, c); sv.setUint32(8 + i * 8, d); });
  const parts = [rawNode(stsd), fullBox('stts', 0, 0, sttsBuf)];

  if (S.some((s) => s.cto)) {
    const neg = S.some((s) => s.cto < 0);
    const runs = [];
    for (const s of S) {
      const last = runs[runs.length - 1];
      if (last && last[1] === s.cto) last[0]++; else runs.push([1, s.cto]);
    }
    const b = new Uint8Array(4 + runs.length * 8); const v = dvOf(b);
    v.setUint32(0, runs.length);
    runs.forEach(([c, o], i) => { v.setUint32(4 + i * 8, c); if (neg) v.setInt32(8 + i * 8, o); else v.setUint32(8 + i * 8, o); });
    parts.push(fullBox('ctts', neg ? 1 : 0, 0, b));
  }
  if (S.some((s) => !s.sync)) {
    const idx = [];
    S.forEach((s, i) => { if (s.sync) idx.push(i + 1); });
    const b = new Uint8Array(4 + idx.length * 4); const v = dvOf(b);
    v.setUint32(0, idx.length);
    idx.forEach((n, i) => v.setUint32(4 + i * 4, n));
    parts.push(fullBox('stss', 0, 0, b));
  }
  // stsc: runs of chunks with the same sample count
  const stsc = [];
  tr.chunks.forEach((c, i) => {
    const last = stsc[stsc.length - 1];
    if (!last || last[1] !== c.count || last[2] !== c.sdi) stsc.push([i + 1, c.count, c.sdi]);
  });
  const scb = new Uint8Array(4 + stsc.length * 12); const scv = dvOf(scb);
  scv.setUint32(0, stsc.length);
  stsc.forEach(([f, n, d], i) => { scv.setUint32(4 + i * 12, f); scv.setUint32(8 + i * 12, n); scv.setUint32(12 + i * 12, d); });
  parts.push(fullBox('stsc', 0, 0, scb));
  // stsz
  const szb = new Uint8Array(8 + S.length * 4); const szv = dvOf(szb);
  szv.setUint32(4, S.length);
  S.forEach((s, i) => szv.setUint32(8 + i * 4, s.size));
  parts.push(fullBox('stsz', 0, 0, szb));
  // co64
  const cob = new Uint8Array(4 + chunkOffsets.length * 8); const cov = dvOf(cob);
  cov.setUint32(0, chunkOffsets.length);
  chunkOffsets.forEach((o, i) => cov.setBigUint64(4 + i * 8, BigInt(o)));
  parts.push(fullBox('co64', 0, 0, cob));
  return box('stbl', ...parts);
}

// Rebuilds a container, swapping some children (by type) and dropping others.
function rebuild(node, swap) {
  const out = [];
  for (const k of node.kids) {
    if (k.type in swap) { const r = swap[k.type](k); if (r) out.push(r); continue; }
    out.push(rawNode(k));
  }
  return box(node.type, ...out);
}

function makeTrak(tr, newId, chunkOffsets, movieDur, delayMovie) {
  const trackDur = tr.samples.reduce((s, x) => s + x.dur, 0);
  const trakDurMovie = Math.round((tr.presentDur / tr.timescale) * 1000);
  return rebuild(tr.trak, {
    tkhd: (n) => {
      const p = payload(n);
      const ver = p[0];
      const v = dvOf(p);
      // Always write version 1: 64-bit times.
      const b = new Uint8Array(4 + 8 + 8 + 4 + 4 + 8 + (p.length - (ver === 1 ? 36 : 24)));
      const bv = dvOf(b);
      bv.setUint32(0, (1 << 24) | 0x000003); // version 1, enabled + in movie
      bv.setUint32(20, newId);
      bv.setBigUint64(28, BigInt(trakDurMovie + delayMovie));
      b.set(p.subarray(ver === 1 ? 36 : 24), 36);
      void v;
      return box('tkhd', b);
    },
    edts: () => null, // replaced below
    mdia: (m) => rebuild(m, {
      mdhd: (n) => {
        const p = payload(n);
        const lang = dvOf(p).getUint16(p[0] === 1 ? 32 : 20);
        const b = new Uint8Array(4 + 8 + 8 + 4 + 8 + 4);
        const bv = dvOf(b);
        bv.setUint32(0, 1 << 24);
        bv.setUint32(20, tr.timescale);
        bv.setBigUint64(24, BigInt(trackDur));
        bv.setUint16(32, lang);
        return box('mdhd', b);
      },
      minf: (mi) => rebuild(mi, {
        stbl: (st) => makeStbl(tr, find(st.kids, 'stsd'), chunkOffsets)
      })
    })
  }).slice(); // copy so the edts can be inserted
}

function withEdts(trakBox, tr, delayMovie) {
  const entries = [];
  if (delayMovie > 0) entries.push([delayMovie, -1]);
  entries.push([Math.round((tr.presentDur / tr.timescale) * 1000), tr.outMediaTime]);
  const b = new Uint8Array(4 + entries.length * 20); const v = dvOf(b);
  v.setUint32(0, entries.length);
  entries.forEach(([d, t], i) => {
    v.setBigUint64(4 + i * 20, BigInt(d));
    v.setBigInt64(12 + i * 20, BigInt(t));
    v.setUint16(20 + i * 20, 1); // media rate 1.0
  });
  const edts = box('edts', fullBox('elst', 1, 0, b));
  // Insert the edts straight after the tkhd.
  const kids = readBoxes(trakBox, 8);
  const tk = kids.find((k) => k.type === 'tkhd');
  return box('trak', trakBox.subarray(8, tk.end), edts, trakBox.subarray(tk.end));
}

function mvhd(durationMs, nextId) {
  const b = new Uint8Array(96);
  const v = dvOf(b);
  v.setUint32(12, 1000);
  v.setUint32(16, Math.min(durationMs, 0xffffffff));
  v.setUint32(20, 0x00010000);
  v.setUint16(24, 0x0100);
  [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].forEach((m, i) => v.setUint32(36 + i * 4, m));
  v.setUint32(92, nextId);
  return box('mvhd', b);
}

// streams: [{ init: Uint8Array|null, pieces: [Uint8Array] }]
// Returns { blob, info } where info lists the tracks written.
function buildMp4(streams, opts = {}) {
  const tracks = [];
  for (const st of streams) {
    const head = st.init || st.pieces[0];
    const ts = readInit(head);
    const byId = new Map(ts.map((t) => [t.id, t]));
    const all = st.init ? st.pieces : st.pieces; // a self-contained file has its moov in piece 0
    for (const piece of all) readFragments(piece, byId);
    if (!ts.some((t) => t.samples.length)) readProgressive(head, ts);
    for (const t of ts) if (t.samples.length && (t.handler === 'vide' || t.handler === 'soun')) tracks.push(t);
  }
  if (!tracks.length) throw new Error('no audio or video found in the stream');
  // Video first, then audio; keep only one track of each kind unless asked otherwise.
  tracks.sort((a, b) => (a.handler === 'vide' ? 0 : 1) - (b.handler === 'vide' ? 0 : 1));
  const chosen = opts.allTracks ? tracks : [tracks.find((t) => t.handler === 'vide'), tracks.find((t) => t.handler === 'soun')].filter(Boolean);

  // Line the tracks up by when their first sample is shown, keeping each track's own
  // edit (B-frame offset, audio priming) and the gap between audio and video.
  for (const t of chosen) {
    let dts = 0, minPres = Infinity, maxEnd = 0;
    for (const s of t.samples) {
      minPres = Math.min(minPres, dts + s.cto);
      maxEnd = Math.max(maxEnd, dts + s.cto + s.dur);
      dts += s.dur;
    }
    const fd = t.firstDecode || 0;
    const orig = t.mediaTime != null ? t.mediaTime : 0;
    t.outMediaTime = Math.max(minPres, orig - fd);
    t.presentDur = Math.max(0, maxEnd - t.outMediaTime);
    t.firstShown = (fd + t.outMediaTime - orig) / t.timescale;
  }
  const t0 = Math.min(...chosen.map((t) => t.firstShown));
  const delays = chosen.map((t) => Math.max(0, Math.round((t.firstShown - t0) * 1000)));

  // Interleave chunks by time so the file plays smoothly from start to end.
  const order = [];
  chosen.forEach((tr, ti) => {
    let t = (tr.firstDecode || 0) / tr.timescale;
    for (const c of tr.chunks) {
      order.push({ ti, c, t });
      for (let i = c.first; i < c.first + c.count; i++) t += tr.samples[i].dur / tr.timescale;
    }
  });
  order.sort((a, b) => a.t - b.t || a.ti - b.ti);

  const ftyp = box('ftyp', new Uint8Array([105, 115, 111, 109]), u32(0x200),
    new Uint8Array([105, 115, 111, 109, 105, 115, 111, 50, 97, 118, 99, 49, 109, 112, 52, 49]));
  const durationMs = Math.max(...chosen.map((t, i) => Math.round((t.presentDur / t.timescale) * 1000) + delays[i]));
  const dataLen = order.reduce((s, o) => s + o.c.data.length, 0);
  const mdatHdr = dataLen + 8 > 0xffffffff ? 16 : 8;

  const build = (base) => {
    const offs = chosen.map(() => []);
    let p = base;
    for (const o of order) { offs[o.ti].push(p); p += o.c.data.length; }
    // co64 needs chunk offsets in the track's own chunk order
    chosen.forEach((tr, ti) => {
      const own = order.filter((o) => o.ti === ti);
      const map = new Map(own.map((o, k) => [o.c, offs[ti][k]]));
      offs[ti] = tr.chunks.map((c) => map.get(c));
    });
    const traks = chosen.map((tr, i) => withEdts(makeTrak(tr, i + 1, offs[i], durationMs, delays[i]), tr, delays[i]));
    return box('moov', mvhd(durationMs, chosen.length + 1), ...traks);
  };
  let moov = build(0);
  moov = build(ftyp.length + moov.length + mdatHdr);

  const hdr = new Uint8Array(mdatHdr);
  const hv = dvOf(hdr);
  if (mdatHdr === 16) { hv.setUint32(0, 1); hv.setBigUint64(8, BigInt(dataLen + 16)); } else hv.setUint32(0, dataLen + 8);
  hdr.set([109, 100, 97, 116], 4);

  const parts = [ftyp, moov, hdr, ...order.map((o) => o.c.data)];
  const info = {
    durationMs,
    tracks: chosen.map((t) => ({ kind: t.handler === 'vide' ? 'video' : 'audio', samples: t.samples.length }))
  };
  const blob = typeof Blob !== 'undefined' ? new Blob(parts, { type: 'video/mp4' }) : null;
  return { blob, parts, info };
}

// Quick look at an init segment: which kinds of track it holds.
function mp4Info(u8) {
  try {
    return readInit(u8).map((t) => (t.handler === 'vide' ? 'video' : t.handler === 'soun' ? 'audio' : t.handler));
  } catch (e) { return []; }
}

if (typeof module !== 'undefined') module.exports = { buildMp4, mp4Info, readBoxes };
