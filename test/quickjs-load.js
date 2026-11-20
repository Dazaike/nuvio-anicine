// Loads providers/anicine.js into a real QuickJS (quickjs-emscripten) with the same globals the app gives plugins (no Buffer, TextEncoder,
// crypto, process, setTimeout, WebAssembly), checks it parses, defines getStreams/onSettings and returns [] for a garbage id.
//   QJS_DIR=<dir containing node_modules/quickjs-emscripten> node test/quickjs-load.js
const fs = require('fs'), path = require('path');
const dir = process.env.QJS_DIR || path.join(__dirname, '..', 're', 'embedsB', 'tools');
const { getQuickJS } = require(path.join(dir, 'node_modules', 'quickjs-emscripten'));
(async () => {
  const QJS = await getQuickJS(), vm = QJS.newContext();
  const pump = () => { const j = vm.runtime.executePendingJobs(); if (j.error) { const e = vm.dump(j.error); j.error.dispose(); throw new Error('job: ' + JSON.stringify(e)); } };
  const run = (code) => { const r = vm.evalCode(code); if (r.error) { const e = vm.dump(r.error); r.error.dispose(); throw new Error(JSON.stringify(e)); } const v = vm.dump(r.value); r.value.dispose(); return v; };
  run(`var global = globalThis; var console = { log: function(){}, error: function(){}, warn: function(){} };
       var fetch = function(){ return Promise.reject(new Error('no network in this check')); };
       var atob = function(s){var c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',o='',b=0,n=0;s=String(s).replace(/=+$/,'');for(var i=0;i<s.length;i++){b=(b<<6)|c.indexOf(s.charAt(i));n+=6;if(n>=8){n-=8;o+=String.fromCharCode((b>>n)&255);}}return o;};`);
  run(fs.readFileSync(path.join(__dirname, '..', 'providers', 'anicine.js'), 'utf8'));
  console.log('typeof getStreams/onSettings:', run('typeof getStreams + "/" + typeof onSettings'));
  console.log('globals present that must not be:', run('["Buffer","TextEncoder","process","WebAssembly","setTimeout"].filter(function(k){return typeof globalThis[k] !== "undefined";}).join(",") || "none"'));
  console.log('onSettings fields:', run('onSettings().map(function(f){return f.type + ":" + (f.key||"")}).join(" ")'));
  run('var __r = "pending"; getStreams("abc","movie").then(function(x){ __r = JSON.stringify(x); }, function(e){ __r = "REJECTED " + e; }); "started"');
  pump();
  console.log('getStreams("abc","movie") ->', run('__r'));
  run('var __n = "pending"; getStreams("550","movie").then(function(x){ __n = "resolved " + JSON.stringify(x); }, function(e){ __n = "REJECTED " + e; }); "started"');
  for (let i = 0; i < 50; i++) pump();
  console.log('getStreams("550","movie") with a failing fetch ->', run('__n'));
  vm.dispose();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
