import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile, rename, cp, rm, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { protectedPath, riskyStorageDiff, ReviewRequired, CheckFailed } from "./policy.js";

export interface ReleaseConfig { cwd: string; dir: string; account: string; project: string; origin: string; wrangler: string; credentials: string; baselineCommit: string; baselineDeployment: string; browserCache: string; branch?: string; }
export type ReleasePhase = "checking" | "publishing" | "verifying" | "rolling_back";
export interface ReleaseOutcome { published: boolean; id?: string; message?: string; }
export interface ReleaseService {
  recover(): Promise<void>;
  completed?(jobId:string): Promise<ReleaseOutcome | undefined>;
  status?(): Promise<string>;
  hasChanges?(): Promise<boolean>;
  checkpoint?(): Promise<{tree:string; baseline:string}>;
  repairContext?(jobId:string): Promise<string>;
  release(jobId: string, update: (phase: ReleasePhase, detail: string) => Promise<void>, signal: AbortSignal): Promise<ReleaseOutcome>;
  undo(id: string, update: (phase: ReleasePhase, detail: string) => Promise<void>): Promise<string>;
}
type Version = { commit: string; deployment: string; release?: string };
type Transaction = { id: string; commit: string; previous: Version; phase: string; deployment?: string; };
type Journal = { current: Version; pending?: Transaction; latest?: Transaction };
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));

export async function command(command: string, args: string[], cwd: string, options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; log?: string; timeout?: number; onOutput?: (text:string)=>void } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ""; let overflow=false;
    const child = spawn(command, args, { cwd, env: options.env ?? cleanEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      // Gameplay runners create detached groups. Stop descendants before their
      // parent so orphaned preview servers cannot retain the output pipes.
      const descendants:number[]=[];
      try {
        const rows=execFileSync("/bin/ps",["-axo","pid=,ppid="],{encoding:"utf8"}).trim().split("\n").map(row=>row.trim().split(/\s+/).map(Number));
        const collect=(parent:number)=>{for(const [pid,ppid] of rows)if(ppid===parent && pid){descendants.push(pid);collect(pid);}};
        if(child.pid)collect(child.pid);
      } catch {}
      for(const pid of descendants.reverse()) {try{process.kill(-pid,"SIGKILL");}catch{} try{process.kill(pid,"SIGKILL");}catch{}}
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    };
    const timer = setTimeout(kill, options.timeout ?? 25 * 60_000);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    const log = options.log ? createWriteStream(options.log,{mode:0o600}) : undefined;
    log?.on("error",()=>kill());
    const collect = (b: Buffer) => { output += b.toString(); if(output.length>2000000){overflow=true;output=output.slice(-18000);} log?.write(b); options.onOutput?.(b.toString()); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", async code => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", kill);
      // Never leave a detached test server alive after a command exits.
      kill();
      if(log) await new Promise<void>(r=>log.end(r));
      if (code === 0 && !options.signal?.aborted && !overflow) resolve(output.trim());
      else reject(new CheckFailed(options.signal?.aborted ? "Stopped before publishing." : `${path.basename(command)} failed (${code}).\n${output.slice(-6500)}`));
    });
  });
}
export class ReleaseController implements ReleaseService {
  private busy = false;
  private ownsLock = false;
  private async acquire(): Promise<void> {
    if(this.ownsLock)return;
    await mkdir(this.config.dir,{recursive:true,mode:0o700});
    const lock=path.join(this.config.dir,"release.lock");
    try {const f=await open(lock,"wx",0o600);await f.writeFile(String(process.pid));await f.close();this.ownsLock=true;}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
      const pid=Number(await readFile(lock,"utf8"));
      if(!Number.isInteger(pid)||pid<=0)throw new Error("Release lock needs Ivan's inspection.");
      try{process.kill(pid,0);}catch(probe){
        if((probe as NodeJS.ErrnoException).code==="ESRCH"){await rm(lock);return this.acquire();}throw probe;
      }
      throw new Error("Another release controller is running; publishing is paused.");
    }
  }
  constructor(readonly config: ReleaseConfig) {}
  private git(args: string[], env?: NodeJS.ProcessEnv) { return command("/usr/bin/git", args, this.config.cwd, { env }); }
  private async journal(): Promise<Journal> { return JSON.parse(await readFile(path.join(this.config.dir, "journal.json"), "utf8")) as Journal; }
  private async save(j: Journal) {
    const file = path.join(this.config.dir, "journal.json");
    await writeFile(file + ".tmp", JSON.stringify(j, null, 2) + "\n", { mode: 0o600 }); await rename(file + ".tmp", file);
  }
  private async api(endpoint = "", method = "GET"): Promise<any> {
    const credentials = await readFile(this.config.credentials, "utf8");
    const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(credentials)?.[1];
    if (!token) throw new Error("Publishing login is unavailable; Ivan needs to reconnect Cloudflare.");
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.config.account}/pages/projects/${this.config.project}${endpoint}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Cloudflare ${method} failed (${response.status}); publishing paused.`);
    const body = await response.json() as {success: boolean; result: any};
    if (!body.success) throw new Error("Cloudflare did not accept the release operation.");
    return body.result;
  }
  private async refresh() { await command(this.config.wrangler, ["whoami"], this.config.dir, { timeout: 60000, log: path.join(this.config.dir, "cloudflare-login.log") }); }
  private async current(): Promise<string> { return (await this.api()).canonical_deployment.id; }
  async recover(): Promise<void> {
    await this.acquire();
    await mkdir(this.config.dir, { recursive: true, mode: 0o700 });
    try { await this.journal(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await this.save({current: {commit: this.config.baselineCommit, deployment: this.config.baselineDeployment}});
    }
    const j = await this.journal();
    if (!j.pending) return;
    await this.refresh();
    const pending = j.pending;
    // An interrupted upload is ambiguous. Identify it by our unique commit message.
    const deployments = await this.api("/deployments?per_page=100");
    const matching = deployments.filter((d: any) => d.deployment_trigger?.metadata?.commit_message === `gengar:${pending.id}`);
    if (matching.some((d: any) => !["success", "failure", "canceled"].includes(d.latest_stage?.status))) throw new Error("A prior upload is still settling. Recovery will retry before accepting changes.");
    const current = await this.current();
    if (current !== pending.previous.deployment) {
      if (!matching.some((d: any) => d.id === current) && current !== pending.deployment) throw new Error("Live game changed outside Gengar. Ivan needs to reconcile the release.");
      await this.rollbackRemote(pending.previous.deployment);
    }
    if(pending.phase==="publishing" && !pending.deployment && matching.length===0) {
      throw new ReviewRequired("The upload outcome is still uncertain. Publishing is paused until Cloudflare confirms it or Ivan reconciles the release.");
    }
    if(pending.phase==="undo") {
      const tree=await this.snapshot();
      if(tree!==await this.git(["rev-parse",`${pending.commit}^{tree}`]) && tree!==await this.git(["rev-parse",`${pending.previous.commit}^{tree}`])) throw new Error("Undo recovery needs source reconciliation by Ivan.");
      await this.git(["reset","--hard",pending.previous.commit]);
      j.current=pending.previous;delete j.latest;
    }
    if(pending.phase!=="undo") {
      const head=await this.git(["rev-parse","HEAD"]);
      if(head===pending.commit) {
        if(await this.git(["symbolic-ref","--short","HEAD"])!==(this.config.branch ?? "family/discord"))throw new ReviewRequired("Source branch changed during recovery; Ivan needs to reconcile it.");
        await this.git(["reset","--mixed",pending.previous.commit]);
      } else if(head!==pending.previous.commit) throw new ReviewRequired("Source history changed during recovery; Ivan needs to reconcile it.");
    }
    // Keep candidate work for repair, but never label an unverified upload live.
    delete j.pending; await this.save(j);
  }
  async checkpoint():Promise<{tree:string;baseline:string}> {
    const j=await this.journal();
    return {tree:await this.snapshot(),baseline:await this.git(["rev-parse",`${j.current.commit}^{tree}`])};
  }
  async hasChanges():Promise<boolean> {
    const j=await this.journal();
    return await this.snapshot() !== await this.git(["rev-parse",`${j.current.commit}^{tree}`]);
  }
  async status():Promise<string> {
    const j=await this.journal();
    return `Trusted release controller status: ${j.current.release ? `A published version was verified at ${this.config.origin}. ${j.latest?.id === j.current.release ? "The latest change can be undone with its Discord Undo control." : "The most recent change has already been undone; no further Undo is available."}` : `The game is on its baseline version at ${this.config.origin}; there is no new published change to undo.`} ${j.pending ? "A release transaction still needs reconciliation." : "No publishing transaction is pending."} The coding agent's earlier statements about not publishing describe its own turn, not the controller's later result. Use this controller status when answering publication questions; do not quote internal version IDs.`;
  }
  async completed(jobId:string):Promise<ReleaseOutcome|undefined> {
    const j=await this.journal();
    if(j.pending || !j.current.release?.startsWith(`${jobId}-`))return;
    await this.refresh();
    if(await this.current()!==j.current.deployment)throw new Error("The recorded completed release is no longer live; Ivan needs to review the change.");
    return {published:true,id:j.current.release,message:`Your change is live. [Open the game](${this.config.origin}) and refresh or reopen it. I recovered the completed release after restarting.`};
  }
  private async assertSourceHead(commit:string) {
    if(await this.git(["symbolic-ref","--short","HEAD"]) !== (this.config.branch ?? "family/discord") || await this.git(["rev-parse","HEAD"])!==commit) {
      throw new ReviewRequired("The source branch changed outside Gengar. Ivan needs to reconcile it before publishing or Undo.");
    }
  }
  private async snapshot(): Promise<string> {
    const index = path.join(this.config.dir, `index-${randomUUID()}`);
    const env = { ...cleanEnv(), GIT_INDEX_FILE: index };
    try {
      await this.git(["read-tree", "HEAD"], env);
      await this.git(["add", "-A", "--", "."], env);
      return await this.git(["write-tree"], env);
    } finally { await rm(index, {force:true}); }
  }
  private async guard(tree: string, previous: string) {
    const lines = (await this.git(["diff-tree", "--no-commit-id", "--name-status", "-r", "--no-renames", previous, tree])).split("\n").filter(Boolean);
    for (const line of lines) {
      const [status, file] = line.split("\t");
      if (!file || /[\x00-\x1f]/.test(file) || file.startsWith('"') || protectedPath(file, status !== "A")) throw new ReviewRequired(`This changes protected game plumbing (${file ?? "unknown file"}). Ivan needs to review it; the live game is unchanged.`);
      if (status === "D" && /^src\/games\/[^/]+\/index\./.test(file)) throw new ReviewRequired("Removing a game needs Ivan's review.");
    }
    const diff = await this.git(["diff", previous, tree, "--", "src"]);
    if (riskyStorageDiff(diff)) throw new ReviewRequired("This touches saved-game storage. Ivan needs to review data compatibility before publishing.");
    const entries = await this.git(["ls-tree", "-r", tree]);
    if (entries.split("\n").some(l => /^(120000|160000) /.test(l))) throw new ReviewRequired("Symlinks and submodules aren't allowed in automatic releases.");
  }
  private async enforceRequestScope(jobId:string, tree:string, base:string):Promise<void> {
    if(!/^[a-zA-Z0-9-]+$/.test(jobId))throw new ReviewRequired("Invalid request identity.");
    const files=(await this.git(["diff-tree","--no-commit-id","--name-only","-r","--no-renames",base,tree])).split("\n").filter(Boolean);
    const dir=path.join(this.config.dir,"request-scopes");await mkdir(dir,{recursive:true,mode:0o700});
    const file=path.join(dir,jobId+".json");
    let scope:{base:string;files:string[]};
    try{scope=JSON.parse(await readFile(file,"utf8"));}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
      await writeFile(file,JSON.stringify({base,files},null,2),{flag:"wx",mode:0o600});return;
    }
    const extra=files.filter(f=>!scope.files.includes(f));
    if(scope.base!==base || extra.length)throw new ReviewRequired(`The repair expanded beyond the original change${extra.length ? ` (${extra.join(", ")})` : ""}. Ivan needs to review the scope; nothing was published.`);
  }
  async repairContext(jobId:string):Promise<string> {
    try {
      const scope=JSON.parse(await readFile(path.join(this.config.dir,"request-scopes",jobId+".json"),"utf8")) as {files:string[]};
      return `The controller only permits repairs in these originally changed files: ${scope.files.join(", ")}. Expanding to another file requires owner review.`;
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return "Preserve the original request's scope.";}
  }
  async release(jobId: string, update: (p: ReleasePhase, d: string) => Promise<void>, signal: AbortSignal): Promise<ReleaseOutcome> {
    await this.acquire();
    if (this.busy) throw new Error("A release is already running.");
    this.busy = true;
    try {
      const j = await this.journal();
      if (j.pending) throw new Error("A previous release needs recovery before continuing.");
      await this.assertSourceHead(j.current.commit);
      const tree = await this.snapshot();
      if (tree === await this.git(["rev-parse", `${j.current.commit}^{tree}`])) return {published:false};
      await update("checking", "Checking the changes, all existing games, offline play, and saved creations. This usually takes several minutes.");
      await this.guard(tree, j.current.commit);
      await this.enforceRequestScope(jobId,tree,j.current.commit);
      const id = `${jobId}-${Date.now()}`;
      const root = path.join(this.config.dir, "releases", id);
      const source = path.join(root, "source");
      await mkdir(source, {recursive:true});
      const archive = path.join(root, "source.tar");
      await this.git(["archive", "--format=tar", `--output=${archive}`, tree]);
      await command("/usr/bin/tar", ["-xf", archive, "-C", source], root);
      // Copy installed dependencies; the agent cannot write the trusted installation.
      await command("/bin/cp", ["-cR", path.join(this.config.cwd, "node_modules"), path.join(source, "node_modules")], root);
      const profile = await this.buildProfile(source, root);
      await command("/usr/bin/sandbox-exec", ["-f", profile, "/opt/homebrew/bin/npm", "run", "verify"], source, {signal, log:path.join(root,"checks.log"),onOutput:text=>{
        const match=/\[(\d+)\/(\d+)\] ([^\n]+) —/.exec(text);
        if(match) void update("checking",`Checking game ${match[1]} of ${match[2]}: ${match[3]}. The live game is unchanged until all checks pass.`).catch(()=>{});
      }});
      await command("/usr/bin/sandbox-exec", ["-f", profile, "/opt/homebrew/bin/node", fileURLToPath(new URL("../../scripts/release-scenarios.mjs",import.meta.url)), source], source, {signal, log:path.join(root,"scenarios.log")});
      if (signal.aborted) throw new CheckFailed("Stopped before publishing.");
      await this.assertSourceHead(j.current.commit);
      if (tree !== await this.snapshot()) throw new ReviewRequired("Files changed during checking. Nothing was published; retry to check the latest work.");
      const commit = await this.git(["-c", "user.name=Gengar", "-c", "user.email=gengar@local", "commit-tree", tree, "-p", j.current.commit, "-m", `Family game change ${jobId}`]);
      await this.git(["update-ref", `refs/gengar/candidates/${id}`, commit]);
      const stage = path.join(root,"artifact");
      await cp(path.join(source,"dist"), stage, {recursive:true});
      await rm(path.join(stage,"_routes.json"),{force:true});
      if (await exists(path.join(stage,"_worker.js"))) throw new ReviewRequired("Worker deployments need Ivan's review.");
      const hashes = await artifactHashes(stage);
      await writeFile(path.join(stage,"release.json"), JSON.stringify({id,commit,hashes}));
      await this.refresh();
      if (await this.current() !== j.current.deployment) throw new ReviewRequired("The live game changed outside Gengar. Ivan needs to reconcile it before publishing.");
      const project = await this.api();
      j.pending = { id, commit, previous: {...j.current}, phase:"publishing" }; await this.save(j);
      try {
        await update("publishing", "Checks passed. Putting this version on the usual game link.");
        // Once upload starts, finish verification or rollback even if Stop is pressed.
        await command(this.config.wrangler, ["pages","deploy",stage,"--project-name",this.config.project,"--branch",project.production_branch,"--commit-hash",commit,"--commit-message",`gengar:${id}`,"--commit-dirty=false"], root, {log:path.join(root,"upload.log"),timeout:180000});
        const deployment = await this.api();
        if (deployment.canonical_deployment.deployment_trigger?.metadata?.commit_message !== `gengar:${id}`) throw new Error("The uploaded version isn't the active production version.");
        j.pending.deployment = deployment.canonical_deployment.id; j.pending.phase="verifying"; await this.save(j);
        await update("verifying", "Checking that the new version is really available on the live game link.");
        await this.verifyLive(id, hashes);
        await command("/usr/bin/sandbox-exec", ["-f", await this.buildProfile(source,root,true), "/opt/homebrew/bin/node", "scripts/production-smoke.mjs", "--origin", this.config.origin, "--skip-build"], source, {log:path.join(root,"live-checks.log")});
        if (signal.aborted) throw new Error("Stop requested; restoring the previous game.");
        if (tree !== await this.snapshot()) throw new Error("Source changed during publishing; restoring previous game.");
        await this.assertSourceHead(j.current.commit);
        await this.git(["reset", "--mixed", commit]);
        j.current = {commit, deployment:j.pending.deployment!, release:id}; j.latest=j.pending; delete j.pending; await this.save(j);
        return {published:true,id,message:`It's live! [Open the game](${this.config.origin}). Refresh or close and reopen the app to see the update. You can use Undo if you'd like the previous version back.`};
      } catch (e) {
        await update("rolling_back", "The release didn't finish cleanly. Checking and restoring the previous live version.");
        await this.recover();
        throw new CheckFailed(`Release wasn't completed. Previous live version restored; your edits are saved. ${e instanceof Error ? e.message : ""}`);
      }
    } finally { this.busy=false; }
  }
  private async verifyLive(id: string, hashes: Record<string,string>) {
    let error: unknown;
    for (let attempt=0;attempt<12;attempt++) {
      try {
        const r=await fetch(`${this.config.origin}/release.json?check=${randomUUID()}`,{headers:{"Cache-Control":"no-cache"},signal:AbortSignal.timeout(15000)});
        if (!r.ok || (await r.json() as {id:string}).id!==id) throw new Error("Live version hasn't updated yet.");
        for (const file of ["index.html","sw.js"]) {
          const asset=await fetch(`${this.config.origin}/${file}?check=${randomUUID()}`,{headers:{"Cache-Control":"no-cache"},signal:AbortSignal.timeout(15000)});
          if (!asset.ok || digest(Buffer.from(await asset.arrayBuffer())) !== hashes[file]) throw new Error(`Live ${file} does not match the checked build.`);
        }
        return;
      } catch(e) { error=e; await new Promise(r=>setTimeout(r,5000)); }
    }
    throw error;
  }
  private async rollbackRemote(deployment: string) {
    await this.api(`/deployments/${deployment}/rollback`,"POST");
    if (await this.current() !== deployment) throw new Error("Rollback is not confirmed. Ivan needs to inspect Cloudflare before more changes.");
    const target=await this.api(`/deployments/${deployment}`);
    const hashes:Record<string,string>={};
    for(const file of ["index.html","sw.js"]){
      const r=await fetch(`${target.url}/${file}`,{signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw new Error("Cannot verify the rollback target.");
      hashes[file]=digest(Buffer.from(await r.arrayBuffer()));
    }
    for(let attempt=0;attempt<12;attempt++){
      let matches=true;
      for(const file of ["index.html","sw.js"]){
        const r=await fetch(`${this.config.origin}/${file}?rollback=${randomUUID()}`,{signal:AbortSignal.timeout(15000)});
        if(!r.ok || digest(Buffer.from(await r.arrayBuffer()))!==hashes[file]) matches=false;
      }
      if(matches)return;
      await new Promise(r=>setTimeout(r,5000));
    }
    throw new Error("Rollback was accepted but the live files aren't confirmed yet. Publishing remains paused.");
  }
  async undo(id: string, update: (p: ReleasePhase,d:string)=>Promise<void>): Promise<string> {
    await this.acquire();
    if(this.busy) throw new Error("Wait for the current request to finish before Undo.");
    this.busy=true;
    try {
      const j=await this.journal();
      if(j.pending || j.current.release!==id || j.latest?.id!==id) throw new Error("Only the latest live change can be undone.");
      await this.assertSourceHead(j.current.commit);
      if(await this.snapshot()!==await this.git(["rev-parse",`${j.current.commit}^{tree}`])) throw new Error("There are unfinished edits. Ivan needs to review them before Undo can change the source safely.");
      await this.refresh();
      if(await this.current()!==j.current.deployment) throw new Error("The live game changed outside Gengar; Undo needs Ivan's review.");
      await update("rolling_back","Restoring the previous version of the game.");
      j.pending={...j.latest,phase:"undo",deployment:j.current.deployment}; await this.save(j);
      await this.rollbackRemote(j.latest.previous.deployment);
      await this.git(["reset","--hard",j.latest.previous.commit]);
      j.current=j.latest.previous; delete j.latest; delete j.pending; await this.save(j);
      return `Previous version restored. [Open the game](${this.config.origin}) and refresh or reopen it. Saved creations were not erased.`;
    } finally {this.busy=false;}
  }
  private async buildProfile(source:string, root:string, live=false) {
    const home="/Users";
    const readable=[source,fileURLToPath(new URL("../../scripts",import.meta.url)),fileURLToPath(new URL("../../config",import.meta.url)),this.config.browserCache,"/opt/homebrew"];
    const temp=await realpath(process.env.TMPDIR ?? "/tmp");
    const allow=(p:string)=>`(subpath ${JSON.stringify(p)})`;
    const profile=`(version 1)\n(allow default)\n(deny file-read-data (require-all (subpath ${JSON.stringify(home)}) (require-not (require-any ${readable.map(allow).join(" ")}))))\n(deny file-write* (require-not (require-any ${[source,temp,"/private/tmp","/tmp","/dev"].map(allow).join(" ")})))\n${live?"":"(deny network*)\n(allow network-outbound (remote ip \"localhost:*\"))\n(allow network-inbound (local ip \"localhost:*\"))\n(allow network-bind (local ip \"localhost:*\"))"}\n`;
    const file=path.join(root,live?"live.sb":"checks.sb"); await writeFile(file,profile); return file;
  }
}
async function exists(file:string) { try {await lstat(file);return true;} catch(e) {if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;} }
function digest(data:Buffer) {return createHash("sha256").update(data).digest("hex");}
async function artifactHashes(dir:string, prefix=""):Promise<Record<string,string>> {
  const result:Record<string,string>={};
  for(const file of await readdir(path.join(dir,prefix))) {
    const relative=path.join(prefix,file); const full=path.join(dir,relative); const stat=await lstat(full);
    if(stat.isSymbolicLink())throw new ReviewRequired("Symlink in built files.");
    if(stat.isDirectory())Object.assign(result,await artifactHashes(dir,relative));
    else result[relative]=digest(await readFile(full));
  }
  return result;
}
