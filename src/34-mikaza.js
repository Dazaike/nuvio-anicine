// mikaza.buzz (haiku/animesalt) Hindi anime resolver (MAL id) - ES5, QuickJS-safe. Never rejects. 2 fetches.
// GET /embed/haiku/mal/{mal}/{ep}/hin -> window.__YUME_PLAYER_CONFIG__.resolve (signed ?resolve=1&rs=...)
// GET resolve -> {src:'/p/<token>/video.mp4'} (same-origin mp4, seekable via Range, no headers needed)
// Language is Hindi ('hin'); the embed also accepts sub/dub but those mp4s ignore Range start (unseekable), so they are not returned.
var MK_BASE = 'https://mikaza.buzz';
var MK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function mkFetch(url, headers) {
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = null;
  if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 8000);
  var o = { headers: headers };
  if (ctl) o.signal = ctl.signal;
  return fetch(url, o).then(function (r) {
    return r.text().then(function (t) { if (timer) clearTimeout(timer); return { status: r.status, text: t }; });
  }, function (e) { if (timer) clearTimeout(timer); throw e; });
}

function resolveMikaza(mal, mediaType, season, episode, opts) {
  var page = MK_BASE + '/embed/haiku/mal/' + mal + '/' + episode + '/hin';
  return mkFetch(page, { 'User-Agent': MK_UA }).then(function (r) {
    var m = /resolve:\s*"([^"]+)"/.exec(r.text);
    if (r.status !== 200 || !m) return [];
    return mkFetch(MK_BASE + m[1].replace(/&amp;/g, '&'), { 'User-Agent': MK_UA, 'Referer': page, 'Accept': 'application/json' }).then(function (s) {
      if (s.status !== 200) return [];
      var j = JSON.parse(s.text);
      if (!j || !j.src || (j.source && j.source.resolvedLanguage !== 'hin')) return [];
      var url = /^https?:/.test(j.src) ? j.src : MK_BASE + j.src;
      return [{ server: 'Mikaza (Hindi)', url: url, kind: 'mp4', quality: '', headers: {}, subtitles: [], expires: null }];
    });
  }).then(function (x) { return x; }, function () { return []; });
}
module.exports = resolveMikaza;
