// Runs the provider in a vm context that looks like Nuvio's QuickJS runtime, then judges every returned stream.
//   node test/node-test.js                 one round
//   ROUNDS=3 node test/node-test.js        three rounds (flakiness), fresh provider state each round (no cache)
//   ROUNDS=3 PAUSE=600 node test/node-test.js   ...then one more round after a 10 minute pause (signed URL / cache expiry)
//   ONLY=tv node test/node-test.js         run only cases whose name matches /tv/i
// Like the device, fetch calls are SERIALIZED here (PluginRuntime's __native_fetch blocks the JS thread), response bodies are capped at
// 1 MB, and there is no Buffer / TextEncoder / crypto / process / WebAssembly / setTimeout inside the sandbox.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { verifyStream } = require('./verify-stream');
const FILE = process.env.PROVIDER_FILE || path.join(__dirname, '..', 'providers', 'anicine.js');
const code = fs.readFileSync(FILE, 'utf8');
const ROUNDS = +(process.env.ROUNDS || 1), PAUSE = +(process.env.PAUSE || 0), ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
const MAX_BODY = 1024 * 1024;

function makeSandbox(logs) {
  let chain = Promise.resolve();
  const serialFetch = (url, opts) => {
    const run = async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      try {
        const r = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
        const rd = r.body.getReader(); const parts = []; let n = 0;
        for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(Buffer.from(value)); n += value.length; if (n >= MAX_BODY) { ctl.abort(); break; } }
        const buf = Buffer.concat(parts).subarray(0, MAX_BODY); const text = buf.toString('utf8');
        return { ok: r.ok, status: r.status, statusText: r.statusText, url: r.url,
          headers: { get: (k) => r.headers.get(k) },
          text: () => Promise.resolve(text), json: () => { try { return Promise.resolve(JSON.parse(text)); } catch (e) { return Promise.resolve(null); } },
          arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) };
      } finally { clearTimeout(timer); }
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
  const sb = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERR ' + a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    fetch: serialFetch, URL, URLSearchParams, AbortController, atob, btoa,
    SCRAPER_ID: 'anicine', SCRAPER_SETTINGS: {},
    require: (m) => { if (m === 'crypto-js') return require('crypto-js'); throw new Error('module not available in sandbox: ' + m); },
  };
  sb.global = sb;
  vm.createContext(sb);
  vm.runInContext(code, sb);
  if (typeof sb.getStreams !== 'function') throw new Error('provider did not define global getStreams');
  return sb;
}

// [name, expectation, args]; expectation 'streams' | 'empty'
const CASES = [
  ['movie 550 Fight Club', 'streams', ['550', 'movie']],
  ['movie 969681 Spider-Man: Brand New Day (2026)', 'streams', ['969681', 'movie']],
  ['movie 1368337 The Odyssey (2026)', 'streams', ['1368337', 'movie']],
  ['movie 10513 Plan 9 from Outer Space (1957)', 'streams', ['10513', 'movie']],
  ['movie 25693 Albino Farm (2009, obscure; thin catalogue)', 'any', ['25693', 'movie']],
  ['movie 129 Spirited Away (anime film)', 'streams', ['129', 'movie']],
  ['tv 1396 Breaking Bad S1E1', 'streams', ['1396', 'tv', 1, 1]],
  ['tv 1622 Supernatural S15E20', 'streams', ['1622', 'tv', 15, 20]],
  ['tv 456 The Simpsons S34E10', 'streams', ['456', 'tv', 34, 10]],
  ['anime tv 37854 One Piece S21E892 (abs 892)', 'streams', ['37854', 'tv', 21, 892]],
  ['anime tv 37854 One Piece S21E100 (TMDB has no such episode)', 'empty', ['37854', 'tv', 21, 100]],
  ['anime tv 85937 Demon Slayer S3E5', 'streams', ['85937', 'tv', 3, 5]],
  ['anime tv 209867 Frieren S1E10', 'streams', ['209867', 'tv', 1, 10]],
  ['anime tv 1429 Attack on Titan S3E15 (part 2)', 'streams', ['1429', 'tv', 3, 15]],
  ['unknown movie 99999999', 'empty', ['99999999', 'movie']],
  ['unknown tv 99999999 S1E1', 'empty', ['99999999', 'tv', 1, 1]],
  ['garbage id "abc"', 'empty', ['abc', 'movie']],
  ['garbage id "-5" tv', 'empty', ['-5', 'tv', 1, 1]],
];

async function round(n) {
  const logs = [], sb = makeSandbox(logs), rows = [];
  let pass = 0, total = 0, sPass = 0, sTotal = 0;
  for (const [name, expect, args] of CASES) {
    if (ONLY && !ONLY.test(name)) continue;
    logs.length = 0; total++;
    const t0 = Date.now();
    let out = [];
    try { out = await sb.getStreams.apply(null, args); } catch (e) { out = null; }
    const ms = Date.now() - t0;
    const row = { name, expect, ms, n: out ? out.length : -1, servers: '', results: [], subs: 0, ok: false, note: '' };
    if (!Array.isArray(out)) { row.note = 'getStreams THREW/rejected'; rows.push(row); continue; }
    if (expect === 'empty') { row.ok = out.length === 0 && ms < 15000; row.note = row.ok ? '[]' : 'expected [] got ' + out.length; rows.push(row); if (row.ok) pass++; continue; }
    if (expect === 'any' && !out.length) { row.ok = true; row.note = '[] (thin catalogue, none of the hosts has it right now)'; rows.push(row); pass++; continue; }
    row.servers = out.map((s) => s.name.replace(/^AniCine - /, '')).join(', ');
    if (process.env.VERBOSE) console.log('--- ' + name + ' (' + ms + ' ms)\n' + logs.join('\n'));
    row.subs = out.reduce((a, s) => a + (s.subtitles || []).length, 0);
    let allOk = out.length > 0 && /Auto \(Best\)/.test(out[0].name);
    if (!allOk) row.note = out.length ? 'first stream is not Auto (Best)' : 'NO STREAMS';
    for (const s of out) {
      const v = await verifyStream(s); sTotal++; if (v.ok) sPass++; else allOk = false;
      row.results.push((v.ok ? 'PASS ' : 'FAIL ') + s.name.replace(/^AniCine - /, '') + ' [' + s.title.split(' - ').slice(1).join(' ') + ']: ' + v.text);
    }
    row.ok = allOk; if (allOk) pass++;
    row.log = logs.filter((l) => /stream\(s\)/.test(l)).pop() || '';
    rows.push(row);
  }
  return { rows, pass, total, sPass, sTotal };
}

(async () => {
  const summary = [];
  const labels = [];
  for (let i = 1; i <= ROUNDS; i++) labels.push('round ' + i);
  if (PAUSE) labels.push('round ' + (ROUNDS + 1) + ' (after ' + PAUSE + ' s pause)');
  for (let i = 0; i < labels.length; i++) {
    if (PAUSE && i === labels.length - 1) { console.log('\n... pausing ' + PAUSE + ' s ...'); await new Promise((r) => setTimeout(r, PAUSE * 1000)); }
    console.log('\n===== ' + labels[i] + ' =====');
    const r = await round(i);
    console.log('| case | streams | servers | per-stream result (master > variant > segment | range bytes) | getStreams ms | subs |');
    console.log('|---|---|---|---|---|---|---|');
    for (const w of r.rows) console.log('| ' + w.name + ' | ' + (w.n < 0 ? 'THREW' : w.n) + ' | ' + (w.servers || w.note) + ' | ' + (w.results.length ? w.results.join('<br>') : w.note) + ' | ' + w.ms + ' | ' + w.subs + ' |');
    console.log('\n' + labels[i] + ': ' + r.pass + '/' + r.total + ' cases passed (every returned stream verified); ' + r.sPass + '/' + r.sTotal + ' individual streams verified. Slowest getStreams: ' + Math.max.apply(null, r.rows.map((x) => x.ms)) + ' ms.');
    summary.push([labels[i], r]);
  }
  const P = summary.reduce((a, [, r]) => a + r.pass, 0), T = summary.reduce((a, [, r]) => a + r.total, 0);
  const SP = summary.reduce((a, [, r]) => a + r.sPass, 0), ST = summary.reduce((a, [, r]) => a + r.sTotal, 0);
  console.log('\nOVERALL: ' + P + '/' + T + ' case runs passed, ' + SP + '/' + ST + ' streams verified.');
  process.exit(P === T ? 0 : 1);
})();
