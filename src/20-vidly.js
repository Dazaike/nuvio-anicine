'use strict';
// embed.filmu.in embed resolver = byte-identical copy of vidly.js logic (the same Next.js "Vidly" app is served on both hosts), default base switched.
//
// Chain (no cookies, no signing):
//   1. GET <base>/movie/<tmdb> | /tv/<tmdb>/<s>/<e> | /anime/mal/<mal>/<ep>/<sub|dub>   (Referer optional)
//      The RSC payload (self.__next_f) carries a "sealed" blob = the default server's streams, plus a per-page "token".
//      sealed = "v1." + base64url(12 byte nonce + data), XOR keystream seeded with FNV-1a(const key + nonce) (ported below, from the player chunk 259-*.js fn ti()).
//   2. extra servers (optional, 1 fetch each): GET <base>/api/sources?kind=..&provider=<id>&t=<token>&tmdb=..[&s=&e=] -> same sealed format (text body)
// Default = default server (page) + prism + citadel => 3 fetches. flux/nimbus/comet are slow (2.5-4 s) and often empty, only used with opts.servers.

var VIDLY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
var VIDLY_KEY = 'vY7#qL2!mZ9@wK4$';

function vidlyUnseal(str) {
  if (str.slice(0, 3) !== 'v1.') throw new Error('bad payload');
  var b = atob(str.slice(3).replace(/-/g, '+').replace(/_/g, '/'));
  var t = new Uint8Array(b.length), i, e, s, q;
  for (i = 0; i < b.length; i++) t[i] = b.charCodeAt(i);
  var nonce = t.subarray(0, 12), d = t.subarray(12), ks = [];
  for (s = 0; s < 4; s++) {
    var n = (0x811c9dc5 ^ (0x9e3779b9 * s)) >>> 0;
    for (e = 0; e < VIDLY_KEY.length; e++) n = Math.imul(n ^ VIDLY_KEY.charCodeAt(e), 0x1000193) >>> 0;
    for (e = 0; e < nonce.length; e++) n = Math.imul(n ^ nonce[e], 0x1000193) >>> 0;
    ks.push(n);
  }
  var A = ks[0], B = ks[1], C = ks[2], D = ks[3], r = 0, out = '';
  for (q = 0; q < d.length; q++) {
    if ((q & 3) === 0) {
      C >>>= 0; D >>>= 0; A >>>= 0; B >>>= 0;
      var x = (A + B) | 0;
      A = B ^ (B >>> 9);
      B = (C + (C << 3)) | 0;
      C = (C << 21) | (C >>> 11);
      D = (D + 1) | 0;
      x = (x + D) | 0;
      C = (C + x) | 0;
      r = x >>> 0;
    }
    out += String.fromCharCode((d[q] ^ ((r >>> ((q & 3) * 8)) & 255)) & 255);
  }
  try { out = decodeURIComponent(escape(out)); } catch (err) {}
  return JSON.parse(out);
}

function vidlyFetch(url, headers, ms) {
  return new Promise(function (resolve, reject) {
    var done = false, timer = null, ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var opts = { method: 'GET', headers: headers || {} };
    if (ctl) opts.signal = ctl.signal;
    if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { if (!done) { done = true; try { ctl.abort(); } catch (e) {} reject(new Error('timeout')); } }, ms || 8000);
    fetch(url, opts).then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .then(function (x) { if (done) return; done = true; if (timer && typeof clearTimeout === 'function') clearTimeout(timer); resolve(x); },
        function (e) { if (done) return; done = true; if (timer && typeof clearTimeout === 'function') clearTimeout(timer); reject(e); });
  });
}

// Concatenate the RSC flight chunks of the HTML page
function vidlyFlight(html) {
  var re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g, m, out = '';
  while ((m = re.exec(html))) { try { out += JSON.parse('"' + m[1] + '"'); } catch (e) {} }
  return out;
}
function vidlySealedOf(flight) {
  var m = /"sealed":"([^"]*)"/.exec(flight);
  if (!m) return null;
  var v = m[1];
  if (v.slice(0, 3) === 'v1.') return v;
  var ref = /^\$([0-9a-f]+)$/.exec(v);
  if (!ref) return null;
  var t = new RegExp('(?:^|\\n)' + ref[1] + ':T([0-9a-f]+),').exec(flight);
  if (!t) return null;
  var start = t.index + t[0].length, len = parseInt(t[1], 16);
  return flight.substr(start, len);
}

// signed CloudFront-style Policy=<base64url json> (maybe URL-encoded inside the bridge url) -> AWS:EpochTime
function vidlyExpiry(u) {
  try {
    var m = /[?&]Policy=([A-Za-z0-9_~=-]+)/.exec(u);
    if (!m) return null;
    var b = m[1].replace(/-/g, '+').replace(/_/g, '/').replace(/~/g, '=');
    while (b.length % 4) b += '=';
    var e = /EpochTime\\?"?:\s*(\d+)/.exec(atob(b));
    return e ? parseInt(e[1], 10) : null;
  } catch (err) { return null; }
}

function vidlyStreams(payload, extraSubs) {
  var out = [], ss = (payload && payload.streams) || [], pl = (payload && payload.provider && payload.provider.label) || 'Vidly', i, k;
  for (i = 0; i < ss.length; i++) {
    var s = ss[i];
    if (!s || !s.url) continue;
    var subs = [], sl = s.subtitles || [];
    for (k = 0; k < sl.length; k++) if (sl[k] && sl[k].url) subs.push({ url: sl[k].url, lang: sl[k].lang || '', label: sl[k].label || sl[k].lang || '' });
    var kind = s.type === 'mp4' ? 'mp4' : (s.type === 'mkv' ? 'mkv' : 'hls');
    var label = s.label || (pl + ' #' + (i + 1));
    out.push({
      server: label.indexOf(pl) === 0 ? label : pl + ' ' + label,
      url: s.url,
      kind: kind,
      quality: (s.quality || '') + (/h265|hevc/i.test(s.url) ? ' HEVC' : ''),
      headers: {},
      subtitles: subs,
      expires: vidlyExpiry(s.url)
    });
  }
  return out;
}

function resolveVidlyBase(base, id, mediaType, season, episode, opts) {
  opts = opts || {};
  try {
    var path, qs;
    if (mediaType === 'movie') { path = '/movie/' + id; qs = 'kind=movie&tmdb=' + encodeURIComponent(id); }
    else if (mediaType === 'tv') { path = '/tv/' + id + '/' + (season || 1) + '/' + (episode || 1); qs = 'kind=tv&tmdb=' + encodeURIComponent(id) + '&s=' + (season || 1) + '&e=' + (episode || 1); }
    else if (mediaType === 'anime') {
      var audio = opts.audio === 'dub' ? 'dub' : 'sub';
      path = '/anime/mal/' + id + '/' + (episode || 1) + '/' + audio;
      qs = 'kind=anime&mal=' + encodeURIComponent(id) + '&anilist=' + encodeURIComponent(id) + '&e=' + (episode || 1) + '&audio=' + audio;
    } else return Promise.resolve([]);
    var hdr = { 'User-Agent': VIDLY_UA, 'Referer': base + path };
    var wanted = opts.servers || ['prism', 'citadel'];
    var results = [];
    return vidlyFetch(base + path, { 'User-Agent': VIDLY_UA }, 9000).then(function (r) {
      if (r.status !== 200) throw new Error('page ' + r.status);
      var fl = vidlyFlight(r.text), sealed = vidlySealedOf(fl), tok = /"token":"([^"]+)"/.exec(fl);
      if (!sealed) throw new Error('no sealed');
      var first = vidlyUnseal(sealed);
      results = results.concat(vidlyStreams(first, null));
      if (!tok) return results;
      var ids = [], sv = first.servers || [], i;
      for (i = 0; i < wanted.length; i++) {
        var w = wanted[i], ok = false, k;
        for (k = 0; k < sv.length; k++) if (sv[k].id === w) ok = true;
        if (ok && (!first.provider || first.provider.id !== w)) ids.push(w);
      }
      // sequential on purpose: the device runtime serialises fetches anyway
      var chain = Promise.resolve();
      ids.forEach(function (pid) {
        chain = chain.then(function () {
          return vidlyFetch(base + '/api/sources?' + qs + '&provider=' + pid + '&t=' + encodeURIComponent(tok[1]), hdr, 7000)
            .then(function (x) { if (x.status === 200) results = results.concat(vidlyStreams(vidlyUnseal(x.text), null)); }, function () {});
        }).then(null, function () {});
      });
      return chain.then(function () { return results; });
    }).then(function (x) { return x; }, function (e) { if (opts.debug && typeof console !== 'undefined') console.log('vidly fail', e && e.message); return results; });
  } catch (e) { return Promise.resolve([]); }
}

function resolveFilmu(id, mediaType, season, episode, opts) { return resolveVidlyBase('https://embed.filmu.in', id, mediaType, season, episode, opts); }

module.exports = resolveFilmu;
module.exports.resolveVidlyBase = resolveVidlyBase;
