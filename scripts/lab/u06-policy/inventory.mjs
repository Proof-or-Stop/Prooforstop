import{execFileSync}from'node:child_process';import{readFileSync,existsSync}from'node:fs';import{join}from'node:path';
export const prospective=JSON.parse(readFileSync(new URL('./prospective-files.json',import.meta.url)));
export function materialInventory(repo,isMaterialExcludedPath){
 const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',maxBuffer:64e6}).split('\0').filter(Boolean);
 const tracked=git(['ls-files','-z']);const extras=git(['ls-files','--others','--exclude-standard','-z']);const approved=new Set(prospective.files.map(r=>r.path));
 const unexpected=extras.filter(p=>!isMaterialExcludedPath(p,repo)&&!prospective.excludedUntracked.includes(p)&&!approved.has(p));
 if(unexpected.length)throw Error('Unreviewed prospective material paths: '+unexpected.join(', '));
 return [...new Set([...tracked,...prospective.files.filter(row=>existsSync(join(repo,row.path))).map(row=>row.path)])].filter(p=>!isMaterialExcludedPath(p,repo)).sort();
}
