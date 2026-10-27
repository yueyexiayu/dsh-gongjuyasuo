import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { fixture, core, config, code, LONG, commit, assertMeter, llm } from './fixture.mjs';

// Every mutation below goes through the installed Session append validator.
// Spill adapters only inject I/O failures; no Session or token fold is mocked.
test('admission requires successful consumption and two later successful requests', async t=>{
  const f=await fixture(t),e=f.tool();
  assert.equal(core.candidate(f.j,e.seq,config()).skip,'not-successfully-consumed');
  for(const options of [{reason:'error'},{interrupted:true},{finishCount:0},{finishCount:2}]) f.request(options);
  assert.equal(f.j.successful,0);
  f.request(); assert.equal(core.candidate(f.j,e.seq,config()).skip,'recent');
  f.request(); assert.equal(core.candidate(f.j,e.seq,config()).skip,'recent');
  f.request(); assert.equal(core.candidate(f.j,e.seq,config()).seq,e.seq);
  assertMeter(assert,f);
});

test('unsafe, excluded, malformed and shared-spill results are never eligible',async t=>{
  const f=await fixture(t);
  const cases=[
    [f.tool('short'),'short'],
    [f.tool(`${LONG}\u0000binary sentinel`),'binary-text'],
    [f.tool(LONG,{name:'gongjuyasuo'}),'excluded'],
    [f.tool(LONG,{name:'secret'}),'excluded'],
    [f.tool(LONG,{isError:true}),'error'],
    [f.tool(LONG,{content:[{type:'text',text:LONG,annotation:'not-losslessly-externalizable'}]}),'unsupported-content'],
    [f.tool(LONG,{content:[{type:'image',url:'data:image/png;base64,AA=='}]}),'unsupported-content'],
    [f.tool(`Full formatted result stored at: /existing/shared\n${LONG}`),'existing-spill'],
  ];
  for(let i=0;i<3;i++) f.request();
  for(const [e,skip]of cases)assert.equal(core.candidate(f.j,e.seq,config({excludeTools:['secret']})).skip,skip);
});

test('checkpoint rejects invented, foreign and never-advertised refs without touching surface',async t=>{
  const f=await fixture(t),e=f.tool();for(let i=0;i<3;i++)f.request();
  const c=core.candidate(f.j,e.seq,config()),cp=f.checkpoint(c),before=[...f.session.surface.nodes];
  assert.throws(()=>core.validateCheckpoint(f.j,cp,config()),code('UNADVERTISED_OR_FOREIGN_REF'));
  for(const ref of ['gy:invented:999:abcdef',core.reference('another-session',e)]) {
    const bad=structuredClone(cp);bad.covered[0].ref=ref;
    assert.throws(()=>core.validateCheckpoint(f.j,bad,config()),code('UNADVERTISED_OR_FOREIGN_REF'));
  }
  f.request({advertise:[c.ref]});assert.equal(core.validateCheckpoint(f.j,cp,config()).covered[0].ref,c.ref);
  assert.deepEqual(f.session.surface.nodes.slice(0,before.length),before);
});

test('handoff requires exact quote, conclusion, dependency clearance and bounded valid state',async t=>{
  const f=await fixture(t),c=f.age(f.tool()),cp=f.checkpoint(c);
  const mutate=[
    [p=>p.covered[0].evidenceQuote='not actually present in original text','INSUFFICIENT_HANDOFF'],
    [p=>p.covered[0].evidenceQuote='too short','INSUFFICIENT_HANDOFF'],
    [p=>p.covered[0].conclusion=' ','INSUFFICIENT_HANDOFF'],
    [p=>p.covered[0].noLongerDirectlyNeeded=false,'INSUFFICIENT_HANDOFF'],
    [p=>p.retain.push({ref:c.ref,reason:'still needed'}),'DUPLICATE_OR_PROTECTED_REF'],
    [p=>p.state.unresolved.push({id:'issue',text:'still open',refs:[c.ref]}),'UNRESOLVED_OR_DIRECT_DEPENDENCY'],
    [p=>p.state.findings[0].refs=['invented'],'UNSUPPORTED_STATE_SOURCE'],
    [p=>p.state.subgoal='','INVALID_STATE'],
    [p=>p.state.changes='x'.repeat(15000),'CHECKPOINT_TOO_LARGE'],
    [p=>p.previousCheckpoint='old','STALE_CHECKPOINT'],
  ];
  for(const [mutator,expected]of mutate){const p=structuredClone(cp);mutator(p);assert.throws(()=>core.validateCheckpoint(f.j,p,config()),code(expected));}
  assert.throws(()=>core.validateCheckpoint(f.j,cp,config({enabled:false})),code('DISABLED'));
});

test('unresolved issues and constraints must carry verbatim or be explicitly resolved',async t=>{
  const f=await fixture(t),a=f.age(f.tool()),b=f.age(f.tool());
  const first=f.checkpoint(a,{retain:[{ref:b.ref,reason:'open issue'}]});
  first.state.unresolved=[{id:'u1',text:'原始未决问题',refs:[b.ref]}];
  f.queue(core.validateCheckpoint(f.j,first,config()));
  const next=f.checkpoint(b);next.state.findings.push({text:'old evidence retained',refs:[a.ref]});
  assert.throws(()=>core.validateCheckpoint(f.j,next,config()),code('DROPPED_UNRESOLVED'));
  next.resolvedIssues=[{id:'u1',evidence:'问题已有可核对解答',refs:[b.ref]}];
  assert.doesNotThrow(()=>core.validateCheckpoint(f.j,next,config()));
  next.state.constraints=[];assert.throws(()=>core.validateCheckpoint(f.j,next,config()),code('DROPPED_CONSTRAINT'));
});

test('batch preserves exact UTF-8 bytes, identity and source; repeat execution is idempotent',async t=>{
  const f=await fixture(t),e=f.tool(),c=f.age(e),cp=f.queue(f.checkpoint(c));
  const before=assertMeter(assert,f),{prepared,result}=await commit(f,cp);
  assert.equal(result.successful.length,1);assert.equal(result.failures.length,0);
  assert.equal(await readFile(prepared.items[0].saved.locator,'utf8'),LONG);
  assert.equal(prepared.items[0].bytes,Buffer.byteLength(LONG));
  const replacement=f.j.events.get(result.successful[0].replacementSeq);
  assert.equal(replacement.data.message.id,e.data.message.id);
  assert.equal(replacement.data.message.toolCallId,e.data.message.toolCallId);
  assert.deepEqual(replacement.sourceEventSeqs,[e.seq,result.manifestSeq]);
  assert.equal(f.j.events.get(replacement.seq-1).type,'compaction/prune');
  assert.ok(!f.session.surface.nodes.includes(e.seq));assert.ok(f.j.events.has(e.seq));
  assert.ok(assertMeter(assert,f).surfaceTokens<before.surfaceTokens);
  assert.equal(core.candidate(f.j,replacement.seq,config()).skip,'upstream-replacement','0.1.1 rejects every non-append result before any externalization-specific check');
  const again=await commit(f,cp);assert.equal(again.result.successful.length,0);
  assert.equal([...f.j.batches.values()].length,1);
  assert.equal([...f.j.events.values()].filter(e=>['compaction/start','compaction/summary','compaction/end'].includes(e.type)).length,0);
});

test('readback mismatch and save failure leave originals intact',async t=>{
  const f=await fixture(t),c=f.age(f.tool()),cp=f.queue(f.checkpoint(c));
  for(const spill of [
    {saveText:async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}},
    {saveText:async input=>{const saved=await f.spill.saveText(input);await writeFile(saved.locator,'corrupted');return saved;}},
    {saveText:async input=>({...await f.spill.saveText(input),bytes:1})},
  ]) {
    const {result}=await commit(f,cp,config(),spill);
    assert.equal(result.successful.length,0);assert.equal(result.failures.length,1);
    assert.ok(['ENOSPC','SPILL_READBACK_MISMATCH'].includes(result.failures[0].code));
    assert.ok(f.session.surface.nodes.includes(c.seq));
  }
  assert.equal(f.j.batches.size,0);assertMeter(assert,f);
});

test('source replaced during save cannot be committed from stale prepared data',async t=>{
  const f=await fixture(t),c=f.age(f.tool()),cp=f.queue(f.checkpoint(c));
  const prepared=await core.prepareBatch(f.j,cp,config(),f.spill);
  f.session.append('compaction/prune',{shadowedRange:{start:c.seq,end:c.seq},shadowedSeqs:[c.seq],shadowedTokenCount:f.ctx.tokenMeter.estimateMessage(c.message)});
  f.session.append('tool/result',{...c.event.data,message:llm.freezeMessage({...c.message,content:[{type:'text',text:'source changed by another safe producer'}]})},{surfaceOp:{op:'replace',startSeq:c.seq,endSeq:c.seq},sourceEventSeqs:[c.seq]});
  const result=core.commitBatch(f.j,cp,prepared,config(),f.ctx.tokenMeter,f.record,llm.freezeMessage);
  assert.equal(result.successful.length,0);assert.ok(result.skips.some(x=>x.reason==='stale-after-save'));assertMeter(assert,f);
});

test('net-reduction gates keep low-yield data; cancel or disable after saving keeps sources',async t=>{
  const f=await fixture(t),c=f.age(f.tool()),cp=f.queue(f.checkpoint(c));
  const tiny=await core.prepareBatch(f.j,cp,config({minNetReductionChars:1000000}),f.spill);
  assert.equal(tiny.items.length,0);assert.ok(tiny.skips.some(x=>x.reason==='insufficient-net-reduction'));
  for(const disabled of [true,false]){
    const prepared=await core.prepareBatch(f.j,cp,config(),f.spill),controller=new AbortController();if(!disabled)controller.abort();
    const result=core.commitBatch(f.j,cp,prepared,config({enabled:!disabled}),f.ctx.tokenMeter,f.record,llm.freezeMessage,controller.signal);
    assert.equal(result.successful.length,0);assert.ok(result.skips.some(x=>x.reason===(disabled?'disabled':'aborted')));
  }
  assert.ok(f.session.surface.nodes.includes(c.seq));
});

test('partial commit reports failures and does not leak a shadow claim into the next append',async t=>{
  const f=await fixture(t),a=f.age(f.tool()),b=f.age(f.tool()),cp=f.queue(f.checkpoint([a,b]));
  assertMeter(assert,f);
  const append=f.session.append.bind(f.session);let injected=false;
  f.session.append=(type,data,...options)=>{
    if(type==='tool/result'&&options[0]?.surfaceOp?.op==='replace'&&options[0].surfaceOp.startSeq===b.seq&&!injected){injected=true;throw Object.assign(new Error('controlled admission failure'),{code:'TEST_REPLACE_FAILURE'});}
    return append(type,data,...options);
  };
  const {result}=await commit(f,cp);f.session.append=append;
  assert.equal(result.successful.length,1);assert.equal(result.failures[0].code,'TEST_REPLACE_FAILURE');
  assert.ok(f.session.surface.nodes.includes(b.seq));assert.ok(!f.session.surface.nodes.includes(a.seq));
  f.tool('post failure');assertMeter(assert,f);
  assert.equal(f.ctx.sessionProjections.stateOf(f.session,'contextPressure').claim,undefined);
});

test('cleanup of spill path is recoverable from preserved source, including after replay',async t=>{
  const f=await fixture(t),c=f.age(f.tool()),cp=f.queue(f.checkpoint(c)),{prepared,result}=await commit(f,cp);
  assert.equal(result.successful.length,1);
  const oldPath=prepared.items[0].saved.locator;await unlink(oldPath);await assert.rejects(readFile(oldPath),{code:'ENOENT'});
  const recovered=await core.recover(f.j,c.ref,f.spill,f.record);
  assert.equal(await readFile(recovered.path,'utf8'),LONG);assert.equal(recovered.sha256,core.digest(LONG));
  const {events}=await f.ctx.sessionQuery.readSession(f.session.id);
  const replay=await fixture(t,{id:f.session.id,seed:JSON.parse(JSON.stringify(events)),meta:{cwd:f.dir}});
  assert.deepEqual(replay.session.surface.nodes,f.session.surface.nodes);
  const {logRevision:replayedRevision,...replayedMeter}=assertMeter(assert,replay);
  const {logRevision:originalRevision,...originalMeter}=f.ctx.tokenMeter.measure(f.session);
  assert.equal(replayedRevision,originalRevision+1,'restoration appends one off-surface session/end-seed marker');
  assert.deepEqual(replayedMeter,originalMeter);
  assert.equal(replay.j.finished.has(cp.seq),true);
  assert.equal((await commit(replay,cp)).result.successful.length,0);
  const restored=await core.recover(replay.j,c.ref,replay.spill,replay.record);
  assert.equal(await readFile(restored.path,'utf8'),LONG);
  await assert.rejects(core.recover(replay.j,'unknown',replay.spill,replay.record),code('UNKNOWN_RECOVERY_REF'));
});

test('pending checkpoint resumes once after restart and preserves current candidate order',async t=>{
  const parent=await fixture(t),early=parent.age(parent.tool('small evidence of at least sixteen exact chars '.repeat(40))),late=parent.age(parent.tool());
  const cp=parent.queue(parent.checkpoint([late,early]));
  const {events}=await parent.ctx.sessionQuery.readSession(parent.session.id);
  const resumed=await fixture(t,{id:parent.session.id,seed:events,meta:{cwd:parent.dir}});
  assert.equal(resumed.j.pending.length,1);assert.equal(resumed.j.finished.size,0);
  const prepared=await core.prepareBatch(resumed.j,resumed.j.pending[0],config({minTailContributionChars:5000}),resumed.spill);
  assert.deepEqual(prepared.items.map(c=>c.seq),[late.seq]);assert.ok(prepared.skips.some(s=>s.ref===early.ref&&s.reason==='early-low-yield'));
  const result=core.commitBatch(resumed.j,cp,prepared,config(),resumed.ctx.tokenMeter,resumed.record,llm.freezeMessage);
  assert.equal(result.successful.length,1);assert.equal(resumed.j.finished.has(cp.seq),true);assert.ok(resumed.session.surface.nodes.includes(early.seq));assertMeter(assert,resumed);
});

test('nonpositive tail item is never folded just because another result subsidizes total reduction',async t=>{
  const f=await fixture(t),large=f.age(f.tool()),tail=f.age(f.tool('短尾仍含可引用的至少十六字固定证据。'.repeat(12))),cp=f.queue(f.checkpoint([large,tail]));
  const prepared=await core.prepareBatch(f.j,cp,config(),f.spill);
  assert.deepEqual(prepared.items.map(item=>item.ref),[large.ref]);
  assert.ok(prepared.items.every(item=>item.net>0));
  assert.ok(prepared.skips.some(item=>item.ref===tail.ref),'nonpositive item must be visibly reported as skipped');
  const result=core.commitBatch(f.j,cp,prepared,config(),f.ctx.tokenMeter,f.record,llm.freezeMessage);
  assert.equal(result.successful.length,1);assert.ok(f.session.surface.nodes.includes(tail.seq));assertMeter(assert,f);
});

test('manifest failure cannot produce prune or replace; recovery verifies readback',async t=>{
  const f=await fixture(t),c=f.age(f.tool()),cp=f.queue(f.checkpoint(c));
  const prepared=await core.prepareBatch(f.j,cp,config(),f.spill),seq=f.session.seq;
  assert.throws(()=>core.commitBatch(f.j,cp,prepared,config(),f.ctx.tokenMeter,()=>{throw Object.assign(new Error('receipt append refused'),{code:'RECEIPT_FAILED'});},llm.freezeMessage),code('RECEIPT_FAILED'));
  assert.equal(f.session.seq,seq);assert.ok(f.session.surface.nodes.includes(c.seq));
  assert.equal((await commit(f,cp)).result.successful.length,1);
  const corrupt={async saveText(input){const saved=await f.spill.saveText(input);await writeFile(saved.locator,'not original');return saved;}};
  await assert.rejects(core.recover(f.j,c.ref,corrupt,f.record),code('RECOVERY_READBACK_MISMATCH'));
});

test('prune alone has zero meter delta and no summary-compaction lifecycle',async t=>{
  const f=await fixture(t),c=f.age(f.tool()),before=assertMeter(assert,f);
  f.session.append('compaction/prune',{shadowedRange:{start:c.seq,end:c.seq},shadowedSeqs:[c.seq],shadowedTokenCount:f.ctx.tokenMeter.estimateMessage(c.message)});
  assert.equal(f.ctx.tokenMeter.measure(f.session).surfaceTokens,before.surfaceTokens);
  assert.equal(f.ctx.sessionProjections.stateOf(f.session,'contextPressure').surfaceTokens,before.surfaceTokens);
  f.record(f.session,core.PREFIX+'finished',{checkpointSeq:0,successful:[],failures:[{ref:c.ref,code:'CONTROLLED_REPLACE_REFUSED'}],skips:[]});
  assert.equal(f.ctx.sessionProjections.stateOf(f.session,'contextPressure').claim,undefined);assertMeter(assert,f);
});

test('ref metadata alone is not advertised unless exact ref occurs in consumed text',async t=>{
  const f=await fixture(t),e=f.tool();for(let i=0;i<3;i++)f.request();const c=core.candidate(f.j,e.seq,config());
  f.session.append('user/message',llm.createUserMessage({source:{kind:'plugin:dsh-gongjuyasuo:reminder',gongjuyasuoRefs:[c.ref],candidateKey:'hidden'},content:[{type:'text',text:'no ref in body'}]}),{surfaceOp:'append'});
  f.request();assert.equal(f.j.advertised.has(c.ref),false);
  assert.throws(()=>core.validateCheckpoint(f.j,f.checkpoint(c),config()),code('UNADVERTISED_OR_FOREIGN_REF'));
  f.request({reason:'tool-calls',advertise:[c.ref]});assert.equal(f.j.advertised.has(c.ref),true);
});

test('fork inherited results cannot fold and session refs are isolated',async t=>{
  const parent=await fixture(t),e=parent.tool();parent.age(e);
  const {events}=await parent.ctx.sessionQuery.readSession(parent.session.id);
  const child=await fixture(t,{id:'mechanism-child',seed:events,meta:{cwd:parent.dir,parentSession:parent.session.id,isSeeded:true,origin:'subagent',delegationDepth:1},inheritedEventCount:events.length});
  assert.equal(core.candidate(child.j,e.seq,config()).skip,'inherited');
  const own=child.age(child.tool());assert.equal(own.seq>=events.length,true);
  assert.notEqual(own.ref,core.reference(parent.session.id,own.event));
});
