// resolveVidstuck: https://vidstuck.cc/embed/{movie/<tmdb> | tv/<tmdb>/<s>/<e>}
// The embed page is a client-rendered Next.js app that talks to its own backend:
//   0. GET  /backend/tmdb/details/{movie|tv}/<id>?language=en-US   -> title, release_date, last_air_date, imdb_id   (skipped when opts.meta given)
//   1. POST /backend/andromeda  {fields..., meow: AES(JSON{id,media_type,path[,season,episode]})}  -> { ts, token }      (one token per server)
//   2. GET  /backend/servers/<server>?<fields>&ts&token&title&year&date[&imdb]  -> { links:[{type,link(AES),resolution}], subtitles, dubs }
//   link = CryptoJS.AES.decrypt(link, KEY) (optionally prefixed 'xArD_' + base64 of the ciphertext). Relative links live on the vidstuck origin.
// Fetches run strictly one after another (device runtime serialises them). Default = details + berkas + orion = 5 fetches (4 when opts.meta is given; ['berkas'] alone = 3);
// every extra server costs 2 more. Plain ES5; never rejects.

var VS_ORIGIN = 'https://vidstuck.cc';
var VS_KEY = '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c';
var VS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
var VS_TIMEOUT = 8000;
var VS_F = { id: 'a7f39c821d604e5b9157b', mediaType: 'c1306d28147a35632e816b', path: '6b491e28392e7561a9384c', ts: '61d9a5274c8e3b2f8291e6',
  token: 'c492f7a183d0e36c538a716d', title: '5e28c9147a0de29f3674b392a1', year: 'b731e6c94f87f8341c306e', date: 'e1649139e5814b3027',
  season: 'd8427b5c82f957c3613e85b', episode: '91c6ea5d1f785c92346b713d', imdbId: 'f35a814265e871c4933a725f', latestDate: 'e95416ad739e5814b3027' };
// server id -> display name used by the embed UI
var VS_SERVERS = { orion: 'Orion', andromeda: 'Andromeda', atlas: 'Atlas', milkyway: 'Milky Way', berkas: 'Berkas' };

function vsCrypto() { try { return require('crypto-js'); } catch (e) { return null; } }

function vsFetch(url, opts) {
  var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = null;
  if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, VS_TIMEOUT);
  var o = opts || {};
  if (ctl) o.signal = ctl.signal;
  return fetch(url, o).then(function (r) {
    return r.text().then(function (t) { if (timer) clearTimeout(timer); return { status: r.status, text: t }; });
  }, function (e) { if (timer) clearTimeout(timer); throw e; });
}
function vsJson(r) { try { return JSON.parse(r.text); } catch (e) { return null; } }
var VS_HDR = { 'User-Agent': VS_UA, 'Accept': 'application/json, text/plain, */*' };

// OpenSSL-style AES passphrase encrypt with a caller-supplied random salt (crypto-js' own salt RNG throws in runtimes without crypto)
function vsMeow(C, obj) {
  var w = [], i;
  for (i = 0; i < 2; i++) w.push((Math.random() * 4294967296) | 0);
  return C.AES.encrypt(JSON.stringify(obj), VS_KEY, { salt: C.lib.WordArray.create(w, 8) }).toString();
}
function vsDecryptLink(C, link) {
  var c = link;
  if (c.indexOf('xArD_') === 0) c = C.enc.Utf8.stringify(C.enc.Base64.parse(c.slice(5)));
  return C.AES.decrypt(c, VS_KEY).toString(C.enc.Utf8);
}

function vsDetails(type, id) {
  return vsFetch(VS_ORIGIN + '/backend/tmdb/details/' + type + '/' + encodeURIComponent(id) + '?language=en-US', { headers: VS_HDR }).then(function (r) {
    var d = r.status === 200 ? vsJson(r) : null;
    if (!d) return null;
    var date = d.release_date ? String(d.release_date) : '';
    var yr = date ? String(new Date(date).getFullYear()) : '';
    return { title: d.title || d.name || '', year: yr, date: date, latest: d.last_air_date || '', imdb: d.imdb_id || '' };
  });
}

function vsServer(C, server, type, id, season, episode, meta, dub) {
  var f = VS_F, inner = {};
  inner.id = String(id); inner.media_type = type; inner.path = server;
  var body = {}; body[f.id] = String(id); body[f.mediaType] = type; body[f.path] = server;
  if (type === 'tv') { inner.season = season; inner.episode = episode; body[f.season] = season; body[f.episode] = episode; }
  body.meow = vsMeow(C, inner);
  var h = { 'User-Agent': VS_UA, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'Origin': VS_ORIGIN };
  return vsFetch(VS_ORIGIN + '/backend/andromeda', { method: 'POST', headers: h, body: JSON.stringify(body) }).then(function (r) {
    var j = r.status === 200 ? vsJson(r) : null;
    if (!j || !j.token) return null;
    var p = [];
    function add(k, v) { p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); }
    add(f.id, id); add(f.path, server); add(f.mediaType, type); add(f.ts, String(j.ts)); add(f.token, j.token);
    add(f.title, meta.title); add(f.year, meta.year); add(f.date, meta.date);
    if (type === 'tv') { add(f.season, String(season)); add(f.episode, String(episode)); if (meta.latest) add(f.latestDate, meta.latest); }
    if (dub && dub.code) { add('dubCode', dub.code); add('dubType', String(dub.type || 0)); }
    if (meta.imdb) add(f.imdbId, meta.imdb);
    return vsFetch(VS_ORIGIN + '/backend/servers/' + server + '?' + p.join('&'), { headers: VS_HDR });
  }).then(function (r) {
    var d = r && r.status === 200 ? vsJson(r) : null;
    return d && d.success && d.links && d.links.length ? d : null;
  });
}

function vsAbs(u) { return u.charAt(0) === '/' ? VS_ORIGIN + u : u; }
function vsExpires(u) { var m = /[?&]t=(\d{9,})/.exec(u) || /[?&]exp=(\d{9,})/.exec(u); return m ? +m[1] : null; }

function vsStreams(C, server, d, allLinks) {
  var out = [], seen = {}, subs = [], i, name = VS_SERVERS[server] || server;
  var sl = d.subtitles || [];
  for (i = 0; i < sl.length; i++) {
    var s = sl[i];
    if (s && s.url) subs.push({ url: vsAbs(s.url), lang: s.lang || s.language || '', label: s.label || s.display || s.lang || '' });
  }
  var links = d.links || [];
  var dubs = [];
  for (i = 0; d.dubs && i < d.dubs.length; i++) dubs.push({ code: d.dubs[i].lanCode, type: d.dubs[i].type, name: d.dubs[i].lanName, original: !!d.dubs[i].original });
  // atlas/alatreon list several mirror playlists; in testing only the first one reliably has live segments (the others often answer 525)
  var firstOnly = !allLinks && (server === 'atlas' || server === 'alatreon' || server === 'ursa');
  for (i = 0; i < links.length; i++) {
    if (firstOnly && i > 0) break;
    var u;
    try { u = vsDecryptLink(C, links[i].link); } catch (e) { u = ''; }
    if (!u) continue;
    u = vsAbs(u);
    var t = links[i].type, q = links[i].resolution ? String(links[i].resolution) : '';
    if (/^\d+$/.test(q)) q = q + 'p';
    if (seen[u]) { out[seen[u] - 1].quality = q || out[seen[u] - 1].quality; continue; } // same file under several labels: keep the highest (listed last)
    seen[u] = out.length + 1;
    out.push({ server: name, url: u, kind: t === 'mp4' ? 'mp4' : t === 'hls' ? 'hls' : t, quality: q, headers: {}, subtitles: subs, expires: vsExpires(u), dubs: dubs });
  }
  return out;
}

// opts: { meta:{title,year,date,latest,imdb}, servers:[...], dub:{code,type} (orion only; see stream.dubs), allLinks:bool }
// Extra field on each stream: dubs = [{code,type,name,original}] (orion audio tracks; request one with opts.dub for 1 more POST+GET).
function resolveVidstuck(tmdbId, mediaType, season, episode, opts) {
  opts = opts || {};
  try {
    var C = vsCrypto();
    if (!C) return Promise.resolve([]);
    var type = mediaType === 'tv' ? 'tv' : 'movie';
    var s = parseInt(season, 10) || 1, e = parseInt(episode, 10) || 1;
    var servers = opts.servers || ['berkas', 'orion'];
    var metaP = opts.meta ? Promise.resolve(opts.meta) : vsDetails(type, tmdbId);
    return metaP.then(function (meta) {
      if (!meta || !meta.title) return [];
      var all = [];
      function next(i) {
        if (i >= servers.length) return Promise.resolve(all);
        return vsServer(C, servers[i], type, tmdbId, s, e, meta, opts.dub).then(function (d) {
          if (d) all = all.concat(vsStreams(C, servers[i], d, opts.allLinks));
        }).catch(function () {}).then(function () { return next(i + 1); });
      }
      return next(0);
    }).catch(function () { return []; });
  } catch (err) { return Promise.resolve([]); }
}

if (typeof module !== 'undefined' && module.exports) module.exports = resolveVidstuck;
