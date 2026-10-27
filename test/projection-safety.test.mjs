import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,core,config,llm,LONG } from './fixture.mjs';

// Preserve the installed Session implementation. Only the projection result
// for one exact target is changed, matching the documented projection seam.
function projectOnly(f,seq,text){
  const derive=f.session.deriveEventMessage.bind(f.session);
  f.session.deriveEventMessage=event=>event.seq===seq?llm.freezeMessage({...derive(event),content:[{type:'text',text}]}):derive(event);
}

test('projected tool text is ineligible rather than saved with an unrecoverable raw-event hash',async t=>{
  const f=await fixture(t),e=f.tool();f.age(e);const original=e.data.message.content[0].text;
  projectOnly(f,e.seq,'projected content is not the durable original\n'.repeat(1000));
  assert.equal(core.candidate(f.j,e.seq,config()).skip,'projected-message');
  assert.equal(e.data.message.content[0].text,original,'durable source must remain unchanged');
  assert.ok(f.session.surface.nodes.includes(e.seq));assert.equal(f.saves(),0);
});

test('official pruner-style replacement cannot be selected as a raw append result',async t=>{
  const f=await fixture(t),e=f.tool(),c=f.age(e);
  f.session.append('compaction/prune',{shadowedRange:{start:c.seq,end:c.seq},shadowedSeqs:[c.seq],shadowedTokenCount:f.ctx.tokenMeter.estimateMessage(c.message)});
  const replacement=f.session.append('tool/result',{...e.data,message:llm.freezeMessage({...e.data.message,content:[{type:'text',text:LONG+'\nupstream replacement'}]})},{surfaceOp:{op:'replace',startSeq:c.seq,endSeq:c.seq},sourceEventSeqs:[c.seq]});
  f.age(replacement);
  assert.equal(core.candidate(f.j,replacement.seq,config()).skip,'upstream-replacement');
  assert.equal(f.j.batches.size,0);assert.equal(f.saves(),0);
});

test('projected reminder or inspect carrier cannot advertise refs from a different raw body',async t=>{
  for(const carrier of ['reminder','inspect']) {
    const f=await fixture(t,{id:`projected-${carrier}`}),e=f.tool();for(let i=0;i<3;i++)f.request();
    const ref=core.reference(f.session.id,e);let advertised;
    if(carrier==='reminder')advertised=f.session.append('user/message',llm.createUserMessage({source:{kind:'plugin:dsh-gongjuyasuo:reminder',gongjuyasuoRefs:[ref],candidateKey:'projection-safety'},content:[{type:'text',text:`候选 ${ref}`}]}),{surfaceOp:'append'});
    else {
      const callId='inspect-carrier';f.session.append('tool/call',{turn:1,step:1,callId,name:'gongjuyasuo',arguments:{action:'inspect'}});
      advertised=f.session.append('tool/result',{turn:1,step:1,message:llm.freezeMessage({id:'inspect-result',role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:`{"refs":["${ref}"]}`}]}),meta:{gongjuyasuo:{refs:[ref]}}},{surfaceOp:'append'});
    }
    projectOnly(f,advertised.seq,'projection removed the candidate body');f.request();
    assert.equal(f.j.advertised.has(ref),false,`${carrier}: model never saw the raw ref`);
    assert.equal(f.j.effectiveReminderSeqs.has(advertised.seq),false);
    const c=core.candidate(f.j,e.seq,config());assert.throws(()=>core.validateCheckpoint(f.j,f.checkpoint(c),config()),error=>error.code==='UNADVERTISED_OR_FOREIGN_REF');
  }
});
