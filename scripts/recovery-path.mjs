import assert from 'node:assert/strict';
import { realpath, stat } from 'node:fs/promises';

// Native read canonicalizes paths; recover may retain a macOS /var alias.
// Equal contents alone do not prove that read observed the recovered file.
export async function assertSameReadFile(readPath, recoveredPath) {
  const [readRealPath,recoveredRealPath,readStat,recoveredStat]=await Promise.all([
    realpath(readPath),realpath(recoveredPath),
    stat(readPath,{bigint:true}),stat(recoveredPath,{bigint:true}),
  ]);
  assert.ok(readStat.isFile()&&recoveredStat.isFile(),'native read and recovery paths must both resolve to regular files');
  assert.equal(readRealPath,recoveredRealPath,'native read must resolve the same canonical recovered file');
  assert.equal(readStat.dev,recoveredStat.dev,'native read must use the recovered file device');
  assert.equal(readStat.ino,recoveredStat.ino,'native read must use the recovered file inode');
  return {realPath:readRealPath,device:readStat.dev.toString(),inode:readStat.ino.toString()};
}
