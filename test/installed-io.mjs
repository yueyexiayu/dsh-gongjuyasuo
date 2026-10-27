import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installed } from './fixture.mjs';
const [{LocalSpillStore},{default:FsLocal},{WorkingDirectoryService},{SystemPrompt},{ToolRuntime},ToolFs]=await Promise.all([
  installed('dsh-spill-local'),installed('dsh-fs-local'),installed('dsh-working-directory'),installed('dsh-system-prompt'),installed('dsh-tools'),installed('dsh-tool-fs'),
]);

export async function installedIo(f) {
  new SystemPrompt(f.ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});
  new ToolRuntime(f.ctx);new FsLocal(f.ctx,{cwd:f.dir,diffBasisMaxBytes:1000000});new WorkingDirectoryService(f.ctx,{defaultDirectory:f.dir});
  // Explicit root and disabled startup sweep: never inspect or clean production spills.
  new LocalSpillStore(f.ctx,{root:join(f.dir,'real-spills'),cleanupPeriodDays:0});
  ToolFs.apply(f.ctx,{read:true,readImage:false,write:false,edit:false,readLimit:2000,readMaxLineLength:2000,readMaxBytes:1024*1024,readStreamMinSize:1024*1024});
  let serial=0;
  async function read(path,offset=1,limit=2000){
    const result=await f.ctx.tools.execute({name:'read',callId:`real-read-${++serial}`,agent:{ctx:f.ctx,session:f.session},arguments:{file_path:path,offset,limit},signal:new AbortController().signal});
    assert.equal(result.isError,false,JSON.stringify(result));return result;
  }
  return {spill:f.ctx.spillStore,read};
}
