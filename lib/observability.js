import { PREFIX, normalizedEvents } from './core.js';
const valid=x=>Number.isSafeInteger(x)&&x>=0;
// Installed pi-ai semantics: inputTokens is uncached, reasoning is inside output.
export function normalizeReportedUsage(u) {
  if(!u||![u.inputTokens,u.outputTokens].every(valid)||['cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'].some(k=>u[k]!==undefined&&!valid(u[k]))||u.reasoningTokens>u.outputTokens) return null;
  const known=u.inputTokens+(u.cacheReadTokens??0)+(u.cacheWriteTokens??0);
  const complete=u.cacheReadTokens!==undefined&&u.cacheWriteTokens!==undefined;
  const total=u.totalTokens??(complete?known+u.outputTokens:undefined);
  if(!valid(known)||!valid(total)||total-u.outputTokens<known||(complete&&total!==known+u.outputTokens)) return null;
  return {...u,totalTokens:total};
}
export function sumUsage(usages) {
  if(!usages.length||usages.some(u=>u===null||u===undefined)) return null;
  const result={};
  for(const k of ['totalTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens']) {
    if(usages.every(u=>valid(u[k]))) {const n=usages.reduce((n,u)=>n+u[k],0);if(!valid(n)) return null;result[k]=n;}
  }
  if(usages.every(u=>valid(u.inputTokens??u.uncachedInputTokens))) {const n=usages.reduce((n,u)=>n+(u.inputTokens??u.uncachedInputTokens),0);if(!valid(n))return null;result.uncachedInputTokens=n;}
  return result;
}
export function metrics(j,deriveTurnTokenUsage) {
  const raw=[...j.events.values()].sort((a,b)=>a.seq-b.seq);
  const events=normalizedEvents(raw);
  const reminders=raw.filter(e=>e.type==='user/message'&&e.data.source?.kind==='plugin:dsh-gongjuyasuo:reminder');
  const checkpoints=events.filter(e=>e.type===PREFIX+'checkpoint');
  const submissions=events.filter(e=>[PREFIX+'submission',PREFIX+'checkpoint'].includes(e.type));
  const batches=events.filter(e=>e.type===PREFIX+'finished');
  const skips={};for(const e of batches)for(const s of e.data.skips??[])skips[s.reason]=(skips[s.reason]??0)+1;
  const seenReminder=reminders.filter(e=>j.effectiveReminderSeqs.has(e.seq));
  const answered=new Set(submissions.map(e=>e.data.reminderSeq).filter(seq=>j.effectiveReminderSeqs.has(seq)));
  const turns=[];let open;
  for(const e of raw) {if(e.type==='turn/start')open=[];if(open)open.push(e);if(e.type==='turn/end'&&open){turns.push({turn:e.data.turn,usage:deriveTurnTokenUsage(open)??null});open=undefined;}}
  const auxiliary=raw.filter(e=>!['assistant/message','assistant/attempt'].includes(e.type)&&e.data?.usage!==undefined).map(e=>({seq:e.seq,type:e.type,usage:normalizeReportedUsage(e.data.usage)}));
  const retry=raw.filter(e=>e.type==='llm/retry');
  return {denominators:{effectiveReminders:'至少被一次明确成功finish请求承载且正文含ref的提醒事件数',submissionRate:'产生至少一次提交的有效提醒 / 有效提醒；自然提交另列',structureValidRate:'结构及来源准入通过的checkpoint / 全部提交',foldRate:'实际有成功替换的checkpoint / 有效checkpoint',coverage:'实际成功替换的结果数；不是全部历史结果比例'},counts:{reminders:reminders.length,effectiveReminders:seenReminder.length,answeredReminders:answered.size,submissions:submissions.length,naturalSubmissions:submissions.filter(e=>e.data.reminderSeq===null).length,validCheckpoints:checkpoints.length,foldedCheckpoints:batches.filter(e=>e.data.successful?.length).length,replacedResults:batches.reduce((n,e)=>n+(e.data.successful?.length??0),0),failedItems:batches.reduce((n,e)=>n+(e.data.failures?.length??0),0),recoveries:events.filter(e=>e.type===PREFIX+'recovery').length,failures:events.filter(e=>e.type===PREFIX+'failure'||e.type===PREFIX+'submission').length,retries:retry.length,readCalls:raw.filter(e=>e.type==='tool/call'&&['read','grep'].includes(e.data.name)).length},submissionRate:seenReminder.length?answered.size/seenReminder.length:null,structureValidRate:submissions.length?checkpoints.length/submissions.length:null,foldRate:checkpoints.length?batches.filter(e=>e.data.successful?.length).length/checkpoints.length:null,coveredResults:checkpoints.reduce((n,e)=>n+e.data.covered.length,0),skipReasons:skips,batches:batches.map(e=>({seq:e.seq,...e.data})),latencies:batches.map(e=>({checkpointSeq:e.data.checkpointSeq,preStepMs:e.data.preStepMs??null})),submissionDelays:checkpoints.map(e=>({checkpoint:e.data.id,requestsAfterReminder:e.data.reminderSuccessRequest===null?null:e.data.submittedAtRequest-e.data.reminderSuccessRequest})),quality:{structuralValidationOnly:true,independentTaskAcceptanceRequired:true,modelSelfAssessmentIsNotQualityEvidence:true},actualUsage:{closedTurns:turns,openTurn:!!open,auxiliary,observedClosedScopeTotal:sumUsage([...turns.map(t=>t.usage),...auxiliary.map(a=>a.usage)]),fullTaskTotal:null,scopeCompleteness:'尚须纳入所有关联子代理及未记入session的辅助模型请求；此处不宣称完整任务总量'},estimated:{batchNetChars:batches.reduce((n,e)=>n+(e.data.successful?.length?e.data.netChars??0:0),0),notProviderTokens:true},retryEvents:retry.map(e=>({seq:e.seq,data:e.data})),noPriceOrRemainingSteps:true};
}
