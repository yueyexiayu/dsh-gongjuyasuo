import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { CASES, csv } from './fixture.mjs';
export async function accept(root) {
  const {parseCsv}=await import(pathToFileURL(join(root,'src/csv.mjs')).href);
  const {importOrders}=await import(pathToFileURL(join(root,'src/importer.mjs')).href);
  let checks=0;
  const store=()=>({orders:new Map(),stock:new Map([['tea',1000],['coffee',1000],['cocoa',1000],['rice',1000]])});
  const s=store();assert.deepEqual(importOrders(csv(),s),{imported:28,skipped:0});checks++;
  for(const c of CASES) {
    const [a,b='']=c.price.split('.'),cents=Number(a)*100+Number(b.padEnd(2,'0'));
    assert.deepEqual(s.orders.get(c.id),{orderId:c.id,sku:c.sku,quantity:c.quantity,unitPriceCents:cents,totalCents:c.quantity*cents,note:c.note});checks++;
  }
  for(const [sku,left] of s.stock) {assert.equal(left,1000-CASES.filter(c=>c.sku===sku).reduce((n,c)=>n+c.quantity,0));checks++;}
  const snapshot=JSON.stringify([[...s.orders],[...s.stock]]);assert.deepEqual(importOrders(csv(),s),{imported:0,skipped:28});assert.equal(JSON.stringify([[...s.orders],[...s.stock]]),snapshot);checks++;
  const header='order_id,sku,quantity,unit_price,note\n';
  for(const line of ['x,tea,2x,1.25,n','x,tea,0,1.25,n','x,tea,1.0,1.25,n','x,tea,1e2,1.25,n','x,tea,9007199254740992,1.25,n','x,tea,2,1.234,n','x,tea,2,1e2,n','x,tea,2,1.,n','x,tea,2, 1.25,n','x,missing,2,1.25,n',',tea,2,1.25,n','x,tea,2,1.25,n,extra','x,tea,9007199254740991,1.25,n']) {
    const st=store(),before=JSON.stringify([[...st.orders],[...st.stock]]);
    assert.throws(()=>importOrders(header+'first,tea,2,1.25,n\n'+line,st));assert.equal(JSON.stringify([[...st.orders],[...st.stock]]),before);checks++;
  }
  for(const source of [header+'x,tea,600,1.00,n\ny,tea,600,1.00,n',header+'x,tea,2,1.00,n\nx,tea,3,1.00,n']) {const st=store();assert.throws(()=>importOrders(source,st));assert.equal(st.orders.size,0);assert.equal(st.stock.get('tea'),1000);checks++;}
  const st=store();assert.deepEqual(importOrders(header+' x , tea ,2,0.29," a\r\nb "\nx,tea,2,0.29," a\r\nb "',st),{imported:1,skipped:1});assert.equal(st.orders.get('x').totalCents,58);assert.equal(st.orders.get('x').note,' a\r\nb ');checks++;
  const old=JSON.stringify([[...st.orders],[...st.stock]]);assert.throws(()=>importOrders(header+'x,tea,3,0.29," a\r\nb "',st));assert.equal(JSON.stringify([[...st.orders],[...st.stock]]),old);checks++;
  assert.deepEqual(parseCsv('\ufeffa,b\r\n"x,y","a""b"\r\n'),[['a','b'],['x,y','a"b']]);checks++;
  for(const source of ['a,"x','a,b"c','a,"x"z']){assert.throws(()=>parseCsv(source));checks++;}
  assert.deepEqual(importOrders('',store()),{imported:0,skipped:0});assert.deepEqual(importOrders(header,store()),{imported:0,skipped:0});checks++;
  const original=await readFile(join(root,'test/import.test.mjs'),'utf8');
  const {PUBLIC_TEST}=await import('./fixture.mjs');assert.equal(original,PUBLIC_TEST,'public tests must not be edited to pass');checks++;
  return {ok:true,checks,publicTestsUnmodified:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(await accept(process.argv[2]),null,2));}catch(e){console.error(e.stack);process.exitCode=1;}
}
