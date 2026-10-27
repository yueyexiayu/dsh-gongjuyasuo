// Launched by io-lifecycle.test.mjs in a new installed Electron RunAsNode
// process. No expected body is passed: recovery must derive it from JSON events.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture,core,assertMeter } from './fixture.mjs';
import { installedIo } from './installed-io.mjs';
const disposers=[];
try {
  const input=JSON.parse(await readFile(process.argv[2],'utf8'));
  const f=await fixture({after(fn){disposers.push(fn);}},{id:input.id,seed:input.events,meta:input.header,inheritedEventCount:input.inheritedEventCount});
  const io=await installedIo(f);
  const recovered=await core.recover(f.j,input.ref,io.spill,f.record);
  const window=await io.read(recovered.path,5,3),all=await io.read(recovered.path);
  const reconstructed=all.value.lines.map(line=>line.text).join('\n')+'\n';
  const original=f.j.events.get(recovered.sourceSeq).data.message.content.map(b=>b.type==='text'?b.text:'').join('');
  // read's line window intentionally omits final newline; compare the exact
  // independently reconstructed line sequence rather than calling readFile.
  assert.deepEqual(all.value.lines.map(x=>x.text),original.replace(/\n$/u,'').split('\n'));
  assert.equal(core.digest(original),input.sha256);
  assert.equal(f.j.finished.size,1);
  const measured=assertMeter(assert,f);
  process.stdout.write(JSON.stringify({pid:process.pid,electron:process.versions.electron,ref:recovered.ref,sha256:core.digest(original),recoveredPath:recovered.path,window:window.value,readLineHash:core.digest(reconstructed),lineCount:all.value.lines.length,finished:f.j.finished.size,batches:f.j.batches.size,surfaceTokens:measured.surfaceTokens})+'\n');
} finally {for(const dispose of disposers.reverse())await dispose();}
