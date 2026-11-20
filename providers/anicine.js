// ==== 00-core.js ====
// AniCine (anicine.sbs) local scraper for Nuvio.
// anicine.sbs is a Next.js shell that only iframes third-party embed hosts (it has no streams of its own). This plugin skips the
// shell and asks those embed hosts directly, keyed by TMDB id (movies/TV) or MAL id (anime). See README.md for the chain.
// Runs in QuickJS: no Buffer / TextEncoder / crypto.subtle / WebAssembly / setTimeout. Plain ES5 promise chains. Never throws or rejects.

var ANI_TAG = '[AniCine]';
var ANI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
var ANI_SITE = 'https://anicine.sbs';
var ANI_BUDGET_MS = 32000;          // no new hop starts after this (the host kills the whole call at 45 s)
var ANI_CACHE_MS = 5 * 60 * 1000;
var ANI_CACHE = {};

function aniLog() {
  try { console.log.apply(console, [ANI_TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
}

function aniSettings() {
  try {
    var s = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS) || {};
    return s && typeof s === 'object' ? s : {};
  } catch (e) { return {}; }
}
function aniFlag(key, dflt) {
  var v = aniSettings()[key];
  if (v === undefined || v === null || v === '') return dflt;
  return v === true || v === 'true' || v === 1 || v === '1';
}

// ---------------------------------------------------------------- http (fetch is a blocking native call on the device: hops add up)
function aniHttp(ctx, url, opts) {
  opts = opts || {};
  if (Date.now() > ctx.deadline) return Promise.reject(new Error('budget'));
  var headers = {};
  var k;
  for (k in (opts.headers || {})) headers[k] = opts.headers[k];
  if (!headers['User-Agent']) headers['User-Agent'] = ANI_UA;
  var o = { method: opts.method || 'GET', headers: headers };
  if (opts.redirect) o.redirect = opts.redirect;
  if (opts.body !== undefined) o.body = opts.body;
  ctx.hops++;
  return fetch(url, o).then(function (r) {
    return r.text().then(function (t) { return { status: r.status, url: r.url, text: t, headers: r.headers }; });
  });
}
function aniJson(ctx, url, opts) {
  return aniHttp(ctx, url, opts).then(function (r) {
    var j = null;
    try { j = JSON.parse(r.text); } catch (e) {}
    return { status: r.status, json: j, text: r.text };
  });
}
// Runs jobs strictly one after another (the device serialises fetches anyway). A job with `max` is skipped once that many ms have passed,
// so slow tail hosts never push the call towards the 45 s kill.
function aniSeries(ctx, jobs) {
  var out = [];
  return jobs.reduce(function (p, job) {
    return p.then(function () {
      var elapsed = Date.now() - ctx.t0;
      if (job.max && elapsed > job.max) { aniLog('skip ' + job.name + ' (' + elapsed + ' ms elapsed)'); return; }
      var j0 = Date.now();
      return Promise.resolve().then(job.fn).then(function (arr) {
        aniLog(job.name + ': ' + ((arr && arr.length) || 0) + ' stream(s) in ' + (Date.now() - j0) + ' ms');
        if (arr && arr.length) out = out.concat(arr);
      }, function (e) {
        aniLog(job.name + ' failed after ' + (Date.now() - j0) + ' ms:', e && e.message ? e.message : e);
      });
    });
  }, Promise.resolve()).then(function () { return out; });
}

function aniHeight(q) {
  var m = /(\d{3,4})\s*p/i.exec(String(q || ''));
  if (m) return +m[1];
  if (/4k|2160/i.test(String(q || ''))) return 2160;
  return 0;
}
function aniEnglish(arr) {
  var out = [], i, s;
  for (i = 0; i < (arr || []).length && out.length < 2; i++) {
    s = arr[i];
    if (s && s.url && /^(en|eng|english)/i.test(String(s.lang || s.label || ''))) out.push({ url: s.url, lang: 'en', label: 'English' });
  }
  return out;
}

// ---------------------------------------------------------------- source: vidbolt.xyz (/api/resolve, needs Referer of its own site)
var ANI_VB = 'https://vidbolt.xyz';
function aniVidbolt(ctx, server) {
  var q = 'type=' + ctx.mediaType + '&id=' + ctx.tmdbId;
  if (ctx.mediaType === 'tv') q += '&season=' + ctx.season + '&episode=' + ctx.episode;
  return aniJson(ctx, ANI_VB + '/api/resolve?' + q + '&only=' + server, { headers: { Referer: ANI_VB + '/' } }).then(function (r) {
    var st = r.json && r.json.stream;
    if (!st || !st.sources || !st.sources.length) return [];
    var out = [], subs = aniEnglish(st.subtitles), seen = {};
    st.sources.forEach(function (s) {
      if (!s.url || s.kind !== 'hls') return;
      var lang = s.language || '';
      var key = s.quality + '|' + lang;
      if (seen[key]) return;
      seen[key] = 1;
      out.push({
        server: server === 'orion' ? 'Orion' : 'Callisto', host: 'vidbolt', url: s.url, kind: 'hls', quality: s.quality || '',
        language: lang, hevc: server === 'callisto', subtitles: subs, headers: { Referer: ANI_VB + '/' }
      });
    });
    return out;
  });
}

// ---------------------------------------------------------------- source: vumeto.xyz (/_player/resolve with the session meta of the embed page)
var ANI_VM = 'https://vumeto.xyz';
function aniVumetoPath(ctx) { return ctx.mediaType === 'tv' ? 'tv/' + ctx.tmdbId + '/' + ctx.season + '/' + ctx.episode : 'movie/' + ctx.tmdbId; }
function aniVumetoSession(ctx) {
  if (ctx.vm) return Promise.resolve(ctx.vm);
  var page = ANI_VM + '/embed/' + aniVumetoPath(ctx);
  return aniHttp(ctx, page, { headers: { Referer: ANI_SITE + '/' } }).then(function (r) {
    var m = /name="vumeto-session" content="([^"]+)"/.exec(r.text);
    if (!m) throw new Error('no session meta (status ' + r.status + ')');
    ctx.vm = { page: page, sess: m[1] };
    return ctx.vm;
  });
}
function aniVumeto(ctx, provider, label) {
  return aniVumetoSession(ctx).then(function (v) {
    var q = 'type=' + ctx.mediaType + '&id=' + ctx.tmdbId + (ctx.mediaType === 'tv' ? '&season=' + ctx.season + '&episode=' + ctx.episode : '');
    return aniJson(ctx, ANI_VM + '/_player/resolve?' + q + '&provider=' + provider, { headers: { Referer: v.page, 'X-Vumeto-Session': v.sess } }).then(function (x) {
      var srcs = (x.json && x.json.sources) || [], res = [];
      srcs.forEach(function (s) {
        if (!s.url) return;
        var u = s.url.charAt(0) === '/' ? ANI_VM + s.url : s.url;
        if (/mpegurl/i.test(s.type || '')) {
          res.push({ server: label, host: 'vumeto', url: u, kind: 'hls', quality: s.quality || s.label || '', language: s.language || '', headers: {}, subtitles: [] });
        } else if (/mp4/i.test(s.type || '') && /^https:\/\/vumeto\.xyz\/media\//.test(u)) {
          // the /media proxy answers only requests that look like a <video> element of its own player
          res.push({
            server: label, host: 'vumeto', url: u, kind: 'mp4', quality: s.label || '', language: s.language || '', spoof: true, subtitles: [],
            headers: { Referer: v.page, 'Sec-Fetch-Dest': 'video', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'same-origin' }
          });
        }
      });
      return res;
    });
  });
}

// ---------------------------------------------------------------- ordering and output
var ANI_HOSTS = { vidbolt: 'Vidbolt', vumeto: 'Vumeto', filmu: 'Filmu', vidly: 'Vidly', vidrift: 'Vidrift', vidstuck: 'Vidstuck', zxcstream: 'Zxcstream', vaplayer: 'VaPlayer',
  megaplay: 'Megaplay', tryembed: 'TryEmbed', zokoanime: 'Zoko', animetvplus: 'AnimeTVPlus', mikaza: 'Mikaza' };
// tie-breaker for Auto (Best) and ordering: hosts whose chain proved steadiest first
var ANI_RANK = { vidbolt: 9, vumeto: 8, vidrift: 7, filmu: 6, vidly: 5, vidstuck: 4, zxcstream: 3, vaplayer: 2,
  zokoanime: 9, megaplay: 8, tryembed: 7, animetvplus: 6, mikaza: 1 };
var ANI_LANGS = /\b(french|hindi|russian|arabic|spanish|portuguese|german|italian|ukrainian|ukr|turkish|indonesian|kurdish|tamil|telugu|thai|korean|polish|dutch|czech|bengali|esla|ptbr|latino|castilian|filipino|malay)\b/i;

// opts.anime: stream came from an anime (MAL) host; opts.audio: 'sub' | 'dub' | 'hindi' for those
function aniAdapt(host, arr, opts) {
  opts = opts || {};
  return (arr || []).filter(function (m) { return m && m.url; }).map(function (m) {
    var qual = String(m.quality || '');
    return {
      host: host, server: String(m.server || ''), url: m.url, kind: m.kind || 'hls',
      quality: qual.replace(/\s*HEVC\s*/i, '').replace(/^auto$/i, '').trim(), hevc: !!m.hevc || /hevc|h\.?265/i.test(qual) || /h265|hevc/i.test(m.url),
      language: m.language || '', headers: m.headers || {}, subtitles: aniEnglish(m.subtitles), spoof: !!m.spoof,
      anime: !!opts.anime, audio: opts.audio || ''
    };
  });
}
function aniOtherAudio(s) {
  if (s.anime) return false;
  if (s.language && /^(original|english|en|sub)$/i.test(s.language)) return false;
  var tag = /\u00b7\s*([^\u00b7]+)$/.exec(s.server || '');   // 'Orion \u00b7 Malayalam': host labels dub tracks as 'Server \u00b7 Language'
  if (tag && !/^(original|english|en)\b/i.test(tag[1].trim())) return true;
  return ANI_LANGS.test(s.language || '') || ANI_LANGS.test(s.server || '');
}

function aniDedupe(list) {
  var seen = {}, out = [];
  list.forEach(function (s) {
    var k = s.url.replace(/[?#].*$/, '') + '|' + s.audio;
    if (seen[k]) return;
    seen[k] = 1;
    out.push(s);
  });
  return out;
}

function aniToStreams(list, ctx) {
  var showHevc = aniFlag('show_hevc', true), allAudio = aniFlag('all_audio', false);
  var all = aniDedupe(list).filter(function (s) {
    return (showHevc || !s.hevc) && (allAudio || !aniOtherAudio(s)) && (allAudio || s.audio !== 'hindi');
  });
  function group(s) { return s.hevc ? 2 : (s.spoof ? 1 : 0); }
  function better(a, b) {
    var d = aniHeight(b.quality) - aniHeight(a.quality);
    return d || ((ANI_RANK[b.host] || 0) - (ANI_RANK[a.host] || 0));
  }
  var cands = all.filter(function (s) { return group(s) === 0 && s.kind === 'hls'; });
  cands.sort(better);
  var best = cands[0];
  if (ctx && ctx.anime) {
    // anime title: Auto prefers the anime hosts in the audio the user asked for, because their quality is not always known up front
    var want = ctx.audio === 'dub' ? 'dub' : 'sub';
    var ac = cands.filter(function (s) { return s.anime && s.audio === want; });
    ac.sort(function (a, b) { return (ANI_RANK[b.host] || 0) - (ANI_RANK[a.host] || 0); });
    if (ac.length) best = ac[0];
  }
  function rank(s) { return ctx && ctx.anime && s.anime ? 100 : 0; }
  all.sort(function (a, b) { return (group(a) - group(b)) || (rank(b) - rank(a)) || better(a, b); });
  function make(s, name) {
    var bits = [];
    if (s.quality) bits.push(s.quality);
    if (s.audio) bits.push(s.audio === 'dub' ? 'Dub' : (s.audio === 'hindi' ? 'Hindi' : 'Sub'));
    else if (s.language && !/^original$/i.test(s.language)) bits.push(s.language);
    if (s.hevc) bits.push('HEVC');
    bits.push(s.kind === 'hls' ? 'HLS' : s.kind.toUpperCase());
    return { name: name, title: (ANI_HOSTS[s.host] || s.host) + ' ' + s.server + ' - ' + bits.join(' - '), url: s.url, quality: s.quality || 'Unknown', headers: s.headers || {}, subtitles: s.subtitles || [] };
  }
  var out = [];
  if (best) out.push(make(best, 'AniCine - Auto (Best)'));
  all.forEach(function (s) { out.push(make(s, 'AniCine - ' + (ANI_HOSTS[s.host] || s.host) + ' ' + s.server + (s.audio === 'dub' ? ' (Dub)' : ''))); });
  return out;
}

// ---------------------------------------------------------------- TMDB meta (through anicine's own key-free /api/tmdb proxy) and anime id mapping
function aniTmdb(ctx, path) {
  return aniJson(ctx, ANI_SITE + '/api/tmdb?path=' + path, { headers: { Referer: ANI_SITE + '/' } });
}
function aniDeburr(s) {
  s = String(s || '');
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
  return s;
}
function aniNorm(s) { return aniDeburr(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function aniBase(s) {
  return aniNorm(s).replace(/\b(season \d+|\d+(st|nd|rd|th) season|part \d+|cour \d+|final season|the final|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();
}
function aniTitleMatch(res, names) {
  var cands = [res.title && res.title.english, res.title && res.title.romaji], i, j, a, b;
  for (i = 0; i < cands.length; i++) {
    a = aniBase(cands[i]);
    if (!a) continue;
    for (j = 0; j < names.length; j++) {
      b = aniBase(names[j]);
      if (b && (a === b || a.indexOf(b + ' ') === 0 || b.indexOf(a + ' ') === 0)) return true;
    }
  }
  return false;
}
function aniDate(d, endOfMonth) {
  if (!d || !d.year) return null;
  return Date.UTC(d.year, (d.month || (endOfMonth ? 12 : 1)) - 1, d.day || 1);
}
function aniIsoDate(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
var ANI_DAY = 86400000;

function aniAnilistSearch(ctx, q) {
  return aniJson(ctx, ANI_SITE + '/api/anilist?action=search&q=' + encodeURIComponent(aniDeburr(q)), { headers: { Referer: ANI_SITE + '/' } }).then(function (r) {
    return (r.json && r.json.results) || [];
  });
}

// Anime TV: TMDB season/episode -> MAL entry + episode number inside that entry. Uses the aired date of the TMDB episode to find the MAL
// entry that was airing then, so split cours, merged seasons and absolute numbering (One Piece) all land on the right MAL id/number.
function aniMapAnimeTv(ctx, d) {
  var names = [d.name, d.original_name].filter(function (x) { return !!x; });
  var S = ctx.season, E = ctx.episode;
  if (S < 1) return Promise.resolve(null);
  var cum = 0;
  (d.seasons || []).forEach(function (s) { if (s.season_number >= 1 && s.season_number < S) cum += s.episode_count || 0; });
  return aniTmdb(ctx, '/tv/' + ctx.tmdbId + '/season/' + S).then(function (r) {
    var eps = (r.json && r.json.episodes) || [];
    var target = null, i;
    for (i = 0; i < eps.length; i++) if (eps[i].episode_number === E) target = eps[i];
    if (!target) return eps.length ? { missing: true } : null;   // TMDB lists this season but not this episode number: nothing to play
    var firstEp = eps.length ? eps[0].episode_number : 1;
    var abs = (firstEp > 1 && E >= firstEp) ? E : cum + E;
    var when = aniIsoDate(target.air_date);
    return aniAnilistSearch(ctx, d.name).then(function (res) {
      var tvish = res.filter(function (x) { return /^(TV|TV_SHORT|ONA)$/.test(x.format || '') && x.idMal && aniTitleMatch(x, names); });
      if (!tvish.length) return null;
      tvish.sort(function (a, b) { return (aniDate(a.startDate) || 0) - (aniDate(b.startDate) || 0); });
      var pick = tvish[0];
      if (when !== null) {
        for (i = 0; i < tvish.length; i++) { var st = aniDate(tvish[i].startDate); if (st !== null && st <= when + 21 * ANI_DAY) pick = tvish[i]; }
      }
      var start = aniDate(pick.startDate), seriesStart = aniIsoDate(d.first_air_date);
      var ep;
      if (start !== null && seriesStart !== null && start <= seriesStart + 90 * ANI_DAY) ep = abs;
      else {
        var before = 0;
        eps.forEach(function (x) { var t = aniIsoDate(x.air_date); if (t !== null && start !== null && t < start - 4 * ANI_DAY) before++; });
        ep = E - before;
        if (ep < 1) ep = E;
      }
      return { mal: pick.idMal, ep: ep, title: (pick.title && (pick.title.english || pick.title.romaji)) || d.name, movie: false };
    });
  });
}

function aniMapAnimeMovie(ctx, d) {
  var names = [d.title, d.original_title].filter(function (x) { return !!x; });
  var year = parseInt(String(d.release_date || '').slice(0, 4), 10) || 0;
  return aniAnilistSearch(ctx, d.title).then(function (res) {
    var m = res.filter(function (x) {
      return x.format === 'MOVIE' && x.idMal && (!year || Math.abs((x.seasonYear || (x.startDate && x.startDate.year) || year) - year) <= 1) && (aniTitleMatch(x, names) || aniNorm(x.title && x.title.english) === aniNorm(d.title));
    });
    if (!m.length) return null;
    return { mal: m[0].idMal, ep: 1, title: (m[0].title && (m[0].title.english || m[0].title.romaji)) || d.title, movie: true };
  });
}

// resolves { missing: true } when TMDB says the id does not exist; { anime: {mal, ep} | null } otherwise. A TMDB outage is not "missing".
function aniMeta(ctx) {
  return aniTmdb(ctx, (ctx.mediaType === 'tv' ? '/tv/' : '/movie/') + ctx.tmdbId).then(function (r) {
    if (r.status === 404) return { missing: true };
    var d = r.json;
    if (!d || !d.id) return { anime: null };
    var genres = (d.genres || []).map(function (g) { return g.id; });
    var jp = (d.origin_country || []).indexOf('JP') >= 0 || d.original_language === 'ja';
    ctx.title = d.name || d.title || '';
    if (genres.indexOf(16) < 0 || !jp) return { anime: null };
    return (ctx.mediaType === 'tv' ? aniMapAnimeTv(ctx, d) : aniMapAnimeMovie(ctx, d)).then(function (a) { return a && a.missing ? { missing: true } : { anime: a }; }, function (e) {
      aniLog('anime mapping failed:', e && e.message ? e.message : e);
      return { anime: null };
    });
  }, function (e) {
    aniLog('tmdb lookup failed:', e && e.message ? e.message : e);
    return { anime: null };
  });
}

// ---------------------------------------------------------------- main
function aniAudioSetting() {
  var v = String(aniSettings().anime_audio || 'sub');
  return v === 'dub' || v === 'both' ? v : 'sub';
}

// Anime-host jobs: MAL id + episode number inside that MAL entry. Each module returns [] on any failure.
function aniAnimeJobs(ctx, a) {
  var jobs = [], langs = ctx.audio === 'both' ? ['sub', 'dub'] : [ctx.audio];
  var mods = [
    { host: 'zokoanime', fn: function () { return resolveZokoanime; }, max: 22000 },
    { host: 'megaplay', fn: function () { return resolveMegaplay; }, max: 22000 },
    { host: 'tryembed', fn: function () { return resolveTryembed; }, max: 20000 },
    { host: 'animetvplus', fn: function () { return resolveAnimetvplus; }, max: 20000, subOnly: true }
  ];
  if (aniFlag('all_audio', false)) mods.push({ host: 'mikaza', fn: function () { return resolveMikaza; }, max: 20000, hindi: true });
  mods.forEach(function (m) {
    if (m.hindi) {
      jobs.push({ name: m.host + ' hindi', max: m.max, fn: function () {
        return Promise.resolve(m.fn()(a.mal, 'anime', null, a.ep, { lang: 'hin' })).then(function (arr) { return aniAdapt(m.host, arr, { anime: true, audio: 'hindi' }); });
      } });
      return;
    }
    langs.forEach(function (lang) {
      if (m.subOnly && lang === 'dub') return;
      jobs.push({ name: m.host + ' ' + lang, max: m.max, fn: function () {
        return Promise.resolve(m.fn()(a.mal, 'anime', null, a.ep, { lang: lang })).then(function (arr) { return aniAdapt(m.host, arr, { anime: true, audio: lang }); });
      } });
    });
  });
  return jobs;
}

function aniRun(ctx) {
  return aniMeta(ctx).then(function (meta) {
    if (meta.missing) { aniLog('TMDB has no such ' + ctx.mediaType + ' ' + ctx.tmdbId); return []; }
    var id = ctx.tmdbId, t = ctx.mediaType, s = ctx.season, e = ctx.episode;
    function adapt(host, p) { return function () { return Promise.resolve(p()).then(function (arr) { return aniAdapt(host, arr); }); }; }
    var jobs = [];
    if (meta.anime) {
      ctx.anime = true;
      aniLog('anime: ' + meta.anime.title + ' -> MAL ' + meta.anime.mal + ' ep ' + meta.anime.ep);
      jobs = jobs.concat(aniAnimeJobs(ctx, meta.anime));
    }
    jobs = jobs.concat([
      { name: 'vidbolt orion', max: 24000, fn: function () { return aniVidbolt(ctx, 'orion'); } },
      { name: 'vumeto astra', max: 12000, fn: function () { return aniVumeto(ctx, 'stream-library', 'Astra'); } },
      { name: 'vidrift', max: 11000, fn: adapt('vidrift', function () { return resolveVidrift(id, t, s, e, {}); }) },
      { name: 'vidbolt callisto', max: 10000, fn: function () { return aniVidbolt(ctx, 'callisto'); } },
      { name: 'vidstuck', max: 8000, fn: adapt('vidstuck', function () { return resolveVidstuck(id, t, s, e, { servers: ['berkas'] }); }) },
      { name: 'zxcstream', max: 8000, fn: adapt('zxcstream', function () { return resolveZxcstream(id, t, s, e, { servers: ['alatreon'] }); }) },
      { name: 'vaplayer', max: 8000, fn: adapt('vaplayer', function () { return resolveVaplayer(id, t, s, e, {}); }) }
    ]);
    if (aniFlag('slow_hosts', false)) jobs.push({ name: 'vumeto flux', max: 9000, fn: function () { return aniVumeto(ctx, 'streamm4u', 'Flux'); } });
    if (aniFlag('slow_hosts', false)) jobs.push({ name: 'filmu', max: 8000, fn: adapt('filmu', function () { return resolveVidlyBase('https://embed.filmu.in', id, t, s, e, {}); }) });
    return aniSeries(ctx, jobs);
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var id = String(tmdbId == null ? '' : tmdbId).trim();
    var type = mediaType === 'tv' || mediaType === 'series' ? 'tv' : (mediaType === 'movie' ? 'movie' : '');
    if (!type || !/^\d{1,9}$/.test(id)) return Promise.resolve([]);
    var s = type === 'tv' ? (parseInt(season, 10) || 0) : 0;
    var e = type === 'tv' ? (parseInt(episode, 10) || 0) : 0;
    if (type === 'tv' && (e < 1 || s < 0)) return Promise.resolve([]);
    var key = type + ':' + id + ':' + s + ':' + e + ':' + JSON.stringify(aniSettings());
    var hit = ANI_CACHE[key];
    if (hit && Date.now() - hit.t < ANI_CACHE_MS) return Promise.resolve(hit.v);
    var t0 = Date.now();
    var ctx = { tmdbId: id, mediaType: type, season: s, episode: e, t0: t0, deadline: t0 + ANI_BUDGET_MS, hops: 0, anime: false, audio: aniAudioSetting() };
    return aniRun(ctx).then(function (list) {
      var out = aniToStreams(list, ctx);
      aniLog(type + ' ' + id + (type === 'tv' ? ' S' + s + 'E' + e : '') + ': ' + out.length + ' stream(s), ' + ctx.hops + ' site hop(s), ' + (Date.now() - t0) + ' ms');
      if (out.length) ANI_CACHE[key] = { t: Date.now(), v: out };
      return out;
    }).catch(function (err) {
      aniLog('failed:', err && err.message ? err.message : err);
      return [];
    });
  } catch (err) {
    return Promise.resolve([]);
  }
}

function onSettings() {
  return [
    { type: 'header', label: 'Anime' },
    {
      type: 'select', key: 'anime_audio', label: 'Anime audio', defaultValue: 'sub',
      options: [
        { label: 'Subtitled (original audio)', value: 'sub' },
        { label: 'Dubbed (English audio)', value: 'dub' },
        { label: 'Both (slower)', value: 'both' }
      ]
    },
    { type: 'info', label: 'Anime is detected from TMDB (Japanese animation) and mapped to MyAnimeList ids, so season and episode numbers follow the TMDB listing. Sub and dub are separate streams on the anime servers.' },
    { type: 'header', label: 'Servers' },
    { type: 'toggle', key: 'show_hevc', label: 'List HEVC servers', description: 'Some servers (Callisto, Vidrift Orion, Vidly Prism) serve H.265 only (up to 1080p, many audio languages). Never picked by Auto (Best).', defaultValue: true },
    { type: 'toggle', key: 'all_audio', label: 'List every audio language', description: 'By default only English / original audio entries are listed (dubs in other languages and the Hindi anime server are hidden).', defaultValue: false },
    { type: 'toggle', key: 'slow_hosts', label: 'Try slow or flaky servers', description: 'Adds Filmu (often hangs for 20 s or more) and Vumeto Flux (MP4 proxy that only answers browser-like requests, often takes 5 s and sometimes stalls). Both can delay the stream list; neither is ever picked by Auto (Best).', defaultValue: false },
    { type: 'info', label: 'Auto (Best) is always an H.264 HLS stream (anime: the first anime server in your audio choice, otherwise the highest quality found). It never needs more than a Referer header.' }
  ];
}

// ==== 10-vidstuck.js ====
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

// ==== 11-zxcstream.js ====
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

// ==== 12-vidrift.js ====
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

// ==== 20-vidly.js ====

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

// ==== 21-vaplayer.js ====

// vaplayer.ru embed resolver (ES5, QuickJS-safe: no WebAssembly / TextDecoder / Buffer / async).
//
// Chain (all plain HTTP, no cookies):
//   1. GET vaplayer.ru/embed/va_src.php?path=<embed path>   (Referer: https://vaplayer.ru/...)  -> {src: nextgencloudfabric.com/embed/..?va=..}
//   2. GET that src (Referer: wrapper url)                                                      -> HTML with CONFIG{apiToken, streamDataApiUrl}
//   3. GET streamdata.vaplayer.ru/api.php?tmdb=..&type=..&stream_urls&api_token=..  (Referer: https://nextgencloudfabric.com/)
//        -> {data:{stream_urls:<base64 blob>, cast_urls:[..]}, va:{wasm_url}}
//   4. in parallel: GET wasm_url (tiny, randomised per request) and GET <stream host>/generate.php?api_token=.. (IP bound JWT)
//   5. the blob is decrypted by that wasm; WebAssembly does not exist in the sandbox, so a minimal i32-only
//      wasm interpreter (WasmMini below) executes alloc()/decrypt() of the downloaded module.
//   6. /pl/<P> -> /pli/<P>?token=<jwt>  (the /pli/ playlists carry the token inside the body, so a plain player can follow them;
//      /pl/ would need the token stamped on every request). Needs Referer: https://nextgencloudfabric.com/ on all requests.

var VAP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
var VAP_WRAP = 'https://vaplayer.ru';

// ---------------------------------------------------------------- minimal wasm interpreter (i32 only)
function WasmMini(bytes) {
  var p = 0, i, j, k, n;
  function u8() { return bytes[p++]; }
  function u32() { var r = 0, s = 0, b; do { b = bytes[p++]; r |= (b & 127) << s; s += 7; } while (b & 128); return r >>> 0; }
  function s32() { var r = 0, s = 0, b; do { b = bytes[p++]; r |= (b & 127) << s; s += 7; } while (b & 128); if (s < 32 && (b & 64)) r |= (-1 << s); return r | 0; }
  function name() { var l = u32(), s = ''; for (var q = 0; q < l; q++) s += String.fromCharCode(bytes[p++]); return s; }
  function limits() { var f = u8(), mn = u32(), mx = (f & 1) ? u32() : -1; return { min: mn, max: mx }; }
  function constExpr() { var v = 0, o = u8(); if (o === 0x41) v = s32(); else throw new Error('const expr ' + o); if (u8() !== 0x0b) throw new Error('const end'); return v; }
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error('not wasm');
  p = 8;
  var types = [], funcTypes = [], funcs = [], globals = [], exportsMap = {}, datas = [], memLimits = null;
  while (p < bytes.length) {
    var id = u8(), size = u32(), end = p + size;
    if (id === 1) { n = u32(); for (i = 0; i < n; i++) { u8(); var np = u32(); for (j = 0; j < np; j++) u8(); var nr = u32(); for (j = 0; j < nr; j++) u8(); types.push({ np: np, nr: nr }); } }
    else if (id === 2) { if (u32() !== 0) throw new Error('imports unsupported'); }
    else if (id === 3) { n = u32(); for (i = 0; i < n; i++) funcTypes.push(u32()); }
    else if (id === 5) { n = u32(); if (n) memLimits = limits(); }
    else if (id === 6) { n = u32(); for (i = 0; i < n; i++) { u8(); u8(); globals.push(constExpr()); } }
    else if (id === 7) { n = u32(); for (i = 0; i < n; i++) { var nm = name(), kd = u8(), ix = u32(); exportsMap[nm] = { kind: kd, idx: ix }; } }
    else if (id === 10) {
      n = u32();
      for (i = 0; i < n; i++) {
        var bsz = u32(), bend = p + bsz, nl = 0, nlg = u32();
        for (j = 0; j < nlg; j++) { nl += u32(); u8(); }
        var op = [], ia = [], ib = [], ic = [], cs = [];
        for (;;) {
          var o = u8(), idx = op.length;
          op.push(o); ia.push(0); ib.push(0); ic.push(0);
          if (o === 0x02 || o === 0x03 || o === 0x04) {
            var ar = 0;
            if (bytes[p] === 0x40) { p++; ar = 0; } else if (bytes[p] >= 0x7c && bytes[p] <= 0x7f) { p++; ar = 1; } else { ar = types[s32()].nr; }
            if (o === 0x04) { ia[idx] = -1; ic[idx] = ar; } else { ib[idx] = ar; }
            cs.push(idx);
          } else if (o === 0x05) { ia[cs[cs.length - 1]] = idx; ib[idx] = cs[cs.length - 1]; }
          else if (o === 0x0b) {
            if (!cs.length) break;
            var bi = cs.pop();
            if (op[bi] === 0x04) { ib[bi] = idx; if (ia[bi] >= 0) ia[ia[bi]] = idx; } else { ia[bi] = idx; }
          }
          else if (o === 0x0c || o === 0x0d || o === 0x10 || (o >= 0x20 && o <= 0x24)) ia[idx] = u32();
          else if (o === 0x0e) { var cnt = u32(), tbl = []; for (k = 0; k < cnt; k++) tbl.push(u32()); ia[idx] = tbl; ib[idx] = u32(); }
          else if (o === 0x11) { u32(); u32(); throw new Error('call_indirect unsupported'); }
          else if (o >= 0x28 && o <= 0x3e) { u32(); ia[idx] = u32(); }
          else if (o === 0x3f || o === 0x40) u8();
          else if (o === 0x41) ia[idx] = s32();
          else if (o === 0x42 || o === 0x43 || o === 0x44 || (o >= 0x8b && o <= 0xc4 && o !== 0xc0 && o !== 0xc1) || (o >= 0x50 && o <= 0x66) || (o >= 0x79 && o <= 0x8a)) throw new Error('unsupported op ' + o);
        }
        p = bend;
        funcs.push({ nl: nl, op: op, ia: ia, ib: ib, ic: ic });
      }
    }
    else if (id === 11) {
      n = u32();
      for (i = 0; i < n; i++) { var fl = u32(); if (fl !== 0) throw new Error('data flag'); var off = constExpr(), len = u32(); datas.push({ off: off, bytes: bytes.subarray(p, p + len) }); p += len; }
    }
    p = end;
  }
  var mem = new Uint8Array((memLimits ? memLimits.min : 1) * 65536);
  for (i = 0; i < datas.length; i++) mem.set(datas[i].bytes, datas[i].off);
  var memMax = memLimits && memLimits.max >= 0 ? memLimits.max : 65536;

  function ld(a, off, nb, signed) {
    var addr = (a >>> 0) + off;
    if (addr + nb > mem.length) throw new Error('oob load');
    var v = 0;
    for (var q = nb - 1; q >= 0; q--) v = (v * 256) + mem[addr + q];
    if (nb === 4) return v | 0;
    if (signed) { var sh = 32 - nb * 8; return (v << sh) >> sh; }
    return v;
  }
  function stt(a, off, nb, v) {
    var addr = (a >>> 0) + off;
    if (addr + nb > mem.length) throw new Error('oob store');
    for (var q = 0; q < nb; q++) { mem[addr + q] = v & 255; v = v >>> 8; }
  }
  function clz(x) { return Math.clz32(x); }
  function ctz(x) { if (x === 0) return 32; var c = 0; while (!(x & 1)) { x = x >>> 1; c++; } return c; }
  function pop(x) { var c = 0; x = x >>> 0; while (x) { c += x & 1; x = x >>> 1; } return c; }

  function call(fi, args) {
    var fn = funcs[fi], ty = types[funcTypes[fi]], op = fn.op, ia = fn.ia, ib = fn.ib, ic = fn.ic;
    var loc = args.slice(0, ty.np);
    for (var z = 0; z < fn.nl; z++) loc.push(0);
    var st = [], cH = [0], cA = [ty.nr], cC = [op.length], cL = [false], pc = 0, a, b, o;
    function br(d) {
      var ix = cH.length - 1 - d;
      if (cL[ix]) { st.length = cH[ix]; cH.length = cA.length = cC.length = cL.length = ix + 1; pc = cC[ix]; }
      else {
        var res = cA[ix] ? st.slice(st.length - cA[ix]) : [];
        st.length = cH[ix];
        for (var q = 0; q < res.length; q++) st.push(res[q]);
        pc = cC[ix]; cH.length = cA.length = cC.length = cL.length = ix;
      }
    }
    while (pc < op.length && cH.length) {
      o = op[pc++];
      switch (o) {
        case 0x00: throw new Error('unreachable');
        case 0x01: break;
        case 0x02: cH.push(st.length); cA.push(ib[pc - 1]); cC.push(ia[pc - 1] + 1); cL.push(false); break;
        case 0x03: cH.push(st.length); cA.push(0); cC.push(pc); cL.push(true); break;
        case 0x04: {
          var c = st.pop(), ix2 = pc - 1;
          cH.push(st.length); cA.push(ic[ix2]); cC.push(ib[ix2] + 1); cL.push(false);
          if (!c) pc = ia[ix2] >= 0 ? ia[ix2] + 1 : ib[ix2];
          break;
        }
        case 0x05: pc = ia[pc - 1]; break;
        case 0x0b: cH.pop(); cA.pop(); cC.pop(); cL.pop(); break;
        case 0x0c: br(ia[pc - 1]); break;
        case 0x0d: if (st.pop()) br(ia[pc - 1]); break;
        case 0x0e: { var t = ia[pc - 1], iv = st.pop() >>> 0; br(iv < t.length ? t[iv] : ib[pc - 1]); break; }
        case 0x0f: br(cH.length - 1); break;
        case 0x10: {
          var cf = ia[pc - 1], cn = types[funcTypes[cf]].np, cargs = st.splice(st.length - cn, cn), r = call(cf, cargs);
          if (types[funcTypes[cf]].nr) st.push(r);
          break;
        }
        case 0x1a: st.pop(); break;
        case 0x1b: { var sc = st.pop(), s2 = st.pop(), s1 = st.pop(); st.push(sc ? s1 : s2); break; }
        case 0x20: st.push(loc[ia[pc - 1]]); break;
        case 0x21: loc[ia[pc - 1]] = st.pop(); break;
        case 0x22: loc[ia[pc - 1]] = st[st.length - 1]; break;
        case 0x23: st.push(globals[ia[pc - 1]]); break;
        case 0x24: globals[ia[pc - 1]] = st.pop(); break;
        case 0x28: st.push(ld(st.pop(), ia[pc - 1], 4, false)); break;
        case 0x2c: st.push(ld(st.pop(), ia[pc - 1], 1, true)); break;
        case 0x2d: st.push(ld(st.pop(), ia[pc - 1], 1, false)); break;
        case 0x2e: st.push(ld(st.pop(), ia[pc - 1], 2, true)); break;
        case 0x2f: st.push(ld(st.pop(), ia[pc - 1], 2, false)); break;
        case 0x36: b = st.pop(); a = st.pop(); stt(a, ia[pc - 1], 4, b); break;
        case 0x3a: b = st.pop(); a = st.pop(); stt(a, ia[pc - 1], 1, b); break;
        case 0x3b: b = st.pop(); a = st.pop(); stt(a, ia[pc - 1], 2, b); break;
        case 0x3f: st.push(mem.length / 65536); break;
        case 0x40: {
          var dp = st.pop() >>> 0, old = mem.length / 65536;
          if (old + dp > memMax) st.push(-1);
          else { var nm2 = new Uint8Array((old + dp) * 65536); nm2.set(mem); mem = nm2; st.push(old); }
          break;
        }
        case 0x41: st.push(ia[pc - 1]); break;
        case 0x45: st.push(st.pop() === 0 ? 1 : 0); break;
        case 0x67: st.push(clz(st.pop())); break;
        case 0x68: st.push(ctz(st.pop())); break;
        case 0x69: st.push(pop(st.pop())); break;
        case 0xc0: st.push((st.pop() << 24) >> 24); break;
        case 0xc1: st.push((st.pop() << 16) >> 16); break;
        default:
          b = st.pop(); a = st.pop();
          switch (o) {
            case 0x46: st.push(a === b ? 1 : 0); break;
            case 0x47: st.push(a !== b ? 1 : 0); break;
            case 0x48: st.push(a < b ? 1 : 0); break;
            case 0x49: st.push((a >>> 0) < (b >>> 0) ? 1 : 0); break;
            case 0x4a: st.push(a > b ? 1 : 0); break;
            case 0x4b: st.push((a >>> 0) > (b >>> 0) ? 1 : 0); break;
            case 0x4c: st.push(a <= b ? 1 : 0); break;
            case 0x4d: st.push((a >>> 0) <= (b >>> 0) ? 1 : 0); break;
            case 0x4e: st.push(a >= b ? 1 : 0); break;
            case 0x4f: st.push((a >>> 0) >= (b >>> 0) ? 1 : 0); break;
            case 0x6a: st.push((a + b) | 0); break;
            case 0x6b: st.push((a - b) | 0); break;
            case 0x6c: st.push(Math.imul(a, b)); break;
            case 0x6d: if (b === 0) throw new Error('div0'); st.push((a / b) | 0); break;
            case 0x6e: if (b === 0) throw new Error('div0'); st.push(((a >>> 0) / (b >>> 0)) | 0); break;
            case 0x6f: if (b === 0) throw new Error('div0'); st.push((a % b) | 0); break;
            case 0x70: if (b === 0) throw new Error('div0'); st.push(((a >>> 0) % (b >>> 0)) | 0); break;
            case 0x71: st.push(a & b); break;
            case 0x72: st.push(a | b); break;
            case 0x73: st.push(a ^ b); break;
            case 0x74: st.push(a << (b & 31)); break;
            case 0x75: st.push(a >> (b & 31)); break;
            case 0x76: st.push((a >>> (b & 31)) | 0); break;
            case 0x77: { var s = b & 31; st.push(s ? ((a << s) | (a >>> (32 - s))) | 0 : a); break; }
            case 0x78: { var s3 = b & 31; st.push(s3 ? ((a >>> s3) | (a << (32 - s3))) | 0 : a); break; }
            default: throw new Error('op ' + o);
          }
      }
    }
    return ty.nr ? st[st.length - 1] : undefined;
  }
  this.run = function (exportName, args) {
    var e = exportsMap[exportName];
    if (!e || e.kind !== 0) throw new Error('no export ' + exportName);
    return call(e.idx - 0, args);
  };
  this.memory = function () { return mem; };
}

// ---------------------------------------------------------------- helpers
function vapFetch(url, headers, ms) {
  return new Promise(function (resolve, reject) {
    var done = false, timer = null, ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var opts = { method: 'GET', headers: headers || {} };
    if (ctl) opts.signal = ctl.signal;
    if (ctl && typeof setTimeout === 'function') timer = setTimeout(function () { if (!done) { done = true; try { ctl.abort(); } catch (e) {} reject(new Error('timeout')); } }, ms || 8000);
    fetch(url, opts).then(function (r) { return r.arrayBuffer ? r.arrayBuffer().then(function (ab) { return { status: r.status, buf: ab, text: null }; }) : r.text().then(function (t) { return { status: r.status, buf: null, text: t }; }); })
      .then(function (x) { if (done) return; done = true; if (timer && typeof clearTimeout === 'function') clearTimeout(timer); resolve(x); },
        function (e) { if (done) return; done = true; if (timer && typeof clearTimeout === 'function') clearTimeout(timer); reject(e); });
  });
}
function vapText(x) {
  if (x.text !== null) return x.text;
  var u = new Uint8Array(x.buf), s = '';
  for (var i = 0; i < u.length; i += 4096) s += String.fromCharCode.apply(null, u.subarray(i, Math.min(i + 4096, u.length)));
  try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
}
function vapB64(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function vapJwtExp(tok) {
  try {
    var seg = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (seg.length % 4) seg += '=';
    var j = JSON.parse(atob(seg));
    return typeof j.exp === 'number' ? j.exp : null;
  } catch (e) { return null; }
}
function vapDecrypt(wasmBytes, b64) {
  var m = new WasmMini(wasmBytes), enc = vapB64(b64);
  var ptr = m.run('alloc', [enc.length]);
  m.memory().set(enc, ptr);
  var outLen = m.run('decrypt', [ptr, enc.length]);
  var mem = m.memory(), s = '';
  for (var i = 0; i < outLen; i++) s += String.fromCharCode(mem[ptr + 12 + i]);
  try { s = decodeURIComponent(escape(s)); } catch (e) {}
  return s.split('\n').filter(function (x) { return x; });
}

function resolveVaplayer(id, mediaType, season, episode, opts) {
  try {
    var path, kindPath;
    if (mediaType === 'movie') path = '/embed/movie/' + id;
    else if (mediaType === 'tv') path = '/embed/tv/' + id + '/' + (season || 1) + '/' + (episode || 1);
    else return Promise.resolve([]);
    var wrapUrl = VAP_WRAP + path;
    var h0 = { 'User-Agent': VAP_UA, 'Referer': wrapUrl };
    var embedOrigin = null, cfg = null, apiJson = null;
    return vapFetch(VAP_WRAP + '/embed/va_src.php?path=' + encodeURIComponent(path), h0)
      .then(function (r) {
        var j = JSON.parse(vapText(r));
        if (!j || !j.src) throw new Error('no src');
        embedOrigin = /^(https?:\/\/[^\/]+)/.exec(j.src)[1];
        return vapFetch(j.src, h0);
      })
      .then(function (r) {
        var html = vapText(r), m = /const CONFIG = (\{.*\});/.exec(html);
        if (!m) throw new Error('no CONFIG');
        cfg = JSON.parse(m[1]);
        if (!cfg.apiToken || cfg.rateLimited) throw new Error('no api token');
        var q = (cfg.idType === 'imdb' ? 'imdb=' : 'tmdb=') + encodeURIComponent(cfg.mediaId) + '&type=' + cfg.mediaType;
        if (cfg.mediaType === 'tv' && cfg.season && cfg.episode) q += '&season=' + cfg.season + '&episode=' + cfg.episode;
        var api = (cfg.streamDataApiUrl || 'https://streamdata.vaplayer.ru/api.php') + '?' + q + '&stream_urls&api_token=' + encodeURIComponent(cfg.apiToken);
        return vapFetch(api, { 'User-Agent': VAP_UA, 'Referer': embedOrigin + '/' });
      })
      .then(function (r) {
        apiJson = JSON.parse(vapText(r));
        if (!apiJson || String(apiJson.status_code) !== '200' || !apiJson.data || typeof apiJson.data.stream_urls !== 'string') throw new Error('api ' + (apiJson && apiJson.status_code));
        var va = apiJson.va || apiJson.vp;
        if (!va || !va.wasm_url) throw new Error('no wasm');
        var castUrls = apiJson.data.cast_urls || [], hostOrigin = castUrls.length ? /^(https?:\/\/[^\/]+)/.exec(castUrls[0]) : null;
        var genP = hostOrigin
          ? vapFetch(hostOrigin[1] + '/generate.php?api_token=' + encodeURIComponent(cfg.apiToken), { 'User-Agent': VAP_UA }).then(function (x) { return { origin: hostOrigin[1], text: vapText(x).trim(), status: x.status }; }).catch(function () { return null; })
          : Promise.resolve(null);
        return Promise.all([vapFetch(va.wasm_url, { 'User-Agent': VAP_UA }), genP]);
      })
      .then(function (rs) {
        var urls = vapDecrypt(new Uint8Array(rs[0].buf), apiJson.data.stream_urls);
        var gen = rs[1], tokens = {}, out = [], i;
        function tokFor(origin) {
          if (tokens[origin] !== undefined) return Promise.resolve(tokens[origin]);
          if (gen && gen.origin === origin && gen.status === 200) { tokens[origin] = gen.text; return Promise.resolve(gen.text); }
          return vapFetch(origin + '/generate.php?api_token=' + encodeURIComponent(cfg.apiToken), { 'User-Agent': VAP_UA })
            .then(function (x) { var t = x.status === 200 ? vapText(x).trim() : ''; tokens[origin] = t; return t; }, function () { tokens[origin] = ''; return ''; });
        }
        return Promise.all(urls.map(function (u) { return tokFor(/^(https?:\/\/[^\/]+)/.exec(u)[1]); })).then(function () {
          var subs = [];
          var ds = apiJson.default_subs || [];
          for (i = 0; i < ds.length; i++) if (ds[i] && ds[i].file) subs.push({ url: ds[i].file, lang: ds[i].lang || '', label: ds[i].label || ds[i].lang || '' });
          for (i = 0; i < urls.length; i++) {
            var u = urls[i], origin = /^(https?:\/\/[^\/]+)/.exec(u)[1], tk = tokens[origin];
            if (!tk) continue;
            var pli = u.replace('/pl/', '/pli/');
            out.push({
              server: 'JustHD #' + (i + 1),
              url: pli + (pli.indexOf('?') > -1 ? '&' : '?') + 'token=' + tk,
              kind: 'hls',
              quality: '',
              headers: { 'Referer': embedOrigin + '/', 'User-Agent': VAP_UA },
              subtitles: subs,
              expires: vapJwtExp(tk)
            });
          }
          return out;
        });
      })
      .then(function (x) { return x; }, function (e) { if (typeof console !== 'undefined' && opts && opts.debug) console.log('vaplayer fail', e && e.message); return []; });
  } catch (e) { return Promise.resolve([]); }
}

// ==== 30-zokoanime.js ====
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

// ==== 31-megaplay.js ====
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

// ==== 32-tryembed.js ====
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

// ==== 33-animetvplus.js ====
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

// ==== 34-mikaza.js ====
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

// ==== 99-exports.js ====

if (typeof module !== 'undefined' && module.exports) module.exports = { getStreams: getStreams, onSettings: onSettings };
else { global.getStreams = getStreams; global.onSettings = onSettings; }

