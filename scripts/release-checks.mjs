// Controller-owned orchestration. Candidate checks and game coverage stay intact.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const games = [
  ['ispy','I Spy','ispy-loop'], ['trains','Trains','trains-loop'],
  ['trash','Trash Day','trash-loop'], ['dig','Dig','dig-loop'],
  ['fire','Fire Truck','fire-loop'], ['planes','Planes','planes-loop'],
  ['space','Space','space-loop'], ['aquarium','Fish Tank','aquarium-loop'],
  ['coloring','Coloring','coloring-loop'], ['pizza','Pizza Kitchen','pizza-loop'],
  ['dino-park','Roarwalk Park','roarwalk-loop'], ['road-trip','Road Trip USA','road-trip-loop'],
  ['catapult-castle','Catapult Castle','catapult-loop'], ['potty-time','Potty Time','potty-loop'],
];
export function orderGames(changed) {
  const touched = game => changed.some(file => file.startsWith(`src/games/${game[0]}/`));
  return [...games.filter(touched), ...games.filter(game => !touched(game))];
}
export function validateCoverage(pkg, gate) {
  const expected='npm run format:check && npm run check && npm run build:bundle && npm run smoke:prod -- --skip-build && npm run bug-report-check -- --skip-build && npm run gameplay-gate -- --skip-build';
  if(pkg.scripts.verify !== expected) throw new Error('GENGAR_CHECK_REVIEW Release verification changed; update the trusted check plan before publishing.');
  const registered=[...gate.matchAll(/script: '([^']+)'/g)].map(match=>match[1]);
  if(JSON.stringify(registered)!==JSON.stringify(games.map(game=>game[2]))) throw new Error('GENGAR_CHECK_REVIEW Gameplay coverage changed; update the trusted check plan before publishing.');
}
// The full phase consumes exactly the dist built by quick. The controller must
// keep that candidate immutable between phases.
export function checkPlan(changed, phase = 'all') {
  if (!['all', 'quick', 'full'].includes(phase)) throw new Error(`Unknown check phase: ${phase}`);
  const plan = [];
  const npm = (label, args, timeout) => plan.push({label, kind:'npm', args, timeout});
  if (phase !== 'full') {
    npm('Formatting', ['format:check']);
    npm('Types, lint, boundaries and unit tests', ['check']);
    npm('Building the game', ['build:bundle']);
  }
  if (phase === 'quick') {
    plan.push({label:'Quick browser preview check', kind:'preview', timeout:30_000});
    return plan;
  }
  const touched = game => changed.some(file => file.startsWith(`src/games/${game[0]}/`));
  const ordered = orderGames(changed);
  for (const game of ordered.filter(touched)) npm(`Changed game: ${game[1]}`, [game[2], '--', '--origin', '{origin}'], 8*60_000);
  plan.push({label:'Game interaction scenarios', kind:'scenarios', timeout:5*60_000});
  npm('Production browser checks', ['smoke:prod', '--', '--origin', '{origin}', '--skip-build']);
  npm('Bug-report checks', ['bug-report-check', '--', '--skip-build']);
  for (const game of ordered.filter(game => !touched(game))) npm(`Regression check: ${game[1]}`, [game[2], '--', '--origin', '{origin}'], 8*60_000);
  return plan;
}
export function stopTree(child) {
  const descendants=[];
  try {
    const rows=execFileSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(row=>row.trim().split(/\s+/).map(Number));
    const collect=parent=>{for(const [pid,ppid] of rows)if(ppid===parent){descendants.push(pid);collect(pid);}};
    if(child.pid)collect(child.pid);
  } catch {}
  for(const pid of descendants.reverse()) {
    try {process.kill(-pid,'SIGKILL');} catch {}
    try {process.kill(pid,'SIGKILL');} catch {}
  }
  child.kill('SIGKILL');
}
export async function main(source, changedJson, phase = 'all') {
  const changed=JSON.parse(changedJson);
  const plan=checkPlan(changed, phase);
  validateCoverage(JSON.parse(await readFile(path.join(source,'package.json'),'utf8')),await readFile(path.join(source,'scripts/gameplay-gate.mjs'),'utf8'));
  const metrics=[];
  const env={...process.env,PATH:"/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"};
  let server;
  const progress=detail=>process.stdout.write(`GENGAR_PROGRESS ${JSON.stringify({detail})}\n`);
  async function run(label, executable, args, timeout=5*60_000) {
    progress(`${label}.`);
    const started=Date.now();
    await new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{cwd:source,env,stdio:['ignore','pipe','pipe']});
      let expired=false; let tail="";
      const capture=data=>{tail=(tail+data.toString()).slice(-8000);};
      child.stdout.on("data",capture); child.stderr.on("data",capture);
      // Child shares this runner's process group; the controller cleans all
      // descendants on failure, cancellation, or timeout, including detached ones.
      const timer=setTimeout(()=>{expired=true; stopTree(child);},timeout);
      child.stdout.pipe(process.stdout,{end:false}); child.stderr.pipe(process.stderr,{end:false});
      child.on('error',error=>{clearTimeout(timer);reject(new Error(`GENGAR_CHECK_UNAVAILABLE ${label}: ${error.message}`));});
      child.on('exit',(code,signal)=>{
        clearTimeout(timer);
        const result={label,durationMs:Date.now()-started,passed:code===0 && !expired};
        metrics.push(result);
        if(result.passed){progress(`${label} passed (${Math.round(result.durationMs/1000)}s).`);resolve();}
        else reject(new Error(`${expired || /Executable doesn’t exist|Executable doesn't exist|browserType.launch:|ENOSPC|EADDRINUSE/.test(tail) ? "GENGAR_CHECK_UNAVAILABLE " : ""}${label}: ${expired ? `time limit of ${timeout/60000} minutes exceeded` : `failed (${signal ?? code})`}`));
      });
    });
  }
  const npm=(label,args,timeout)=>run(label,'/opt/homebrew/bin/npm',['run',...args],timeout);
  try {
    while (plan[0]?.kind === 'npm' && !plan[0].args.includes('--')) {
      const stage=plan.shift();
      await npm(stage.label,stage.args,stage.timeout);
    }
    // The test runner owns a single production preview, just as gameplay-gate did.
    server=spawn(process.execPath,[path.join(source,'node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','0'],{cwd:source,env,stdio:['ignore','pipe','pipe']});
    const origin=await new Promise((resolve,reject)=>{
      let output='';
      const timer=setTimeout(()=>reject(new Error('GENGAR_CHECK_UNAVAILABLE Preview startup timed out')),30_000);
      server.stdout.on('data',data=>{
        output+=data.toString();
        const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if(match){clearTimeout(timer);resolve(match[0]);}
      });
      server.stderr.pipe(process.stderr,{end:false});
      server.once('error',error=>{clearTimeout(timer);reject(new Error(`GENGAR_CHECK_UNAVAILABLE Preview: ${error.message}`));});
      server.once('exit',()=>{clearTimeout(timer);reject(new Error('GENGAR_CHECK_UNAVAILABLE Preview exited before startup'));});
    });
    for (const stage of plan) {
      if (stage.kind === 'npm') await npm(stage.label, stage.args.map(arg => arg === '{origin}' ? origin : arg), stage.timeout);
      else if (stage.kind === 'preview') await run(stage.label, process.execPath, [fileURLToPath(new URL('./preview-smoke.mjs', import.meta.url)), source, origin, changedJson], stage.timeout);
      else await run(stage.label, process.execPath, [fileURLToPath(new URL('./release-scenarios.mjs', import.meta.url)), source], stage.timeout);
    }
    progress(phase==='quick' ? 'Quick checks passed; full verification is still required.' : 'All release checks passed.');
  } finally {
    if(server) stopTree(server);
    await writeFile(path.join(source,'.gengar-check-timings.json'),JSON.stringify(metrics,null,2));
    if (phase !== 'all') await writeFile(path.join(source,`.gengar-check-timings-${phase}.json`),JSON.stringify(metrics,null,2));
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  main(process.argv[2],process.argv[3],process.argv[4]).catch(error=>{console.error(error.message);process.exitCode=1;});
}
