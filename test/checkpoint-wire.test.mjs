import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, core, config, LONG, code } from './fixture.mjs';
import { pluginFixture } from './plugin-fixture.mjs';
const golden=JSON.parse(await readFile(new URL('./fixtures/smoke2-checkpoint.json',import.meta.url),'utf8'));
function value(result){assert.equal(result.isError,false,JSON.stringify(result));return result.value;}

test('first checkpoint may omit resolvedIssues and previousCheckpoint through real ToolRuntime',async t=>{
  const f=await pluginFixture(t),c=f.age(f.tool());value(await f.execute({action:'inspect'}));f.request();
  const cp=f.checkpoint(c);delete cp.resolvedIssues;delete cp.previousCheckpoint;
  const validated=core.validateCheckpoint(f.j,cp,config());assert.deepEqual(validated.resolvedIssues,[]);
  assert.equal(Object.hasOwn(cp,'resolvedIssues'),false,'validation must not mutate caller-owned arguments');
  for(const invalid of [null,'not-an-array',{}])assert.throws(()=>core.validateCheckpoint(f.j,{...cp,resolvedIssues:invalid},config()),code('INVALID_COVERAGE'));
  const result=await f.execute(cp);assert.equal(value(result).status,'queued-not-yet-folded');assert.deepEqual(result.meta.gongjuyasuo.data.resolvedIssues,[]);
  await f.preStep();assert.ok(!f.session.surface.nodes.includes(c.seq));
});

test('omitting resolvedIssues never permits dropping or mutating inherited unresolved issues',async t=>{
  const f=await fixture(t),a=f.age(f.tool()),b=f.age(f.tool());
  const first=f.checkpoint(a,{retain:[{ref:b.ref,reason:'still needed'}]});first.state.unresolved=[{id:'must-carry',text:'真实未决问题不可静默丢弃',refs:[b.ref]}];
  f.queue(core.validateCheckpoint(f.j,first,config()));
  const next=f.checkpoint(b);delete next.resolvedIssues;next.state.findings.push({text:'previous evidence',refs:[a.ref]});
  assert.throws(()=>core.validateCheckpoint(f.j,next,config()),code('DROPPED_UNRESOLVED'));
  const carry=f.checkpoint(a,{retain:[{ref:b.ref,reason:'still needed'}]});delete carry.resolvedIssues;carry.state.unresolved=structuredClone(first.state.unresolved);
  assert.doesNotThrow(()=>core.validateCheckpoint(f.j,carry,config()));
  carry.state.unresolved[0].text='silently rewritten';assert.throws(()=>core.validateCheckpoint(f.j,carry,config()),code('MUTATED_UNRESOLVED'));
});

test('sanitized historical INVALID_COVERAGE regression maps runtime refs and preserves optional omission',async t=>{
  assert.equal(golden.provenance.pluginVersion,'0.1.1');assert.equal(golden.provenance.observedResult.code,'INVALID_COVERAGE');
  assert.equal(Object.hasOwn(golden.arguments,'resolvedIssues'),false);assert.equal(Object.hasOwn(golden.arguments,'previousCheckpoint'),false);
  const f=await pluginFixture(t),mapping=new Map();
  for(const entry of [...golden.arguments.covered,...golden.arguments.retain]) {
    const event=f.tool(`${entry.evidenceQuote??'retained diagnostic source remains available'}\n${LONG}`);
    mapping.set(entry.ref,f.age(event).ref);
  }
  function remap(input){if(typeof input==='string')return mapping.get(input)??input;if(Array.isArray(input))return input.map(remap);if(input&&typeof input==='object')return Object.fromEntries(Object.entries(input).map(([key,v])=>[key,remap(v)]));return input;}
  const cp=remap(golden.arguments);
  // Historical prose, state, quotes, omissions and coverage structure remain.
  // Published fixture identifiers are sanitized, then mapped to runtime refs.
  assert.equal(Object.hasOwn(cp,'resolvedIssues'),false);assert.equal(Object.hasOwn(cp,'previousCheckpoint'),false);
  const result=await f.execute(cp),queued=value(result);assert.equal(queued.status,'queued-not-yet-folded');assert.deepEqual(result.meta.gongjuyasuo.data.resolvedIssues,[]);
  await f.preStep();
  const metricsResponse=await f.routes[0].fetch(new Request(`http://unit.test/api/dsh-gongjuyasuo?sessionId=${f.session.id}`)),body=await metricsResponse.json();
  assert.equal(body.metrics.counts.validCheckpoints,1);assert.equal(body.metrics.counts.replacedResults,2);
});

test('missing required checkpoint fields are explained without blaming the optional resolvedIssues',async t=>{
  const f=await pluginFixture(t),result=value(await f.execute({action:'checkpoint'}));
  assert.equal(result.status,'invalid-checkpoint');
  assert.match(JSON.stringify(result),/state/);assert.match(JSON.stringify(result),/covered/);assert.match(JSON.stringify(result),/retain/);
  const c=f.age(f.tool()),cp=f.checkpoint(c);delete cp.covered;delete cp.retain;delete cp.resolvedIssues;
  const detailed=value(await f.execute(cp));assert.equal(detailed.code,'INVALID_COVERAGE');assert.ok(Array.isArray(detailed.fieldErrors));
  assert.match(JSON.stringify(detailed.fieldErrors),/covered/);assert.match(JSON.stringify(detailed.fieldErrors),/retain/);assert.doesNotMatch(JSON.stringify(detailed.fieldErrors),/resolvedIssues/);
  assert.equal(f.saves(),0);
});

test('invalid findings and source references identify exact fields and preserve originals until repaired',async t=>{
  const f=await pluginFixture(t),c=f.age(f.tool());value(await f.execute({action:'inspect'}));f.request();
  const cp=f.checkpoint(c),before=[...f.session.surface.nodes];
  const empty=structuredClone(cp);empty.state.findings[0].refs=[];
  const rejected=value(await f.execute(empty));assert.equal(rejected.code,'INVALID_STATE_FIELDS');assert.match(rejected.fieldErrors.join(' '),/state\.findings\[0\]\.refs/);assert.match(rejected.fieldErrors.join(' '),/nonempty/);
  const foreign=structuredClone(cp);foreign.covered[0].ref='gy:invented';
  const invalidRef=value(await f.execute(foreign));assert.equal(invalidRef.code,'UNADVERTISED_OR_FOREIGN_REF');assert.match(invalidRef.fieldErrors.join(' '),/covered\[0\]\.ref/);
  const wrongQuote=structuredClone(cp);wrongQuote.covered[0].evidenceQuote='this quotation does not occur in the original';
  const invalidQuote=value(await f.execute(wrongQuote));assert.equal(invalidQuote.code,'INSUFFICIENT_HANDOFF');assert.match(invalidQuote.fieldErrors.join(' '),/covered\[0\]\.evidenceQuote/);
  assert.ok(before.every(seq=>f.session.surface.nodes.includes(seq)));assert.equal(f.saves(),0);
  assert.equal(value(await f.execute(cp)).status,'queued-not-yet-folded');await f.preStep();
  const recovered=value(await f.execute({action:'recover',ref:c.ref}));assert.equal(await readFile(recovered.path,'utf8'),c.text);
});
