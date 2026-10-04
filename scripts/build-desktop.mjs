import {mkdir,writeFile,readFile,readdir,lstat,copyFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {nodeClientBundle} from '../packages/agents/client-bundle.mjs';
import {readArchive} from '../packages/agents/archive.mjs';
import {build,Platform,Arch} from 'electron-builder';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows x64 builder required.');
const version=JSON.parse(await readFile(resolve(root,'apps/desktop/package.json'),'utf8')).version;
const area=resolve(root,'.data/desktop-release'),resources=resolve(area,'resources'),payload=resolve(resources,'client-payload');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function run(cmd,args,cwd){await new Promise((yes,no)=>{const p=spawn(cmd,args,{cwd,shell:false,windowsHide:true,stdio:'inherit'});p.once('error',no);p.once('exit',c=>c===0?yes():no(Error(cmd+' exit '+c)))})}
async function list(dir){const out=[];for(const f of await readdir(dir,{withFileTypes:true})){const p=resolve(dir,f.name);if(f.isSymbolicLink())throw Error('Payload must not contain links.');if(f.isDirectory())out.push(...await list(p));else out.push(p)}return out}
await mkdir(payload,{recursive:true});
const reuse=process.argv.includes('--reuse-resources');
if((await readdir(payload)).length&&!reuse)throw Error('Build resources exist. Use a fresh or explicitly archived .data/desktop-release/resources directory.');
console.log('1/4 preparing self-contained Hub payload');
const files=await readArchive(await nodeClientBundle(root));
if(reuse){
  for(const[name,bytes]of files)if(sha(await readFile(resolve(payload,name)))!==sha(bytes))throw Error('Existing payload is stale: '+name);
}else for(const[name,bytes]of files){await mkdir(dirname(resolve(payload,name)),{recursive:true});await writeFile(resolve(payload,name),bytes)}
// Use the SDK's existing pinned standalone lock, not desktop or web dependencies.
if(!reuse)await run(process.execPath,[resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],payload);
const nodeSource=process.execPath,runtimeVersion=execFileSync(nodeSource,['--version'],{encoding:'utf8'}).trim().replace(/^v/,'');
if(runtimeVersion!=='24.14.1')throw Error('This release is pinned to Node 24.14.1.');
await mkdir(resolve(resources,'runtime'),{recursive:true});await copyFile(nodeSource,resolve(resources,'runtime/node.exe'));
const hashes={};for(const p of await list(payload)){const name=p.slice(payload.length+1).replaceAll('\\','/');if(name==='CLIENT_MANIFEST.json'||name==='node_modules/.package-lock.json'||name.startsWith('node_modules/.bin/'))continue;hashes[name]=sha(await readFile(p))}
const manifest={schema:1,clientProtocol:'hub-1',runtimeVersion,runtimeSha256:sha(await readFile(nodeSource)),files:hashes};
await writeFile(resolve(payload,'CLIENT_MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('2/4 packaging Windows x64 application and installer');
process.env.CSC_IDENTITY_AUTO_DISCOVERY='false';
await build({projectDir:root,targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),publish:'never',config:{
  appId:'com.mitangai.island',productName:'协作岛',asar:true,npmRebuild:false,
  electronFuses:{runAsNode:false,enableCookieEncryption:true,enableNodeOptionsEnvironmentVariable:false,enableNodeCliInspectArguments:true,enableEmbeddedAsarIntegrityValidation:true,onlyLoadAppFromAsar:true},
  directories:{app:resolve(root,'apps/desktop'),output:resolve(area,'out')},
  files:['src/**/*','ui/**/*','assets/**/*','package.json'],
  // Builder skips node_modules roots, including nested SDK dependencies.
  // Exact file mappings bypass dependency pruning; hashes verify the final copy.
  extraResources:[...Object.keys(hashes).concat('CLIENT_MANIFEST.json').map(name=>({from:resolve(payload,name),to:'client-payload/'+name})),
    {from:resolve(resources,'runtime'),to:'runtime'}],
  win:{target:[{target:'nsis',arch:['x64']}],executableName:'Island',icon:resolve(root,'apps/desktop/assets/island.ico'),requestedExecutionLevel:'asInvoker'},
  artifactName:'Island-Setup-${version}-${arch}.${ext}',
  nsis:{oneClick:true,perMachine:false,allowElevation:false,runAfterFinish:false,createDesktopShortcut:true,createStartMenuShortcut:true,shortcutName:'协作岛',include:resolve(root,'apps/desktop/installer.nsh'),unicode:true},
}});
console.log('3/4 publishing exact checksummed manifest');
const packagedResources=resolve(area,'out/win-unpacked/resources');
for(const[name,hash]of Object.entries(hashes))if(sha(await readFile(resolve(packagedResources,'client-payload',name)))!==hash)throw Error('Packaged SDK mismatch: '+name);
if(sha(await readFile(resolve(packagedResources,'runtime/node.exe')))!==manifest.runtimeSha256)throw Error('Packaged runtime mismatch');
const exe=resolve(area,'out',`Island-Setup-${version}-x64.exe`),size=(await stat(exe)).size,digest=sha(await readFile(exe));
const installScriptSha256=sha(await readFile(resolve(root,'apps/web/public/desktop/install.ps1')));
const release={schema:1,version,platform:'win32',arch:'x64',minimumWindows:'Windows 10 22H2 x64 / Windows 11 x64',runtime:runtimeVersion,
  url:`https://github.com/mitang-ai/agentxzlts/releases/download/desktop-v${version}/Island-Setup-${version}-x64.exe`,sha256:digest,size,signed:false,guide:'/guide',installScriptSha256};
await writeFile(resolve(root,'apps/web/public/desktop/release.json'),JSON.stringify(release,null,2)+'\n');
await writeFile(resolve(area,'out','SHA256SUMS.txt'),`${digest}  Island-Setup-${version}-x64.exe\n`);
await writeFile(resolve(area,'build-report.json'),JSON.stringify({version,runtimeVersion,exe,size,sha256:digest,clientFiles:Object.keys(hashes).length,signed:false,windowsHardwareTested:false},null,2));
console.log('4/4 packaged; smoke-test the actual executable before publishing',JSON.stringify({exe,size,sha256:digest}));
