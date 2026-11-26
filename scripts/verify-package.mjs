#!/usr/bin/env node
// Prove the shipped patch really composes in the installed DSH version. Dump
// config exits before mounting plugins: no Web listener, credential or model call.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)), pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const cli=process.argv[2] || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
if(!existsSync(cli)) throw Error('请把与桌面版本匹配的 DSH CLI 的绝对路径作为参数传入。');
const parent=await realpath(tmpdir()), temp=await mkdtemp(path.join(parent,'dsh-router-verify-'));
try {
  const profile=path.join(temp,'profiles','web');await mkdir(path.join(profile,'node_modules'),{recursive:true});
  const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',DSH_HOME:temp,HOME:temp,TMPDIR:parent};
  const run=args=>{
    const r=spawnSync(cli,args,{cwd:temp,env,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
    if(r.status!==0)throw Error('DSH '+args.join(' ')+' failed: '+(r.error?.message || r.stderr.slice(-1500)));
    return r.stdout;
  };
  assert.equal(run(['--version']).trim(),pkg.engines.dsh);
  await symlink(root,path.join(profile,'node_modules',pkg.name),'dir');
  await writeFile(path.join(profile,'package.json'), JSON.stringify({name:'router-verification',private:true,dependencies:{[pkg.name]:'link:'+root},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',pkg.name]}}}));
  const dump=run(['--profile','web','--dump-config']);
  assert.ok(dump.includes('personal-session-router') && dump.includes(pkg.name),'The plugin must appear in the composed profile');
  console.log('OK: isolated DSH '+pkg.engines.dsh+' composed the router with the actual Web profile. No server started.');
} finally {
  // Only remove our own fresh mkdtemp directory directly under the OS temp root.
  if(path.dirname(temp)!==parent || !path.basename(temp).startsWith('dsh-router-verify-') || await realpath(temp)!==temp) throw Error('临时目录身份不符，拒绝清理。');
  await rm(temp,{recursive:true,force:true});
}
