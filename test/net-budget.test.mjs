import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, core, config, llm, assertMeter } from './fixture.mjs';
import { pluginFixture } from './plugin-fixture.mjs';
import { join } from 'node:path';

// task-2 write scope is this file only; no model is ever requested.
// Actual red baseline (unmodified core.VERSION 0.1.2):
// ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test test/net-budget.test.mjs
// 5 tests / 0 pass / 5 fail / exit 1. Boundary diagnostic: gross=15564,
// checkpointChars=485, min=14879, completeNet=14679, shortfall=200,
// prepareItems=1 but commitSuccessful=0, skip='revalidated-net-too-small'.
// Four remaining failures: netBudget was undefined. This is observed evidence,
// not a reconstructed copy of the old implementation.
const chars=text=>Array.from(text).length;
function expectedBudget(gross, checkpoint, required) {
  return {grossReductionChars:gross,checkpointChars:chars(JSON.stringify(checkpoint)),receiptReserveChars:400,netReductionChars:gross-chars(JSON.stringify(checkpoint))-400,requiredNetReductionChars:required,estimatedCharsOnly:true};
}
async function setup(t) {
  const f=await fixture(t),c=f.age(f.tool()),cp=f.queue(f.checkpoint(c));
  // Reuse the exact verified file path for every prepare: save-counter digits
  // and fresh locator lengths must not perturb a 200-character boundary.
  const saved=await f.spill.saveText({content:c.text,suggestedName:'stable-budget-source.txt'});
  const spill={async saveText(input){assert.equal(input.content,c.text);return saved;}};
  const probe=await core.prepareBatch(f.j,cp,config({minNetReductionChars:1}),spill);
  assert.equal(probe.items.length,1);
  const gross=chars(c.text)-chars(probe.items[0].replacement);
  assert.equal(probe.items[0].net,gross);
  return {...f,c,cp,spill,probe,gross};
}
function commit(f,prepared,cfg) {
  return core.commitBatch(f.j,f.cp,prepared,cfg,f.ctx.tokenMeter,f.record,llm.freezeMessage);
}

test('prepare rejects the exact 400-character receipt window rather than promising a commit that cannot happen',async t=>{
  const f=await setup(t),checkpointChars=chars(JSON.stringify(f.cp));
  const minimum=f.gross-checkpointChars-200;assert.ok(minimum>1);
  const cfg=config({minNetReductionChars:minimum}),prepared=await core.prepareBatch(f.j,f.cp,cfg,f.spill);
  const budget=expectedBudget(f.gross,f.cp,minimum);
  // On 0.1.2 this diagnostic independently demonstrates the contradiction:
  // prepare admits one item, then commit rejects it with no source mutation.
  if(prepared.items.length) {
    const result=commit(f,prepared,cfg);
    t.diagnostic(JSON.stringify({version:core.VERSION,gross:f.gross,checkpointChars,minimum,expectedNet:budget.netReductionChars,shortfall:minimum-budget.netReductionChars,prepareItems:prepared.items.length,commitSuccessful:result.successful.length,commitSkips:result.skips.map(x=>x.reason)}));
  }
  assert.equal(prepared.items.length,0,'prepare must already reserve the same 400 chars as commit');
  assert.deepEqual(prepared.netBudget,budget);assert.equal(prepared.checkpointOverheadChars,checkpointChars+400);
  assert.equal(prepared.netBudget.requiredNetReductionChars-prepared.netBudget.netReductionChars,200);
  assert.ok(prepared.skips.some(x=>x.ref===f.c.ref&&x.reason==='insufficient-net-reduction'));
  assert.ok(f.session.surface.nodes.includes(f.c.seq));assert.equal(f.j.batches.size,0);assertMeter(assert,f);
});

test('sufficient net reduction uses identical explicit budgets in prepare, commit and finished receipt',async t=>{
  const f=await setup(t),cfg=config({minNetReductionChars:4000});
  const prepared=await core.prepareBatch(f.j,f.cp,cfg,f.spill),budget=expectedBudget(f.gross,f.cp,4000);
  assert.ok(budget.netReductionChars>=4000);assert.equal(prepared.items.length,1);assert.deepEqual(prepared.netBudget,budget);
  assert.equal(prepared.checkpointOverheadChars,budget.checkpointChars+budget.receiptReserveChars);
  const result=commit(f,prepared,cfg);assert.equal(result.successful.length,1);assert.deepEqual(result.netBudget,budget);
  const finished=[...f.j.events.values()].map(core.recordOf).findLast(record=>record?.type===core.PREFIX+'finished');
  assert.ok(finished);assert.deepEqual(finished.data.netBudget,budget);assert.equal(finished.data.netChars,budget.netReductionChars);assertMeter(assert,f);
});

test('disabled commit returns budget evidence but never appends a manifest or replaces the source',async t=>{
  const f=await setup(t),cfg=config({enabled:false,minNetReductionChars:4000}),seq=f.session.seq;
  const result=commit(f,f.probe,cfg);
  assert.equal(result.successful.length,0);assert.ok(result.skips.some(x=>x.reason==='disabled'));
  assert.deepEqual(result.netBudget,expectedBudget(f.gross,f.cp,4000));assert.equal(f.session.seq,seq);assert.ok(f.session.surface.nodes.includes(f.c.seq));assertMeter(assert,f);
});

test('stale source recomputes the zero-valid-item budget instead of reusing the prepared gross reduction',async t=>{
  const f=await setup(t),cfg=config({minNetReductionChars:4000});
  f.session.append('compaction/prune',{shadowedRange:{start:f.c.seq,end:f.c.seq},shadowedSeqs:[f.c.seq],shadowedTokenCount:f.ctx.tokenMeter.estimateMessage(f.c.message)});
  const replacement=f.session.append('tool/result',{...f.c.event.data,message:llm.freezeMessage({...f.c.message,content:[{type:'text',text:'source replaced by another producer'}]})},{surfaceOp:{op:'replace',startSeq:f.c.seq,endSeq:f.c.seq},sourceEventSeqs:[f.c.seq]});
  const seq=f.session.seq,result=commit(f,f.probe,cfg);
  assert.equal(result.successful.length,0);assert.ok(result.skips.some(x=>x.reason==='stale-after-save'));
  assert.deepEqual(result.netBudget,expectedBudget(0,f.cp,4000));assert.equal(f.session.seq,seq);assert.ok(f.session.surface.nodes.includes(replacement.seq));assert.equal(f.j.batches.size,0);assertMeter(assert,f);
});

test('the public default remains 4000 chars and budgeting is explicitly an estimate, not token savings',async t=>{
  assert.equal(core.DEFAULTS.minNetReductionChars,4000);assert.equal(core.settings().minNetReductionChars,4000);
  const f=await setup(t);assert.deepEqual(f.probe.netBudget,expectedBudget(f.gross,f.cp,1));
  assert.equal(f.probe.netBudget.estimatedCharsOnly,true);assert.equal(Object.hasOwn(f.probe.netBudget,'tokensSaved'),false);
});

test('real plugin inspect explains its net gate and an insufficient valid checkpoint preserves the source with a visible numeric receipt',async t=>{
  const minimum=1000000,f=await pluginFixture(t,{settings:{minNetReductionChars:minimum}});
  const c=f.age(f.tool()),original=structuredClone(f.j.events.get(c.seq));
  const inspected=await f.execute({action:'inspect'});assert.equal(inspected.isError,false);
  const gate=inspected.value.netGate;
  assert.equal(gate.unit,'estimated-chars-not-provider-tokens');assert.equal(gate.minimumNetReductionChars,minimum);assert.equal(gate.receiptReserveChars,400);
  assert.match(gate.formula,/checkpoint/);assert.match(gate.formula,/receipt reserve/);assert.match(gate.policy,/保留原文/);assert.match(gate.policy,/不降低质量/);
  assert.ok(inspected.value.refs.includes(c.ref));f.request();
  const queued=await f.execute(f.checkpoint(c));assert.equal(queued.isError,false);assert.equal(queued.value.status,'queued-not-yet-folded');
  const checkpoint=structuredClone(f.j.pending.at(-1));assert.ok(checkpoint);
  await f.preStep();
  assert.equal(f.saves(),1);const locator=join(f.dir,`1-gongjuyasuo-${c.seq}.txt`);assert.equal(await f.readFile(locator,'utf8'),c.text);
  const gross=chars(c.text)-chars(core.marker(config(),c,checkpoint,{locator}));
  const budget=expectedBudget(gross,checkpoint,minimum);assert.ok(budget.netReductionChars<minimum);
  const finishedEvent=[...f.j.events.values()].findLast(event=>core.recordOf(event)?.type===core.PREFIX+'finished');
  assert.ok(finishedEvent);const finished=core.recordOf(finishedEvent);
  assert.deepEqual(finished.data.netBudget,budget);assert.equal(finished.data.successful.length,0);assert.ok(finished.data.skips.some(x=>x.reason==='insufficient-net-reduction'));
  const visible=core.textOf(finishedEvent.data);
  assert.ok(visible.includes(`${budget.netReductionChars}/${minimum}`));assert.ok(visible.includes(`检查点 ${budget.checkpointChars}`));assert.ok(visible.includes('收据预留 400'));
  assert.match(visible,/不足时原文保留/);assert.match(visible,/不是提供方 token 收益/);
  assert.deepEqual(f.j.events.get(c.seq),original);assert.ok(f.session.surface.nodes.includes(c.seq));assert.equal(f.j.batches.size,0);assertMeter(assert,f);
});
