import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { assertSameReadFile } from '../scripts/recovery-path.mjs';

// Real filesystem aliases exercise the same canonicalization as macOS /var -> /private/var.
test('native read accepts a directory-symlink alias of the same recovered file',async t=>{
  const {dir}=await fixture(t);
  const physical=join(dir,'physical'),alias=join(dir,'alias');
  await mkdir(physical);await symlink(physical,alias,'dir');
  const recovered=join(alias,'source.txt'),canonical=join(physical,'source.txt');
  await writeFile(recovered,'保留原文\r\nquoted "note", count=2\n','utf8');
  assert.notEqual(recovered,canonical);
  const identity=await assertSameReadFile(canonical,recovered);
  assert.equal(identity.realPath,await realpath(recovered));
  assert.match(identity.device,/^\d+$/);assert.match(identity.inode,/^\d+$/);
});

test('different regular files are rejected even when every byte is equal',async t=>{
  const {dir}=await fixture(t);
  const recovered=join(dir,'recovered.txt'),other=join(dir,'other.txt');
  const bytes=Buffer.from('identical bytes do not imply file identity\n');
  await writeFile(recovered,bytes);await writeFile(other,bytes);
  assert.deepEqual(await readFile(other),await readFile(recovered));
  await assert.rejects(assertSameReadFile(other,recovered),{code:'ERR_ASSERTION',message:/same canonical recovered file/});
});

test('a missing read or recovery path fails explicitly with ENOENT',async t=>{
  const {dir}=await fixture(t);
  const present=join(dir,'present.txt'),missing=join(dir,'missing.txt');
  await writeFile(present,'present');
  await assert.rejects(assertSameReadFile(missing,present),{code:'ENOENT'});
  await assert.rejects(assertSameReadFile(present,missing),{code:'ENOENT'});
});

test('the same directory is not accepted as a recovered regular file',async t=>{
  const {dir}=await fixture(t);
  await assert.rejects(assertSameReadFile(dir,dir),{code:'ERR_ASSERTION',message:/regular files/});
});
