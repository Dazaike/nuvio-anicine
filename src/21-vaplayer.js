'use strict';
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

module.exports = resolveVaplayer;
module.exports.WasmMini = WasmMini;
module.exports.vapDecrypt = vapDecrypt;
