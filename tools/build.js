// Concatenates src/*.js (sorted) into providers/anicine.js. The embed modules in src/ were written as CommonJS-style files; their
// `'use strict'` and `module.exports...` lines are dropped so the result is one plain script (the only export is at the end).
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
let out = '';
for (const f of files) {
  let t = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!/^99-/.test(f)) t = t.replace(/^\s*'use strict';\s*$/gm, '').replace(/^(if \(typeof module !== 'undefined' && module\.exports\) )?module\.exports(\.[A-Za-z_]+)? = .*$/gm, '');
  out += '// ==== ' + f + ' ====\n' + t.replace(/\s+$/, '') + '\n\n';
}
fs.writeFileSync(path.join(__dirname, '..', 'providers', 'anicine.js'), out);
console.log('built providers/anicine.js from', files.join(', '), '(' + out.length + ' bytes)');
