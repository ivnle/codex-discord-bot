import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
// @ts-expect-error Controller runner is also directly executable JavaScript.
import {orderGames,games,validateCoverage} from '../../scripts/release-checks.mjs';
import {taskCard} from '../../src/conversation/presentation.js';
import type {Job} from '../../src/conversation/store.js';

describe('release check ordering and coverage',()=>{
 it('checks a changed last-in-library game first without dropping or duplicating coverage',()=>{
  const ordered=orderGames(['src/games/potty-time/PottyTimeGame.tsx']);
  expect(ordered[0][0]).toBe('potty-time');
  expect(ordered).toHaveLength(games.length);
  expect(new Set(ordered.map((g:string[])=>g[2]))).toEqual(new Set(games.map((g:string[])=>g[2])));
 });
 it('handles multiple changes, deleted files, and unknown new games without dropping regressions',()=>{
  expect(orderGames(['src/games/pizza/deleted.ts','src/games/potty-time/style.css']).slice(0,2).map((g:string[])=>g[0])).toEqual(['pizza','potty-time']);
  expect(orderGames(['src/games/new-game/Game.tsx'])).toEqual(games);
 });
 it('refuses to silently omit a newly added verification stage',()=>{
  expect(()=>validateCoverage({scripts:{verify:'npm run extra'}},'')).toThrow('verification changed');
 });
 it('refuses to silently omit a newly added game check',async()=>{
  const source=await readFile(new URL('../../scripts/release-checks.mjs',import.meta.url),'utf8');
  const verify=source.match(/const expected='([^']+)'/)![1];
  const gate=games.map((g:string[])=>`script: '${g[2]}'`).join('\n');
  expect(()=>validateCoverage({scripts:{verify}},gate)).not.toThrow();
  expect(()=>validateCoverage({scripts:{verify}},gate+"\nscript: 'new-game-loop'")).toThrow('coverage changed');
 });
 it('shows check progress independently of Codex connection',()=>{
  const job={phase:'checking',created:0,activity:1000,id:'job',detail:'Attempt 2: Changed game: Potty Time.'} as Job;
  const card=taskCard(job,120000,true);
  expect(card.content).toContain('Last progress <t:1:R>');
  expect(card.content).not.toContain('Codex connected');
  expect(card.content).toContain('Attempt 2');
 });
});

it('stage timeout cleanup kills detached descendants',async()=>{
 const {spawn}=await import('node:child_process');
 // @ts-expect-error Directly executable controller runner.
 const {stopTree}=await import('../../scripts/release-checks.mjs');
 const child=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
 const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 const pid=await new Promise<number>(resolve=>child.stdout.once('data',data=>resolve(Number(data.toString().trim()))));
 try {stopTree(child);await exited;await new Promise(r=>setTimeout(r,50));expect(()=>process.kill(pid,0)).toThrow();}
 finally {try{process.kill(pid,'SIGKILL');}catch{}child.kill('SIGKILL');}
});

describe('staged preview verification',()=>{
 it('quick checks build once and never run exhaustive gameplay',async()=>{
  // @ts-expect-error Directly executable controller runner.
  const {checkPlan}=await import('../../scripts/release-checks.mjs');
  const plan=checkPlan(['src/games/potty-time/Game.tsx'],'quick');
  expect(plan.map((stage:{kind:string,args?:string[]})=>stage.args?.[0] ?? stage.kind)).toEqual(['format:check','check','build:bundle','preview']);
  expect(plan.at(-1).timeout).toBe(30000);
 });
 it('full preserves every exhaustive gate without rebuilding and all remains compatible',async()=>{
  // @ts-expect-error Directly executable controller runner.
  const {checkPlan}=await import('../../scripts/release-checks.mjs');
  const changed=['src/games/potty-time/Game.tsx'];
  const full=checkPlan(changed,'full');
  expect(full[0].args[0]).toBe('potty-loop');
  expect(full.filter((s:{args?:string[]})=>s.args?.[0]?.endsWith('-loop')).map((s:{args:string[]})=>s.args[0]).sort()).toEqual(games.map((g:string[])=>g[2]).sort());
  expect(full.some((s:{kind:string})=>s.kind==='scenarios')).toBe(true);
  expect(full.filter((s:{args?:string[]})=>['smoke:prod','bug-report-check'].includes(s.args?.[0]??''))).toHaveLength(2);
  expect(checkPlan(changed).slice(3)).toEqual(full);
  expect(()=>checkPlan(changed,'typo')).toThrow('Unknown check phase');
 });
 it('previews affected games and broadens shared or unknown changes to the library',async()=>{
  // @ts-expect-error Directly executable controller runner.
  const {previewLabels}=await import('../../scripts/preview-smoke.mjs');
  expect(previewLabels(['src/games/potty-time/Game.tsx'])).toEqual(['Potty Time']);
  expect(previewLabels(['src/games/dino-park/Game.tsx'])).toEqual(['Roarwalk']);
  expect(previewLabels(['src/games/potty-time/Game.tsx','src/platform/input.ts'])).toBeNull();
  expect(previewLabels(['src/games/new-game/Game.tsx'])).toBeNull();
 });
});
