// Reddit Saver background script: on a toolbar click, works out which post, user or
// subreddit the tab shows and opens the results tab for it.
/* global HOSTMAP_TEST */
if (typeof importScripts === 'function') importScripts('hostmap.js');

const HOSTS = ['https://*.reddit.com/*', 'https://i.redd.it/*', 'https://preview.redd.it/*', 'https://external-preview.redd.it/*', 'https://v.redd.it/*'];
const SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best']);
const USER_LISTS = new Set(['submitted', 'saved', 'upvoted']);
const NAME = /^[A-Za-z0-9_-]{2,40}$/;
const SUB = /^[A-Za-z0-9_]{2,30}(\+[A-Za-z0-9_]{2,30})*$/;
const POST_ID = /^[a-z0-9]{4,12}$/;

function parseRedditUrl(u) {
  let x;
  try { x = new URL(u); } catch (e) { return null; }
  const host = x.hostname;
  const isReddit = x.protocol === 'https:' && (host === 'reddit.com' || /^(www|old|new|np|sh)\.reddit\.com$/.test(host));
  if (!isReddit && !(HOSTMAP_TEST && host === '127.0.0.1')) return null;
  // Normal Reddit and old Reddit both answer .json on the same paths.
  const origin = host === 'reddit.com' || host === 'np.reddit.com' || host === 'new.reddit.com' || host === 'sh.reddit.com' ? 'https://www.reddit.com' : x.origin;
  const p = x.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } });
  // Read ?t= by hand (Firefox can't always iterate page objects).
  const tm = /[?&]t=(hour|day|week|month|year|all)(?:&|$)/.exec(x.search);
  const t = tm ? tm[1] : '';
  const post = (id) => (POST_ID.test(id || '') ? { kind: 'post', id, origin } : null);
  if (p[0] === 'comments' || p[0] === 'gallery' || p[0] === 'video') return post(p[1]);
  if (p[0] === 'r' && p[1]) {
    if (!SUB.test(p[1])) return null;
    if (p[2] === 'comments') return post(p[3]);
    if (!p[2]) return { kind: 'sub', sub: p[1], sort: 'hot', t: '', origin };
    if (SORTS.has(p[2]) && p.length === 3) return { kind: 'sub', sub: p[1], sort: p[2], t: p[2] === 'top' || p[2] === 'controversial' ? t : '', origin };
    return null;
  }
  if ((p[0] === 'user' || p[0] === 'u') && p[1]) {
    if (!NAME.test(p[1])) return null;
    if (p[2] === 'comments') return post(p[3]);
    if (!p[2] || p[2] === 'posts') return { kind: 'user', user: p[1], list: 'submitted', origin };
    if (USER_LISTS.has(p[2]) && p.length === 3) return { kind: 'user', user: p[1], list: p[2], origin };
    return null;
  }
  return null;
}

async function openResults(query, tab) {
  await chrome.tabs.create({ url: chrome.runtime.getURL('results.html?' + query), index: tab && tab.index != null ? tab.index + 1 : undefined });
}

async function startJob(tab) {
  const target = parseRedditUrl((tab && tab.url) || '');
  if (!target) return openResults('help=wrong', tab);
  const id = 'job_' + Date.now();
  await chrome.storage.local.set({ [id]: { ...target, tabId: tab.id, tabOrigin: new URL(tab.url).origin, source: tab.url, created: Date.now() } });
  return openResults('job=' + id, tab);
}

chrome.action.onClicked.addListener(async (tab) => {
  // Firefox lets people switch off site access, so ask again if needed.
  // Asked straight away (no await first) so Firefox still counts it as the user's click.
  // Nothing is shown when access is already there.
  try {
    if (!(await chrome.permissions.request({ origins: HOSTS }))) return openResults('help=access', tab);
  } catch (e) { /* not supported: nothing to ask */ }
  startJob(tab);
});

if (typeof module !== 'undefined') module.exports = { parseRedditUrl };
