import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReleaseController, type ReleaseConfig } from '../../src/releases/controller.js';
import { protectedPath, riskyStorageDiff, ReviewRequired } from '../../src/releases/policy.js';
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function setup(journal:unknown){
 const dir=await mkdtemp(path.join(os.tmpdir(),'gengar-release-test-'));dirs.push(dir);
 const config={dir,cwd:dir,baselineCommit:'base',baselineDeployment:'old'} as ReleaseConfig;
 await writeFile(path.join(dir,'journal.json'),JSON.stringify(journal));
 const controller=new ReleaseController(config) as any;
 controller.refresh=vi.fn(async()=>{});
 controller.assertSourceHead=vi.fn(async()=>{});
 controller.git=vi.fn(async(args:string[])=>args[0]==="rev-parse"&&args[1]==="HEAD"?"base":args[0]==="symbolic-ref"?"family/discord":"");
 return {controller,dir,journal:async()=>JSON.parse(await readFile(path.join(dir,'journal.json'),'utf8'))};
}
describe('release policy',()=>{
 it('allows ordinary changes and new games but protects release machinery and existing tests',()=>{
  for(const file of ['src/games/pizza/Pizza.tsx','src/games/new-game/index.ts','src/app/games.ts','public/balloon.svg','release-checks/new-game.json'])expect(protectedPath(file,false)).toBe(false);
  for(const file of ['package.json','package-lock.json','.gitignore','scripts/gameplay-gate.mjs','public/sw.js','public/_redirects','src/main.tsx','src/platform/storage.ts','src/games/pizza/storage.ts','src/games/pizza/foo.test.ts','src/.env','src/.codex/config.toml'])expect(protectedPath(file,true)).toBe(true);
 });
 it('recognizes changed storage keys, stores, and destructive local storage operations',()=>{
  expect(riskyStorageDiff('+const STORAGE_VERSION = 2')).toBe(true);
  expect(riskyStorageDiff('-const save = createStore("pizza", 1)')).toBe(true);
  expect(riskyStorageDiff('+localStorage.clear()')).toBe(true);
  expect(riskyStorageDiff('+const pizzaColor = "red"')).toBe(false);
 });
 it('refuses symlinks and protected edits before running candidate code',async()=>{
  const {controller}=await setup({current:{commit:'base',deployment:'old'}});
  controller.git=vi.fn(async(args:string[])=>args[0]==='diff-tree'?'M\tpackage.json':'');
  await expect(controller.guard('candidate','base')).rejects.toBeInstanceOf(ReviewRequired);
  controller.git=vi.fn(async(args:string[])=>args[0]==='ls-tree'?'120000 blob abc\tsrc/link':'');
  await expect(controller.guard('candidate','base')).rejects.toBeInstanceOf(ReviewRequired);
 });
});
describe('release recovery and rollback',()=>{
 const transaction={id:'change1',commit:'candidate',previous:{commit:'base',deployment:'old'},phase:'verifying',deployment:'new'};
 it('rolls back a crash after upload rather than claiming an unverified release succeeded',async()=>{
  const {controller,journal}=await setup({current:transaction.previous,pending:transaction});
  controller.api=vi.fn(async()=>[{id:'new',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_message:'gengar:change1'}}}]);
  controller.current=vi.fn(async()=> 'new');controller.rollbackRemote=vi.fn(async()=>{});
  await controller.recover();expect(controller.rollbackRemote).toHaveBeenCalledWith('old');
  expect((await journal()).current.deployment).toBe('old');expect((await journal()).pending).toBeUndefined();
 });
 it('does not roll back somebody else’s deployment',async()=>{
  const {controller,journal}=await setup({current:transaction.previous,pending:transaction});
  controller.api=vi.fn(async()=>[]);controller.current=vi.fn(async()=> 'external');controller.rollbackRemote=vi.fn();
  await expect(controller.recover()).rejects.toThrow('outside Gengar');
  expect(controller.rollbackRemote).not.toHaveBeenCalled();expect((await journal()).pending).toBeDefined();
 });
 it('retains ambiguous uploads until Cloudflare reports a terminal state',async()=>{
  const {controller,journal}=await setup({current:transaction.previous,pending:transaction});
  controller.api=vi.fn(async()=>[{latest_stage:{status:'active'},deployment_trigger:{metadata:{commit_message:'gengar:change1'}}}]);
  await expect(controller.recover()).rejects.toThrow('still settling');expect((await journal()).pending).toBeDefined();
 });
 it('preserves edits when Undo cannot safely restore the source',async()=>{
  const {controller}=await setup({current:{commit:'candidate',deployment:'new',release:'change1'},latest:transaction});
  controller.snapshot=vi.fn(async()=> 'dirty-tree');controller.git=vi.fn(async()=> 'candidate-tree');controller.rollbackRemote=vi.fn();
  await expect(controller.undo('change1',async()=>{})).rejects.toThrow('unfinished edits');
  expect(controller.rollbackRemote).not.toHaveBeenCalled();
 });
 it('restores production and source together and rejects an old Undo button',async()=>{
  const {controller,journal}=await setup({current:{commit:'candidate',deployment:'new',release:'change1'},latest:transaction});
  controller.snapshot=vi.fn(async()=> 'same-tree');controller.git=vi.fn(async()=> 'same-tree');controller.current=vi.fn(async()=> 'new');controller.rollbackRemote=vi.fn(async()=>{});
  await controller.undo('change1',async()=>{});
  expect(controller.rollbackRemote).toHaveBeenCalledWith('old');expect(controller.git).toHaveBeenCalledWith(['reset','--hard','base']);
  expect((await journal()).current).toEqual(transaction.previous);
  await expect(controller.undo('change1',async()=>{})).rejects.toThrow('latest live change');
 });
 it('repairs source after a crash halfway through Undo',async()=>{
  const {controller,journal}=await setup({current:{commit:'candidate',deployment:'new',release:'change1'},latest:transaction,pending:{...transaction,phase:'undo'}});
  controller.api=vi.fn(async()=>[]);controller.current=vi.fn(async()=> 'old');controller.snapshot=vi.fn(async()=> 'same-tree');controller.git=vi.fn(async()=> 'same-tree');
  await controller.recover();expect(controller.git).toHaveBeenCalledWith(['reset','--hard','base']);expect((await journal()).current).toEqual(transaction.previous);
 });
});


it('retains the journal when an interrupted upload is not yet visible in the API',async()=>{
 const pending={id:'unconfirmed',commit:'candidate',previous:{commit:'base',deployment:'old'},phase:'publishing'};
 const {controller,journal}=await setup({current:pending.previous,pending});
 controller.api=vi.fn(async()=>[]);controller.current=vi.fn(async()=> 'old');
 await expect(controller.recover()).rejects.toThrow('still uncertain');expect((await journal()).pending).toEqual(pending);
});
it('recognizes a verified release after a crash before its Discord reply',async()=>{
 const {controller}=await setup({current:{commit:'candidate',deployment:'new',release:'job-123'}});
 controller.current=vi.fn(async()=> 'new');
 expect(await controller.completed('job')).toMatchObject({published:true,id:'job-123'});
 expect(await controller.completed('another-job')).toBeUndefined();
});
it('refuses a second publisher even when it runs in the same process',async()=>{
 const {controller,dir}=await setup({current:{commit:'base',deployment:'old'}});
 await controller.recover();
 const second=new ReleaseController({dir} as ReleaseConfig);
 await expect(second.recover()).rejects.toThrow('Another release controller');
});

it('locks repair scope to the files in the first prepared candidate',async()=>{
 const {controller}=await setup({current:{commit:'base',deployment:'old'}});
 controller.git=vi.fn(async()=> 'src/games/pizza/pizza.css');
 await controller.enforceRequestScope('job','tree','base');
 await expect(controller.enforceRequestScope('job','another-tree','base')).resolves.toBeUndefined();
 controller.git=vi.fn(async()=> 'src/games/pizza/pizza.css\nsrc/games/potty-time/PottyTimeGame.tsx');
 await expect(controller.enforceRequestScope('job','broader-tree','base')).rejects.toThrow('expanded beyond');
 expect(await controller.repairContext('job')).toContain('src/games/pizza/pizza.css');
 await expect(controller.enforceRequestScope('job','tree','different-base')).rejects.toThrow('expanded beyond');
});

it('cancels detached test descendants instead of hanging on inherited output pipes',async()=>{
 const {command}=await import('../../src/releases/controller.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'gengar-cancel-test-'));dirs.push(dir);
 const script=path.join(dir,'runner.mjs');const ready=path.join(dir,'ready');
 await writeFile(script,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});writeFileSync(${JSON.stringify(ready)},String(c.pid));setInterval(()=>{},1000);`);
 const abort=new AbortController();const task=command(process.execPath,[script],dir,{signal:abort.signal});
 const result=expect(task).rejects.toThrow('Stopped before publishing');
 let pid=0;for(let i=0;i<100;i++){try{pid=Number(await readFile(ready,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,20));}}
 expect(pid).toBeGreaterThan(0);abort.abort();await result;
 await new Promise(r=>setTimeout(r,50));expect(()=>process.kill(pid,0)).toThrow();
},5000);
