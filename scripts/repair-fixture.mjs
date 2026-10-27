import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixture, PUBLIC_TEST } from './fixture.mjs';
import { accept } from './acceptance.mjs';

export const REPAIR_SCOPE = 'repair-20261026';
export const REPAIR_ACCEPTANCE = Object.freeze({
  originalIndependentChecks:57, restockIndependentAcceptance:true, publicTestsUnmodified:true,
  publicTestsExitZero:true, effectiveReminder:true, validCheckpoint:true, replacement:true,
  laterActualModelRequest:true, nativeRecoverReadProbe:true, probeIsNotModelRecall:true,
  formalConfigurationUnchanged:true, watermarkChars:24000, maxModelRuns:1, stage2Paused:true,
});
export const REPAIR_USER_INSTRUCTION = '修复这个仓库的两条仓储 CSV 业务流。先阅读 README.md、docs/contract.md、docs/examples.json、docs/restock-contract.md、docs/restock-examples.json，以及 src、data 和 test 中的现有实现与测试。订单导入与补货接收必须共享 src/csv.mjs 的 parseCsv，按照各自合同处理真实 CSV 引号、换行、严格数值、批次原子性和规范重复/冲突；补货只能增加库存，不能重放重复补货。保持公开 API 和公共测试字节不变，不加依赖，不把不同业务流程合并成一次大重写。先理解并修复共享解析及订单流，再完成补货流，检查两条流在同一个 store 上的交互。补充必要边界回归，更新必要说明并递增样例工程版本，运行全部公共测试。最后说明实际改动和验证结果；不要改测试来迎合实现，也不要制造执行记录。';

const contract = `# Restock CSV receiving contract

## Purpose and shared boundary
The same warehouse exports sales orders and inbound receiving slips. Repair both business flows, not a CSV demonstration. The existing orders contract remains authoritative for orders. Receiving must import parseCsv from ./csv.mjs, the exact shared CSV parser used by importer.mjs; do not maintain a second parser. Public receiving API: importRestocks(text, store) -> { received, skipped }. It is synchronous and uses only caller-owned Maps. Store.stock already contains known SKU inventory; Store.restocks is a Map recording applied receiving slips. Existing orders and their insertion order must remain untouched by receiving. No dependency, network, clock, random ID, persistence or global state is needed.

## CSV boundary
Header: restock_id,sku,quantity,note, exactly four columns in that order. An optional initial UTF-8 BOM belongs to the CSV transport, not the first header field. Empty input and the exact header alone are no-op batches. LF and CRLF row endings are accepted. Quotes must follow the common orders CSV grammar: quoted commas and physical line breaks are part of a field; a doubled quote is one literal quote; unmatched, stray, or trailing text after a closing quote rejects the whole batch. Preserve the exact note, including leading/trailing spaces and embedded CRLF. A final row ending does not create a phantom receiving slip. A nonempty data row must contain exactly four fields. A different header, missing cell, extra cell or malformed quoting is an error, not a partial import or silent skip.

## Identity and quantity
Trim only restock_id and sku. Both must be nonempty after trimming; matching is case-sensitive. SKU must exist in stock even when a row reuses an already applied restock ID. Quantity is a full decimal digit string representing a strictly positive safe integer. Leading zeros are permitted and normalize numerically, so 02 and 2 describe the same quantity. Do not trim quantity. Reject empty, zero (including 000), negative, plus sign, spaces, exponent notation, fractions, trailing junk and values above Number.MAX_SAFE_INTEGER. Validation must not use permissive parseInt or truncate fractional values.

A new receiving record has the exact public value { restockId, sku, quantity, note }, with normalized identity strings, numeric quantity, and verbatim note. Preserve those field meanings; business code may organize validation differently. Every touched current stock value must be a nonnegative safe integer. The resulting per-SKU stock must remain safe after all distinct slips in this batch are added. Check aggregate overflow, not just one row at a time. Reject overflow before any mutation. Multiple receiving slips for the same SKU are allowed.

## Idempotence and conflict
A restock ID names one immutable receiving payload: normalized sku, normalized numeric quantity, verbatim note. An identical normalized ID and payload already in restocks is skipped and must not increase stock again. Identical duplicates within this batch receive once and report every additional row skipped.  R1 , tea ,02,box and R1,tea,2,box are equivalent; changing note whitespace is not equivalent. A duplicate with a different SKU, quantity, or note is a conflict, whether it disagrees with an existing record or an earlier row in this batch. Reject the entire batch. Validate duplicate rows before skipping: invalid or unknown-SKU rows must still fail even when their ID exists. Distinct IDs are new slips even when the payloads otherwise match.

## Transaction boundary and order
Validate and stage every row and all inventory arithmetic before mutating stock or restocks. If any later row fails, both Maps must retain their original keys, insertion order, values and original value-object identities. Do not insert a speculative slip and roll it back after a later error. On success, insert new restocks in first-occurrence CSV order. Existing entries retain their position and identity; existing stock keys retain their position. Never alter orders. Return counts for input data rows: received counts distinct new slips; skipped counts identical duplicates against either the preexisting store or this batch. Their sum equals the number of valid input rows, including repeated rows. For no-op batches both are zero.

## Workflow exercise and release
The sample restocks represent actual receiving desks, supplier references, damaged-label notes, and multi-line handling instructions. They are small real business records, not a padding corpus. Inspect the orders export and receiving export before changing code. First repair common CSV parsing and order handling under the unchanged orders test, then implement receiving under its unchanged public test. Finally apply receiving and orders to one store: receiving can enable an order that would otherwise exhaust inventory; an identical receiving replay cannot create inventory. Re-run both flows and their duplicate checks. Preserve all shipped public test bytes; additional edge tests are welcome. Update relevant project documentation and increment the sample package version. Report actual command results; a model self-assessment is not acceptance.
`;

export const RESTOCK_CASES = [
  {id:'RCV-101',sku:'tea',quantity:12,note:'Dock A, supplier invoice 8452; sealed cartons.'},
  {id:'RCV-102',sku:'coffee',quantity:7,note:'Receiving clerk wrote "counted twice" on label.'},
  {id:'RCV-103',sku:'cocoa',quantity:9,note:'Cold room delivery\r\nKeep original lot label.'},
  {id:'RCV-104',sku:'rice',quantity:16,note:'  retain these note spaces  '},
  {id:'RCV-105',sku:'tea',quantity:4,note:'Replacement stock for rejected consignment, not a return.'},
  {id:'RCV-106',sku:'coffee',quantity:8,note:'Supplier changed pallet ID; invoice remains 8459.'},
  {id:'RCV-107',sku:'cocoa',quantity:3,note:'Verify seal before shelf transfer.'},
  {id:'RCV-108',sku:'rice',quantity:11,note:'Dispatch desk B\nSecond signature required.'},
];
const quote = value => /[",\n\r]/.test(value) ? '"'+value.replaceAll('"','""')+'"' : value;
export const restockCsv = (rows=RESTOCK_CASES) => '\ufeffrestock_id,sku,quantity,note\r\n'+rows.map(r=>[r.id,r.sku,String(r.quantity),r.note].map(quote).join(',')).join('\r\n')+'\r\n';

export const PUBLIC_RESTOCK_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importRestocks } from '../src/restock.mjs';
import { importOrders } from '../src/importer.mjs';
const sample=await readFile(new URL('../data/restocks.csv',import.meta.url),'utf8');
const store=()=>({stock:new Map([['tea',10],['coffee',20],['cocoa',30],['rice',40]]),restocks:new Map(),orders:new Map()});
const header='restock_id,sku,quantity,note\\n';
const row=(id='r1',q='2',note='counted',sku='tea')=>[id,sku,q,note].join(',');
const snapshot=s=>JSON.stringify([[...s.stock],[...s.restocks],[...s.orders]]);
test('receiving export preserves quoted notes and replay does not add inventory',()=>{const s=store();assert.deepEqual(importRestocks(sample,s),{received:8,skipped:0});assert.equal(s.stock.get('tea'),26);assert.equal(s.stock.get('coffee'),35);assert.equal(s.stock.get('cocoa'),42);assert.equal(s.stock.get('rice'),67);assert.equal(s.restocks.get('RCV-102').note,'Receiving clerk wrote "counted twice" on label.');assert.equal(s.restocks.get('RCV-103').note,'Cold room delivery\\r\\nKeep original lot label.');assert.equal(s.restocks.get('RCV-104').note,'  retain these note spaces  ');const before=snapshot(s);assert.deepEqual(importRestocks(sample,s),{received:0,skipped:8});assert.equal(snapshot(s),before);});
test('normalized duplicates receive once with numeric leading-zero equivalence',()=>{const s=store();assert.deepEqual(importRestocks(header+row(' r1 ','02')+'\\n'+row('r1','2'),s),{received:1,skipped:1});assert.deepEqual(s.restocks.get('r1'),{restockId:'r1',sku:'tea',quantity:2,note:'counted'});assert.equal(s.stock.get('tea'),12);assert.deepEqual(importRestocks(header+row(' r1 ','0002'),s),{received:0,skipped:1});});
test('strict receiving quantity rejects every permissive numeric representation',()=>{for(const q of ['','0','000','-1','+1','1.0','1e2','2x',' 2','2 ','9007199254740992']){const s=store(),before=snapshot(s);assert.throws(()=>importRestocks(header+row('first')+'\\n'+row('bad',q),s),q);assert.equal(snapshot(s),before,q);}});
test('all duplicates validate unknown SKU and invalid quantity before skipping',()=>{const s=store();importRestocks(header+row(),s);const before=snapshot(s);for(const source of [header+row('r1','0'),header+row('r1','2','counted','missing')]){assert.throws(()=>importRestocks(source,s));assert.equal(snapshot(s),before);}});
test('conflicts against existing and current-batch IDs reject atomically',()=>{for(const rows of [row('r1')+'\\n'+row('r1','3'),row('r1')+'\\n'+row('r1','2','different'),row('r1')+'\\n'+row('r1','2','counted','coffee')]){const s=store(),before=snapshot(s);assert.throws(()=>importRestocks(header+rows,s));assert.equal(snapshot(s),before);}const s=store();importRestocks(header+row(),s);const original=s.restocks.get('r1'),before=snapshot(s);assert.throws(()=>importRestocks(header+row('new')+'\\n'+row('r1','3'),s));assert.equal(snapshot(s),before);assert.equal(s.restocks.get('r1'),original);});
test('aggregate safe-integer overflow rejects before applying a valid first slip',()=>{const s=store();s.stock.set('tea',Number.MAX_SAFE_INTEGER-3);const before=snapshot(s);assert.throws(()=>importRestocks(header+row('a','2')+'\\n'+row('b','2'),s));assert.equal(snapshot(s),before);});
test('header, field counts and malformed CSV reject without partial mutation',()=>{for(const source of ['id,sku,quantity,note\\n'+row(),header+'x,tea,2',header+'x,tea,2,n,extra',header+'x,tea,2,"unterminated',header+'x,tea,2,a"b',header+'x,tea,2,"a"z',header+row(' '),header+row('a','2','n',' ')]){const s=store(),before=snapshot(s);assert.throws(()=>importRestocks(source,s));assert.equal(snapshot(s),before);}});
test('empty and header-only receiving inputs are no-op batches',()=>{for(const source of ['',header,'\\ufeffrestock_id,sku,quantity,note\\r\\n']){const s=store(),before=snapshot(s);assert.deepEqual(importRestocks(source,s),{received:0,skipped:0});assert.equal(snapshot(s),before);}});
test('success preserves Map order and existing objects, note whitespace is payload',()=>{const s=store();const saved={restockId:'old',sku:'rice',quantity:1,note:'old note'};s.restocks.set('old',saved);assert.deepEqual(importRestocks(header+' b , tea ,2," n "\\n'+'a,coffee,3,n\\n'+'b,tea,02," n "',s),{received:2,skipped:1});assert.deepEqual([...s.restocks.keys()],['old','b','a']);assert.deepEqual([...s.stock.keys()],['tea','coffee','cocoa','rice']);assert.equal(s.restocks.get('old'),saved);const before=snapshot(s);assert.throws(()=>importRestocks(header+'b,tea,2,n',s));assert.equal(snapshot(s),before);});
test('orders and receiving share inventory but never mutate each other journals',()=>{const s=store();s.stock.set('tea',1);importRestocks(header+row('shipment','4'),s);const receipt=s.restocks.get('shipment');assert.deepEqual(importOrders('order_id,sku,quantity,unit_price,note\\norder-a,tea,4,0.29,"paid, exact"',s),{imported:1,skipped:0});assert.equal(s.stock.get('tea'),1);assert.equal(s.orders.get('order-a').totalCents,116);assert.equal(s.restocks.get('shipment'),receipt);const order=s.orders.get('order-a');assert.deepEqual(importRestocks(header+row('shipment','4'),s),{received:0,skipped:1});assert.equal(s.stock.get('tea'),1);assert.equal(s.orders.get('order-a'),order);});
`;

export async function createRepairFixture(root) {
  const original = await createFixture(root);
  const files = {
    'docs/restock-contract.md':contract,
    'docs/restock-examples.json':JSON.stringify(RESTOCK_CASES,null,2)+'\n',
    'data/restocks.csv':restockCsv(),
    'src/restock.mjs':`import { parseCsv } from './csv.mjs';
export function importRestocks(text, store) {
  let received=0, skipped=0;
  for(const [restockId,sku,q,note] of parseCsv(text).slice(1)) {
    if(store.restocks.has(restockId)){skipped++;continue;}
    const quantity=parseInt(q);
    if(!store.stock.has(sku))throw new Error('unknown sku');
    store.stock.set(sku,store.stock.get(sku)+quantity);
    store.restocks.set(restockId,{restockId,sku,quantity,note});
    received++;
  }
  return {received,skipped};
}
`,
    'test/restock.test.mjs':PUBLIC_RESTOCK_TEST,
  };
  for(const [name,content] of Object.entries(files)) await writeFile(join(root,name),content,'utf8');
  return {...original,scope:REPAIR_SCOPE,files:[...original.files,...Object.keys(files)],businessFlows:['orders','receiving'],padding:false,acceptance:REPAIR_ACCEPTANCE};
}

export async function acceptRestockFlow(root) {
  const {importRestocks}=await import(pathToFileURL(join(root,'src/restock.mjs')).href);
  const {importOrders}=await import(pathToFileURL(join(root,'src/importer.mjs')).href);
  let checks=0;
  const store=()=>({stock:new Map([['tea',11],['coffee',13],['cocoa',17],['rice',19]]),restocks:new Map(),orders:new Map([['retained',{orderId:'retained',note:'existing order object'}]])});
  const snapshot=s=>JSON.stringify([[...s.stock],[...s.restocks],[...s.orders]]);
  const h='restock_id,sku,quantity,note\n';
  const s=store(),oldOrder=s.orders.get('retained');
  assert.deepEqual(importRestocks(restockCsv(),s),{received:8,skipped:0});checks++;
  const expectedStock={tea:27,coffee:28,cocoa:29,rice:46};
  for(const [sku,value] of s.stock) {assert.equal(value,expectedStock[sku]);checks++;}
  for(const r of RESTOCK_CASES) {assert.deepEqual(s.restocks.get(r.id),{restockId:r.id,sku:r.sku,quantity:r.quantity,note:r.note});checks++;}
  assert.equal(s.orders.get('retained'),oldOrder);checks++;
  const before=snapshot(s);assert.deepEqual(importRestocks(restockCsv(),s),{received:0,skipped:8});assert.equal(snapshot(s),before);checks++;
  const duplicate=store();assert.deepEqual(importRestocks(h+' x , tea ,0003,"  a\r\nb, c"\nx,tea,3,"  a\r\nb, c"',duplicate),{received:1,skipped:1});assert.equal(duplicate.restocks.get('x').note,'  a\r\nb, c');checks++;
  for(const line of ['bad,tea,,n','bad,tea,0,n','bad,tea,000,n','bad,tea,-2,n','bad,tea,+2,n','bad,tea, 2,n','bad,tea,2 ,n','bad,tea,2e1,n','bad,tea,2.0,n','bad,tea,2x,n','bad,tea,9007199254740992,n','bad,missing,2,n',',tea,2,n','bad, ,2,n','bad,tea,2','bad,tea,2,n,extra']) {
    const st=store(),old=st.orders.get('retained'),snap=snapshot(st);
    assert.throws(()=>importRestocks(h+'valid,coffee,2,n\n'+line,st));assert.equal(snapshot(st),snap);assert.equal(st.orders.get('retained'),old);checks++;
  }
  for(const tail of ['x,tea,4,n','x,coffee,3,n','x,tea,3,changed']) {
    const st=store(),snap=snapshot(st);assert.throws(()=>importRestocks(h+'x,tea,3,n\n'+tail,st));assert.equal(snapshot(st),snap);checks++;
  }
  const stored=store();const value={restockId:'x',sku:'tea',quantity:3,note:'n'};stored.restocks.set('x',value);
  assert.deepEqual(importRestocks(h+' x , tea ,03,n',stored),{received:0,skipped:1});checks++;
  for(const tail of ['x,tea,4,n','x,coffee,3,n','x,tea,3,changed','x,missing,3,n','x,tea,0,n']) {
    const snap=snapshot(stored);assert.throws(()=>importRestocks(h+'fresh,rice,2,n\n'+tail,stored));assert.equal(snapshot(stored),snap);assert.equal(stored.restocks.get('x'),value);checks++;
  }
  for(const initial of [Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER-4]) {
    const st=store();st.stock.set('tea',initial);const snap=snapshot(st);assert.throws(()=>importRestocks(h+'a,tea,3,n\nb,tea,2,n',st));assert.equal(snapshot(st),snap);checks++;
  }
  const edge=store();edge.stock.set('tea',Number.MAX_SAFE_INTEGER-2);assert.deepEqual(importRestocks(h+'edge,tea,2,n',edge),{received:1,skipped:0});assert.equal(edge.stock.get('tea'),Number.MAX_SAFE_INTEGER);checks++;
  for(const source of ['',h,'\ufeffrestock_id,sku,quantity,note\r\n']) {const st=store(),snap=snapshot(st);assert.deepEqual(importRestocks(source,st),{received:0,skipped:0});assert.equal(snapshot(st),snap);checks++;}
  for(const source of ['wrong,sku,quantity,note\nx,tea,1,n',h+'x,tea,2,"broken',h+'x,tea,2,n"o',h+'x,tea,2,"n"q']) {const st=store(),snap=snapshot(st);assert.throws(()=>importRestocks(source,st));assert.equal(snapshot(st),snap);checks++;}
  const order=store();const saved={restockId:'old',sku:'rice',quantity:1,note:'n'};order.restocks.set('old',saved);assert.deepEqual(importRestocks(h+'b,tea,2,n\na,coffee,3,n\nb,tea,02,n',order),{received:2,skipped:1});assert.deepEqual([...order.restocks.keys()],['old','b','a']);assert.deepEqual([...order.stock.keys()],['tea','coffee','cocoa','rice']);assert.equal(order.restocks.get('old'),saved);checks++;
  const mixed=store();mixed.stock.set('tea',0);importRestocks(h+'supply,tea,5,n',mixed);const savedReceipt=mixed.restocks.get('supply');assert.deepEqual(importOrders('order_id,sku,quantity,unit_price,note\nsale,tea,4,1.25,n',mixed),{imported:1,skipped:0});assert.equal(mixed.stock.get('tea'),1);assert.equal(mixed.restocks.get('supply'),savedReceipt);const savedSale=mixed.orders.get('sale');assert.deepEqual(importRestocks(h+'supply,tea,5,n',mixed),{received:0,skipped:1});assert.equal(mixed.stock.get('tea'),1);assert.equal(mixed.orders.get('sale'),savedSale);checks++;
  assert.deepEqual(await readFile(join(root,'test/restock.test.mjs')),Buffer.from(PUBLIC_RESTOCK_TEST),'public receiving tests must remain byte-identical');checks++;
  assert.deepEqual(await readFile(join(root,'test/import.test.mjs')),Buffer.from(PUBLIC_TEST),'public orders tests must remain byte-identical');checks++;
  return {ok:true,checks,publicTestsUnmodified:true,businessFlow:'receiving-and-orders-interaction'};
}

export async function acceptRepair(root) {
  const original=await accept(root);
  assert.equal(original.checks,REPAIR_ACCEPTANCE.originalIndependentChecks,'original independent contract must remain intact');
  const restock=await acceptRestockFlow(root);
  return {ok:true,checks:original.checks+restock.checks,original,restock,publicTestsUnmodified:true};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const mode=process.argv[2],root=process.argv[3];
    if(!['--accept','--accept-restocks'].includes(mode)||!root)throw new Error('USAGE: repair-fixture.mjs --accept|--accept-restocks <isolated-project>');
    console.log(JSON.stringify(await (mode==='--accept'?acceptRepair(root):acceptRestockFlow(root)),null,2));
  } catch(error) {console.error(JSON.stringify({ok:false,name:error.name,message:error.message}));process.exitCode=1;}
}
