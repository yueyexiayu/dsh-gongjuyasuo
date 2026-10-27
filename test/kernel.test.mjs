import test from 'node:test';
import assert from 'node:assert/strict';
import { installed, installedBase, fixture, llm, core, commit, config } from './fixture.mjs';
import * as Plugin from '../lib/index.js';
import { join } from 'node:path';

const [{AgentRegistry},{LlmRuntime},{SystemPrompt},{ToolRuntime},{AgentLoop},{default:FsLocal},{WorkingDirectoryService},{SubagentRuntime},Spawn,Fork,client]=await Promise.all([
  installed('dsh-agent'),installed('dsh-llm'),installed('dsh-system-prompt'),installed('dsh-tools'),installed('dsh-agent-loop'),installed('dsh-fs-local'),installed('dsh-working-directory'),installed('dsh-subagent'),installed('dsh-subagent-spawn-in-process'),installed('dsh-subagent-fork-in-process'),import(installedBase+'dsh-token-meter/lib/types/client.js'),
]);

test('real Cordis plugin and AgentLoop expose gongjuyasuo to actual spawn and fork; zero model calls',async t=>{
  const f=await fixture(t),ctx=f.ctx;
  new AgentRegistry(ctx);new LlmRuntime(ctx);new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});new ToolRuntime(ctx);
  new FsLocal(ctx,{cwd:f.dir,diffBasisMaxBytes:1000000});new WorkingDirectoryService(ctx,{});
  new AgentLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>10}});
  new SubagentRuntime(ctx,{maxDepth:{get:()=>1},maxActiveSubagents:{get:()=>8}});
  Spawn.apply(ctx,{providerName:'spawn'});Fork.apply(ctx,{providerName:'fork'});
  ctx.provide('loader',{import:spec=>spec==='@deepseek-ai/dsh-token-meter/client'?client:installed(spec.replace('@deepseek-ai/',''))});
  let spillWrites=0,modelCalls=0;
  ctx.provide('spillStore',{saveText(){spillWrites++;throw new Error('kernel exposure test must never write spill');}});
  ctx.on('llm/stream',()=>{modelCalls++;throw new Error('kernel exposure test must never request a model');},{global:true,prepend:true});
  await ctx.plugin(Plugin,{diagnosticsPath:join(f.dir,'kernel-diagnostics.jsonl')});
  const observed=[];
  // Register last and prepend: run the plugin's real inner pre-step first, then
  // reject outside it, before AgentLoop can select/call any model adapter.
  ctx.on('agent/pre-step',async(info,next)=>{
    const decision=await next();
    const result=await ctx.tools.execute({name:'gongjuyasuo',callId:`kernel-${info.agent.session.id}`,agent:info.agent,arguments:{action:'inspect'},signal:info.signal});
    const snapshot=await ctx.sessionQuery.readSession(info.agent.session.id);
    observed.push({id:info.agent.session.id,parent:info.agent.session.header.parentSession,isSeeded:info.agent.session.header.isSeeded,inherited:snapshot.inheritedEventCount,schemas:ctx.tools.schemas(info.agent).map(x=>x.name),result,decision});
    return {kind:'reject',reason:'deterministic test: forbid real model'};
  },{global:true,prepend:true});
  const parent=await ctx.agents.create({sessionId:'kernel-parent',meta:{cwd:f.dir}});
  const receipts=[];
  t.after(()=>{for(const receipt of receipts.reverse())receipt.dispose();parent.dispose();});
  parent.agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'balanced parent seed; no model'}]}));await parent.agent.whenIdle();
  for(const provider of ['spawn','fork']) {
    const receipt=await ctx.subagents.startActivation({provider,label:`kernel-${provider}`,request:{parent:parent.agent,cwd:f.dir,prompt:[{type:'text',text:'inspect exposure; no model'}]},signal:new AbortController().signal,delivery:'caller'});
    receipts.push(receipt);await receipt.result;
    assert.equal(ctx.agents.get(receipt.childId),undefined,'completed caller-delivery child tears down');
  }
  assert.equal(observed.length,3);
  for(const row of observed){assert.ok(row.schemas.includes('gongjuyasuo'));assert.equal(row.result.isError,false);assert.equal(row.result.value.ok,true);assert.equal(row.decision.kind,'enter');}
  const children=observed.filter(x=>x.parent==='kernel-parent');assert.equal(children.length,2);
  assert.equal(children.find(x=>!x.isSeeded).inherited,0);assert.ok(children.find(x=>x.isSeeded).inherited>0);
  assert.equal(spillWrites,0);assert.equal(modelCalls,0);assert.equal(ctx.get('sessionPersistence'),undefined);
});

test('fork recovers a parent ref into child-owned storage without replaying inherited checkpoints',async t=>{
  const f=await fixture(t),c=f.age(f.tool()),cp=f.queue(f.checkpoint(c));assert.equal((await commit(f,cp)).result.successful.length,1);
  const {events}=await f.ctx.sessionQuery.readSession(f.session.id);
  const child=await fixture(t,{id:'fork-recovery-child',seed:events,meta:{cwd:f.dir,parentSession:f.session.id,isSeeded:true,origin:'subagent'},inheritedEventCount:events.length});
  assert.equal(child.j.pending.length,0);assert.equal(child.j.finished.size,0);assert.equal(child.j.batches.size,1);
  let owner;
  const spill={async saveText(input){owner=input.owner;return child.spill.saveText(input);}};
  const recovered=await core.recover(child.j,c.ref,spill,child.record);
  assert.equal(owner.sessionId,child.session.id);assert.equal(await child.readFile(recovered.path,'utf8'),c.text);
  assert.equal(core.candidates(child.j,config()).eligible.length,0);
});
