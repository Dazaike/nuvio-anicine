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
