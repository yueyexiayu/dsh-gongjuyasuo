import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture, installed, installedBase, config, llm } from './fixture.mjs';
import { apply } from '../lib/index.js';
const [{ToolRuntime},{NativeToolExecutor},{SystemPrompt},tokenClient]=await Promise.all([
  installed('dsh-tools'),installed('dsh-tool-executor-native'),installed('dsh-system-prompt'),import(installedBase+'dsh-token-meter/lib/types/client.js'),
]);

export async function pluginFixture(t,options={}) {
  const f=await fixture(t,options);
  new SystemPrompt(f.ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});
  const runtime=new ToolRuntime(f.ctx);
  runtime.setExecutor(new NativeToolExecutor(f.ctx));
  const configPath=join(f.dir,'isolated-config.json');
  let current=config(options.settings);
  await writeFile(configPath,JSON.stringify(current));
  const preSteps=[],effects=[],routes=[],warnings=[];
  const pluginContext={
    loader:{async import(name){if(name==='@deepseek-ai/dsh-llm')return llm;if(name==='@deepseek-ai/dsh-token-meter/client')return tokenClient;throw new Error('unexpected module '+name);}},
    tools:runtime,spillStore:f.spill,tokenMeter:f.ctx.tokenMeter,sessionQuery:f.ctx.sessionQuery,
    logger:{warn:text=>warnings.push(text),error:text=>warnings.push(text)},
    on(name,callback,opts){if(name==='agent/pre-step'){preSteps.push(callback);return ()=>{};}return f.ctx.on(name,callback,opts);},
    inject(names,callback){if(names.join(',')!=='connection')throw new Error('unexpected inject');callback({connection:{fetch:{register:route=>routes.push(route)}}});},
    effect(factory){const dispose=factory();effects.push(dispose);return dispose;},
  };
  await apply(pluginContext,{configPath,diagnosticsPath:join(f.dir,'isolated-diagnostics.jsonl')});
  t.after(()=>{for(const dispose of effects.reverse())if(typeof dispose==='function')dispose();});
  let serial=0;
  async function execute(args,{session=f.session,callId=`plugin-call-${++serial}`,persist=true,signal=new AbortController().signal}={}) {
    session.append('tool/call',{turn:1,step:1,callId,name:'gongjuyasuo',arguments:args});
    const batch=await runtime.execute({calls:[{type:'tool-call',id:callId,name:'gongjuyasuo',arguments:JSON.stringify(args)}],agent:{session},signal});
    const result=batch.results[0].result;
    if(persist) {
      const message=llm.freezeMessage({id:`result-${callId}-${session.seq}`,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:result.content,...(result.isError?{isError:true}:{})});
      session.append('tool/result',{turn:1,step:1,message,...(result.meta?{meta:result.meta}:{})},{surfaceOp:'append'});
    }
    return result;
  }
  async function preStep({session=f.session,decision={kind:'enter',messages:[]},signal=new AbortController().signal}={}){
    let next=async()=>decision;
    for(const hook of [...preSteps].reverse()){const previous=next;next=()=>hook({agent:{session},signal},previous);}
    return next();
  }
  return {...f,runtime,execute,preStep,routes,warnings,dispose:()=>effects.forEach(fn=>fn?.()),async setSettings(patch){current={...current,...patch};await writeFile(configPath,JSON.stringify(current));}};
}
