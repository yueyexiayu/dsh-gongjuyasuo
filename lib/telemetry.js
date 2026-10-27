import { normalizeReportedUsage } from './observability.js';
export function observeStream(options,next,{emit,initiator,sessionId,configHash}) {
  return (async function*(){
    const start=performance.now();let usage,finish,finishes=0,firstTokenMs=null,thrown=false;
    try {
      for await(const chunk of next()) {
        if(chunk.type==='usage') usage=chunk.usage;
        if(chunk.type==='finish'){finish=chunk.reason.kind;finishes++;}
        if(firstTokenMs===null&&['text-delta','reasoning-delta','tool-call-delta'].includes(chunk.type))firstTokenMs=performance.now()-start;
        yield chunk;
      }
    } catch(e) {thrown=true;throw e;}
    finally {
      // Provider samples are cumulative snapshots; one settled observation per actual stream.
      emit({kind:'llm-call',sessionId:options.sessionId??sessionId??null,initiatorSessionId:initiator?.id??null,parentSessionId:initiator?.header?.parentSession??null,provider:options.provider,model:options.model,configHash,finish:finish??null,finishCount:finishes,thrown,reportedUsage:usage??null,exactUsage:normalizeReportedUsage(usage),wallMs:performance.now()-start,firstTokenMs,toolNames:(options.tools??[]).map(t=>t.name),toolSchemaChars:JSON.stringify(options.tools??[]).length,messageCount:options.messages.length,attribution:options.sessionId?'explicit-session':sessionId?'inherited-initiator':'unattributed'});
    }
  })();
}
