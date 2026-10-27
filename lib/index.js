import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { VERSION, PREFIX, DEFAULTS, RECEIPT_RESERVE_CHARS, digest, settings, makeJournal, ingest, candidates, validateCheckpoint, prepareBatch, commitBatch, recover } from './core.js';
import { metrics } from './observability.js';
import { observeStream } from './telemetry.js';
export { VERSION, DEFAULTS };
export const name='dsh-gongjuyasuo';
export const inject=['loader','tools','spillStore','tokenMeter','sessionQuery','agents'];
const locks=new WeakSet();
const s={type:'string'},strings={type:'array',items:s};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const PARAMETERS={type:'object',properties:{
  action:{type:'string',enum:['inspect','checkpoint','recover']},ref:s,offset:{type:'integer'},
  previousCheckpoint:{oneOf:[s,{type:'null'}]},
  state:object({subgoal:s,nextStep:s,findings:{type:'array',items:object({text:s,refs:strings})},constraints:strings,changes:s,validation:s,unresolved:{type:'array',items:object({id:s,text:s,refs:strings})},hypotheses:strings}),
  covered:{type:'array',items:object({ref:s,conclusion:s,evidenceQuote:s,noLongerDirectlyNeeded:{type:'boolean'}})},
  retain:{type:'array',items:object({ref:s,reason:s})},
  resolvedIssues:{type:'array',items:object({id:s,evidence:s,refs:strings})}
},required:['action'],additionalProperties:false};
export const DESCRIPTION='单个长任务的工作状态交接与工具原文恢复。自然阶段结束或收到水位提醒时先 inspect 获取真实结果 ref；仅在已吸收结论且不再直接依赖原文时 checkpoint。checkpoint 必须提供 state、covered（非空）、retain（无保留项时 []）；首次 previousCheckpoint 为 null；resolvedIssues 无已解决项时可省略或 []，省略绝不免除继承未决项。提交当前子目标、下一步、已确认发现及来源、约束、修改与验证状态、未决问题、假设；covered 每项须含原文逐字 evidenceQuote（至少16字）与结论；仍直接依赖的代码、未解决错误和未交接信息必须 retain。继承上个检查点的有效未决信息和约束，不总结整个会话、不把猜测当事实。无合格交接则继续任务并保留原文。工具仅排队检查，请求前再次准入才折叠。recover(ref) 从保留源事件重建原文文件，再用 read(offset/limit) 或 grep 读取；关闭后仍可恢复。';
export async function apply(ctx,input={}) {
  const helpers=await ctx.loader.import('@deepseek-ai/dsh-llm');
  const {deriveTurnTokenUsage}=await ctx.loader.import('@deepseek-ai/dsh-token-meter/client');
  const configPath=input.configPath??fileURLToPath(new URL('../config.json',import.meta.url));
  const load=()=>settings({...JSON.parse(readFileSync(configPath,'utf8')),...input.settings});
  load();
  const journals=new WeakMap(),active=new Map();
  let disposed=false,lastFailure=null;
  const diagnosticsPath=input.diagnosticsPath??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'storages','dsh-gongjuyasuo','diagnostics.jsonl');
  mkdirSync(dirname(diagnosticsPath),{recursive:true,mode:0o700});
  let diagnosticSequence=0;
  const emit=data=>{try{appendFileSync(diagnosticsPath,JSON.stringify({version:VERSION,pid:process.pid,sequence:++diagnosticSequence,time:new Date().toISOString(),...data})+'\n',{mode:0o600});}catch{lastFailure={stage:'diagnostics',code:'DIAGNOSTIC_WRITE_FAILED'};ctx.logger.error('dsh-gongjuyasuo DIAGNOSTIC_WRITE_FAILED');}};
  const runtime={version:VERSION,pid:process.pid,node:process.versions.node,electron:process.versions.electron??null,configPath,diagnosticsPath,sourceHash:digest(['index.js','core.js','observability.js','telemetry.js'].map(f=>readFileSync(fileURLToPath(new URL(f,import.meta.url)),'utf8')).join(''))};
  ctx.on('llm/stream',(options,next)=>{
    const initiator=ctx.agents?.currentInitiator?.();
    let configHash=null;try{configHash=digest(load());}catch{emit({kind:'configuration-error',code:'INVALID_CONFIG'});}
    return observeStream(options,next,{emit,initiator:initiator?.session,sessionId:initiator?.session.id,configHash});
  },{global:true});
  emit({kind:'loaded',runtime,settings:load()});
  const journal=session=>{let j=journals.get(session);if(!j){j=makeJournal(session);journals.set(session,j);active.set(session.id,j);}return j;};
  // Supported message/source metadata and this tool's own presentationMeta only.
  // Experimental appendPluginRecord is explicitly unavailable to external plugins.
  const record=(session,type,data)=>{
    const details={version:VERSION,...data};
    const budgetText=data.netBudget?` 字符估计净缩减 ${data.netBudget.netReductionChars}/${data.netBudget.requiredNetReductionChars}；检查点 ${data.netBudget.checkpointChars} + 收据预留 ${data.netBudget.receiptReserveChars} chars。不是提供方 token 收益；不足时原文保留，不降低交接质量。`:'';
    const text=type===PREFIX+'batch'?`[gongjuyasuo 批次准备] 检查点 ${data.checkpointId}；${data.items.length} 项原文已逐字保存，尚待逐项替换。`:type===PREFIX+'finished'?`[gongjuyasuo 批次结果] 成功 ${data.successful?.length??0} 项；失败 ${data.failures?.length??0} 项；跳过 ${data.skips?.length??0} 项。恢复请用原 ref。${budgetText}`:type===PREFIX+'recovery'?`[gongjuyasuo 恢复索引] ${data.ref} → ${data.locator}`:type===PREFIX+'failure'?`[gongjuyasuo 诊断] ${data.stage}: ${data.code}；受影响原文保留，继续正常任务。`:`[gongjuyasuo 观测] 检查点提交耗时 ${Math.round(data.preStepMs??0)} ms。`;
    const seq=session.append('user/message',helpers.createUserMessage({source:{kind:'plugin:dsh-gongjuyasuo:record',recordType:type,recordData:details},content:[{type:'text',text}]}),{surfaceOp:'append'}).seq;
    emit({kind:type.slice(PREFIX.length),sessionId:session.id,seq,...details});
    return seq;
  };
  const diagnose=(session,stage,error,{persist=true}={})=>{
    const code=typeof error.code==='string'&&/^[A-Z0-9_-]{1,80}$/u.test(error.code)?error.code:'OPERATION_FAILED';
    lastFailure={sessionId:session.id,stage,code};
    if(persist)try {record(session,PREFIX+'failure',{stage,code});}catch {ctx.logger.error('dsh-gongjuyasuo: diagnostic record write failed');}
    ctx.logger.warn(`dsh-gongjuyasuo ${stage}: ${code}`);
    return code;
  };
  ctx.on('session/event',(session,event)=>{try{ingest(journal(session),event);}catch(e){journal(session).invalid=true;diagnose(session,'journal',e,{persist:false});}},{global:true});
  ctx.on('agent/disposed',({agent})=>active.delete(agent.session.id),{global:true});
  async function ready(session) {
    const j=journal(session);
    if(!j.initialized) {
      const {events}=await ctx.sessionQuery.readSession(session.id);
      for(const e of events) ingest(j,e);
      if(j.cursor!==session.seq) throw Object.assign(new Error('EVENT_GAP'),{code:'EVENT_GAP'});
      j.initialized=true;
    }
    if(j.invalid) throw Object.assign(new Error('INVALID_JOURNAL'),{code:'INVALID_JOURNAL'});
    return j;
  }
  const publicCandidate=c=>({ref:c.ref,tool:c.name,args:c.args,chars:c.chars,sourceSeq:c.seq});
  const publicValue=value=>Object.fromEntries(Object.entries(value).filter(([k])=>k!=='_gongjuyasuo'));
  ctx.tools.register({name:'gongjuyasuo',description:DESCRIPTION,parameters:PARAMETERS,timeoutMs:120000,
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(publicValue(value))}],presentationMeta:(_args,value)=>({gongjuyasuo:value._gongjuyasuo??{refs:value.refs??[]}})},
    isConcurrencySafe:()=>false,
    async execute(args,exec) {
      const session=exec.agent?.session;
      if(!session) throw Object.assign(new Error('AGENT_REQUIRED'),{code:'AGENT_REQUIRED'});
      const j=await ready(session),config=load();exec.signal.throwIfAborted();
      if(args.action==='recover') return recover(j,args.ref,ctx.spillStore,record,exec.signal);
      if(!config.enabled) return {ok:false,status:'disabled',message:'停止新提醒、检查点与折叠；已有 ref 仍可 recover。'};
      if(args.action==='inspect') {
        const {eligible,skips}=candidates(j,config),offset=args.offset??0;
        if(!Number.isSafeInteger(offset)||offset<0) throw Object.assign(new Error('INVALID_OFFSET'),{code:'INVALID_OFFSET'});
        const page=eligible.slice(offset,offset+32).map(publicCandidate);
        return {ok:true,previousCheckpoint:j.lastCheckpoint?.id??null,previousState:j.lastCheckpoint?.state??null,candidates:page,refs:page.map(c=>c.ref),skips,netGate:{unit:'estimated-chars-not-provider-tokens',minimumNetReductionChars:config.minNetReductionChars,receiptReserveChars:RECEIPT_RESERVE_CHARS,formula:'sum(original chars - recovery-index chars) - serialized checkpoint chars - receipt reserve',policy:'有效交接不等于可以折叠。只覆盖已吸收且无直接依赖的原文；完整承接关键约束与未决信息，避免无关重复。不足门槛时保留原文继续任务，不降低质量、不猜测清理。'},nextOffset:eligible.length>offset+32?offset+32:null};
      }
      if(args.action!=='checkpoint') throw Object.assign(new Error('UNKNOWN_ACTION'),{code:'UNKNOWN_ACTION'});
      const submission={callId:exec.callId,reminderSeq:j.lastReminderSeq,reminderSuccessRequest:j.lastReminder<0?null:j.lastReminder};
      try {
        const id=`cp:${digest(session.id+':'+exec.callId).slice(0,20)}`,requestHash=digest(args);
        const existing=j.pending.find(c=>c.id===id);
        if(existing) {
          if(existing.requestHash!==requestHash) throw Object.assign(new Error('CALL_ID_CONFLICT'),{code:'CALL_ID_CONFLICT'});
          return {ok:true,status:'already-queued',checkpointId:id};
        }
        const cp=validateCheckpoint(j,args,config);
        return {ok:true,status:'queued-not-yet-folded',checkpointId:id,state:cp.state,covered:cp.covered.map(c=>({ref:c.ref,conclusion:c.conclusion})),_gongjuyasuo:{recordType:PREFIX+'checkpoint',data:{...cp,id,requestHash,submittedAtRequest:j.successful,...submission}}};
      } catch(e) {
        const code=diagnose(session,'invalid-checkpoint',e,{persist:false});
        return {ok:false,status:'invalid-checkpoint',code,fieldErrors:Array.isArray(e.fieldErrors)?e.fieldErrors:[],message:'原文保留；checkpoint 必须提供 state、covered（非空）、retain（无保留项为 []）；首次 previousCheckpoint:null；resolvedIssues 可省略或 []，但继承未决项仍须保留或明确解决。请按 code/fieldErrors 修正交接，或继续任务；不会自动猜测清理。',_gongjuyasuo:{recordType:PREFIX+'submission',data:{...submission,code}}};
      }
    }
  });
  ctx.on('agent/pre-step',async ({agent,signal},next)=>{
    const decision=await next();
    if(decision.kind!=='enter'||disposed) return decision;
    const session=agent.session;
    if(locks.has(session)) return decision;
    locks.add(session);
    try {
      let config=load();
      if(!config.enabled) return decision;
      const j=await ready(session);signal.throwIfAborted();
      for(const checkpoint of j.pending.filter(c=>!j.finished.has(c.seq))) {
        const started=performance.now();
        const prepared=await prepareBatch(j,checkpoint,config,ctx.spillStore,signal);
        config=load();
        const result=commitBatch(j,checkpoint,prepared,config,ctx.tokenMeter,record,helpers.freezeMessage,signal);
        if(!j.finished.has(checkpoint.seq)) record(session,PREFIX+'finished',{checkpointSeq:checkpoint.seq,...result,netChars:0,earliestSeq:null});
        // Timing is off-surface receipt metadata, not a per-step changing prompt.
        const last=[...j.events.values()].at(-1);
        runtime.lastBatchLatency={sessionId:session.id,checkpointSeq:checkpoint.seq,preStepMs:performance.now()-started,receiptSeq:last?.seq??null};
      }
      if(!config.enabled||signal.aborted) return decision;
      const {eligible}=candidates(j,config),chars=eligible.reduce((n,c)=>n+c.chars,0);
      const progressSeq=[...j.calls.values()].filter(e=>e.data.name!=='gongjuyasuo').at(-1)?.seq??-1;
      const key=digest([eligible.map(c=>c.ref),progressSeq]);
      if(chars<config.watermarkChars||!eligible.length||j.successful-j.lastReminder<config.reminderIntervalRequests||key===j.lastReminderKey) return decision;
      const list=eligible.slice(0,32).map(publicCandidate);
      const reminder=helpers.createUserMessage({source:{kind:'plugin:dsh-gongjuyasuo:reminder',gongjuyasuoRefs:list.map(c=>c.ref),candidateKey:key},content:[{type:'text',text:`[工具上下文交接检查，不是任务停止条件]\n累计候选 ${chars} chars。请在下一次实现完成或测试通过的稳定阶段边界，先 inspect，再以 checkpoint 交接已吸收的发现、约束、修改验证状态与下一步；只覆盖那时已不再直接需要的原文。如果现在仍依赖原文，保留它并继续当前工作，不要为整理而降低交接质量。这是任务内部交接，不等下一轮用户消息；提交后仍继续原任务。不得省略未决问题、关键约束或直接依赖的代码。可用结果索引：${JSON.stringify(list)}\ninspect 可查看完整列表和上次检查点。长度/年龄不是无用证明；不要求为此额外调用总结模型。`} ]});
      return {...decision,messages:[...decision.messages,reminder]};
    } catch(e) {diagnose(session,'pre-step',e);return decision;}
    finally {locks.delete(session);}
  },{global:true,prepend:true});
  ctx.inject(['connection'],routeCtx=>{
    routeCtx.connection.fetch.register({path:'/api/dsh-gongjuyasuo',methods:['GET'],requestBody:'buffered',fetch:async request=>{
      const id=new URL(request.url).searchParams.get('sessionId');
      let j=id?active.get(id):null;
      if(id&&!j) {
        try {
          const loaded=await ctx.sessionQuery.readSession(id);
          const replay={id,header:loaded.session,surface:{nodes:[]},isOwnSeq:seq=>seq>=loaded.inheritedEventCount&&seq<loaded.events.length,deriveEventMessage:e=>e.type==='tool/result'?e.data.message:e.type==='user/message'?e.data:null};
          j=makeJournal(replay);for(const e of loaded.events)ingest(j,e);replay.surface.nodes=j.nodes;
        } catch {return new Response(JSON.stringify({ok:false,code:'SESSION_READ_FAILED',sessionId:id}),{status:404,headers:{'content-type':'application/json'}});}
      }
      return new Response(JSON.stringify({ok:true,runtime,settings:load(),lastFailure,metricsView:id&&!active.has(id)?'retained-raw-replay-no-historical-projection':'live-projected',sessions:[...active.values()].map(j=>({sessionId:j.session.id,successfulRequests:j.successful,checkpointCount:j.pending.length,finishedCount:j.finished.size,batchCount:j.batches.size,eligible:candidates(j,load()).eligible.length})),metrics:j?metrics(j,deriveTurnTokenUsage):null}),{headers:{'content-type':'application/json'}});
    }});
  });
  ctx.effect(()=>()=>{disposed=true;active.clear();},'dsh-gongjuyasuo.lifecycle');
}
