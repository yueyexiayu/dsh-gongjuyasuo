import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { core, assertMeter } from './fixture.mjs';
import { pluginFixture } from './plugin-fixture.mjs';

function successful(result) {assert.equal(result.isError,false,JSON.stringify(result));assert.ok(Array.isArray(result.content));return result.value;}

test('real ToolRuntime validates schema and renders public inspect refs while keeping control metadata off text',async t=>{
  const f=await pluginFixture(t),c=f.age(f.tool());
  const result=await f.execute({action:'inspect'}),value=successful(result);
  assert.deepEqual(value.refs,[c.ref]);assert.deepEqual(JSON.parse(result.content[0].text),value);
  assert.deepEqual(result.meta.gongjuyasuo.refs,[c.ref]);
  const invalid=await f.execute({action:'made-up'});assert.equal(invalid.isError,true);
  assert.equal(f.session.header.origin,undefined);assertMeter(assert,f);
});

test('model does not cooperate: reminder and inspect alone never replace originals',async t=>{
  const f=await pluginFixture(t),e=f.tool();for(let i=0;i<3;i++)f.request();
  const decision=await f.preStep();assert.equal(decision.kind,'enter');assert.equal(decision.messages.length,1);
  assert.match(decision.messages[0].content[0].text,/不是任务停止条件/);
  // The AgentLoop's supported persistence seam for pre-step messages.
  f.session.append('user/message',decision.messages[0],{surfaceOp:'append'});
  for(let i=0;i<8;i++){f.request();await f.execute({action:'inspect'});const next=await f.preStep();assert.equal(next.messages.length,0);}
  assert.ok(f.session.surface.nodes.includes(e.seq));
  const {events}=await f.ctx.sessionQuery.readSession(f.session.id);
  assert.equal(events.filter(e=>e.type==='compaction/prune').length,0);assert.equal(f.saves(),0);
});

test('unadvertised checkpoint is rejected; advertised handoff queues and commits only at next enter',async t=>{
  const f=await pluginFixture(t),e=f.tool();for(let i=0;i<3;i++)f.request();
  const c=core.candidate(f.j,e.seq,core.settings({...core.DEFAULTS,thresholdChars:100,recentProtectionRequests:2})),cp=f.checkpoint(c);
  const rejected=successful(await f.execute(cp));assert.equal(rejected.status,'invalid-checkpoint');assert.equal(rejected.code,'UNADVERTISED_OR_FOREIGN_REF');
  successful(await f.execute({action:'inspect'}));f.request();
  const result=await f.execute(cp,{callId:'fixed-checkpoint-call'}),queued=successful(result);
  assert.equal(queued.status,'queued-not-yet-folded');assert.ok(f.session.surface.nodes.includes(e.seq));
  assert.equal(result.meta.gongjuyasuo.recordType,core.PREFIX+'checkpoint');assert.doesNotMatch(result.content[0].text,/_gongjuyasuo|evidenceQuote/);
  const rejectedDecision={kind:'reject',reason:'zero-model test'};assert.deepEqual(await f.preStep({decision:rejectedDecision}),rejectedDecision);assert.ok(f.session.surface.nodes.includes(e.seq));
  await f.preStep();assert.ok(!f.session.surface.nodes.includes(e.seq));
  const saves=f.saves();await f.preStep();assert.equal(f.saves(),saves);
  const again=successful(await f.execute(cp,{callId:'fixed-checkpoint-call'}));assert.equal(again.status,'already-queued');
  const conflicting=structuredClone(cp);conflicting.state.nextStep='changed request under same call identity';
  const conflict=successful(await f.execute(conflicting,{callId:'fixed-checkpoint-call'}));assert.equal(conflict.code,'CALL_ID_CONFLICT');
  assertMeter(assert,f);
});

test('dynamic disabled gate stops reminders, submissions and queued commits but recovery remains available',async t=>{
  const f=await pluginFixture(t),c=f.age(f.tool());
  successful(await f.execute({action:'inspect'}));f.request();
  successful(await f.execute(f.checkpoint(c)));
  await f.setSettings({enabled:false});
  assert.deepEqual(await f.preStep(),{kind:'enter',messages:[]});assert.ok(f.session.surface.nodes.includes(c.seq));
  assert.equal(successful(await f.execute({action:'inspect'})).status,'disabled');
  assert.equal(successful(await f.execute(f.checkpoint(c))).status,'disabled');
  await f.setSettings({enabled:true});await f.preStep();assert.ok(!f.session.surface.nodes.includes(c.seq));
  await f.setSettings({enabled:false});
  const recovered=successful(await f.execute({action:'recover',ref:c.ref}));
  assert.equal(recovered.ok,true);assert.equal(await readFile(recovered.path,'utf8'),c.text);assertMeter(assert,f);
});

test('parent and subagent sessions have distinct journals, checkpoints and disabled behavior',async t=>{
  const f=await pluginFixture(t),parent=f.age(f.tool());
  const child=f.ctx.sessions.create('plugin-subagent',{meta:{cwd:f.dir,parentSession:f.session.id,origin:'subagent',delegationDepth:1}});
  const childView=successful(await f.execute({action:'inspect'},{session:child}));assert.deepEqual(childView.refs,[]);
  const cross=successful(await f.execute(f.checkpoint(parent),{session:child}));assert.equal(cross.code,'UNADVERTISED_OR_FOREIGN_REF');
  const parentView=successful(await f.execute({action:'inspect'}));assert.deepEqual(parentView.refs,[parent.ref]);
  await f.setSettings({enabled:false});assert.equal(successful(await f.execute({action:'inspect'},{session:child})).status,'disabled');
  assert.ok(f.session.surface.nodes.includes(parent.seq));
});

test('same candidates remind again only after real non-gongjuyasuo progress and six successful requests',async t=>{
  const f=await pluginFixture(t,{settings:{reminderIntervalRequests:6}}),e=f.tool();for(let i=0;i<3;i++)f.request();
  const first=await f.preStep();assert.equal(first.messages.length,1);f.session.append('user/message',first.messages[0],{surfaceOp:'append'});
  const ref=core.reference(f.session.id,e);
  for(let i=0;i<6;i++){successful(await f.execute({action:'inspect'}));f.request();assert.equal((await f.preStep()).messages.length,0,'inspect alone must not manufacture progress');}
  f.tool('short genuine progress',{name:'read',args:{file_path:'/fixture/progress.txt'}});
  const second=await f.preStep();assert.equal(second.messages.length,1);assert.deepEqual(second.messages[0].source.gongjuyasuoRefs,[ref]);assert.notEqual(second.messages[0].source.candidateKey,first.messages[0].source.candidateKey);
  f.session.append('user/message',second.messages[0],{surfaceOp:'append'});
  f.tool('another short progress',{name:'grep',args:{pattern:'fixed',path:'/fixture/progress.txt'}});
  for(let i=0;i<5;i++){f.request();assert.equal((await f.preStep()).messages.length,0,'real progress does not bypass the six-request interval');}
  f.request();const third=await f.preStep();assert.equal(third.messages.length,1);assert.deepEqual(third.messages[0].source.gongjuyasuoRefs,[ref]);
  assert.ok(f.session.surface.nodes.includes(e.seq));assert.equal(f.saves(),0);
});

test('repeated invalid checkpoint submissions back off reminders until the interval or candidates change',async t=>{
  const f=await pluginFixture(t,{settings:{reminderIntervalRequests:2}}),event=f.tool();for(let i=0;i<3;i++) f.request();
  const c=core.candidate(f.j,event.seq,core.settings({...core.DEFAULTS,thresholdChars:100,recentProtectionRequests:2}));
  const first=await f.preStep();assert.equal(first.messages.length,1);f.session.append('user/message',first.messages[0],{surfaceOp:'append'});
  successful(await f.execute({action:'inspect'}));f.request();
  const invalid=f.checkpoint(c);invalid.state.findings[0].refs=[];
  assert.equal(successful(await f.execute(invalid)).code,'INVALID_STATE_FIELDS');
  assert.equal(successful(await f.execute(invalid)).code,'INVALID_STATE_FIELDS');
  const saved=await f.ctx.sessionQuery.readSession(f.session.id);
  const replay=await pluginFixture(t,{id:f.session.id,seed:JSON.parse(JSON.stringify(saved.events)),meta:{cwd:f.dir},settings:{reminderIntervalRequests:2}});
  assert.equal((await replay.preStep()).messages.length,0,'failure backoff survives journal replay');
  f.tool('real progress',{name:'read'});
  for(let i=0;i<7;i++){f.request();assert.equal((await f.preStep()).messages.length,0);}
  f.request();assert.equal((await f.preStep()).messages.length,1,'two matching failures wait 8 successful requests');
  const nextEvent=f.tool();for(let i=0;i<3;i++) f.request();const next=core.candidate(f.j,nextEvent.seq,core.settings({...core.DEFAULTS,thresholdChars:100,recentProtectionRequests:2}));assert.notEqual(next.ref,c.ref);
  assert.equal((await f.preStep()).messages.length,1,'new eligible evidence clears failure backoff');
  assert.ok(f.session.surface.nodes.includes(c.seq));assert.equal(f.saves(),0);
});

test('offline diagnostics route replays retained JSON events through real SessionQuery without a false 404',async t=>{
  const f=await pluginFixture(t),c=f.age(f.tool());successful(await f.execute({action:'inspect'}));f.request();successful(await f.execute(f.checkpoint(c)));await f.preStep();successful(await f.execute({action:'recover',ref:c.ref}));
  const source=await f.ctx.sessionQuery.readSession(f.session.id);
  const resumed=await pluginFixture(t,{id:f.session.id,seed:JSON.parse(JSON.stringify(source.events)),meta:{cwd:f.dir}});
  const route=resumed.routes.find(route=>route.path==='/api/dsh-gongjuyasuo');assert.ok(route);
  const response=await route.fetch(new Request(`http://unit.test/api/dsh-gongjuyasuo?sessionId=${encodeURIComponent(f.session.id)}`));
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.ok,true);assert.equal(body.metricsView,'retained-raw-replay-no-historical-projection');assert.deepEqual(body.sessions,[]);
  assert.equal(body.metrics.counts.validCheckpoints,1);assert.equal(body.metrics.counts.foldedCheckpoints,1);assert.equal(body.metrics.counts.replacedResults,1);assert.equal(body.metrics.counts.recoveries,1);
  const missing=await route.fetch(new Request('http://unit.test/api/dsh-gongjuyasuo?sessionId=absent-test-session'));assert.equal(missing.status,404);assert.deepEqual(await missing.json(),{ok:false,code:'SESSION_READ_FAILED',sessionId:'absent-test-session'});
});

test('disposed plugin cannot produce reminder or fold a queued checkpoint',async t=>{
  const f=await pluginFixture(t),c=f.age(f.tool());successful(await f.execute({action:'inspect'}));f.request();successful(await f.execute(f.checkpoint(c)));
  f.dispose();assert.deepEqual(await f.preStep(),{kind:'enter',messages:[]});assert.ok(f.session.surface.nodes.includes(c.seq));assert.equal(f.saves(),0);
});
