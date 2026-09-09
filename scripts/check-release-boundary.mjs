// Run from the bridge checkout, with an existing local production preview if desired.
import { readFile } from 'node:fs/promises';
import { ReleaseController, command } from '../dist/releases/controller.js';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const controller=new ReleaseController(config);
const profile=await controller.buildProfile(config.cwd,config.dir);
console.log(await command('/usr/bin/sandbox-exec',['-f',profile,'/opt/homebrew/bin/python3','-c',`
from pathlib import Path
import socket
paths=${JSON.stringify(['/Users/ivanlee/.config/ispy-discord/gengar.env','/Users/ivanlee/Library/Preferences/.wrangler/config/default.toml','/Users/ivanlee/.codex/auth.json'])}
for p in paths:
 try:
  with open(p,'rb') as f: f.read(1)
 except PermissionError: pass
 else: raise AssertionError('Credential unexpectedly readable: '+p)
p=Path('/Users/ivanlee/repos/codex-discord-bot/.boundary-probe')
try: p.write_text('probe')
except PermissionError: pass
else: p.unlink(); raise AssertionError('Controller unexpectedly writable')
try: socket.create_connection(('1.1.1.1',443),timeout=2)
except PermissionError: pass
else: raise AssertionError('External network unexpectedly available')
print('PASS: credentials unreadable, controller unwritable, public network denied')
`],config.cwd));
