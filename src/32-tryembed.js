// tryembed.us.cc anime resolver (MAL id) - ES5, QuickJS-safe. Never rejects.
// Chain (3 fetches): GET embed page (sets session cookies; has __TE_KEY + BOOTSTRAP_TICKET)
//   -> POST /api/bootstrap (X-TryEmbed-Bootstrap: ticket, Cookie, Referer=page) -> AES-256-CBC json (key hex, iv b64)
//   -> providers[astra].qualities[0].token -> GET /s/{token}.m3u8 (Cookie+Referer+Origin) = master pointing at
//      sora.anixx.cloud variant playlist whose URL/segments are self-contained signed tokens (no headers needed).
var TE_BASE = 'https://tryembed.us.cc';
var TE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function teFetch(url, opts, ms) {
  opts = opts || {};
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = null;
  if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ms || 8000);
  if (ctl) opts.signal = ctl.signal;
  return fetch(url, opts).then(function (r) {
    return r.text().then(function (t) { if (timer) clearTimeout(timer); return { status: r.status, text: t, headers: r.headers }; });
  }, function (e) { if (timer) clearTimeout(timer); throw e; });
}

// "a=1; Path=/; ..., b=2; Path=/..." -> "a=1; b=2"
function teCookies(h) {
  var raw = h && h.get ? (h.get('set-cookie') || '') : '';
  var parts = raw.split(/,(?=\s*[A-Za-z0-9_.-]+=)/), out = [];
  for (var i = 0; i < parts.length; i++) { var p = parts[i].replace(/^\s+/, '').split(';')[0]; if (p && p.indexOf('=') > 0) out.push(p); }
  return out;
}
function teMerge(a, b) {
  var map = {}, order = [], all = a.concat(b), i;
  for (i = 0; i < all.length; i++) { var k = all[i].split('=')[0]; if (!(k in map)) order.push(k); map[k] = all[i]; }
  var o = []; for (i = 0; i < order.length; i++) o.push(map[order[i]]);
  return o.join('; ');
}

function teDecrypt(d, keyHex) {
  var C = require('crypto-js');
  var out = C.AES.decrypt({ ciphertext: C.enc.Base64.parse(d.data) }, C.enc.Hex.parse(keyHex), { iv: C.enc.Base64.parse(d.iv), mode: C.mode.CBC, padding: C.pad.Pkcs7 });
  return JSON.parse(C.enc.Utf8.stringify(out));
}

function resolveTryembed(mal, mediaType, season, episode, opts) {
  var lang = (opts && opts.lang === 'dub') ? 'dub' : 'sub';
  var page = TE_BASE + '/embed/anime/mal/' + mal + '/' + episode + '/' + lang;
  return teFetch(page, { headers: { 'User-Agent': TE_UA } }).then(function (r) {
    var key = /__TE_KEY="([0-9a-f]+)"/.exec(r.text), tk = /BOOTSTRAP_TICKET="([^"]+)"/.exec(r.text);
    if (r.status !== 200 || !key || !tk) return [];
    var ck1 = teCookies(r.headers);
    return teFetch(TE_BASE + '/api/bootstrap', { method: 'POST', headers: { 'User-Agent': TE_UA, 'X-TryEmbed-Bootstrap': tk[1], 'Cookie': ck1.join('; '), 'Referer': page, 'Origin': TE_BASE } }).then(function (b) {
      var d = JSON.parse(b.text);
      var j = d && d._enc === 1 ? teDecrypt(d, key[1]) : d;
      var p = j && j.selectedProvider;
      if (!p || p.status !== 'ready' || !p.qualities || !p.qualities.length) return [];
      var q = p.qualities[0];
      if (!q.token) return [];
      var cookie = teMerge(ck1, teCookies(b.headers));
      var hdr = { 'Cookie': cookie, 'Referer': page, 'Origin': TE_BASE, 'User-Agent': TE_UA };
      var proxied = TE_BASE + '/s/' + q.token + '.m3u8';
      var subs = [], i, caps = p.captions || [];
      for (i = 0; i < caps.length; i++) if (caps[i].url && !/forced|\bCC\b/i.test(caps[i].label || '')) subs.push({ url: caps[i].url, lang: caps[i].lang || '', label: caps[i].label || '' });
      return teFetch(proxied, { headers: hdr }).then(function (m) {
        var inner = null, mm = /^(https?:\/\/\S+)/m.exec(m.text);
        if (m.status === 200 && mm) inner = mm[1];
        var h = /RESOLUTION=\d+x(\d+)/.exec(m.text);
        var quality = h ? h[1] + 'p' : '';
        if (inner) return [{ server: p.name || 'Astra', url: inner, kind: 'hls', quality: quality, headers: {}, subtitles: subs, expires: null }];
        return [{ server: p.name || 'Astra', url: proxied, kind: 'hls', quality: quality, headers: hdr, subtitles: subs, expires: null }];
      });
    });
  }).then(function (x) { return x; }, function () { return []; });
}
module.exports = resolveTryembed;
