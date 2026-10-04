import {mkdir,lstat,realpath,readFile,writeFile,rename,copyFile,access,unlink} from "node:fs/promises";
import {resolve,dirname,relative,isAbsolute,sep} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {execFileSync} from "node:child_process";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=b=>createHash("sha256").update(b).digest("hex");
async function exists(p){try{await access(p);return true}catch(e){if(e.code==="ENOENT")return false;throw e}}
async function noLinks(p){
  let current=resolve(p);
  while(true){try{if((await lstat(current)).isSymbolicLink())throw Error("客户端目录不能经过符号链接或目录联接。")}catch(e){if(e.code!=="ENOENT")throw e}
    const parent=dirname(current);if(parent===current)return;current=parent;
  }
}
export async function withInstallLock(base,fn,{timeout=300000}={}){
  await noLinks(base);await mkdir(base,{recursive:true,mode:0o700});
  const lock=resolve(base,"client-install.lockdir"),owner=resolve(lock,"owner.json"),nonce=randomUUID(),until=Date.now()+timeout;
  for(;;){
    try{await mkdir(lock,{mode:0o700});await writeFile(owner,JSON.stringify({pid:process.pid,nonce}),{flag:"wx",mode:0o600});break}
    catch(e){
      if(e.code!=="EEXIST")throw e;
      if((await lstat(lock)).isSymbolicLink())throw Error("安装锁不能为链接。");
      try{const bytes=await readFile(owner,"utf8"),old=JSON.parse(bytes);if(Number.isInteger(old.pid)&&old.pid>0){
        try{process.kill(old.pid,0)}catch(x){if(x.code==="ESRCH"&&(await readFile(owner,"utf8"))===bytes){await unlink(owner);const fs=await import("node:fs/promises");await fs.rmdir(lock);continue}}
      }}catch(x){if(!["ENOENT","ENOTEMPTY"].includes(x.code))throw x}
      if(Date.now()>=until)throw Error("另一个客户端正在安装，等待超时；未覆盖已有配置。");
      await sleep(100);
    }
  }
  try{return await fn()}finally{
    const own=JSON.parse(await readFile(owner,"utf8"));if(own.nonce!==nonce)throw Error("安装锁身份变化，停止清理。");
    await unlink(owner);const fs=await import("node:fs/promises");await fs.rmdir(lock);
  }
}
export async function installClient({payload,home,nodeSource,desktopExe,version="0.4.0",onProgress=()=>{}}){
  const base=resolve(home,".island-node"),clientRoot=resolve(base,"client");
  return withInstallLock(base,async()=>{
    const progress=(phase,percent,message)=>onProgress({phase,percent,message});
    progress("verify",0,"正在校验内置客户端…");
    await noLinks(payload);await noLinks(nodeSource);
    const manifest=JSON.parse(await readFile(resolve(payload,"CLIENT_MANIFEST.json"),"utf8"));
    if(manifest.schema!==1||manifest.clientProtocol!=="hub-1"||!manifest.files||typeof manifest.files!=="object"||!/^\d+\.[0-9]+\.[0-9]+$/.test(manifest.runtimeVersion)||Number(manifest.runtimeVersion.split('.')[0])<22||!(/^[a-f0-9]{64}$/.test(manifest.runtimeSha256||"")))throw Error("内置客户端清单无效。");
    const entries=Object.entries(manifest.files);
    for(const required of ["CLIENT_VERSION.txt","package.json","packages/node/bin/island-node.mjs","node_modules/ws/package.json","node_modules/proper-lockfile/package.json"])
      if(!manifest.files[required])throw Error("内置客户端清单缺少必要文件。");
    for(const [name,hash]of entries){
      const p=resolve(payload,name),rel=relative(payload,p);
      if(!rel||isAbsolute(name)||name.includes("\\")||name.split("/").includes("..")||rel.startsWith(".."+sep)||name.startsWith(".data/")||!(/^[a-f0-9]{64}$/.test(hash)))throw Error("内置文件路径或校验值无效。");
      await noLinks(p);if(sha(await readFile(p))!==hash)throw Error("内置组件校验失败，不安装。");
    }
    if(sha(await readFile(nodeSource))!==manifest.runtimeSha256)throw Error("内置 Node 校验失败。");
    const runtimeVersion=execFileSync(nodeSource,["--version"],{encoding:"utf8",windowsHide:true,timeout:10000}).trim();
    if(runtimeVersion!=="v"+manifest.runtimeVersion)throw Error("内置 Node 实际版本与清单不一致。");
    progress("runtime",20,"正在准备专用运行时（不修改系统 Node）…");
    const runtimeDir=resolve(base,"runtime",manifest.runtimeVersion),node=resolve(runtimeDir,process.platform==="win32"?"node.exe":"node");
    await noLinks(node);await mkdir(runtimeDir,{recursive:true,mode:0o700});
    if(await exists(node)){if(sha(await readFile(node))!==manifest.runtimeSha256)throw Error("已存在的专用运行时校验失败，请诊断修复。")}
    else{const temp=node+"."+randomUUID()+".tmp";await copyFile(nodeSource,temp);await rename(temp,node);if(process.platform!=="win32"){const fs=await import("node:fs/promises");await fs.chmod(node,0o700)}}
    await noLinks(clientRoot);
    let reused=false;
    if(await exists(clientRoot)){
      const marker=(await readFile(resolve(clientRoot,"CLIENT_VERSION.txt"),"utf8")).trim();
      if(marker!=="hub-1")throw Error("已有客户端版本不兼容；请先备份升级，不自动覆盖或重配。");
      for(const p of ["packages/node/bin/island-node.mjs","node_modules/ws/package.json","node_modules/proper-lockfile/package.json"]){await noLinks(resolve(clientRoot,p));await access(resolve(clientRoot,p))}
      const oldManifestPath=resolve(clientRoot,"CLIENT_MANIFEST.json");
      if(await exists(oldManifestPath)){
        const old=JSON.parse(await readFile(oldManifestPath,"utf8"));
        if(old.schema!==1||old.clientProtocol!=="hub-1"||!old.files||typeof old.files!=="object")throw Error("已有客户端完整性清单无效。");
        for(const required of ["CLIENT_VERSION.txt","package.json","packages/node/bin/island-node.mjs","node_modules/ws/package.json","node_modules/proper-lockfile/package.json"])if(!old.files[required])throw Error("已有客户端完整性清单不完整。");
        for(const[name,hash]of Object.entries(old.files)){
          if(isAbsolute(name)||name.includes("\\")||name.split("/").some(p=>!p||p==='.'||p==='..')||name.startsWith('.data/')||!(/^[a-f0-9]{64}$/.test(hash)))throw Error("已有客户端完整性清单无效。");
          const p=resolve(clientRoot,name);await noLinks(p);
          if(sha(await readFile(p))!==hash)throw Error("已有客户端组件损坏，停止复用，不覆盖身份。");
        }
      }else{
        try{
          execFileSync(node,["--input-type=module","-e",'await import("./packages/node/src/runtime.mjs");await import("ws");await import("proper-lockfile");'],{cwd:clientRoot,windowsHide:true,timeout:10000,stdio:"pipe"});
          execFileSync(node,['--check','packages/node/bin/island-node.mjs'],{cwd:clientRoot,windowsHide:true,timeout:10000,stdio:'pipe'});
          const help=execFileSync(node,['packages/node/bin/island-node.mjs','help'],{cwd:clientRoot,encoding:'utf8',windowsHide:true,timeout:10000,stdio:'pipe'});
          if(!help.includes('bootstrap')||!help.includes('hub-status'))throw Error('Invalid legacy CLI');
        }
        catch{throw Error("已有客户端组件不完整或损坏，停止复用，不覆盖身份。");}
      }
      // Existing compatible identities and processes are deliberately not overwritten.
      reused=true;progress("reuse",90,"已找到兼容客户端，保留已有身份和工作成果。");
    }else{
      const stage=resolve(base,"client-staging-"+randomUUID());await mkdir(stage,{mode:0o700});
      let count=0;
      for(const[name]of entries){const out=resolve(stage,name);await mkdir(dirname(out),{recursive:true});await copyFile(resolve(payload,name),out);if(sha(await readFile(out))!==manifest.files[name])throw Error("部署组件校验失败；保留诊断目录，不生成就绪标记。");progress("deploy",25+Math.floor(++count/entries.length*60),"正在部署内置组件…")}
      await copyFile(resolve(payload,"CLIENT_MANIFEST.json"),resolve(stage,"CLIENT_MANIFEST.json"));
      await rename(stage,clientRoot);progress("deploy",90,"客户端已原子部署。");
    }
    const io=await import(pathToFileURL(resolve(clientRoot,"packages/node/src/io.mjs")).href);
    await io.protectDirectory(base);await io.protectDirectory(resolve(clientRoot,".data"));
    const locator={schema:1,version,exe:resolve(desktopExe),node,root:clientRoot,clientRoot,runtimeVersion:manifest.runtimeVersion,ready:true,reused};
    await io.writeJSON(resolve(base,"desktop-install.json"),locator);
    progress("ready",100,"安装完成。Agent 配对和房间审批状态将单独显示。");
    return locator;
  });
}
