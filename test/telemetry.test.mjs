import test from 'node:test';
import assert from 'node:assert/strict';
import { observeStream } from '../lib/telemetry.js';
import { normalizeReportedUsage, sumUsage, metrics } from '../lib/observability.js';
import { fixture, commit, core, installedBase } from './fixture.mjs';
const {deriveTurnTokenUsage}=await import(installedBase+'dsh-token-meter/lib/types/client.js');
const options={provider:'test-provider',model:'no-model',messages:[],tools:[{name:'gongjuyasuo'}],sessionId:'explicit-child'};
const usage={inputTokens:100,outputTokens:20,cacheReadTokens:40,cacheWriteTokens:10,reasoningTokens:5,totalTokens:170};
async function collect(chunks,opts=options){const records=[],seen=[];for await(const chunk of observeStream(opts,async function*(){yield*chunks;},{emit:r=>records.push(r),initiator:{id:'parent',header:{parentSession:'grandparent'}},sessionId:'fallback',configHash:'fixed-hash'}))seen.push(chunk);return {records,seen};}

test('provider cumulative usage counts last snapshot once, preserving chunks and call attribution',async()=>{
  const chunks=[{type:'usage',usage:{...usage,inputTokens:1,totalTokens:71}},{type:'text-delta',text:'fixed'},{type:'usage',usage},{type:'finish',reason:{kind:'stop'}}];
  const {records,seen}=await collect(chunks);assert.deepEqual(seen,chunks);assert.equal(records.length,1);
  const r=records[0];assert.deepEqual(r.reportedUsage,usage);assert.deepEqual(r.exactUsage,usage);assert.equal(r.finishCount,1);assert.equal(r.thrown,false);
  assert.equal(r.sessionId,'explicit-child');assert.equal(r.initiatorSessionId,'parent');assert.equal(r.parentSessionId,'grandparent');assert.equal(r.attribution,'explicit-session');assert.deepEqual(r.toolNames,['gongjuyasuo']);
  assert.ok(Number.isFinite(r.wallMs)&&r.wallMs>=0);assert.ok(Number.isFinite(r.firstTokenMs)&&r.firstTokenMs>=0);
});

test('failed streams are visible, rethrow exact error and are not silently merged with retries',async()=>{
  const records=[],error=Object.assign(new Error('controlled failure'),{code:'TEST_FAILURE'});
  await assert.rejects(async()=>{for await(const _ of observeStream(options,async function*(){yield {type:'usage',usage};throw error;},{emit:r=>records.push(r),configHash:'test'})){}},e=>e===error);
  assert.equal(records.length,1);assert.equal(records[0].thrown,true);assert.equal(records[0].finishCount,0);
  const retry=await collect([{type:'finish',reason:{kind:'stop'}}]);assert.equal(retry.records.length,1);assert.equal(retry.records[0].exactUsage,null);
  assert.equal(sumUsage([records[0].exactUsage,retry.records[0].exactUsage]),null);
});

test('unknown, invalid and inconsistent usage stays unknown rather than fabricated zero',async()=>{
  for(const u of [undefined,null,{}, {inputTokens:1,outputTokens:2}, {...usage,totalTokens:169}, {...usage,reasoningTokens:21}, {...usage,inputTokens:-1}, {...usage,totalTokens:NaN}])assert.equal(normalizeReportedUsage(u),null);
  assert.equal(sumUsage([]),null);assert.equal(sumUsage([usage,null]),null);
  assert.deepEqual(sumUsage([usage,usage]),{totalTokens:340,outputTokens:40,cacheReadTokens:80,cacheWriteTokens:20,reasoningTokens:10,uncachedInputTokens:200});
  const noUsage=await collect([],{provider:'p',model:'m',messages:[]});assert.equal(noUsage.records[0].reportedUsage,null);assert.equal(noUsage.records[0].exactUsage,null);assert.equal(noUsage.records[0].firstTokenMs,null);assert.equal(noUsage.records[0].attribution,'inherited-initiator');
});

test('new supported record protocol feeds real checkpoint/fold/recovery metrics',async t=>{
  const f=await fixture(t),c=f.age(f.tool()),cp=f.queue(f.checkpoint(c));
  const {result}=await commit(f,cp);assert.equal(result.successful.length,1);await core.recover(f.j,c.ref,f.spill,f.record);
  const m=metrics(f.j,deriveTurnTokenUsage);
  assert.equal(m.counts.validCheckpoints,1);assert.equal(m.counts.foldedCheckpoints,1);assert.equal(m.counts.replacedResults,1);assert.equal(m.counts.recoveries,1);
  assert.equal(m.foldRate,1);assert.equal(m.structureValidRate,1);assert.equal(m.actualUsage.fullTaskTotal,null);
});
