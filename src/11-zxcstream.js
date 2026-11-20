// resolveZxcstream: https://zxcstream.cc/player/{movie/<tmdb> | tv/<tmdb>/<s>/<e>}
// Same Next.js player family as vidstuck.cc (same AES key, same server names) with different field names / routes:
//   0. GET  /backend/imdb/details/{movie|tv}/<id>?language=en-US     -> title, release_date, last_air_date, imdb_id   (skipped when opts.meta given)
//   1. POST /backend/andromeda  {id, mediaType, path[, season, episode]}  -> { ts, token }      (one token per server; no 'meow' needed here)
//   2. GET  /backend_/sources/<server>?<fields>&ts&token&title&year&date[&imdb]  -> { links:[{type,link(AES),resolution}], subtitles, dubs }
//   link = CryptoJS.AES.decrypt(link, KEY). Several servers hand out proxy links on vidstuck.cc (same files as the vidstuck module).
// Some servers (atlas) 403 unless Referer is the embed page itself (https://zxcstream.cc/player/...); sent on every call.
// Fetches run strictly one after another (device runtime serialises them). Plain ES5; never rejects.

var ZX_ORIGIN = 'https://zxcstream.cc';
var ZX_KEY = '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c';
var ZX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
var ZX_TIMEOUT = 8000;
var ZX_F = { id: 'a7f39c821d604e5b91e57b', mediaType: 'c81306d28147a35632e816b', path: '6b491e258392e7561a9384c', ts: '61d9a5274c8e3b2f38291e6',
  token: 'c492f7a183d01e36c538a716d', title: '5e28c9147a06de29f3674b392a1', year: 'b731e6c94f867f8341c306e', date: 'e16493139e5814b3027',
  season: 'd8427b5c382f957c3613e85b', episode: '91c6ea75d1f785c92346b713d', imdbId: 'f35a8194265e871c4933a725f', latestDate: 'e953416ad739e5814b3027' };
// server id -> display name used by the embed UI
var ZX_SERVERS = { valstrax: 'Valstrax II', orion: 'Orion I', atlas: 'Atlas III', ursa: 'Ursa IV', alatreon: 'Alatreon V', daedalus: 'Daedalus VI', resshin: 'Resshin' };

function zxCrypto() { try { return require('crypto-js'); } catch (e) { return null; } }

function zxFetch(url, opts) {
  var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = null;
  if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ZX_TIMEOUT);
  var o = opts || {};
  if (ctl) o.signal = ctl.signal;
  return fetch(url, o).then(function (r) {
    return r.text().then(function (t) { if (timer) clearTimeout(timer); return { status: r.status, text: t }; });
  }, function (e) { if (timer) clearTimeout(timer); throw e; });
}
function zxJson(r) { try { return JSON.parse(r.text); } catch (e) { return null; } }
function zxHdr(type, id, season, episode) {
  var page = ZX_ORIGIN + '/player/' + (type === 'tv' ? 'tv/' + id + '/' + season + '/' + episode : 'movie/' + id);
  return { 'User-Agent': ZX_UA, 'Accept': 'application/json, text/plain, */*', 'Referer': page };
}

function zxDecryptLink(C, link) {
  var c = link;
  if (c.indexOf('xArD_') === 0) c = C.enc.Utf8.stringify(C.enc.Base64.parse(c.slice(5)));
  return C.AES.decrypt(c, ZX_KEY).toString(C.enc.Utf8);
}

function zxDetails(type, id, hdr) {
  return zxFetch(ZX_ORIGIN + '/backend/imdb/details/' + type + '/' + encodeURIComponent(id) + '?language=en-US', { headers: hdr }).then(function (r) {
    var d = r.status === 200 ? zxJson(r) : null;
    if (!d) return null;
    var date = d.release_date ? String(d.release_date) : '';
    var yr = date ? String(new Date(date).getFullYear()) : '';
    return { title: d.title || d.name || '', year: yr, date: date, latest: d.last_air_date || '', imdb: d.imdb_id || '' };
  });
}

function zxServer(server, type, id, season, episode, meta, dub, hdr) {
  var f = ZX_F;
  var body = {}; body[f.id] = String(id); body[f.mediaType] = type; body[f.path] = server;
  if (type === 'tv') { body[f.season] = season; body[f.episode] = episode; }
  var h = { 'User-Agent': ZX_UA, 'Accept': hdr.Accept, 'Referer': hdr.Referer, 'Content-Type': 'application/json', 'Origin': ZX_ORIGIN };
  return zxFetch(ZX_ORIGIN + '/backend/andromeda', { method: 'POST', headers: h, body: JSON.stringify(body) }).then(function (r) {
    var j = r.status === 200 ? zxJson(r) : null;
    if (!j || !j.token) return null;
    var p = [];
    function add(k, v) { p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); }
    add(f.id, id); add(f.path, server); add(f.mediaType, type); add(f.ts, String(j.ts)); add(f.token, j.token);
    add(f.title, meta.title); add(f.year, meta.year); add(f.date, meta.date);
    if (type === 'tv') { add(f.season, String(season)); add(f.episode, String(episode)); if (meta.latest) add(f.latestDate, meta.latest); }
    if (dub && dub.code) { add('dubCode', dub.code); add('dubType', String(dub.type || 0)); }
    if (meta.imdb) add(f.imdbId, meta.imdb);
    return zxFetch(ZX_ORIGIN + '/backend_/sources/' + server + '?' + p.join('&'), { headers: hdr });
  }).then(function (r) {
    var d = r && r.status === 200 ? zxJson(r) : null;
    return d && d.success && d.links && d.links.length ? d : null;
  });
}

function zxAbs(u) { return u.charAt(0) === '/' ? ZX_ORIGIN + u : u; }
function zxExpires(u) { var m = /[?&]t=(\d{9,})/.exec(u) || /[?&]exp=(\d{9,})/.exec(u); return m ? +m[1] : null; }

function zxStreams(C, server, d, allLinks) {
  var out = [], seen = {}, subs = [], i, name = ZX_SERVERS[server] || server;
  var sl = d.subtitles || [];
  for (i = 0; i < sl.length; i++) {
    var s = sl[i];
    if (s && s.url) subs.push({ url: zxAbs(s.url), lang: s.lang || s.language || '', label: s.label || s.display || s.lang || '' });
  }
  var links = d.links || [];
  var dubs = [];
  for (i = 0; d.dubs && i < d.dubs.length; i++) dubs.push({ code: d.dubs[i].lanCode, type: d.dubs[i].type, name: d.dubs[i].lanName, original: !!d.dubs[i].original });
  // atlas/alatreon list several mirror playlists; in testing only the first one reliably has live segments (the others often answer 525)
  var firstOnly = !allLinks && (server === 'atlas' || server === 'alatreon' || server === 'ursa');
  for (i = 0; i < links.length; i++) {
    if (firstOnly && i > 0) break;
    var u;
    try { u = zxDecryptLink(C, links[i].link); } catch (e) { u = ''; }
    if (!u) continue;
    u = zxAbs(u);
    var t = links[i].type, q = links[i].resolution ? String(links[i].resolution) : '';
    if (/^\d+$/.test(q)) q = q + 'p';
    if (seen[u]) { out[seen[u] - 1].quality = q || out[seen[u] - 1].quality; continue; } // same file under several labels: keep the highest (listed last)
    seen[u] = out.length + 1;
    out.push({ server: name, url: u, kind: t === 'mp4' ? 'mp4' : t === 'hls' ? 'hls' : t, quality: q, headers: {}, subtitles: subs, expires: zxExpires(u), dubs: dubs });
  }
  return out;
}

// opts: { meta:{title,year,date,latest,imdb}, servers:[...], dub:{code,type} (orion only; see stream.dubs), allLinks:bool }
// Extra field on each stream: dubs = [{code,type,name,original}] (orion audio tracks; request one with opts.dub for 1 more POST+GET).
function resolveZxcstream(tmdbId, mediaType, season, episode, opts) {
  opts = opts || {};
  try {
    var C = zxCrypto();
    if (!C) return Promise.resolve([]);
    var type = mediaType === 'tv' ? 'tv' : 'movie';
    var s = parseInt(season, 10) || 1, e = parseInt(episode, 10) || 1;
    var servers = opts.servers || ['orion', 'alatreon'];
    var hdr = zxHdr(type, tmdbId, s, e);
    var metaP = opts.meta ? Promise.resolve(opts.meta) : zxDetails(type, tmdbId, hdr);
    return metaP.then(function (meta) {
      if (!meta || !meta.title) return [];
      var all = [];
      function next(i) {
        if (i >= servers.length) return Promise.resolve(all);
        return zxServer(servers[i], type, tmdbId, s, e, meta, opts.dub, hdr).then(function (d) {
          if (d) all = all.concat(zxStreams(C, servers[i], d, opts.allLinks));
        }).catch(function () {}).then(function () { return next(i + 1); });
      }
      return next(0);
    }).catch(function () { return []; });
  } catch (err) { return Promise.resolve([]); }
}

if (typeof module !== 'undefined' && module.exports) module.exports = resolveZxcstream;
