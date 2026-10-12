// Reddit Saver: reads a post, a user's posts or a subreddit from Reddit's own .json pages
// and lists their pictures, galleries and videos for the results page.
// The .json pages are read inside the Reddit tab, so they come with the person's own
// Reddit sign-in and settings, exactly as the site would load them.
/* exported SITE */
/* global buildMp4 */
const PAGE_PAUSE = 1000; // ms between pages, to stay well inside Reddit's limits
const PAGE_SIZE = 100;

function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('stopped')); }, { once: true });
  });
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayOf = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '');
// Reddit escapes & as &amp; in addresses unless raw_json=1 is used: undo it either way.
const unesc = (u) => String(u || '').replace(/&amp;/g, '&');

// Runs fetch inside the Reddit tab (the page's own origin and sign-in). Returns { status, text }.
async function inTab(tabId, path) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (p) => {
      try {
        const res = await fetch(p, { credentials: 'include', headers: { Accept: 'application/json' } });
        return { status: res.status, reset: res.headers.get('x-ratelimit-reset') || '', text: res.ok ? await res.text() : '' };
      } catch (e) { return { status: 0, reset: '', text: '', error: String(e && e.message || e) }; }
    },
    args: [path]
  });
  if (!r || !r.result) throw new Error('no answer from the Reddit tab');
  return r.result;
}

// The tab is used while it still shows the same Reddit site; if it was closed or moved
// on, the request is sent from here instead (still with the Reddit sign-in cookies).
async function tabUsable(job) {
  if (job.tabId == null) return false;
  try {
    const t = await chrome.tabs.get(job.tabId);
    return !!t && typeof t.url === 'string' && t.url.startsWith((job.tabOrigin || job.origin) + '/');
  } catch (e) { return false; }
}

async function redditJson(job, path, signal) {
  for (let i = 0; ; i++) {
    if (signal.aborted) throw new Error('stopped');
    let r;
    if (await tabUsable(job)) {
      r = await inTab(job.tabId, path);
    } else {
      const res = await fetch(job.origin + path, { credentials: 'include', signal });
      r = { status: res.status, reset: res.headers.get('x-ratelimit-reset') || '', text: res.ok ? await res.text() : '' };
    }
    if (r.status === 200) {
      try { return JSON.parse(r.text); } catch (e) { throw new Error('Reddit sent a page that isn\'t JSON (are you signed in?)'); }
    }
    if ((r.status === 429 || r.status >= 500 || r.status === 0) && i < 3) {
      const wait = r.reset ? Math.min(60000, Math.max(1000, Number(r.reset) * 1000)) : 3000 * (i + 1);
      await sleep(wait, signal);
      continue;
    }
    if (r.status === 403) throw new Error('403 private or blocked');
    if (r.status === 404) throw new Error('404 not found');
    throw new Error(r.status ? 'HTTP ' + r.status : (r.error || 'network error'));
  }
}

// ---------- Turning a post into files ----------
const EXT = { 'image/jpg': 'jpg', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

// preview.redd.it/<id>.<ext>?width=...&s=... is a resized copy of i.redd.it/<id>.<ext>.
function iredd(u) {
  const m = /^https:\/\/preview\.redd\.it\/(?:[^/?#]*-)?([A-Za-z0-9]{6,20})\.(jpe?g|png|gif|webp)(?:[?#]|$)/.exec(unesc(u));
  return m ? `https://i.redd.it/${m[1]}.${m[2]}` : '';
}
const mediaId = (u) => (/\/(?:[^/?#]*-)?([A-Za-z0-9]{6,20})\.(?:jpe?g|png|gif|webp|mp4)(?:[?#]|$)/.exec(unesc(u)) || [])[1] || '';
const onReddit = (u) => /^https:\/\/(i|preview|external-preview|v)\.redd\.it\//.test(u);

// A small copy (about 320-640 wide) for the grid, from a list of {u|url, x|width}.
function smallOf(list) {
  const l = (list || []).map((r) => ({ u: unesc(r.u || r.url), w: r.x || r.width || 0 })).filter((r) => onReddit(r.u));
  return (l.find((r) => r.w >= 320) || l[l.length - 1] || {}).u || '';
}

function videoOf(post) {
  const rv = (post.secure_media && post.secure_media.reddit_video) || (post.media && post.media.reddit_video);
  if (rv) return rv;
  // Links to GIF and video sites: Reddit keeps its own copy on v.redd.it.
  return (post.preview && post.preview.reddit_video_preview) || null;
}

function mediaOf(post0, opts) {
  // A crosspost holds the original post's media.
  const post = (post0.crosspost_parent_list && post0.crosspost_parent_list[0]) || post0;
  const out = [];
  const permalink = 'https://www.reddit.com' + (post0.permalink || `/comments/${post0.id}/`);
  const meta = {
    id: post0.id, sub: post0.subreddit || '', author: post0.author || 'deleted',
    date: dayOf(post0.created_utc), title: post0.title || '', url: permalink,
    nsfw: !!post0.over_18, from: post !== post0 ? `r/${post.subreddit} by u/${post.author}` : ''
  };
  const add = (x) => {
    const n = out.length + 1;
    out.push({ ...x, key: post0.name + '#' + n, n, post: meta, caption: (x.caption ? x.caption + ' | ' : '') + meta.title.slice(0, 160) });
  };
  const img0 = post.preview && post.preview.images && post.preview.images[0];

  // 1. Gallery: every picture, from media_metadata in gallery_data order.
  if (post.is_gallery && post.media_metadata) {
    const order = ((post.gallery_data && post.gallery_data.items) || []).map((i) => ({ id: i.media_id, caption: i.caption || '' }));
    const ids = order.length ? order : Object.keys(post.media_metadata).map((id) => ({ id, caption: '' }));
    for (const { id, caption } of ids) {
      const m = post.media_metadata[id];
      if (!m || m.status !== 'valid' || !m.s) continue;
      const ext = EXT[m.m] || 'jpg';
      if (m.e === 'AnimatedImage') {
        const gif = unesc(m.s.gif);
        add({ kind: 'image', thumb: smallOf(m.p), cands: [gif, `https://i.redd.it/${id}.gif`].filter(onReddit), w: m.s.x || 0, h: m.s.y || 0, alt: caption, mime: 'image/gif', dupKey: id, caption });
      } else if (m.e === 'RedditVideo' && (m.dashUrl || m.hlsUrl)) {
        add({ kind: 'video', src: 'dash', url: unesc(m.dashUrl), hls: unesc(m.hlsUrl), fallback: '', poster: '', w: m.x || 0, h: m.y || 0, dur: 0, gif: !!m.isGif, dupKey: 'v_' + (m.id || id), alt: caption, caption });
      } else if (m.e === 'Image') {
        add({ kind: 'image', thumb: smallOf(m.p), cands: [`https://i.redd.it/${id}.${ext}`, unesc(m.s.u)].filter(onReddit), w: m.s.x || 0, h: m.s.y || 0, alt: caption, mime: m.m || '', dupKey: id, caption });
      }
    }
    return out;
  }

  // 2. Reddit-hosted video (v.redd.it): DASH, video and sound joined into one MP4.
  const rv = videoOf(post);
  if (rv && (rv.dash_url || rv.hls_url || rv.fallback_url)) {
    const id = (/v\.redd\.it\/([A-Za-z0-9]+)/.exec(unesc(rv.fallback_url || rv.dash_url || rv.hls_url)) || [])[1] || post.id;
    add({
      kind: 'video', src: 'dash', url: unesc(rv.dash_url), hls: unesc(rv.hls_url), fallback: unesc(rv.fallback_url),
      poster: img0 ? smallOf(img0.resolutions) || unesc(img0.source.url) : '', w: rv.width || 0, h: rv.height || 0,
      dur: rv.duration || 0, audio: rv.has_audio === false ? false : undefined, gif: !!rv.is_gif, dupKey: 'v_' + id, alt: ''
    });
    return out;
  }

  // 3. A single picture: the uploaded original on i.redd.it, or Reddit's copy of a picture on another site.
  const url = unesc(post.url_overridden_by_dest || post.url);
  const isImg = post.post_hint === 'image' || /^https:\/\/i\.redd\.it\/[A-Za-z0-9]+\.(jpe?g|png|gif|webp)$/.test(url);
  if (isImg && img0 && img0.source) {
    const src = unesc(img0.source.url);
    const gifSrc = img0.variants && img0.variants.gif && unesc(img0.variants.gif.source.url);
    if (/^https:\/\/i\.redd\.it\//.test(url)) {
      add({ kind: 'image', thumb: smallOf(img0.resolutions), cands: [url, iredd(src), src].filter(Boolean), w: img0.source.width, h: img0.source.height, alt: '', mime: '', dupKey: mediaId(url) });
    } else if (opts.external !== false) {
      // Hosted elsewhere (e.g. Imgur): Reddit's full-size copy on external-preview.redd.it.
      add({ kind: 'image', thumb: smallOf(img0.resolutions), cands: [gifSrc && /\.gif/i.test(url) ? gifSrc : src].filter(onReddit), w: img0.source.width, h: img0.source.height, alt: '', mime: '', dupKey: img0.id || mediaId(src), external: url });
    }
  } else if (isImg && /^https:\/\/i\.redd\.it\//.test(url)) {
    add({ kind: 'image', thumb: '', cands: [url], w: 0, h: 0, alt: '', mime: '', dupKey: mediaId(url) });
  }
  return out;
}

// Reddit's sound file sits next to the video file, under one of a few names.
const AUDIO_NAMES = ['CMAF_AUDIO_128.mp4', 'CMAF_AUDIO_64.mp4', 'DASH_AUDIO_128.mp4', 'DASH_AUDIO_64.mp4', 'DASH_audio.mp4', 'audio'];
async function joinFallback(it, onProgress) {
  const getU8 = async (u) => {
    const r = await fetch(u, { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  };
  const v = await getU8(it.fallback);
  if (onProgress) onProgress(1, 2);
  let a = null;
  if (it.audio !== false) {
    const base = it.fallback.replace(/[^/]*$/, '');
    for (const n of AUDIO_NAMES) { try { a = await getU8(base + n); break; } catch (e) { /* try the next name */ } }
  }
  if (onProgress) onProgress(2, 2);
  const streams = [{ init: null, pieces: [v] }];
  if (a) streams.push({ init: null, pieces: [a] });
  return { blob: buildMp4(streams).blob, ext: 'mp4' };
}

// ---------- Site description for the results page ----------
const SORT_WORD = { hot: 'hot', new: 'new', top: 'top', rising: 'rising', controversial: 'controversial', best: 'best' };
const T_WORD = { hour: 'past hour', day: 'today', week: 'this week', month: 'this month', year: 'this year', all: 'all time' };

const SITE = {
  key: 'rs',
  name: 'Reddit Saver',
  credentials: 'omit',
  legal: 'Reddit Saver is an independent tool, not made by or affiliated with Reddit, Inc. It only reads posts you can already see on Reddit. The pictures and videos belong to the people who posted them: only save what you have the right to keep.',
  options: [
    { id: 'max', label: 'How many', value: 250, reload: true, when: (job) => job.kind !== 'post',
      choices: [[50, '50 posts'], [100, '100 posts'], [250, '250 posts'], [500, '500 posts'], [1000, '1,000 posts (Reddit\'s limit)']] },
    { id: 'external', type: 'check', label: 'Pictures linked from other sites (Reddit\'s copy)', value: true, reload: true },
    { id: 'csv', type: 'check', label: 'Add a CSV of titles and links', value: false }
  ],
  help: {
    how: ['Reddit Saver', 'Open a Reddit post, a user\'s profile or a subreddit, then click the Reddit Saver icon in the toolbar. Reddit Saver lists every picture, gallery and video so you can pick what to download.'],
    wrong: ['Open a Reddit post, user or subreddit', 'Reddit Saver works on reddit.com posts, user profiles (reddit.com/user/name) and subreddits (reddit.com/r/name), on new or old Reddit. Open one, then click the Reddit Saver icon again.'],
    access: ['Reddit Saver needs permission', 'Reddit Saver needs access to reddit.com and Reddit\'s picture and video servers (i.redd.it, preview.redd.it, external-preview.redd.it and v.redd.it). Click the icon again and choose Allow.'],
    expired: ['This download has expired', 'Click the Reddit Saver icon on the Reddit page again to start a new one.'],
    empty: ['No pictures or videos found', 'Reddit Saver didn\'t find any pictures, galleries or Reddit videos in these posts. Videos from YouTube and other sites, and text posts, are left out.']
  },
  describe: (job) => job.kind === 'post' ? 'Reddit post ' + job.id
    : job.kind === 'user' ? `u/${job.user}${job.list !== 'submitted' ? ' (' + job.list + ')' : ''}`
      : `r/${job.sub}, ${SORT_WORD[job.sort] || job.sort}${job.t ? ' ' + T_WORD[job.t] : ''}`,
  // Account (or subreddit) plus today's date, e.g. r-pics_top_2026-10-13.zip
  zipName: (job) => job.kind === 'post' ? `u-${job.author || 'reddit'}_${job.id}_${today()}`
    : job.kind === 'user' ? `u-${job.user}${job.list !== 'submitted' ? '_' + job.list : ''}_${today()}`
      : `r-${job.sub}_${job.sort}${job.t ? '-' + job.t : ''}_${today()}`,
  fileBase: (it) => `${it.post.author}_${it.post.date || 'undated'}_${it.post.id}_${it.n}`,
  csvColumns: ['subreddit', 'author', 'date', 'post_url', 'post_id', 'title', 'type', 'width', 'height', 'caption', 'linked_from', 'crosspost_of', 'nsfw'],
  csvRow: (it) => [it.post.sub, it.post.author, it.post.date, it.post.url, it.post.id, it.post.title, it.kind, it.w || '', it.h || '', it.alt || '', it.external || '', it.post.from, it.post.nsfw ? 'yes' : ''],
  explainError: (msg) => /403|private|blocked/i.test(msg)
    ? 'Reddit refused to show these posts. The subreddit may be private or banned, or you may need to sign in to Reddit in this browser first.'
    : /404|not found/i.test(msg) ? 'Reddit couldn\'t find this post, user or subreddit. Check the address and try again.'
      : `Reddit's server said: ${msg}. Try again in a minute.`,

  async videoSources(it) {
    const list = [];
    if (it.url) list.push({ src: 'dash', url: it.url });
    if (it.hls) list.push({ src: 'hls', url: it.hls });
    if (it.fallback) list.push({ src: 'custom', url: it.fallback, get: (p) => joinFallback(it, p) });
    return list;
  },

  async load(ctx) {
    const { job, opts, signal } = ctx;
    if (job.kind === 'post') {
      ctx.status('Reading the post...', 0);
      const res = await redditJson(job, `/comments/${job.id}.json?raw_json=1&limit=1`, signal);
      const child = res && res[0] && res[0].data && res[0].data.children && res[0].data.children[0];
      if (!child || child.kind !== 't3') throw new Error('404 not found');
      const p = child.data;
      job.author = p.author;
      ctx.title(`r/${p.subreddit}: ${p.title.slice(0, 90)}`);
      ctx.emit(mediaOf(p, opts));
      ctx.status('1 post', 1);
      return;
    }
    const base = job.kind === 'user' ? `/user/${job.user}/${job.list}.json` : `/r/${job.sub}/${job.sort}.json`;
    const extra = job.kind === 'user' ? '&sort=new' : job.t ? '&t=' + job.t : '';
    const max = opts.max || 1000;
    let after = '', posts = 0, read = 0, pages = 0;
    const seen = new Set();
    ctx.status('Reading posts...', 0);
    while (read < max) {
      const page = await redditJson(job, `${base}?raw_json=1&limit=${Math.min(PAGE_SIZE, max - read)}${extra}${after ? '&after=' + after : ''}`, signal);
      pages++;
      const kids = (page && page.data && page.data.children) || [];
      const found = [];
      for (const c of kids) {
        if (c.kind !== 't3' || seen.has(c.data.name)) continue; // comments in a user's saved list are skipped
        seen.add(c.data.name);
        read++;
        const media = mediaOf(c.data, opts);
        if (media.length) { posts++; found.push(...media); }
      }
      ctx.emit(found);
      ctx.status(`${read} posts read, ${posts} with pictures or videos`, Math.min(1, read / max));
      after = page && page.data && page.data.after;
      if (!after || !kids.length) break;
      await sleep(PAGE_PAUSE, signal);
    }
    ctx.status(`${read} posts read in ${pages} page${pages === 1 ? '' : 's'}, ${posts} with pictures or videos`, 1);
  }
};
