// megaplay.buzz anime resolver (MAL id) - ES5, QuickJS-safe. Never rejects.
// Chain: GET /stream/mal/{mal}/{ep}/{sub|dub} (needs Referer) -> data-id
//        GET /stream/getSources?id= (needs Referer+XHR header) -> {enc, tracks}
//        enc = AES-256-CBC (zero-padded key/iv, b64url) -> {file: master.m3u8}
// The master is multi-audio on newer shows; "?t=sub|dub" picks the default audio rendition.
var MP_BASE = 'https://megaplay.buzz';
var MP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function mpFetch(url, headers, ms) {
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = null;
  if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ms || 8000);
  var opts = { headers: headers };
  if (ctl) opts.signal = ctl.signal;
  return fetch(url, opts).then(function (r) {
    return r.text().then(function (t) { if (timer) clearTimeout(timer); return { status: r.status, text: t }; });
  }, function (e) { if (timer) clearTimeout(timer); throw e; });
}

function mpDecrypt(enc) {
  var CryptoJS = require('crypto-js');
  function pad(s, n) { var b = s; while (b.length < n) b += '\u0000'; return b.substring(0, n); }
  var key = CryptoJS.enc.Utf8.parse(pad('i?LMTAx0Q6,:}50U', 32));
  var iv = CryptoJS.enc.Utf8.parse(pad("W0;27ToaUpl_P%'c", 16));
  var b64 = String(enc).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  var out = CryptoJS.AES.decrypt({ ciphertext: CryptoJS.enc.Base64.parse(b64) }, key, { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
  return JSON.parse(CryptoJS.enc.Utf8.stringify(out));
}

// one subtitle per language (non-forced), vtt preferred over ass; English first
function mpSubs(tr) {
  var best = {}, order = [], i;
  for (i = 0; i < tr.length; i++) {
    var t = tr[i];
    if (t.kind !== 'captions' || !t.file || /forced/i.test(t.label || '')) continue;
    var lab = String(t.label || '');
    var key = lab.replace(/\s*\(.*\)\s*/, '').replace(/\s+\d+$/, '').toLowerCase();
    var isVtt = /\.vtt(\?|$)/i.test(t.file);
    var cur = best[key];
    if (!cur) { best[key] = { url: t.file, lang: key.substring(0, 2), label: lab, vtt: isVtt }; order.push(key); }
    else if (isVtt && !cur.vtt) { best[key] = { url: t.file, lang: key.substring(0, 2), label: lab, vtt: true }; }
  }
  var out = [];
  for (i = 0; i < order.length; i++) { var o = best[order[i]]; out.push({ url: o.url, lang: o.lang, label: o.label }); }
  out.sort(function (a, b) { return (b.label === 'English') - (a.label === 'English'); });
  return out;
}

function resolveMegaplay(mal, mediaType, season, episode, opts) {
  var lang = (opts && opts.lang === 'dub') ? 'dub' : 'sub';
  var page = MP_BASE + '/stream/mal/' + mal + '/' + episode + '/' + lang;
  var hdr = { 'User-Agent': MP_UA, 'Referer': 'https://anicine.sbs/' };
  return mpFetch(page, hdr).then(function (r) {
    var m = /data-id="(\d+)"/.exec(r.text);
    if (r.status !== 200 || !m) return [];
    var xh = { 'User-Agent': MP_UA, 'Referer': page, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' };
    return mpFetch(MP_BASE + '/stream/getSources?id=' + m[1] + '&platform=OTHER&st=other', xh).then(function (s) {
      var j = JSON.parse(s.text);
      if (!j || !j.enc) return [];
      var f = mpDecrypt(j.enc);
      if (!f || !f.file) return [];
      var subs = mpSubs(j.tracks || []);
      var url = f.file + (f.file.indexOf('?') < 0 ? '?' : '&') + 't=' + lang;
      return [{ server: 'MegaPlay', url: url, kind: 'hls', quality: '', headers: { 'Referer': MP_BASE + '/', 'User-Agent': MP_UA }, subtitles: subs, expires: null }];
    });
  }).then(function (x) { return x; }, function () { return []; });
}
module.exports = resolveMegaplay;
