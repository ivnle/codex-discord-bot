import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
const game=process.argv[2];if(!game)throw Error('Pass the installed game checkout');
const root=await mkdtemp(path.join(os.tmpdir(),'gengar-scenario-test-'));
try{
 await mkdir(path.join(root,'dist'));await mkdir(path.join(root,'release-checks'));
 await symlink(path.join(game,'node_modules'),path.join(root,'node_modules'),'dir');await writeFile(path.join(root,'package.json'),'{}');
 const labels=JSON.parse(await readFile(new URL('../config/family-game-labels.json',import.meta.url),'utf8'));
 await writeFile(path.join(root,'dist/index.html'),`<!doctype html><html><body><main id="library"></main><section id="board" hidden><button aria-label="Play" onclick="document.querySelector('[data-outcome]').hidden=false">Play</button><p data-outcome hidden>Success!</p><button aria-label="Back to the games" onclick="document.querySelector('#board').hidden=true;document.querySelector('#library').hidden=false">Back</button></section><script>for(const label of ${JSON.stringify([...labels,'Fixture Game'])}){const b=document.createElement('button');b.className='library-tile';b.setAttribute('aria-label',label);b.textContent=label;b.onclick=()=>{document.querySelector('#library').hidden=true;document.querySelector('#board').hidden=false};document.querySelector('#library').append(b);}</script></body></html>`);
 const run=()=>spawnSync(process.execPath,[fileURLToPath(new URL('./release-scenarios.mjs',import.meta.url)),root],{encoding:'utf8',timeout:45000});
 let result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/needs a release-checks JSON gameplay scenario/);console.log('PASS: an untested new game is rejected');
 const scenario=path.join(root,'release-checks/fixture.json');
 await writeFile(scenario,JSON.stringify({game:'Fixture Game',steps:[{action:'click',selector:'button[aria-label="Play"]'},{action:'expectVisible',selector:'body'}]}));
 result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/Final outcome must become visible/);console.log('PASS: a vacuous always-visible assertion is rejected');
 await writeFile(scenario,JSON.stringify({game:'Fixture Game',steps:[{action:'click',selector:'button[aria-label="Play"]'},{action:'expectVisible',selector:'[data-outcome]'}]}));
 result=run();assert.equal(result.status,0,result.stderr);console.log('PASS: a new game with a real interaction and changed visible outcome is accepted');
}finally{await rm(root,{recursive:true,force:true});}
