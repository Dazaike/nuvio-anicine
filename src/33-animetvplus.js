// embed.animetvplus.site anime resolver (MAL id) - ES5, QuickJS-safe. Never rejects. 2 fetches. Japanese audio + soft subs only (no dub).
// GET /home/embed/mal/{mal}/{ep} -> <script id="state-data"> json {src:'https://uqload.vc/embed-xxx.html', status}
// GET uqload embed (p,a,c,k,e,d packed) -> unpack -> jwplayer sources[0].file = signed master.m3u8 (no headers needed; a foreign Referer returns a decoy)
var AT_BASE = 'https://embed.animetvplus.site';
var AT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function atFetch(url, headers) {
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = null;
  if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 8000);
  var o = { headers: headers };
  if (ctl) o.signal = ctl.signal;
  return fetch(url, o).then(function (r) {
    return r.text().then(function (t) { if (timer) clearTimeout(timer); return { status: r.status, text: t }; });
  }, function (e) { if (timer) clearTimeout(timer); throw e; });
}

function atUnpack(html) {
  var m = /\}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\)/.exec(html);
  if (!m) return null;
  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'), a = +m[2], c = +m[3], k = m[4].split('|');
  function tok(n) { return (n < a ? '' : tok(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36)); }
  while (c--) if (k[c]) p = p.replace(new RegExp('\\b' + tok(c) + '\\b', 'g'), k[c]);
  return p;
}

function resolveAnimetvplus(mal, mediaType, season, episode, opts) {
  if (opts && opts.lang === 'dub') return Promise.resolve([]);
  var page = AT_BASE + '/home/embed/mal/' + mal + '/' + episode;
  return atFetch(page, { 'User-Agent': AT_UA }).then(function (r) {
    var m = /id="state-data">([\s\S]*?)<\/script>/.exec(r.text);
    if (r.status !== 200 || !m) return [];
    var S = JSON.parse(m[1]);
    if (!S || S.status !== 'ready' || !S.src || S.source !== 'uqload') return [];
    return atFetch(S.src, { 'User-Agent': AT_UA }).then(function (e) {
      var u = atUnpack(e.text);
      var f = u && /file:"(https:[^"]+master\.m3u8[^"]*)"/.exec(u);
      if (!f) return [];
      var subs = [], re = /\{file:"([^"]+)",label:"([^"]+)",kind:"captions"/g, t;
      while ((t = re.exec(u))) if (t[1].indexOf("/srt/") < 0 && t[1].indexOf("http") === 0) subs.push({ url: t[1], lang: t[2].toLowerCase().substring(0, 2), label: t[2] });
      var exp = /[?&]s=(\d+)&e=(\d+)/.exec(f[1]);
      return [{ server: 'AnimeTVPlus (Uqload)', url: f[1], kind: 'hls', quality: '1080p', headers: {}, subtitles: subs, expires: exp ? (+exp[1]) + (+exp[2]) : null }];
    });
  }).then(function (x) { return x; }, function () { return []; });
}
module.exports = resolveAnimetvplus;
