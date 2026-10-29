import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const VERSION = '0.1.6';
export const PREFIX = 'plugin:dsh-gongjuyasuo/';
export const DEFAULTS = Object.freeze({enabled:true,thresholdChars:1500,excludeTools:[],summaryTemplate:'[工具原文已外置；结论见检查点 {{checkpoint}}]\n{{index}}',watermarkChars:24000,recentProtectionRequests:2,reminderIntervalRequests:6,minNetReductionChars:4000,minTailContributionChars:1000});
export const digest = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const textOf = message => message.content.map(b=>b.type==='text'?b.text:'').join('');
const count = s => Array.from(s).length;
const fail = code => Object.assign(new Error(code),{code});
const fieldFail = (code,...fieldErrors) => Object.assign(fail(code),{fieldErrors});
const json = x => JSON.parse(JSON.stringify(x));
export function settings(input={}) {
  for(const k of Object.keys(input)) if(!(k in DEFAULTS)) throw fail('UNKNOWN_CONFIG_'+k);
  const out={...DEFAULTS,...input};
  if(typeof out.enabled!=='boolean'||!Array.isArray(out.excludeTools)||out.excludeTools.some(x=>typeof x!=='string')) throw fail('INVALID_CONFIG');
  for(const k of ['thresholdChars','watermarkChars','recentProtectionRequests','reminderIntervalRequests','minNetReductionChars','minTailContributionChars']) if(!Number.isSafeInteger(out[k])||out[k]<1) throw fail('INVALID_CONFIG_'+k);
  if(typeof out.summaryTemplate!=='string'||!out.summaryTemplate.includes('{{index}}')||!out.summaryTemplate.includes('{{checkpoint}}')||out.summaryTemplate.length>1000) throw fail('INVALID_TEMPLATE');
  return out;
}
export function reference(sessionId,event) {return `gy:${digest(sessionId).slice(0,10)}:${event.seq}:${digest(event.data.message).slice(0,10)}`;}
export function makeJournal(session) {return {session,events:new Map(),cursor:0,nodes:[],calls:new Map(),requestNodes:[],successful:0,seen:new Map(),advertised:new Map(),effectiveReminderSeqs:new Set(),pending:[],finished:new Set(),batches:new Map(),lastReminder:-Infinity,lastReminderSeq:null,lastReminderKey:null,lastCheckpoint:null,lastFailedSubmission:null,initialized:false};}
export function recordOf(e) {
  if(e.type==='user/message'&&e.data.source?.kind==='plugin:dsh-gongjuyasuo:record') return {type:e.data.source.recordType,data:e.data.source.recordData};
  if(e.type==='tool/result'&&!e.data.message.isError&&e.data.meta?.gongjuyasuo?.recordType) return {type:e.data.meta.gongjuyasuo.recordType,data:e.data.meta.gongjuyasuo.data};
  return null;
}
export function normalizedEvents(events) {return events.flatMap(e=>{const r=recordOf(e);return r?[e,{...e,type:r.type,data:r.data}]:[e];});}
export function ingest(j,event) {
  j.events.set(event.seq,event);
  while(j.events.has(j.cursor)) {
    const e=j.events.get(j.cursor++),d=e.data;
    if(e.type==='step/start') j.requestNodes=[...j.nodes];
    const finish=Array.isArray(d.stream)?d.stream.filter(r=>r.type==='chunk'&&r.chunk?.type==='finish'):[];
    if(e.type==='assistant/message'&&!d.interrupted&&finish?.length===1&&['stop','tool-calls'].includes(finish[0].chunk.reason.kind)) {
      j.successful++;
      for(const seq of j.requestNodes) if(j.nodes.includes(seq)&&j.events.get(seq)?.type==='tool/result') {const old=j.seen.get(seq);j.seen.set(seq,{first:old?.first??j.successful,last:j.successful});}
      for(const seq of j.nodes) {
        const n=j.events.get(seq);
        if(!n||!['user/message','tool/result'].includes(n.type))continue;
        const raw=n.type==='tool/result'?n.data.message:n.data,derived=j.session.deriveEventMessage(n);
        const visible=JSON.stringify(derived)===JSON.stringify(raw)?textOf(derived):'';
        let advertised=false;
        for(const ref of n.data.source?.gongjuyasuoRefs??n.data.meta?.gongjuyasuo?.refs??[]) if(visible.includes(ref)){j.advertised.set(ref,j.successful);advertised=true;}
        if(advertised&&n.data.source?.kind==='plugin:dsh-gongjuyasuo:reminder') j.effectiveReminderSeqs.add(seq);
      }
    }
    if(e.type==='tool/call') j.calls.set(d.callId,e);
    if(e.surfaceOp==='append') j.nodes.push(e.seq);
    else if(e.surfaceOp?.op==='replace') {const a=j.nodes.indexOf(e.surfaceOp.startSeq),b=j.nodes.indexOf(e.surfaceOp.endSeq);if(a<0||b<a) throw fail('JOURNAL_SURFACE_GAP');j.nodes.splice(a,b-a+1,e.seq);}
    const control=recordOf(e);
    if(control?.type===PREFIX+'checkpoint'&&j.session.isOwnSeq(e.seq)) {j.pending.push({seq:e.seq,...control.data});j.lastCheckpoint={seq:e.seq,...control.data};j.lastFailedSubmission=null;}
    if(control?.type===PREFIX+'submission'&&j.session.isOwnSeq(e.seq)&&typeof control.data.failureSignature==='string'&&typeof control.data.candidateSet==='string'&&Number.isSafeInteger(control.data.atRequest)) {
      const old=j.lastFailedSubmission,same=old?.failureSignature===control.data.failureSignature&&old?.candidateSet===control.data.candidateSet;
      j.lastFailedSubmission={...control.data,count:same?Math.min(old.count+1,3):1};
    }
    if(control?.type===PREFIX+'batch') j.batches.set(e.seq,control.data);
    if(control?.type===PREFIX+'finished'&&j.session.isOwnSeq(e.seq)) j.finished.add(control.data.checkpointSeq);
    if(e.type==='user/message'&&d.source?.kind==='plugin:dsh-gongjuyasuo:reminder') {j.lastReminder=j.successful;j.lastReminderSeq=e.seq;j.lastReminderKey=d.source.candidateKey;}
  }
}
function toolInfo(j,event) {const call=j.calls.get(event.data.message.source.callId);return {call,name:call?.data.name,args:call?.data.arguments};}
export function candidate(j,seq,config,{ignoreRecent=false}={}) {
  const event=j.events.get(seq);
  if(!event||event.type!=='tool/result'||!j.session.surface.nodes.includes(seq)) return {skip:'not-current'};
  if(!j.session.isOwnSeq(seq)) return {skip:'inherited'};
  const message=j.session.deriveEventMessage(event),{call,name,args}=toolInfo(j,event);
  if(JSON.stringify(message)!==JSON.stringify(event.data.message)) return {skip:'projected-message'};
  if(event.surfaceOp!=='append') return {skip:'upstream-replacement'};
  if(!call||!name) return {skip:'missing-call'};
  if(name==='gongjuyasuo'||config.excludeTools.includes(name)) return {skip:'excluded'};
  if(message.isError||event.data.error) return {skip:'error'};
  if(!message.content.length||message.content.some(b=>b.type!=='text'||Object.keys(b).some(k=>!['type','text'].includes(k)))) return {skip:'unsupported-content'};
  if(event.sourceEventSeqs?.some(s=>j.batches.has(s))) return {skip:'already-externalized'};
  // Existing shared spills remain intact, including their existing recovery relationship.
  if(message.content.some(b=>b.text.includes('Full formatted result stored at:'))) return {skip:'existing-spill'};
  const text=textOf(message),chars=count(text);
  if(text.includes('\u0000')) return {skip:'binary-text'};
  if(chars<config.thresholdChars) return {skip:'short'};
  const seen=j.seen.get(seq);
  if(!seen) return {skip:'not-successfully-consumed'};
  if(!ignoreRecent&&j.successful-seen.first<config.recentProtectionRequests) return {skip:'recent'};
  return {seq,event,message,text,chars,bytes:Buffer.byteLength(text),name,args,callSeq:call.seq,ref:reference(j.session.id,event),hash:digest(text)};
}
export function candidates(j,config) {
  const eligible=[],skips={};
  for(const seq of j.session.surface.nodes) {const c=candidate(j,seq,config);if(c.skip) skips[c.skip]=(skips[c.skip]??0)+1;else eligible.push(c);}
  return {eligible,skips};
}
const str = x => typeof x==='string'&&x.trim().length>0;
export function validateCheckpoint(j,args,config) {
  if(!config.enabled) throw fail('DISABLED');
  const cp=json(args),s=cp.state;
  // The stable wire schema marks this optional. Missing means no explicit resolutions,
  // never permission to discard inherited unresolved issues below.
  if(cp.resolvedIssues===undefined) cp.resolvedIssues=[];
  if(!s||!['subgoal','nextStep','changes','validation'].every(k=>str(s[k]))||!['findings','constraints','unresolved','hypotheses'].every(k=>Array.isArray(s[k]))) throw fieldFail('INVALID_STATE',...(!s?['state: object required']:[...['subgoal','nextStep','changes','validation'].filter(k=>!str(s[k])).map(k=>`state.${k}: nonempty text required`),...['findings','constraints','unresolved','hypotheses'].filter(k=>!Array.isArray(s[k])).map(k=>`state.${k}: array required`)]));
  const errors=[];
  for(const [i,f] of s.findings.entries()) {if(!str(f?.text)) errors.push(`state.findings[${i}].text: nonempty text required`);if(!Array.isArray(f?.refs)||!f.refs.length) errors.push(`state.findings[${i}].refs: nonempty array of source refs required`);}
  for(const key of ['constraints','hypotheses']) for(const [i,value] of s[key].entries()) if(!str(value)) errors.push(`state.${key}[${i}]: nonempty text required`);
  for(const [i,u] of s.unresolved.entries()) {for(const key of ['id','text']) if(!str(u?.[key])) errors.push(`state.unresolved[${i}].${key}: nonempty text required`);if(!Array.isArray(u?.refs)) errors.push(`state.unresolved[${i}].refs: array required`);}
  if(errors.length) throw fieldFail('INVALID_STATE_FIELDS',...errors);
  if(!Array.isArray(cp.covered)||!cp.covered.length||!Array.isArray(cp.retain)||!Array.isArray(cp.resolvedIssues)) throw Object.assign(fail('INVALID_COVERAGE'),{fieldErrors:[...(!Array.isArray(cp.covered)||!cp.covered.length?['covered: nonempty array required']:[]),...(!Array.isArray(cp.retain)?['retain: array required; use [] only when nothing remains directly needed']:[]),...(!Array.isArray(cp.resolvedIssues)?['resolvedIssues: omit or provide array; null is invalid']:[])]});
  if(JSON.stringify(cp).length>14000) throw fail('CHECKPOINT_TOO_LARGE');
  const prev=j.lastCheckpoint;
  if((cp.previousCheckpoint??null)!==(prev?.id??null)) throw fieldFail('STALE_CHECKPOINT','previousCheckpoint: use the current id returned by inspect, or null for the first checkpoint');
  const known=new Map();
  for(const seq of j.session.surface.nodes) {const e=j.events.get(seq);if(e?.type==='tool/result') known.set(reference(j.session.id,e),seq);}
  const refs=[...cp.covered.map(x=>x.ref),...cp.retain.map(x=>x.ref)];
  if(new Set(refs).size!==refs.length) throw fieldFail('DUPLICATE_OR_PROTECTED_REF','covered/retain: each source ref may appear only once; retain sources still directly needed');
  for(const group of ['covered','retain']) for(const [i,item] of cp[group].entries()) if(!known.has(item.ref)||!j.advertised.has(item.ref)) throw fieldFail('UNADVERTISED_OR_FOREIGN_REF',`${group}[${i}].ref: use a current session ref returned by inspect or a visible reminder`);
  for(const [i,c] of cp.covered.entries()) {
    const item=candidate(j,known.get(c.ref),config);
    if(item.skip) throw fieldFail('INELIGIBLE_'+item.skip,`covered[${i}].ref: source is not currently eligible (${item.skip}); inspect again and retain it if still needed`);
    const detail=[];
    if(!str(c.conclusion)) detail.push(`covered[${i}].conclusion: nonempty text required`);
    if(c.noLongerDirectlyNeeded!==true) detail.push(`covered[${i}].noLongerDirectlyNeeded: must be true only if the original is no longer directly needed`);
    if(!str(c.evidenceQuote)||count(c.evidenceQuote)<16||!item.text.includes(c.evidenceQuote)) detail.push(`covered[${i}].evidenceQuote: provide at least 16 characters copied verbatim from this source`);
    if(detail.length) throw fieldFail('INSUFFICIENT_HANDOFF',...detail);
  }
  for(const [i,item] of cp.retain.entries()) if(!str(item.reason)) throw fieldFail('INVALID_RETAIN',`retain[${i}].reason: explain why this source remains directly needed`);
  const protectedRefs=new Set([...cp.retain.map(x=>x.ref),...s.unresolved.flatMap(u=>u.refs)]);
  for(const [i,c] of cp.covered.entries()) if(protectedRefs.has(c.ref)) throw fieldFail('UNRESOLVED_OR_DIRECT_DEPENDENCY',`covered[${i}].ref: unresolved or directly needed source must remain retained`);
  const sourceRefs=new Set([...refs,...prev?.state.findings.flatMap(f=>f.refs)??[],...prev?.state.unresolved.flatMap(u=>u.refs)??[]]);
  for(const group of ['findings','unresolved']) for(const [i,item] of s[group].entries()) for(const [k,ref] of item.refs.entries()) if(!sourceRefs.has(ref)) throw fieldFail('UNSUPPORTED_STATE_SOURCE',`state.${group}[${i}].refs[${k}]: cite a source from covered, retain, or the previous checkpoint`);
  // Still-valid unresolved information is inherited verbatim unless explicitly resolved with a cited finding.
  for(const old of prev?.state.unresolved??[]) {
    const carry=s.unresolved.find(u=>u.id===old.id),resolved=cp.resolvedIssues.find(x=>x.id===old.id);
    if(carry&&JSON.stringify(carry)!==JSON.stringify(old)) throw fieldFail('MUTATED_UNRESOLVED',`state.unresolved: carry previous issue ${old.id} verbatim or explicitly resolve it`);
    if(!carry&&(!resolved||!str(resolved.evidence)||!Array.isArray(resolved.refs)||!resolved.refs.length||resolved.refs.some(r=>!sourceRefs.has(r)))) throw fieldFail('DROPPED_UNRESOLVED',`state.unresolved / resolvedIssues: carry previous issue ${old.id} verbatim or resolve it with evidence and source refs`);
  }
  if(prev?.state.constraints.some(c=>!s.constraints.includes(c))) throw fieldFail('DROPPED_CONSTRAINT','state.constraints: retain every previous checkpoint constraint');
  return cp;
}
export function marker(config,c,checkpoint,saved) {
  const index=`${c.ref} | ${c.name}(${JSON.stringify(c.args)}) | ${c.chars} chars / ${c.bytes} bytes | sha256=${c.hash}\n原文: ${saved.locator}\nread(file_path=${JSON.stringify(saved.locator)}, offset=1, limit=200) 或 grep 此路径。失效时 gongjuyasuo(action="recover", ref=${JSON.stringify(c.ref)}) 从保留源事件重建快照。`;
  return config.summaryTemplate.replaceAll('{{checkpoint}}',checkpoint.id).replaceAll('{{index}}',index);
}
export const RECEIPT_RESERVE_CHARS=400;
function batchNetBudget(items,checkpointChars,config) {
  const grossReductionChars=items.reduce((n,c)=>n+c.net,0);
  return {grossReductionChars,checkpointChars,receiptReserveChars:RECEIPT_RESERVE_CHARS,netReductionChars:grossReductionChars-checkpointChars-RECEIPT_RESERVE_CHARS,requiredNetReductionChars:config.minNetReductionChars,estimatedCharsOnly:true};
}
export async function prepareBatch(j,checkpoint,config,spill,signal) {
  const startedAt=performance.now();
  const items=[],failures=[],skips=[];
  for(const covered of checkpoint.covered) {
    const seq=[...j.session.surface.nodes].find(n=>{const e=j.events.get(n);return e?.type==='tool/result'&&reference(j.session.id,e)===covered.ref;});
    const c=candidate(j,seq,config);
    if(c.skip) {skips.push({ref:covered.ref,reason:c.skip});continue;}
    try {
      signal?.throwIfAborted();
      const saved=await spill.saveText({owner:{sessionId:j.session.id},suggestedName:`gongjuyasuo-${seq}.txt`,content:c.text});
      const readback=await readFile(saved.locator,'utf8');
      if(readback!==c.text||saved.bytes!==c.bytes) throw fail('SPILL_READBACK_MISMATCH');
      const replacement=marker(config,c,checkpoint,saved),net=c.chars-count(replacement);
      if(net<=0) {skips.push({ref:c.ref,reason:'nonpositive-item-net'});continue;}
      items.push({...c,saved,replacement,net});
    } catch(e) {failures.push({ref:c.ref,code:e.code??'SAVE_FAILED'});}
  }
  // Trim only the low-contribution prefix; this is not an optimal suffix search.
  const positions=new Map(j.session.surface.nodes.map((seq,i)=>[seq,i]));
  let selected=items.sort((a,b)=>positions.get(a.seq)-positions.get(b.seq));
  while(selected.length>1&&selected[0].net<config.minTailContributionChars) {skips.push({ref:selected[0].ref,reason:'early-low-yield'});selected=selected.slice(1);}
  const checkpointChars=count(JSON.stringify(checkpoint));
  const netBudget=batchNetBudget(selected,checkpointChars,config);
  if(netBudget.netReductionChars<config.minNetReductionChars) {skips.push(...selected.map(c=>({ref:c.ref,reason:'insufficient-net-reduction'})));selected=[];}
  return {items:selected,failures,skips,checkpointOverheadChars:checkpointChars+RECEIPT_RESERVE_CHARS,netBudget,startedAt};
}
export function commitBatch(j,checkpoint,prepared,config,meter,record,freeze,signal) {
  const successful=[],failures=[...prepared.failures],skips=[...prepared.skips];
  const valid=[];
  for(const c of prepared.items) {const now=candidate(j,c.seq,config);if(now.skip||now.hash!==c.hash||JSON.stringify(now.message)!==JSON.stringify(c.message)) skips.push({ref:c.ref,reason:'stale-after-save'});else valid.push(c);}
  const overhead=prepared.checkpointOverheadChars;
  // Preserve the prepared failure budget; otherwise recompute after stale-item removal.
  const netBudget=prepared.items.length?batchNetBudget(valid,overhead-RECEIPT_RESERVE_CHARS,config):prepared.netBudget;
  if(signal?.aborted||!config.enabled) {skips.push(...valid.map(c=>({ref:c.ref,reason:signal?.aborted?'aborted':'disabled'})));return {successful,failures,skips,netBudget};}
  if(!prepared.items.length) return {successful,failures,skips,netBudget};
  if(netBudget.netReductionChars<config.minNetReductionChars) {skips.push(...valid.map(c=>({ref:c.ref,reason:'revalidated-net-too-small'})));return {successful,failures,skips,netBudget};}
  const manifest={checkpointSeq:checkpoint.seq,checkpointId:checkpoint.id,sessionId:j.session.id,items:valid.map(c=>({ref:c.ref,seq:c.seq,hash:c.hash,chars:c.chars,bytes:c.bytes,locator:c.saved.locator,name:c.name,callSeq:c.callSeq})),netChars:netBudget.netReductionChars,earliestSeq:valid[0].seq};
  const manifestSeq=record(j.session,PREFIX+'batch',manifest);
  j.batches.set(manifestSeq,manifest);
  for(const c of valid) {
    try {
      const message=freeze({...c.message,content:[{type:'text',text:c.replacement}]});
      // No await or diagnostic event may separate these two statements.
      j.session.append('compaction/prune',{shadowedRange:{start:c.seq,end:c.seq},shadowedSeqs:[c.seq],shadowedTokenCount:meter.estimateMessage(c.message)});
      const e=j.session.append('tool/result',{...c.event.data,message},{surfaceOp:{op:'replace',startSeq:c.seq,endSeq:c.seq},sourceEventSeqs:[c.seq,manifestSeq]});
      successful.push({ref:c.ref,originalSeq:c.seq,replacementSeq:e.seq,netChars:c.net});
    } catch(e) {failures.push({ref:c.ref,code:e.code??'COMMIT_FAILED'});}
  }
  record(j.session,PREFIX+'finished',{checkpointSeq:checkpoint.seq,manifestSeq,successful,failures,skips,netBudget,earliestSeq:successful[0]?.originalSeq??null,netChars:successful.reduce((n,c)=>n+c.netChars,0)-overhead,preStepMs:performance.now()-(prepared.startedAt??performance.now())});
  return {manifestSeq,successful,failures,skips,netBudget};
}
export async function recover(j,ref,spill,record,signal) {
  const batch=[...j.batches.values()].find(b=>b.items.some(x=>x.ref===ref));
  const entry=batch?.items.find(x=>x.ref===ref);
  if(!entry) throw fail('UNKNOWN_RECOVERY_REF');
  const e=j.events.get(entry.seq);
  // Forks retain the original immutable manifest and source event; they write a new child-owned spill.
  if(e?.type!=='tool/result'||reference(batch.sessionId,e)!==ref||digest(textOf(e.data.message))!==entry.hash) throw fail('SOURCE_SNAPSHOT_UNAVAILABLE');
  signal?.throwIfAborted();
  const saved=await spill.saveText({owner:{sessionId:j.session.id},suggestedName:`gongjuyasuo-recovered-${entry.seq}.txt`,content:textOf(e.data.message)});
  if(await readFile(saved.locator,'utf8')!==textOf(e.data.message)) throw fail('RECOVERY_READBACK_MISMATCH');
  record(j.session,PREFIX+'recovery',{ref,sourceSeq:entry.seq,locator:saved.locator,hash:entry.hash});
  return {ok:true,ref,path:saved.locator,bytes:saved.bytes,sourceSeq:entry.seq,sha256:entry.hash,retrievalHint:saved.retrievalHint};
}
