// Trusted, intentionally shallow preview gate. Exhaustive gameplay remains in full.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { games } from './release-checks.mjs';

export function previewLabels(changed) {
  const touched = games.filter(([id]) => changed.some(file => file.startsWith(`src/games/${id}/`)));
  const shared = changed.some(file => !file.startsWith('src/games/') || !games.some(([id]) => file.startsWith(`src/games/${id}/`)));
  // Shared/unknown changes get a shallow open/back check of the whole library.
  return shared || !touched.length ? null : touched.map(([id, label]) => id === 'dino-park' ? 'Roarwalk' : label);
}

export async function main(source, origin, changedJson) {
  const url = new URL(origin);
  assert.equal(url.hostname, '127.0.0.1', 'Quick checks require a local preview');
  const require = createRequire(path.join(path.resolve(source), 'package.json'));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if(message.type() === 'error') errors.push(message.text());});
    page.on('requestfailed', request => {if(request.url().startsWith(url.origin)) errors.push(`${request.url()}: ${request.failure()?.errorText}`);});
    page.on('response', response => {if(response.url().startsWith(url.origin) && response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);});
    const response = await page.goto(origin, {waitUntil:'load',timeout:8000});
    assert(response?.ok(), 'Preview did not load');
    await page.locator('.library').waitFor({state:'visible'});
    const labels = await page.locator('.library-tile').evaluateAll(tiles => tiles.map(tile => tile.getAttribute('aria-label')?.trim()));
    assert(labels.length && labels.every(Boolean), 'Library tiles need accessible names');
    assert.equal(new Set(labels).size, labels.length, 'Library tiles must be unique');
    const output = path.join(source,'.gengar-preview');
    await mkdir(output,{recursive:true});
    await page.screenshot({path:path.join(output,'library.png')});
    const selected = previewLabels(JSON.parse(changedJson)) ?? labels;
    for (const [index,label] of selected.entries()) {
      assert(labels.includes(label), `Affected game is missing from the library: ${label}`);
      await page.getByRole('button',{name:label,exact:true}).tap();
      await page.locator('button.kit-back-button').waitFor({state:'visible'});
      assert.equal(await page.locator('.library').count(),0,`${label}: game failed to open`);
      // Two paint frames prove the initial screen rendered without waiting for a
      // complete animation or advancing game time and hiding timing defects.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({path:path.join(output,`game-${index+1}.png`)});
      await page.locator('button.kit-back-button').tap();
      await page.locator('.library').waitFor({state:'visible'});
      console.log(`Preview opened and returned: ${label}`);
    }
    assert.deepEqual([...new Set(errors)],[], 'Preview emitted browser errors');
    console.log(`Quick preview passed: ${selected.length} game(s); screenshots: ${output}`);
  } finally {
    await browser.close();
  }
}
if(process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2],process.argv[3],process.argv[4]).catch(error => {console.error(error.stack ?? error.message);process.exitCode=1;});
}
