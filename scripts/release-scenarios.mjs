// Trusted runner. Game authors provide data, never executable check code.
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const source=process.argv[2];
const require=createRequire(path.join(source,'package.json'));
const {chromium}=require('playwright');
const server=spawn(process.execPath,[path.join(source,'node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','4197','--strictPort'],{cwd:source,stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:4197')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:4197');
  const labels=await page.locator('.library-tile').evaluateAll(tiles=>tiles.map(t=>t.getAttribute('aria-label')));
  // Baseline labels are supplied by the immutable baseline build, not the candidate.
  const baseline=JSON.parse(await readFile(new URL('../config/family-game-labels.json',import.meta.url),'utf8'));
  for(const label of baseline) assert(labels.includes(label),`Existing game removed: ${label}`);
  let files=[];try{files=(await readdir(path.join(source,'release-checks'))).filter(f=>f.endsWith('.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const covered=new Set();
  for(const file of files){
    const scenario=JSON.parse(await readFile(path.join(source,'release-checks',file),'utf8'));
    assert(typeof scenario.game==='string'&&labels.includes(scenario.game),'Scenario must name an existing game tile');
    assert(Array.isArray(scenario.steps)&&scenario.steps.length>=2&&scenario.steps.length<=30,'Scenario requires 2–30 steps');
    assert(scenario.steps.some(s=>s.action==='click'),'Scenario must interact with the game');
    assert(scenario.steps.at(-1).action==='expectVisible','Scenario must finish by checking a visible outcome');
    await page.goto('http://127.0.0.1:4197');
    await page.getByRole('button',{name:scenario.game,exact:true}).click();
    const outcome=scenario.steps.at(-1);
    assert(typeof outcome.selector==='string' && !(await page.locator(outcome.selector).isVisible()),'Final outcome must become visible as a result of the interaction');
    for(const step of scenario.steps){
      assert(typeof step.selector==='string'&&step.selector.length<300,'Each step needs a selector');
      const target=page.locator(step.selector);
      if(step.action==='click')await target.click({timeout:10000});
      else if(step.action==='expectVisible')await target.waitFor({state:'visible',timeout:10000});
      else throw Error(`Unsupported action ${step.action}`);
    }
    await page.getByRole('button',{name:'Back to the games',exact:true}).click();
    await page.getByRole('button',{name:scenario.game,exact:true}).waitFor();
    covered.add(scenario.game);
  }
  for(const label of labels.filter(l=>!baseline.includes(l)))assert(covered.has(label),`New game ${label} needs a release-checks JSON gameplay scenario`);
  assert.deepEqual(errors,[],'Games emitted browser errors');
  console.log(`PASS: ${labels.length} games registered; ${covered.size} additional gameplay scenarios.`);
}finally{await browser?.close();server.kill();}
