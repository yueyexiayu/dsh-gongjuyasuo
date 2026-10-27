import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, core, commit, config, assertMeter, installed, installedBase, llm } from './fixture.mjs';
import { installedIo } from './installed-io.mjs';
import { metrics } from '../lib/observability.js';
const [{BasicCompactionEngine},Retry,{AgentRegistry},{LlmRuntime},{deriveTurnTokenUsage}]=await Promise.all([
  installed('dsh-compaction-basic'),installed('dsh-llm-retry'),installed('dsh-agent'),installed('dsh-llm'),import(installedBase+'dsh-token-meter/lib/types/client.js'),
]);

function expectedWindow(text,offset,limit){return text.replace(/\n$/u,'').split('\n').slice(offset-1,offset-1+limit).map((text,i)=>({number:offset+i,text}));}

async function balancedFixture(t){
  const f=await fixture(t);new AgentRegistry(f.ctx);new LlmRuntime(f.ctx);
  Retry.apply(f.ctx,{}, {random:()=>0.5});
  f.session.append('turn/start',{turn:1});
  f.session.append('step/start',{turn:1,step:100});
  const call=llm.createAssistantMessage({source:{provider:'synthetic',model:'no-provider'},content:[{type:'tool-call',id:'call-1',name:'read',arguments:'{"file_path":"fixture-source"}'}]});
  const first=f.session.append('assistant/message',{turn:1,step:100,message:call,stream:[{type:'chunk',chunk:{type:'finish',reason:{kind:'tool-calls'}}}]},{surfaceOp:'append'});
  const original=f.tool('官方压缩邻接证据：αβ🙂，synthetic no-provider original text.\n'.repeat(700));f.session.append('step/end',{turn:1,step:100});
  const c=f.age(original),cp=f.queue(f.checkpoint(c));
  let summaries=0;
  class DeterministicCompaction extends BasicCompactionEngine {
    async summarize(){summaries++;return {summary:[{type:'text',text:'Synthetic official compaction summary; no provider called.'}],provider:'synthetic',model:'no-provider'};}
  }
  const engine=new DeterministicCompaction(f.ctx,{auto:false});
  const agent={ctx:f.ctx,session:f.session,options:{}};
  const policy={mode:'normal',maxRetries:2,retryableCodes:['SERVER'],initialDelayMs:0,maxDelayMs:0,jitterRatio:0};
  const payload={agent,turn:1,step:3,provider:'synthetic',failure:{code:'SERVER',message:'deterministic retry probe'},retryPolicy:policy,signal:new AbortController().signal};
  const retry=()=>f.ctx.waterfall('agent/request-error',payload,()=>undefined);
  const retryState=()=>f.ctx.sessionProjections.stateOf(f.session,'llmRetry')[JSON.stringify(['synthetic',Retry.retryPolicyKey(policy)])];
  return {...f,c,cp,first,engine,agent,retry,retryState,summaries:()=>summaries};
}

test('real LocalSpillStore and installed read restore deleted snapshots across a fresh Electron process despite changed source',async t=>{
  const f=await fixture(t),io=await installedIo(f),source=join(f.dir,'original-source.txt');
  const sourceText=Array.from({length:400},(_,i)=>`原始源行 ${i+1} αβ🙂 固定证据 unchanged snapshot`).join('\n')+'\n';
  await writeFile(source,sourceText);
  const sourceRead=await io.read(source,1,400),original=sourceRead.content[0].text;
  const event=f.tool(original,{args:{file_path:source,offset:1,limit:400}}),c=f.age(event),cp=f.queue(f.checkpoint(c));
  const {prepared,result}=await commit(f,cp,config(),io.spill);assert.equal(result.successful.length,1);
  const saved=prepared.items[0].saved;
  assert.equal((await stat(saved.locator)).mode&0o777,0o600);
  assert.deepEqual((await io.read(saved.locator,5,3)).value.lines,expectedWindow(original,5,3));
  await writeFile(source,'SOURCE CHANGED AFTER ORIGINAL READ\nreplacement is not the saved event\n');
  assert.deepEqual((await io.read(source,1,2)).value.lines,[{number:1,text:'SOURCE CHANGED AFTER ORIGINAL READ'},{number:2,text:'replacement is not the saved event'}]);
  assert.deepEqual((await io.read(saved.locator,5,3)).value.lines,expectedWindow(original,5,3));
  // Delete only this exact newly-created spill file, never an arbitrary root.
  assert.equal(dirname(dirname(resolve(saved.locator))),resolve(io.spill.root));
  await unlink(saved.locator);await assert.rejects(stat(saved.locator),{code:'ENOENT'});
  const recovered=await core.recover(f.j,c.ref,io.spill,f.record);
  assert.notEqual(recovered.path,saved.locator);
  assert.deepEqual((await io.read(recovered.path,5,3)).value.lines,expectedWindow(original,5,3));
  assert.deepEqual((await io.read(recovered.path)).value.lines,expectedWindow(original,1,2000));
  // Remove this recovery too: the new process cannot rely on either prior path.
  assert.equal(dirname(dirname(resolve(recovered.path))),resolve(io.spill.root));await unlink(recovered.path);
  const snapshot=await f.ctx.sessionQuery.readSession(f.session.id),seedPath=join(f.dir,'restart-source-events.json');
  await writeFile(seedPath,JSON.stringify({id:f.session.id,header:f.session.header,inheritedEventCount:f.session.inheritedEventCount,events:snapshot.events,ref:c.ref,sha256:c.hash}));
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_TEST_CONTEXT;
  const child=spawnSync('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',[fileURLToPath(new URL('./restart-worker.mjs',import.meta.url)),seedPath],{env,encoding:'utf8',timeout:20000});
  assert.ifError(child.error);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
  const restored=JSON.parse(child.stdout.trim());assert.notEqual(restored.pid,process.pid);assert.equal(restored.electron,process.versions.electron);
  assert.equal(restored.sha256,c.hash);assert.equal(restored.ref,c.ref);assert.equal(restored.batches,1);assert.equal(restored.finished,1);
  assert.deepEqual(restored.window.lines,expectedWindow(original,5,3));assert.equal(restored.lineCount,original.split('\n').length);
  assertMeter(assert,f);
});

test('official BasicCompactionEngine lifecycle next to plugin prune preserves retry budget, receipts, recovery and token projections',async t=>{
  const f=await balancedFixture(t),io=await installedIo(f);
  assert.deepEqual(await f.retry(),{kind:'retry'});const firstRetry={...f.retryState()};assert.equal(firstRetry.retry,1);
  const {result}=await commit(f,f.cp,config(),io.spill);assert.equal(result.successful.length,1);assert.deepEqual(f.retryState(),firstRetry);
  assertMeter(assert,f);
  const end=f.session.surface.nodes.at(-1);
  const compacted=await f.engine.compactRegion(f.first.seq,end,f.agent,new AbortController().signal);
  assert.equal(f.summaries(),1);assert.equal(f.j.events.get(compacted.startSeq).type,'compaction/start');assert.equal(f.j.events.get(compacted.summarySeq).type,'compaction/summary');assert.equal(f.j.events.get(compacted.summarySeq+1).type,'user/message');assert.equal(f.j.events.get(compacted.endSeq).type,'compaction/end');
  assert.equal(f.j.events.get(compacted.summarySeq).data.llmStreamCall,undefined,'synthetic summarizer must not claim a real model stream');
  assert.deepEqual(f.retryState(),firstRetry);assert.equal(f.j.finished.size,1);assert.equal(f.j.batches.size,1);assertMeter(assert,f);
  const recovered=await core.recover(f.j,f.c.ref,io.spill,f.record);assert.deepEqual((await io.read(recovered.path,1,2)).value.lines,expectedWindow(f.c.text,1,2));
  assert.deepEqual(await f.retry(),{kind:'retry'});assert.equal(f.retryState().retry,2);assert.equal(f.retryState().retryId,firstRetry.retryId);
  assert.equal(await f.retry(),undefined,'prune and compaction may not reset the normal retry limit');
  const m=metrics(f.j,deriveTurnTokenUsage);assert.equal(m.counts.recoveries,1);assert.equal(m.counts.foldedCheckpoints,1);assert.equal(m.counts.retries,2);assertMeter(assert,f);
  f.session.append('turn/end',{turn:1,reason:{kind:'stop'}});assert.deepEqual(f.ctx.sessionProjections.stateOf(f.session,'llmRetry'),{});assert.equal(f.j.finished.size,1);
});

test('official compaction during asynchronous spill saving invalidates only stale item and leaves retry recovery alive',async t=>{
  const f=await balancedFixture(t),io=await installedIo(f);assert.deepEqual(await f.retry(),{kind:'retry'});const firstRetry={...f.retryState()};
  let official;
  const interleavedSpill={async saveText(input){const saved=await io.spill.saveText(input);official=await f.engine.compactRegion(f.first.seq,f.session.surface.nodes.at(-1),f.agent,new AbortController().signal);return saved;}};
  const {result}=await commit(f,f.cp,config(),interleavedSpill);
  assert.equal(result.successful.length,0);assert.ok(result.skips.some(x=>x.reason==='stale-after-save'));
  assert.equal(f.summaries(),1);assert.ok(official);assert.deepEqual(f.retryState(),firstRetry);assert.equal(f.j.batches.size,0);
  assert.equal([...f.j.events.values()].filter(e=>e.type==='compaction/prune').length,0,'stale plugin commit may not add prune inside or after official compaction');
  assertMeter(assert,f);assert.deepEqual(await f.retry(),{kind:'retry'});assert.equal(f.retryState().retry,2);
  assert.equal(f.j.events.get(official.endSeq).type,'compaction/end');
  assert.equal(metrics(f.j,deriveTurnTokenUsage).counts.retries,2);
});
