import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as Plugin from '../lib/index.js';
import { makeJournal, ingest, recordOf, DEFAULTS } from '../lib/core.js';
import { metrics, sumUsage } from '../lib/observability.js';
import { createFixture } from './fixture.mjs';
import { accept } from './acceptance.mjs';
import { assertSameReadFile } from './recovery-path.mjs';
import { createRepairFixture, acceptRepair, REPAIR_SCOPE, REPAIR_ACCEPTANCE, REPAIR_USER_INSTRUCTION } from './repair-fixture.mjs';
const base='file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/';
const mod=name=>import(base+name+'/lib/index.js');
const pluginRoot=fileURLToPath(new URL('../',import.meta.url));
const mode=process.argv[2]??'--prepare',number=Number(process.argv[3]??1);
const repair=mode.startsWith('--repair-'),preparing=['--prepare','--repair-prepare'].includes(mode),running=['--run','--repair-run'].includes(mode);
if(!['--prepare','--run','--repair-prepare','--repair-run'].includes(mode)||!Number.isInteger(number)||number<1||number>(repair?1:3)||process.argv.length>4)throw new Error('USAGE: smoke.mjs --prepare|--run [1..3] OR --repair-prepare|--repair-run [1]');
const repairRoot=join(pluginRoot,'evidence',REPAIR_SCOPE),planPath=join(repairRoot,'plan.json');
const evidenceRoot=repair?repairRoot:join(pluginRoot,'evidence','smoke');
const attemptRoot=join(evidenceRoot,preparing?`preflight-${Date.now()}-${randomUUID().slice(0,8)}`:`attempt-${number}`);
const legacyLedgerPath=join(pluginRoot,'evidence','smoke','attempt-ledger.json');
const ledgerPath=repair?join(repairRoot,'attempt-ledger.json'):legacyLedgerPath;
const hash=s=>createHash('sha256').update(s).digest('hex');
const sourceFiles=['package.json','config.json','cordis.patch.yml','lib/index.js','lib/core.js','lib/observability.js','lib/telemetry.js','scripts/fixture.mjs','scripts/acceptance.mjs','scripts/smoke.mjs','scripts/repair-fixture.mjs','scripts/recovery-path.mjs'];
const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,hash(await readFile(join(pluginRoot,f)))])));
const legacyLedgerBytes=await readFile(legacyLedgerPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const planContract={schemaVersion:1,scope:REPAIR_SCOPE,number:1,version:Plugin.VERSION,sourceHashes,acceptance:REPAIR_ACCEPTANCE,maxModelRuns:1,stage2Paused:true};
let plan,planHash,ledger=[],ledgerAdmitted=false;
// A repair rejection before admission cannot load credentials, alter old evidence, or consume a model sample.
if(mode==='--repair-run') {
  const bytes=await readFile(planPath);plan=JSON.parse(bytes);planHash=hash(bytes);
  assert.equal(plan.schemaVersion,1,'REPAIR_PLAN_SCHEMA');assert.equal(plan.scope,REPAIR_SCOPE,'REPAIR_PLAN_SCOPE');assert.equal(plan.number,1,'REPAIR_PLAN_NUMBER');
  assert.equal(plan.version,Plugin.VERSION,'REPAIR_PLAN_VERSION');assert.equal(JSON.parse(await readFile(join(pluginRoot,'package.json'),'utf8')).version,Plugin.VERSION,'PACKAGE_SOURCE_VERSION_MISMATCH');
  assert.deepEqual(plan.sourceHashes,sourceHashes,'REPAIR_PLAN_SOURCE_HASHES');assert.deepEqual(plan.acceptance,REPAIR_ACCEPTANCE,'REPAIR_PLAN_ACCEPTANCE_COMMITMENT');
  assert.equal(plan.maxModelRuns,1,'REPAIR_PLAN_ONE_RUN');assert.equal(plan.stage2Paused,true,'STAGE2_MUST_STAY_PAUSED');
}
if(!repair)try{ledger=JSON.parse(await readFile(ledgerPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(running) {
  if(repair) {
    ledger=[{number:1,scope:REPAIR_SCOPE,status:'started',startedAt:new Date().toISOString(),attemptRoot,planPath,planHash,version:Plugin.VERSION,sourceHashes,maxModelRuns:1,legacyLedgerHash:legacyLedgerBytes===null?null:hash(legacyLedgerBytes)}];
    await mkdir(dirname(ledgerPath),{recursive:true});
    // Exclusive creation is the immutable one-attempt admission gate, including crashed/failed attempts.
    await writeFile(ledgerPath,JSON.stringify(ledger,null,2),{flag:'wx'});
  } else {
    if(ledger.length!==number-1||ledger.length>=3)throw new Error('FORMAL_ATTEMPT_ORDER_OR_LIMIT');
    if(number>1&&!ledger.at(-1).nextRepairBasis)throw new Error('NO_NEW_REPAIR_BASIS');
    ledger.push({number,status:'started',startedAt:new Date().toISOString(),attemptRoot});
    await mkdir(dirname(ledgerPath),{recursive:true});await writeFile(ledgerPath,JSON.stringify(ledger,null,2));
  }
  ledgerAdmitted=true;
}
let ctx,handle,timer,outcome={mode,number,scope:repair?REPAIR_SCOPE:'legacy-smoke',pluginVersion:Plugin.VERSION,attemptRoot};
async function saveCommand(name,args,cwd) {
  const result=spawnSync('/usr/local/bin/node',args,{cwd,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  const log=join(attemptRoot,name+'.log');await writeFile(log,(result.stdout??'')+'\n'+(result.stderr??''));
  return {exitCode:result.status,signal:result.signal,error:result.error?{code:result.error.code,message:result.error.message}:null,log};
}
async function repairBaseline(root) {
  for(const file of ['test/import.test.mjs','test/restock.test.mjs','src/restock.mjs']) {
    const checked=await saveCommand('baseline-syntax-'+file.replaceAll('/','-'),['--check',join(root,file)],root);
    if(checked.exitCode!==0||checked.error)throw new Error('BASELINE_INVALID_SYNTAX_'+file);
  }
  const results={
    ordersPublic:await saveCommand('baseline-orders-public',['--test','test/import.test.mjs'],root),
    restockPublic:await saveCommand('baseline-restock-public',['--test','test/restock.test.mjs'],root),
    ordersIndependent:await saveCommand('baseline-orders-independent',[join(pluginRoot,'scripts/acceptance.mjs'),root],root),
    restockIndependent:await saveCommand('baseline-restock-independent',[join(pluginRoot,'scripts/repair-fixture.mjs'),'--accept-restocks',root],root),
    combinedIndependent:await saveCommand('baseline-combined-independent',[join(pluginRoot,'scripts/repair-fixture.mjs'),'--accept',root],root),
  };
  await writeFile(join(attemptRoot,'baseline-results.json'),JSON.stringify(results,null,2));
  for(const [name,result] of Object.entries(results))if(result.exitCode!==1||result.error||result.signal)throw new Error('EXPECTED_BASELINE_ASSERTION_FAILURE_'+name);
  return {ok:true,meaning:'both business flows are genuinely broken; failures are expected baseline evidence, not a model-task pass',results};
}
async function nativeRecoveryReadProbe(before,llm) {
  const proof={modelInitiated:false,kind:'post-idle-native-tool-probe',modelCalls:0,ok:false,callIds:[],events:[]};
  try {
    const finished=before.events.filter(e=>recordOf(e)?.type==='plugin:dsh-gongjuyasuo/finished');
    const item=finished.flatMap(e=>recordOf(e).data.successful??[])[0];
    if(!item)throw new Error('NO_SUCCESSFUL_REPLACEMENT_TO_RECOVER');
    const original=before.events.find(e=>e.seq===item.originalSeq);
    if(original?.type!=='tool/result'||original.data.message.content.some(c=>c.type!=='text'))throw new Error('RAW_SOURCE_EVENT_UNAVAILABLE');
    const raw=original.data.message.content.map(c=>c.text).join('');
    const lastStep=before.events.filter(e=>e.type==='step/start').at(-1)?.data??{turn:1,step:1};
    const execute=async(name,args)=>{
      const callId=`native-repair-probe-${name}-${randomUUID()}`;proof.callIds.push(callId);
      const call=handle.agent.session.append('tool/call',{turn:lastStep.turn,step:lastStep.step,callId,name,arguments:args});proof.events.push(call.seq);
      const batch=await ctx.tools.execute({calls:[{type:'tool-call',id:callId,name,arguments:JSON.stringify(args)}],agent:handle.agent,signal:new AbortController().signal});
      const result=batch.results[0].result;
      const message=llm.freezeMessage({id:callId+'-result',role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:result.content,...(result.isError?{isError:true}:{})});
      const event=handle.agent.session.append('tool/result',{turn:lastStep.turn,step:lastStep.step,message,...(result.meta?{meta:result.meta}:{})},{surfaceOp:'append'});proof.events.push(event.seq);
      await writeFile(join(attemptRoot,`native-probe-${name}-result.json`),JSON.stringify(result,null,2));
      if(result.isError)throw new Error('NATIVE_PROBE_TOOL_FAILED_'+name);
      return result;
    };
    const recovery=await execute('gongjuyasuo',{action:'recover',ref:item.ref});
    const path=recovery.value?.path;if(typeof path!=='string')throw new Error('NATIVE_RECOVER_PATH_MISSING');
    const bytes=await readFile(path),expected=Buffer.from(raw,'utf8');
    assert.deepEqual(bytes,expected,'recovered bytes must match immutable raw source event');
    assert.equal(recovery.value.sha256,hash(expected),'recover metadata SHA must match raw source');
    assert.equal(recovery.value.bytes,expected.length,'recover metadata bytes must match raw source');
    const read=await execute('read',{file_path:path});
    await assertSameReadFile(read.value?.path,path);
    assert.ok(read.value.lines.length>0,'native read must return actual source lines');
    const rawLines=raw.split('\n').map(s=>s.endsWith('\r')?s.slice(0,-1):s);
    for(const line of read.value.lines) {
      const full=rawLines[line.number-1];assert.equal(typeof full,'string');
      assert.equal(line.text,full.length>2000?full.slice(0,2000)+'... (line truncated to 2000 chars)':full,'read window must match source text');
    }
    Object.assign(proof,{ok:true,ref:item.ref,originalSeq:item.originalSeq,replacementSeq:item.replacementSeq,path,sha256:hash(bytes),rawSha256:hash(expected),bytes:bytes.length,rawBytes:expected.length,byteIdentical:true,readWindowVerified:true,readWindowLines:read.value.lines.length,readTotalLines:read.value.totalLines,note:'The host invoked native recover then native read after natural idle. This is not model-initiated recall. Byte/SHA equality uses the recovered file and immutable raw event; read uses its normal bounded line window.'});
  } catch(error) {proof.failure={name:error.name,message:error.message,code:error.code??null};}
  await writeFile(join(attemptRoot,'native-recovery-read-probe.json'),JSON.stringify(proof,null,2));
  return proof;
}
try {
  await mkdir(dirname(attemptRoot),{recursive:true});await mkdir(attemptRoot,{recursive:false});
  const root=join(attemptRoot,'project');const fixture=await (repair?createRepairFixture(root):createFixture(root));
  const formal=JSON.parse(await readFile(join(pluginRoot,'config.json'),'utf8'));
  const config=repair?{...formal}:{...formal,watermarkChars:6000};
  const differences=Object.keys(config).filter(k=>JSON.stringify(formal[k])!==JSON.stringify(config[k]));
  if(repair) {assert.deepEqual(differences,[],'REPAIR_MUST_USE_UNCHANGED_FORMAL_CONFIG');assert.equal(config.watermarkChars,24000,'REPAIR_FORMAL_WATERMARK');assert.equal(DEFAULTS.watermarkChars,24000,'DEFAULT_WATERMARK');}
  else if(JSON.stringify(differences)!==JSON.stringify(['watermarkChars']))throw new Error('SMOKE_CONFIGURATION_MUST_ONLY_LOWER_WATERMARK');
  const configPath=join(attemptRoot,'smoke-config.json');await writeFile(configPath,JSON.stringify(config,null,2));
  const configEvidence={formal,temporary:config,differences,defaultWatermark:DEFAULTS.watermarkChars};await writeFile(join(attemptRoot,'config-evidence.json'),JSON.stringify(configEvidence,null,2));
  if(repair) {
    outcome.baseline=await repairBaseline(root);
    const files=await Promise.all(fixture.files.map(async f=>({path:f,bytes:(await readFile(join(root,f))).length})));
    outcome.fixtureScope={businessFlows:fixture.businessFlows,padding:false,files,totalBytes:files.reduce((n,f)=>n+f.bytes,0),newFlowBytes:files.filter(f=>/restock/.test(f.path)).reduce((n,f)=>n+f.bytes,0)};
    await writeFile(join(attemptRoot,'fixture-scope.json'),JSON.stringify(outcome.fixtureScope,null,2));
    await writeFile(join(attemptRoot,'expected-plan-contract.json'),JSON.stringify(planContract,null,2));
    if(running) {
      assert.equal(hash(await readFile(planPath)),planHash,'PLAN_CHANGED_AFTER_ADMISSION');
      assert.deepEqual(Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,hash(await readFile(join(pluginRoot,f)))]))),plan.sourceHashes,'SOURCE_CHANGED_AFTER_ADMISSION');
    }
  }
  const names=['cordis','dsh-session','dsh-session-projection','dsh-token-meter','dsh-session-query','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-tool-executor-native','dsh-agent-loop','dsh-fs-local','dsh-working-directory'];
  const [cordis,session,projection,token,query,agent,llm,prompt,tools,native,loop,fsLocal,wd]=await Promise.all(names.map(mod));
  const tokenClient=await import(base+'dsh-token-meter/lib/types/client.js');ctx=new cordis.Context();
  for(const [service,options] of [[session.SessionStore,{}],[projection.SessionProjectionRegistry,{}],[token.TokenMeter,{}],[query.SessionQueryEngine,{}],[agent.AgentRegistry,{}],[llm.LlmRuntime,{}],[prompt.SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false}],[tools.ToolRuntime,{}],[fsLocal.default,{cwd:root}],[wd.WorkingDirectoryService,{}],[loop.AgentLoop,{agents:[],maxParallelToolCalls:4}]])await ctx.plugin(service,options);
  const executor=new native.NativeToolExecutor(ctx);ctx.tools.setExecutor(executor);
  ctx.provide('loader',{import:spec=>spec==='@deepseek-ai/dsh-token-meter/client'?tokenClient:mod(spec.replace('@deepseek-ai/',''))});
  await ctx.plugin((await mod('dsh-spill-local')).default,{root:join(attemptRoot,'spills'),cleanupPeriodDays:0});await ctx.plugin(await mod('dsh-tool-fs'),{readImage:false});
  await ctx.plugin((await mod('dsh-subprocess-local')).default,{});await ctx.plugin((await mod('dsh-bash-local')).default,{cwd:root});
  await ctx.plugin(await mod('dsh-shell-env'),{});await ctx.plugin(await mod('dsh-tool-bash'),{enableRunInBackground:false});
  await ctx.plugin(Plugin,{configPath,diagnosticsPath:join(attemptRoot,'diagnostics.jsonl')});
  ctx.systemPrompt.section({name:'smoke-coding-contract',order:1,text:'You are a coding agent. Complete the one user repair task using the provided filesystem and bash tools. Work only in the given isolated project; do not read credentials or other projects. Read existing text before editing it. Use read to inspect files; do not shell-cat text. Preserve test expectations. Check real command exit codes. Do not claim verification without executing it. Continue until the task is done. Do not manufacture logs or evidence.'});
  const sessionId=`gongjuyasuo-${repair?REPAIR_SCOPE:running?'smoke-'+number:'preflight'}-${Date.now()}`;
  handle=await ctx.agents.create({sessionId,meta:{cwd:root},agentOptions:{provider:'openai-codex',model:'gpt-6.1-sol'}});
  const schemas=executor.describe(ctx.tools.definitions(handle.agent)).schemas.map(t=>t.name);
  for(const name of ['read','write','edit','bash','gongjuyasuo'])if(!schemas.includes(name))throw new Error('MISSING_ACTUAL_TOOL_'+name);
  await writeFile(join(attemptRoot,'actual-tool-list.json'),JSON.stringify({capabilities:ctx.tools.schemas(handle.agent).map(t=>t.name),wire:schemas},null,2));
  await writeFile(join(attemptRoot,'source-hashes.json'),JSON.stringify(sourceHashes,null,2));
  if(preparing) {
    const runTool=async(name,id,args)=>(await ctx.tools.execute({calls:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}],agent:handle.agent,signal:new AbortController().signal})).results[0].result;
    const readResult=await runTool('read','preflight-read',{file_path:join(root,'docs/contract.md')});
    await writeFile(join(attemptRoot,'real-read-result.json'),JSON.stringify(readResult,null,2));
    if(readResult.isError||!readResult.content.some(c=>c.type==='text'&&c.text.includes('Atomicity')))throw new Error('REAL_READ_PREFLIGHT_FAILED');
    const execution=await runTool('bash','preflight-bash',{command:'/usr/local/bin/node --version',description:'Verify isolated Node runtime',workdir:root});
    await writeFile(join(attemptRoot,'real-bash-result.json'),JSON.stringify(execution,null,2));
    if(execution.isError||execution.value?.kind!=='foreground'||execution.value.exitCode!==0||execution.value.timedOut)throw new Error('REAL_BASH_PREFLIGHT_FAILED');
    const inspection=await runTool('gongjuyasuo','preflight-inspect',{action:'inspect'});
    await writeFile(join(attemptRoot,'real-gongjuyasuo-result.json'),JSON.stringify(inspection,null,2));
    if(inspection.isError||inspection.value?.ok!==true||!Array.isArray(inspection.value?.candidates))throw new Error('REAL_PLUGIN_INSPECT_PREFLIGHT_FAILED');
    const diagnostics=(await readFile(join(attemptRoot,'diagnostics.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const loaded=diagnostics.find(entry=>entry.kind==='loaded');
    const runtimeHash=hash((await Promise.all(['index.js','core.js','observability.js','telemetry.js'].map(name=>readFile(join(pluginRoot,'lib',name),'utf8')))).join(''));
    if(loaded?.runtime?.version!==Plugin.VERSION||loaded.runtime.sourceHash!==runtimeHash)throw new Error('PLUGIN_RUNTIME_SOURCE_MISMATCH');
    outcome={...outcome,ok:true,modelCalls:0,schemas,credentialServiceLoaded:false,realRead:true,realBash:true,realPluginInspect:true,runtimeSourceHash:runtimeHash,formalConfigUnchanged:repair?true:null,planRequiredForRun:repair?planPath:null,modelSampleConsumed:false};
  } else {
    // This branch is the sole model entry. --repair-run has already consumed its one ledger slot.
    await ctx.plugin((await mod('dsh-credentials-local')).default,{watch:false});
    await ctx.plugin(await mod('dsh-llm-pi-ai'),{providers:{'openai-codex':{models:[{id:'gpt-6.1-sol',name:'gpt-6.1-sol',contextWindow:400000,maxTokens:128000,input:['text','image']}]}}});
    const user=repair?REPAIR_USER_INSTRUCTION:'修复这个仓库的订单 CSV 导入器。先阅读 README.md、docs/contract.md、docs/examples.json 和现有实现及测试，依据合同修复 CSV 引号/换行处理、严格数值校验、整批原子性以及重复订单幂等与冲突检查。保持公开 API，不改测试来迎合实现，不加依赖；更新必要说明并递增样例工程版本。运行现有测试，并补充必要的边界回归，最后说明改动和实际验证结果。';
    await writeFile(join(attemptRoot,'user-instruction.txt'),user);
    ctx.on('session/event',(s,e)=>{if(s.id===sessionId&&['tool/call','assistant/attempt','turn/end'].includes(e.type))console.log(JSON.stringify({event:e.type,seq:e.seq,name:e.data.name??null,reasonKind:e.data.reason?.kind??null}));},{global:true});
    timer=setTimeout(()=>{outcome.environmentTimeout=true;handle.agent.cancel({kind:'user'});},15*60*1000);
    handle.agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:user}]}));await handle.agent.whenIdle();clearTimeout(timer);timer=null;
    const before=await ctx.sessionQuery.readSession(sessionId);
    await writeFile(join(attemptRoot,repair?'session-before-native-probe.json':'session.json'),JSON.stringify(before,null,2));
    const probe=repair&&!outcome.environmentTimeout?await nativeRecoveryReadProbe(before,llm):null;
    const loaded=repair?await ctx.sessionQuery.readSession(sessionId):before;
    if(repair)await writeFile(join(attemptRoot,'session.json'),JSON.stringify(loaded,null,2));
    const j=makeJournal(handle.agent.session);for(const e of loaded.events)ingest(j,e);
    const measured=ctx.tokenMeter.measure(handle.agent.session),report=metrics(j,tokenClient.deriveTurnTokenUsage);
    const diagnostics=(await readFile(join(attemptRoot,'diagnostics.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
    const calls=diagnostics.filter(d=>d.kind==='llm-call');
    let independent,independentError;try{independent=await (repair?acceptRepair(root):accept(root));}catch(e){independentError={name:e.name,message:e.message};}
    const testFiles=(await readdir(join(root,'test'))).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>join('test',n));
    const tests=spawnSync('/usr/local/bin/node',['--test',...testFiles],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
    await writeFile(join(attemptRoot,'post-task-tests.log'),(tests.stdout??'')+'\n'+(tests.stderr??''));
    const finished=before.events.filter(e=>recordOf(e)?.type==='plugin:dsh-gongjuyasuo/finished'),replaced=finished.flatMap(e=>recordOf(e).data.successful??[]);
    const lastReplacement=before.events.find(e=>e.seq===replaced.at(-1)?.replacementSeq);
    const laterRequest=!!lastReplacement&&calls.some(c=>Date.parse(c.time)>=lastReplacement.time)&&before.events.some(e=>e.type==='assistant/message'&&e.seq>lastReplacement.seq&&!e.data.interrupted);
    const laterTool=!!lastReplacement&&before.events.some(e=>e.type==='tool/call'&&e.seq>lastReplacement.seq);
    const turnEnds=before.events.filter(e=>e.type==='turn/end');
    const recoveryEvents=loaded.events.filter(e=>recordOf(e)?.type==='plugin:dsh-gongjuyasuo/recovery');
    const countsConsistent=report.counts.recoveries===recoveryEvents.length&&report.counts.replacedResults===replaced.length;
    const ok=!outcome.environmentTimeout&&turnEnds.length===1&&turnEnds[0].data.reason.kind==='completed'&&report.counts.effectiveReminders>0&&report.counts.validCheckpoints>0&&replaced.length>0&&laterRequest&&independent?.ok&&tests.status===0&&!tests.error&&(!repair||(probe?.ok&&countsConsistent));
    outcome={...outcome,ok:!!ok,sessionId,taskRoot:root,model:'openai-codex/gpt-6.1-sol',configEvidence,turnStarts:before.events.filter(e=>e.type==='turn/start').length,turnEnds:turnEnds.map(e=>e.data),actualLlmCalls:calls.length,actualObservedTotal:sumUsage(calls.map(c=>c.exactUsage)),unknownUsageCalls:calls.filter(c=>!c.exactUsage).length,metrics:report,measuredEstimate:{totalTokens:measured.totalTokens,surfaceTokens:measured.surfaceTokens,baseline:measured.baseline.kind},replaced,laterRequest,laterTool,independent:independent??null,independentError:independentError??null,publicTestsExit:tests.status,publicTestsError:tests.error?.code??null,nativeRecoveryReadProbe:probe,countsConsistent,probeRecoveryEvents:recoveryEvents.map(e=>e.seq),scope:{relatedSubagents:0,auxiliaryModelPlugins:false,allLlmStreamsObserved:true},environmentProtection:{timeoutMs:15*60*1000,notAnAcceptanceBudget:true,stepCap:null,tokenBudget:null},netBenefitClaimed:false};
  }
} catch(e) {outcome={...outcome,ok:false,failure:{code:e.code??null,name:e.name,message:e.message}};}
finally {
  if(timer)clearTimeout(timer);
  // Preserve live evidence even if adapter execution, acceptance, or a later probe throws.
  if(running&&handle&&ctx) {
    try {const final=await ctx.sessionQuery.readSession(handle.agent.session.id);await writeFile(join(attemptRoot,'session.json'),JSON.stringify(final,null,2));outcome.rawSessionSaved=true;}
    catch(e){outcome.rawSessionSaveFailure={name:e.name,message:e.message};outcome.ok=false;}
  }
  if(mode==='--repair-run') {
    try {assert.equal(hash(await readFile(planPath)),planHash,'PLAN_CHANGED_DURING_RUN');assert.deepEqual(Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,hash(await readFile(join(pluginRoot,f)))]))),plan.sourceHashes,'SOURCE_CHANGED_DURING_RUN');outcome.frozenSourcesUnchanged=true;}
    catch(e){outcome.frozenSourcesUnchanged=false;outcome.ok=false;outcome.freezeFailure={name:e.name,message:e.message};}
  }
  if(handle){try{await handle.dispose();}catch(e){outcome.agentCleanupFailure=e.message;outcome.ok=false;}}
  if(ctx){try{await ctx.fiber.dispose();}catch(e){outcome.cleanupFailure=e.message;outcome.ok=false;}}
  if(repair) {
    try {assert.deepEqual(await readFile(legacyLedgerPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;}),legacyLedgerBytes,'legacy ledger must remain immutable');outcome.legacyLedgerUnchanged=true;}catch(e){outcome.ok=false;outcome.legacyLedgerUnchanged=false;outcome.failure={name:e.name,message:e.message};}
  }
  await mkdir(attemptRoot,{recursive:true});await writeFile(join(attemptRoot,'result.json'),JSON.stringify(outcome,null,2));
  if(running&&ledgerAdmitted) {ledger[number-1]={...ledger[number-1],status:outcome.ok?'passed':'failed',endedAt:new Date().toISOString(),resultPath:join(attemptRoot,'result.json'),failure:outcome.failure??null};await writeFile(ledgerPath,JSON.stringify(ledger,null,2));}
}
// Exit only this isolated harness after natural idle/cleanup; never the user's Desktop Host.
// Stdout is a bounded status summary. Full raw task/probe evidence stays in the owned evidence directory.
const summary={mode,number,scope:outcome.scope,ok:outcome.ok,attemptRoot,pluginVersion:outcome.pluginVersion,modelCalls:outcome.modelCalls??outcome.actualLlmCalls??null,credentialServiceLoaded:outcome.credentialServiceLoaded??running,legacyLedgerUnchanged:outcome.legacyLedgerUnchanged??null,failure:outcome.failure?{name:outcome.failure.name,code:outcome.failure.code??null}:null,resultPath:join(attemptRoot,'result.json'),activeResourcesAfterDispose:process.getActiveResourcesInfo()};
await new Promise(resolve=>process.stdout.write(JSON.stringify(summary,null,2)+'\n',resolve));
process.exit(outcome.ok?0:1);
