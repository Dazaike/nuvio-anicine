// Judge one returned Nuvio stream: HLS (master -> variant -> first segment, see verify-hls.js) or MP4/MKV (Range request, magic bytes).
const { verifyHls } = require('./verify-hls');

async function rangeBytes(url, headers, max) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let status = 0, n = 0, got = [];
  try {
    const r = await fetch(url, { headers: Object.assign({ Range: 'bytes=0-' + (max - 1) }, headers), redirect: 'follow', signal: ctl.signal });
    status = r.status;
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      got.push(Buffer.from(value)); n += value.length;
      if (n >= max) { ctl.abort(); break; }
    }
  } catch (e) { if (n < max) throw e; } finally { clearTimeout(timer); }
  return { status, buf: Buffer.concat(got) };
}

function kindOf(buf) {
  if (!buf || buf.length < 12) return 'too small';
  if (/^\s*<(!doctype|html)/i.test(buf.subarray(0, 64).toString('latin1'))) return 'HTML';
  const t = buf.subarray(4, 8).toString('latin1');
  if (t === 'ftyp') return 'mp4 (ftyp)';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'mkv (EBML)';
  if (buf[0] === 0x47 && buf[188] === 0x47) return 'mpegts';
  return 'unknown:' + buf.subarray(0, 8).toString('hex');
}

async function verifyStream(s) {
  const headers = s.headers || {};
  const isHls = /\bHLS\b/.test(s.title || '') || /m3u8/i.test(s.url);
  try {
    if (isHls) {
      const r = await verifyHls(s.url, headers);
      return { ok: r.ok, text: r.steps.join(' > ') + (r.why ? ' !' + r.why : '') };
    }
    const r = await rangeBytes(s.url, headers, 1024 * 1024);
    const k = kindOf(r.buf);
    const ok = (r.status === 200 || r.status === 206) && /^(mp4|mkv|mpegts)/.test(k);
    return { ok, text: 'range ' + r.status + ' ' + r.buf.length + 'B ' + k };
  } catch (e) { return { ok: false, text: 'exception ' + (e && e.message || e) }; }
}
module.exports = { verifyStream };
