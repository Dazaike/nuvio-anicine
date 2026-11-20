// resolveVidrift: embed.vidrift.in (mirror of embed.vidrift.net, which sits behind a Cloudflare challenge for non-browsers).
// Chain (2 fetches): GET {embed}/api/boot/{movie/<id> | tv/<id>/<s>/<e>}  with  x-embed-parent: https://7movies.ac  (whitelisted parent; the
// anicine.sbs parent gets bigbangUrl:"" and unsigned evion links)  ->  meta { bigbangUrl, evionUrl, orionStreams[] } ; then each master is
// fetched (BigBang only) to prove it is alive and read its top resolution. 2 fetches per resolve; Evion/Orion come straight from the boot JSON.
// Plain ES5, no Node-only APIs. Never rejects.

var VR_EMBED = 'https://embed.vidrift.in';
var VR_PARENT = 'https://7movies.ac';
var VR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
var VR_TIMEOUT = 8000;

function vrFetch(url, headers) {
  var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = null;
  if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, VR_TIMEOUT);
  var opts = { headers: headers };
  if (ctl) opts.signal = ctl.signal;
  return fetch(url, opts).then(function (r) {
    return r.text().then(function (t) { if (timer) clearTimeout(timer); return { status: r.status, text: t }; });
  }, function (e) { if (timer) clearTimeout(timer); throw e; });
}

function vrTopHeight(master) {
  var h = 0, re = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)/g, m;
  while ((m = re.exec(master))) h = Math.max(h, +m[1]);
  return h;
}
function vrQuality(h) { return h >= 2000 ? '2160p' : h >= 1000 ? '1080p' : h > 0 ? h + 'p' : ''; }
function vrExpires(url) { var m = /[?&]exp=(\d+)/.exec(url || ''); return m ? +m[1] : null; }

function vrSubs(meta) {
  var out = [], l = meta.bigbangSubtitles || [];
  for (var i = 0; i < l.length; i++) if (l[i] && l[i].url) out.push({ url: l[i].url, lang: l[i].lang || '', label: l[i].label || l[i].lang || '' });
  return out;
}

// BigBang master is fetched once: proves the signed link is live and gives the top resolution (up to 2160p)
function vrProbeBigbang(url, subs, codec) {
  return vrFetch(url, {}).then(function (r) {
    if (r.status !== 200 || r.text.indexOf('#EXTM3U') < 0) return null;
    var q = vrQuality(vrTopHeight(r.text));
    if (codec === 'hevc') q = (q || 'Auto') + ' HEVC';
    return { server: 'BigBang', url: url, kind: 'hls', quality: q, headers: {}, subtitles: subs, expires: vrExpires(url) };
  }).catch(function () { return null; });
}

function resolveVidrift(tmdbId, mediaType, season, episode, opts) {
  try {
    var isTv = mediaType === 'tv';
    var path = isTv ? '/api/boot/tv/' + encodeURIComponent(tmdbId) + '/' + (parseInt(season, 10) || 1) + '/' + (parseInt(episode, 10) || 1)
                    : '/api/boot/movie/' + encodeURIComponent(tmdbId);
    return vrFetch(VR_EMBED + path, {
      'User-Agent': VR_UA, 'Accept': '*/*', 'Referer': VR_EMBED + '/embed2/play', 'x-embed-parent': VR_PARENT,
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty'
    }).then(function (r) {
      if (r.status !== 200) return [];
      var meta = JSON.parse(r.text).meta || {};
      var out = [], i;
      // Orion: master is inlined in meta.warmManifests only for some; resolution comes from rungs. HEVC (hvc1) only; needs Referer = embed origin (UA alone -> 403)
      var os = meta.orionStreams || [];
      for (i = 0; i < os.length; i++) {
        if (!os[i] || !os[i].url) continue;
        var rg = os[i].rungs || [], h = 0;
        for (var k = 0; k < rg.length; k++) h = Math.max(h, rg[k].height || 0);
        out.push({ server: String(os[i].name || 'Orion'), url: os[i].url.charAt(0) === '/' ? VR_EMBED + os[i].url : os[i].url, kind: 'hls',
          quality: (vrQuality(h) || 'Auto') + ' HEVC', headers: { 'Referer': VR_EMBED + '/', 'User-Agent': VR_UA }, subtitles: [], expires: null });
      }
      // Evion: signed, header-free, H.264 MPEG-TS HLS (not probed: 0 extra fetches)
      if (meta.evionUrl) out.unshift({ server: 'Evion', url: meta.evionUrl, kind: 'hls', quality: '', headers: {}, subtitles: [], expires: vrExpires(meta.evionUrl) });
      if (!meta.bigbangUrl) return out;
      return vrProbeBigbang(meta.bigbangUrl, vrSubs(meta), meta.bigbangCodec || '').then(function (bb) { if (bb) out.unshift(bb); return out; });
    }).catch(function () { return []; });
  } catch (e) { return Promise.resolve([]); }
}

if (typeof module !== 'undefined' && module.exports) module.exports = resolveVidrift;
