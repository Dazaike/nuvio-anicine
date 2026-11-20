// zokoanime.video anime resolver (MAL id) - ES5, QuickJS-safe. Never rejects. 1 fetch.
// Page embeds window.__P = base64(xor("otaku-embed-v1", json)); json.src is the master.m3u8 (needs Referer zokoanime.video).
var ZK_BASE = 'https://zokoanime.video';
var ZK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function zkDecode(b64) {
  var key = 'otaku-embed-v1', raw = atob(b64), o = '', i;
  for (i = 0; i < raw.length; i++) o += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return JSON.parse(decodeURIComponent(escape(o)));
}

function resolveZokoanime(mal, mediaType, season, episode, opts) {
  var lang = (opts && opts.lang === 'dub') ? 'dub' : 'sub';
  var page = ZK_BASE + '/stream/mal/' + mal + '/' + episode + '/' + lang;
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = null;
  if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 8000);
  var o = { headers: { 'User-Agent': ZK_UA } };
  if (ctl) o.signal = ctl.signal;
  return fetch(page, o).then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); }).then(function (r) {
    if (timer) clearTimeout(timer);
    var m = /window\.__P="([^"]+)"/.exec(r.text);
    if (r.status !== 200 || !m) return [];
    var d = zkDecode(m[1]);
    if (!d || !d.src) return [];
    var subs = [], i, st = d.subtitles || [];
    for (i = 0; i < st.length; i++) if (st[i].src && !/forced|\bCC\b|SDH/i.test(st[i].label || '')) subs.push({ url: st[i].src, lang: st[i].lang || '', label: st[i].label || '' });
    subs.sort(function (a, b) { return (b.lang === 'en') - (a.lang === 'en'); });
    return [{ server: 'ZokoAnime', url: d.src, kind: 'hls', quality: '', headers: { 'Referer': ZK_BASE + '/', 'User-Agent': ZK_UA }, subtitles: subs, expires: null }];
  }).then(function (x) { return x; }, function () { if (timer) clearTimeout(timer); return []; });
}
module.exports = resolveZokoanime;
