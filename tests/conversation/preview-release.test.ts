import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReleaseController,type ReleaseConfig} from '../../src/releases/controller.js';
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'preview-release-'));dirs.push(dir);
 await writeFile(path.join(dir,'index.html'),'test');await writeFile(path.join(dir,'sw.js'),'test');
 const c:any=new ReleaseController({wrangler:'/usr/bin/true',project:'game',dir} as ReleaseConfig);
 c.refresh=vi.fn(async()=>{});c.current=vi.fn(async()=> 'prod');c.verifyLive=vi.fn(async()=>{});
 return {dir,c};
}
it('never uploads a preview to the production branch',async()=>{
 const {dir,c}=await fixture();c.api=vi.fn(async()=>({subdomain:'game.pages.dev',production_branch:'gengar-preview',canonical_deployment:{id:'prod'}}));
 await expect(c.publishPreview(dir,dir,'draft','commit','tree','prod',new AbortController().signal)).rejects.toThrow('matches production');
 expect(c.api).toHaveBeenCalledTimes(1);expect(c.verifyLive).not.toHaveBeenCalled();
});
it('selects the exact successful preview deployment and verifies its bytes',async()=>{
 const {dir,c}=await fixture();
 c.api=vi.fn(async(endpoint:string)=>endpoint ? [
 {environment:'production',url:'https://game.pages.dev',deployment_trigger:{metadata:{commit_message:'gengar-preview:draft'}}},
 {environment:'preview',url:'https://abc.game.pages.dev',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_message:'gengar-preview:draft'}}}
 ] : {subdomain:'game.pages.dev',production_branch:'main',canonical_deployment:{id:'prod'}});
 expect(await c.publishPreview(dir,dir,'draft','commit','tree','prod',new AbortController().signal)).toEqual({id:'draft',url:'https://abc.game.pages.dev',tree:'tree'});
 expect(c.verifyLive).toHaveBeenCalledWith('draft',expect.objectContaining({'index.html':expect.any(String),'sw.js':expect.any(String)}),'https://abc.game.pages.dev',expect.any(AbortSignal));
});
it('rejects an unexpected preview origin',async()=>{
 const {dir,c}=await fixture();c.api=vi.fn(async(endpoint:string)=>endpoint ? [{environment:'preview',url:'https://evil.test',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_message:'gengar-preview:draft'}}}] : {subdomain:'game.pages.dev',production_branch:'main',canonical_deployment:{id:'prod'}});
 await expect(c.publishPreview(dir,dir,'draft','commit','tree','prod',new AbortController().signal)).rejects.toThrow('Unexpected draft URL');
 expect(c.verifyLive).not.toHaveBeenCalled();
});
it('does not expose a draft if cancellation arrived before upload',async()=>{
 const {dir,c}=await fixture();c.api=vi.fn(async()=>({subdomain:'game.pages.dev',production_branch:'main',canonical_deployment:{id:'prod'}}));
 const abort=new AbortController();abort.abort();
 await expect(c.publishPreview(dir,dir,'draft','commit','tree','prod',abort.signal)).rejects.toThrow('Stopped before uploading');
 expect(c.verifyLive).not.toHaveBeenCalled();
});
it('finds a preview beyond the first API page using accepted page sizes',async()=>{
 const {dir,c}=await fixture();
 const match={environment:'preview',url:'https://abc.game.pages.dev',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_message:'gengar-preview:draft'}}};
 c.api=vi.fn(async(endpoint:string)=>!endpoint ? {subdomain:'game.pages.dev',production_branch:'main',canonical_deployment:{id:'prod'}} : endpoint.endsWith('page=1') ? Array.from({length:25},()=>({environment:'preview'})) : [match]);
 expect((await c.publishPreview(dir,dir,'draft','commit','tree','prod',new AbortController().signal)).url).toBe('https://abc.game.pages.dev');
 expect(c.api).toHaveBeenCalledWith('/deployments?per_page=25&page=2');
});

it('accepts the assigned Pages subdomain when it differs from the project name',async()=>{
 const {dir,c}=await fixture();
 c.api=vi.fn(async(endpoint:string)=>endpoint ? [{environment:'preview',url:'https://abc.game-f39.pages.dev',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_message:'gengar-preview:draft'}}}] : {subdomain:'game-f39.pages.dev',production_branch:'main',canonical_deployment:{id:'prod'}});
 expect((await c.publishPreview(dir,dir,'draft','commit','tree','prod',new AbortController().signal)).url).toBe('https://abc.game-f39.pages.dev');
});
