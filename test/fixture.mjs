import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../lib/core.js';

export const installedBase = 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/';
export const installed = name => import(`${installedBase}${name}/lib/index.js`);
const [{Context}, {SessionStore}, {SessionProjectionRegistry}, {TokenMeter}, {SessionQueryEngine}, llm] = await Promise.all([
  installed('cordis'), installed('dsh-session'), installed('dsh-session-projection'), installed('dsh-token-meter'), installed('dsh-session-query'), installed('dsh-llm'),
]);
export { llm, core };
export const LONG = '证据逐字保留：αβ🙂\r\n第二行\t原始空白尾部\n'.repeat(700);
export const config = overrides => core.settings({thresholdChars:100, recentProtectionRequests:2, minNetReductionChars:100, minTailContributionChars:100, watermarkChars:100, reminderIntervalRequests:2, ...overrides});

export async function fixture(t, options={}) {
  const ctx = new Context();
  new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx, {});
  new SessionQueryEngine(ctx);
  const dir = await mkdtemp(join(tmpdir(), 'gongjuyasuo-tests-'));
  // The only recursive deletion target is the exact directory returned by mkdtemp.
  t.after(async () => { ctx.fiber.dispose(); await rm(dir, {recursive:true, force:true}); });
  const events = [];
  const journals = new Map();
  ctx.on('session/event', (session,event) => {
    events.push({sessionId:session.id,event});
    const j=journals.get(session);
    if(j) core.ingest(j,event);
  }, {global:true});
  const session = ctx.sessions.create(options.id??'mechanism-parent', options.seed ? {seed:options.seed, meta:options.meta??{cwd:dir},...(options.inheritedEventCount===undefined?{}:{inheritedEventCount:options.inheritedEventCount})} : {meta:{cwd:dir,...options.meta}});
  const j = core.makeJournal(session);
  journals.set(session,j);
  if(options.seed) for(const event of (await ctx.sessionQuery.readSession(session.id)).events) core.ingest(j,event);
  let saves=0;
  const spill = {async saveText({content,suggestedName}) {
    const locator=join(dir,`${++saves}-${suggestedName}`);
    await writeFile(locator,content,'utf8');
    return {locator,bytes:Buffer.byteLength(content),retrievalHint:'read the exact local file'};
  }};
  const record = (target,type,data) => target.append('user/message',llm.createUserMessage({
    source:{kind:'plugin:dsh-gongjuyasuo:record',recordType:type,recordData:data},
    content:[{type:'text',text:`工具整理收据 ${type.slice(core.PREFIX.length)}`}],
  }),{surfaceOp:'append'}).seq;
  let callCounter=0, stepCounter=0;
  function tool(text=LONG, opts={}) {
    const callId=`call-${++callCounter}`;
    session.append('tool/call',{turn:1,step:1,callId,name:opts.name??'read',arguments:opts.args??{file_path:'/fixture/source.txt'}});
    const message=llm.freezeMessage({id:`tool-${callCounter}`,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:opts.content??[{type:'text',text}],...(opts.isError?{isError:true}:{}),...(opts.meta?{meta:opts.meta}:{})});
    return session.append('tool/result',{turn:1,step:1,message,...(opts.error?{error:opts.error}:{})},{surfaceOp:'append'});
  }
  function request({reason='stop',interrupted=false,advertise=[],finishCount=1}={}) {
    const step=++stepCounter;
    session.append('step/start',{turn:1,step});
    if(advertise.length) session.append('user/message',llm.createUserMessage({source:{kind:'plugin:dsh-gongjuyasuo:reminder',gongjuyasuoRefs:advertise,candidateKey:core.digest(advertise)},content:[{type:'text',text:`候选索引 ${advertise.join(' ')}`} ]}),{surfaceOp:'append'});
    const message=llm.createAssistantMessage({source:{provider:'test-no-model',model:'deterministic'},content:[{type:'text',text:'固定结论'}]});
    session.append('assistant/message',{turn:1,step,message,interrupted,stream:Array.from({length:finishCount},()=>({type:'chunk',chunk:{type:'finish',reason:{kind:reason}}}))},{surfaceOp:'append'});
    session.append('step/end',{turn:1,step});
  }
  function age(event) { for(let i=0;i<3;i++) request(i===2?{advertise:[core.reference(session.id,event)]}:{}); return core.candidate(j,event.seq,config()); }
  function checkpoint(items, overrides={}) {
    const list=Array.isArray(items)?items:[items];
    return {action:'checkpoint',previousCheckpoint:j.lastCheckpoint?.id??null,state:{subgoal:'验证源事件',nextStep:'继续任务',findings:list.map(c=>({text:'已确认固定证据',refs:[c.ref]})),constraints:['逐字保存'],changes:'无源码改动',validation:'确定性机制测试',unresolved:[],hypotheses:[]},covered:list.map(c=>({ref:c.ref,conclusion:'原文结论已吸收',evidenceQuote:c.text.slice(0,40),noLongerDirectlyNeeded:true})),retain:[],resolvedIssues:[],...overrides};
  }
  function queue(cp) { const data={...cp,id:`cp:test-${session.seq}`}; const seq=record(session,core.PREFIX+'checkpoint',data); return {seq,...data}; }
  return {ctx,session,j,events,dir,spill,record,tool,request,age,checkpoint,queue,journals,saves:()=>saves,readFile};
}

export function code(expected) {return error=>error.code===expected;}
export async function commit(f, cp, cfg=config(), spill=f.spill, signal=new AbortController().signal) {
  const prepared=await core.prepareBatch(f.j,cp,cfg,spill,signal);
  const result=core.commitBatch(f.j,cp,prepared,cfg,f.ctx.tokenMeter,f.record,llm.freezeMessage,signal);
  return {prepared,result};
}
export function assertMeter(assert, f) {
  const measured=f.ctx.tokenMeter.measure(f.session);
  const expected=f.session.deriveMessages().reduce((sum,message)=>sum+f.ctx.tokenMeter.estimateMessage(message),0);
  assert.equal(measured.surfaceTokens,expected);
  const pressure=f.ctx.sessionProjections.stateOf(f.session,'contextPressure');
  const breakdown=f.ctx.sessionProjections.stateOf(f.session,'contextBreakdown');
  assert.equal(pressure.surfaceTokens,expected);
  assert.equal(breakdown.surfaceTokens,expected);
  return measured;
}
