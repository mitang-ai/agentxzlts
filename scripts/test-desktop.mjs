import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {resolve,dirname,isAbsolute,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {_electron as electron,chromium} from 'playwright-core';
import WebSocket,{WebSocketServer} from 'ws';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const value=name=>{const i=process.argv.indexOf('--'+name);return i<0?'':process.argv[i+1]||''};
const sourcePayload=resolve(value('payload')||process.env.ISLAND_DESKTOP_TEST_PAYLOAD||resolve(root,'.data/desktop-release/resources/client-payload'));
const sourceNode=resolve(value('node')||process.env.ISLAND_DESKTOP_TEST_NODE||resolve(root,'.data/desktop-release/resources/runtime/node.exe'));
const executable=value('exe')||process.env.ISLAND_DESKTOP_TEST_EXE||'';
const developmentExecutable=value('electron')||process.env.ISLAND_DESKTOP_TEST_ELECTRON||'';
const onlyPackaged=process.argv.includes('--packaged-only');
const artifacts=resolve(root,'.data/desktop-validation',new Date().toISOString().replace(/[:.]/g,'-'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const require=createRequire(import.meta.url);
const report={started:new Date().toISOString(),platform:process.platform,arch:process.arch,tests:[],passed:false,windows10HardwareTested:false,commercialAgentsTested:false};
const checkpoint=async(name,data={})=>{
  report.tests.push({name,...data});
  await writeFile(resolve(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('PASS',name);
};
async function until(fn,timeout=30000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const result=await fn();if(result)return result;await sleep(100)}
  throw Error('真实桌面窗口验收超时');
}
const pendingCloses=[];
// Packaged Electron ignores Node's -r loader. Its deliberately un-navigated
// hidden WebContentsView can otherwise hold Playwright's initial-page gate.
// Hide only that empty CDP target until its first real navigation; do not load,
// stop, close or change the application's view or production entry point.
async function nativePackaged(exe,env){
  // This is the visible application under test, not a console background helper.
  // SW_HIDE startup flags would suppress Electron's first native ShowWindow.
  const child=spawn(exe,['--inspect=0','--remote-debugging-port=0','--smoke-test'],{env,windowsHide:false,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stdout.resume();child.stderr.on('data',b=>{stderr+=b.toString()});
  let inspector,transport,browser;
  const streams=new Set();
  try{
    const urls=await until(()=>{if(child.exitCode!==null)throw Error('原生EXE启动退出：'+child.exitCode+' '+stderr);const node=stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/),chrome=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);return node&&chrome?{node:node[1],chrome:chrome[1]}:null},30000);
    const rpc=async url=>{
      const socket=new WebSocket(url);streams.add(socket);
      await new Promise((yes,no)=>{socket.once('open',yes);socket.once('error',no)});
      let id=0;const pending=new Map();
      socket.on('message',b=>{const m=JSON.parse(b.toString());if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}});
      socket.on('close',()=>{for(const p of pending.values())p.reject(Error('测试CDP已断开'));pending.clear()});
      return{socket,send(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}))})}};
    };
    inspector=await rpc(urls.node);
    const evaluate=async(fn,arg)=>{
      const r=await inspector.send('Runtime.evaluate',{expression:`(async()=>{const electron=require('electron');return (${fn.toString()})(electron,${arg===undefined?'undefined':JSON.stringify(arg)})})()`,awaitPromise:true,returnByValue:true,includeCommandLineAPI:true});
      if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
      return r.result.value;
    };
    await until(()=>evaluate(({app})=>app.isReady()),30000);
    const socket=new WebSocket(urls.chrome);streams.add(socket);await new Promise((yes,no)=>{socket.once('open',yes);socket.once('error',no)});
    const held=new Map(),ignore=new Set(),queue=[];let rawId=100000000;
    const resume=m=>{const id=++rawId;ignore.add(id);socket.send(JSON.stringify({id,sessionId:m.params.sessionId,method:'Runtime.runIfWaitingForDebugger'}))};
    transport={send:m=>socket.send(JSON.stringify(m)),close:()=>socket.close(),onmessage:undefined,onclose:undefined};
    const forward=m=>transport.onmessage?transport.onmessage(m):queue.push(m);
    socket.on('message',b=>{
      const m=JSON.parse(b.toString());if(ignore.delete(m.id))return;
      if(m.method==='Target.attachedToTarget'&&m.params.targetInfo.type==='page'&&!m.params.targetInfo.url){held.set(m.params.targetInfo.targetId,m);resume(m);return}
      if(m.method==='Target.targetInfoChanged'&&held.has(m.params.targetInfo.targetId)&&m.params.targetInfo.url){const old=held.get(m.params.targetInfo.targetId);held.delete(m.params.targetInfo.targetId);old.params.targetInfo=m.params.targetInfo;old.params.waitingForDebugger=false;forward(old)}
      if(m.method==='Target.detachedFromTarget'){for(const[id,old]of held)if(old.params.sessionId===m.params.sessionId){held.delete(id);return}}
      forward(m);
    });
    socket.on('close',()=>transport.onclose?.());
    transport.open=()=>{for(const m of queue.splice(0))transport.onmessage?.(m)};
    browser=await chromium.connectOverCDP(transport,{noDefaults:true,isLocal:true,timeout:30000});
    return{
      process:()=>child,windows:async()=>{
        // Electron's un-navigated WebContentsView does not always emit the
        // browser Target.targetInfoChanged event on its first load.
        for(const[id,old]of held){const url=await evaluate(({webContents},id)=>webContents.fromDevToolsTargetId(id)?.getURL()||'',id);if(url){held.delete(id);old.params.targetInfo.url=url;old.params.waitingForDebugger=false;forward(old)}}
        return browser.contexts().flatMap(c=>c.pages());
      },evaluate,
      browserWindow:async page=>({evaluate:fn=>evaluate(({BrowserWindow,webContents},{fn,url})=>{const wc=webContents.getAllWebContents().find(w=>w.getURL()===url);return eval('('+fn+')')(BrowserWindow.fromWebContents(wc))},{fn:fn.toString(),url:page.url()})}),
      close:async()=>{evaluate(({app})=>app.quit()).catch(()=>{});await sleep(100);for(const s of streams)s.close();await until(()=>child.exitCode!==null,15000);await browser.close().catch(()=>{})},
    };
  }catch(e){
    for(const s of streams)s.close();if(child.exitCode===null)child.kill();await until(()=>child.exitCode!==null,10000).catch(()=>{});throw e;
  }
}
async function exitGUI(application){
  const process=application.process(),closing=application.close();
  // Windows may retain a Playwright pipe handle in a deliberately detached Hub.
  // Observe native GUI exit rather than requiring that unrelated Hub to exit too.
  closing.catch(()=>{});pendingCloses.push(closing);
  await until(async()=>{
    try{globalThis.process.kill(process.pid,0);return false}
    catch(e){if(e.code==='ESRCH')return true;throw e}
  },15000);
}
function failMessage(e){return String(e?.stack||e).replace(/Bearer\s+\S+/ig,'Bearer [redacted]').replace(/FIXTURE-DESKTOP-[A-Z-]+[a-f0-9-]+/ig,'[fixture redacted]')}
async function fixtureServer(){
  const peers=new Map(),paired=new Map(),server=createServer(),wire=new WebSocketServer({server});
  let visits=0,refreshes=0;
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>协作岛 isolated fixture</title>
  <style>body{font:16px system-ui;background:#f7f7f4;color:#27362e;margin:0;display:flex}aside{width:190px;padding:25px;background:#fff;height:90vh}main{padding:35px;flex:1}textarea{width:85%;height:100px}button{padding:8px}</style></head>
  <body><aside><h2>协作岛</h2><p>房间 · 任务 · 文件 · 我的 Agent</p><a href="/guide">操作指南</a></aside><main><h1>聊天室 fixture</h1><p>此页面验证桌面网页视图，不代表真实服务器或商业模型验收。</p><textarea data-testid="cloud-draft" placeholder="未发送消息"></textarea><p data-testid="cloud-refresh-count">0</p><button data-testid="cloud-mcp-probe">检查网页权限隔离</button></main>
  <script>let refreshCount=0;window.addEventListener('island-desktop-refresh',e=>{e.preventDefault();document.querySelector('[data-testid=cloud-refresh-count]').textContent=String(++refreshCount);fetch('/refresh',{method:'POST'}).catch(()=>{})});
  document.querySelector('[data-testid=cloud-mcp-probe]').onclick=()=>document.body.dataset.bridge=typeof window.islandDesktop;</script></body></html>`;
  server.on('request',async(req,res)=>{
    if(req.url==='/api/agent-node/pair'){
      try{
        let bytes='';for await(const b of req){bytes+=b;if(bytes.length>16384)throw Error('fixture input too large')}
        const input=JSON.parse(bytes);
        if(!/^DESKTOP-FIXTURE-[12]$/.test(input.code)||paired.has(input.code))return res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({error:'fixture invitation invalid or already used'}));
        const identity={id:randomUUID(),token:'FIXTURE-DESKTOP-TOKEN-'+randomUUID(),connections:0};paired.set(input.code,identity);
        return res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({node_id:identity.id,token:identity.token}));
      }catch{return res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:'invalid fixture input'}))}
    }
    if(req.url==='/refresh'){refreshes++;return res.writeHead(204).end()}
    if(req.url==='/'||req.url==='/guide'){visits++;return res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}).end(html)}
    res.writeHead(404).end('fixture only');
  });
  wire.on('connection',(socket,req)=>{
    const identity=[...paired.values()].find(p=>req.headers.authorization==='Bearer '+p.token);
    if(!identity)return socket.close();
    identity.connections++;peers.set(socket,identity);
    socket.send(JSON.stringify({type:'welcome',data:{state:'platform',room_id:null}}));
    socket.on('message',bytes=>{
      const p=JSON.parse(bytes.toString());
      socket.send(JSON.stringify({type:'result',request_id:p.request_id,data:p.type==='sync'?{state:'platform',muted:false,room_id:null,cursor:0}:null}));
    });
    socket.on('close',()=>peers.delete(socket));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return{origin:'http://127.0.0.1:'+server.address().port,paired,stats:()=>({visits,refreshes}),
    close:async()=>{for(const socket of wire.clients)socket.terminate();await new Promise(r=>wire.close(r));server.closeAllConnections();await new Promise(r=>server.close(r))}};
}
async function run(mode,exe){
  const area=await mkdtemp(resolve(tmpdir(),'island-desktop-gui-')),home=resolve(area,'中文 用户 with spaces');
  assert.notEqual(resolve(home),resolve(homedir()));
  assert.ok(isAbsolute(home)&&relative(tmpdir(),area)&&!relative(tmpdir(),area).startsWith('..'));
  await mkdir(home,{recursive:true});
  const fixture=await fixtureServer();
  let app,manager,clientRoot,sdk,hubPID,firstConfigHash;
  const env={...process.env,ISLAND_DESKTOP_TEST:'1',ISLAND_DESKTOP_TEST_TRAY:'1',ISLAND_DESKTOP_TEST_HOME:home,ISLAND_DESKTOP_TEST_ORIGIN:fixture.origin,ISLAND_DESKTOP_TEST_PAYLOAD:sourcePayload,ISLAND_DESKTOP_TEST_NODE:sourceNode};
  delete env.ELECTRON_RUN_AS_NODE;
  if(mode==='packaged'){
    // Validate the EXE's real bundled resources, not a passing external fixture.
    delete env.ISLAND_DESKTOP_TEST_PAYLOAD;delete env.ISLAND_DESKTOP_TEST_NODE;
  }
  // Development uses the upstream ready gate; final EXE uses its own ASAR.
  const readinessLoader=resolve(dirname(require.resolve('playwright-core/package.json')),'lib/server/electron/loader.js');
  const launch=()=>mode==='packaged'?nativePackaged(exe,env):electron.launch({executablePath:exe,args:['-r',readinessLoader,resolve(root,'apps/desktop/src/main.mjs'),'--smoke-test'],env,timeout:90000});
  const invoke=(action,data)=>manager.evaluate(({action,data})=>window.islandDesktop.invoke(action,data),{action,data});
  try{
    app=await launch();
    // The hidden WebContentsView can initialize before the visible shell when
    // attaching to a packaged app. Select the real owner by observed URL.
    manager=await until(async()=>(await app.windows()).find(p=>p.url()==='island-desktop://app/index.html'));
    await manager.getByTestId('desktop-refresh').waitFor();
    await manager.evaluate(()=>window.islandDesktop.onProgress(p=>{window.__desktopSmokePhase=p.phase}));
    await checkpoint(mode+': 真实本机主窗口加载完成');
    await until(async()=>{
      const p=await manager.evaluate(()=>({phase:window.__desktopSmokePhase,value:document.querySelector('#progress').value,label:document.querySelector('#progress-label').textContent}));
      if(p.phase==='error'||/校验失败|组件损坏|清单无效|版本不兼容/.test(p.label))throw Error('桌面客户端安装失败：'+p.label);
      return p.value===100;
    },90000);
    const locator=JSON.parse(await readFile(resolve(home,'.island-node/desktop-install.json'),'utf8'));
    assert.equal(locator.ready,true);clientRoot=locator.clientRoot;
    const packagedNode=mode==='packaged'?resolve(dirname(exe),'resources/runtime/node.exe'):sourceNode;
    assert.notEqual(locator.node,exe);assert.equal(sha(await readFile(locator.node)),sha(await readFile(packagedNode)));
    sdk=await import(pathToFileURL(resolve(clientRoot,'packages/node/src/runtime.mjs')).href);
    const status=await invoke('status');assert.equal(status.installed,true);assert.equal(status.hub.running,false);
    await checkpoint(mode+': 真实窗口、中文路径、专用运行时与统一进度',{runtime:locator.runtimeVersion});

    // Local shell input survives status refresh; this must not re-pair or launch a Hub.
    const mainWindow=await app.browserWindow(manager);
    const initialNative=await mainWindow.evaluate(w=>({visible:w.isVisible(),minimized:w.isMinimized()}));
    // Shared desktop activity or Win32 startup flags may minimize the GUI.
    // Restore/focus the actual native owner before user-input automation.
    await mainWindow.evaluate(w=>{if(w.isMinimized())w.restore();w.show();w.focus()});
    const windowState=await mainWindow.evaluate(w=>({visible:w.isVisible(),minimized:w.isMinimized(),bounds:w.getBounds()}));
    const pageState=await manager.evaluate(()=>({hidden:document.querySelector('#local').hidden,viewport:{width:innerWidth,height:innerHeight},nameBounds:document.querySelector('input[name=name]').getBoundingClientRect().toJSON()}));
    report.nativeWindow={mode,initial:initialNative,focused:windowState};
    assert.equal(windowState.visible,true,'the native manager window must be visible');
    assert.equal(pageState.hidden,false,'the local manager must be initially visible');
    await manager.locator('input[name=name]').fill('未保存的本机表单');
    await manager.getByTestId('desktop-refresh').click();
    assert.equal(await manager.locator('input[name=name]').inputValue(),'未保存的本机表单');
    assert.equal((await invoke('status')).hub.running,false);
    for(const[action,data]of [['run',{command:'cmd.exe'}],['start',{node_id:'../../outside/config.json'}],['settings',{openAtLogin:true,command:'cmd.exe'}],['add',{token:'not accepted'}]]){
      const result=await manager.evaluate(async({action,data})=>{try{await window.islandDesktop.invoke(action,data);return{allowed:true}}catch(e){return{allowed:false,message:e.message}}},{action,data});
      assert.equal(result.allowed,false,action+' must reject invalid IPC');
    }
    await checkpoint(mode+': 本机表单刷新保留输入、未知动作与越界参数拒绝');

    // A second window with the exact same local URL and preload is still not the owner.
    const intruderPreload=mode==='development'?resolve(root,'apps/desktop/src/preload.cjs'):resolve(dirname(exe),'resources/app.asar/src/preload.cjs');
    const intruder=await app.evaluate(async({BrowserWindow,webContents},preload)=>{
      const owner=webContents.getAllWebContents().find(w=>w.getURL()==='island-desktop://app/index.html');
      if(!owner)throw Error('local owner window missing');
      const test=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false}});
      try{await test.loadURL('island-desktop://app/index.html');return await test.webContents.executeJavaScript("typeof window.islandDesktop==='undefined'?({bridge:false,allowed:false}):window.islandDesktop.invoke('status').then(()=>({bridge:true,allowed:true}),e=>({bridge:true,allowed:false,message:e.message}))")}
      finally{test.destroy()}
    },intruderPreload);
    assert.equal(intruder.bridge,true,'test window must use the actual preload');assert.equal(intruder.allowed,false);assert.match(intruder.message,/拒绝非本机/);
    await checkpoint(mode+': 同URL/同preload的其他窗口不能调用本机IPC');

    await manager.getByTestId('desktop-web').click();
    const cloud=await until(async()=>(await app.windows()).find(p=>p.url().startsWith(fixture.origin+'/')));
    await cloud.getByTestId('cloud-draft').fill('保留未发送消息');
    const isolated=await cloud.evaluate(()=>({bridge:typeof window.islandDesktop,require:typeof require,node:typeof process}));
    assert.deepEqual(isolated,{bridge:'undefined',require:'undefined',node:'undefined'});
    const preferences=await app.evaluate(({webContents},origin)=>{
      const w=webContents.getAllWebContents().find(w=>w.getURL().startsWith(origin+'/')),p=w.getLastWebPreferences();
      return{nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,sandbox:p.sandbox,preload:!!p.preload,webSecurity:p.webSecurity};
    },fixture.origin);
    assert.deepEqual(preferences,{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:false,webSecurity:true});
    const visits=fixture.stats().visits;
    await manager.getByTestId('desktop-refresh').click();
    await until(async()=>fixture.stats().refreshes===1);
    assert.equal(await cloud.getByTestId('cloud-draft').inputValue(),'保留未发送消息');
    assert.equal(await cloud.getByTestId('cloud-refresh-count').textContent(),'1');
    assert.equal(fixture.stats().visits,visits);
    await cloud.evaluate(()=>{location.href='island-desktop://app/index.html'});
    await sleep(300);assert.ok(cloud.url().startsWith(fixture.origin+'/'));
    await checkpoint(mode+': 完整网页视图权限隔离、左下刷新事件保留草稿、不重载');
    await manager.locator('#guide').click();
    const guide=await until(async()=>(await app.windows()).find(p=>p.url()===fixture.origin+'/guide'));
    assert.equal(await guide.evaluate(()=>typeof window.islandDesktop),'undefined');
    assert.equal(await cloud.getByTestId('cloud-draft').inputValue(),'保留未发送消息');
    await guide.close();
    await checkpoint(mode+': 指南独立沙箱窗口，不替换聊天或丢失草稿');

    await manager.getByTestId('desktop-manager').click();
    const workspace=resolve(home,'workspaces','agent one');await mkdir(workspace,{recursive:true});
    const runner=resolve(workspace,'fixture-agent.mjs');
    await writeFile(runner,"if(process.argv.includes('--version'))console.log('desktop fixture');else{for await(const b of process.stdin){}console.log(JSON.stringify({message:'fixture only',done:true,acknowledge:false}))}\n");
    await manager.locator('input[name=code]').fill('DESKTOP-FIXTURE-1');
    await manager.locator('input[name=name]').fill('独立执行器一');
    await manager.locator('select[name=adapter]').selectOption('cli');
    await manager.locator('input[name=workspace]').fill(workspace);
    await manager.locator('input[name=command]').fill(locator.node);
    await manager.locator('input[name=args]').fill(JSON.stringify([runner]));
    await manager.locator('#add-submit').click();
    const first=await until(async()=>{const s=await invoke('status');return s.identities.length===1&&s.identities[0].connected?s:false},90000);
    hubPID=first.hub.pid;assert.ok(hubPID>0);assert.equal(fixture.paired.size,1);
    const firstID=first.identities[0].node_id;
    await invoke('start',{node_id:firstID});
    assert.equal((await invoke('status')).hub.pid,hubPID);
    assert.equal([...fixture.paired.values()][0].connections,1);
    const secondWorkspace=resolve(home,'workspaces','agent two');await mkdir(secondWorkspace,{recursive:true});
    await invoke('add',{code:'DESKTOP-FIXTURE-2',name:'独立执行器二',adapter:'cli',command:locator.node,args:[runner],workspace:secondWorkspace,allowDevelopment:false});
    const both=await invoke('status');assert.equal(both.hub.pid,hubPID);assert.equal(both.identities.length,2);assert.ok(both.identities.every(p=>p.connected));
    for(const p of fixture.paired.values())assert.ok(!JSON.stringify(both).includes(p.token));
    assert.ok(!JSON.stringify(both).includes(home.replaceAll('\\','\\\\')));
    await invoke('stop',{node_id:firstID});
    await until(async()=>!(await invoke('status')).identities.find(p=>p.node_id===firstID).running);
    const single=await invoke('status');assert.equal(single.hub.pid,hubPID);assert.ok(single.identities.find(p=>p.node_id!==firstID).connected);
    await checkpoint(mode+': 可视化注册独立身份、重复启动复用Hub、单身份停止隔离');

    const registry=JSON.parse(await readFile(resolve(clientRoot,'.data/hub/registry.json'),'utf8'));
    firstConfigHash=sha(await readFile(registry.agents.find(p=>p.node_id===firstID).file));
    await manager.getByTestId('desktop-refresh').click();assert.equal((await invoke('status')).hub.pid,hubPID);
    const close=app;app=null;await exitGUI(close);
    assert.equal((await sdk.runtimeStatus(resolve(clientRoot,'.data/hub/registry.json'))).pid,hubPID);
    app=await launch();manager=await until(async()=>(await app.windows()).find(p=>p.url()==='island-desktop://app/index.html'));
    await until(async()=>await manager.locator('#progress').getAttribute('value')==='100',90000);
    const reopened=await invoke('status');assert.equal(reopened.hub.pid,hubPID);assert.equal(reopened.identities.length,2);
    assert.equal(sha(await readFile(registry.agents.find(p=>p.node_id===firstID).file)),firstConfigHash);
    assert.equal(fixture.paired.size,2);
    await checkpoint(mode+': 退出GUI保留Hub、重开复用配置不重新配对');
    await manager.screenshot({path:resolve(artifacts,mode+'-manager.png')});
    await manager.getByTestId('desktop-web').click();
    const reopenedCloud=await until(async()=>(await app.windows()).find(p=>p.url().startsWith(fixture.origin+'/')));
    // CDP main-frame screenshots do not include a WebContentsView's surface.
    await reopenedCloud.screenshot({path:resolve(artifacts,mode+'-website.png')});
  }catch(e){
    if(manager){
      const diagnostic=await manager.evaluate(()=>({url:location.href,progress:document.querySelector('#progress')?.value,label:document.querySelector('#progress-label')?.textContent,notice:document.querySelector('#notice')?.textContent,hub:document.querySelector('#hub')?.textContent,bridge:typeof window.islandDesktop})).catch(()=>null);
      report.diagnostic={mode,...diagnostic};
      await manager.screenshot({path:resolve(artifacts,mode+'-failure.png'),timeout:5000}).catch(()=>{});
    }
    throw e;
  }finally{
    if(app)await exitGUI(app).catch(()=>{});
    if(sdk&&clientRoot){
      const registry=resolve(clientRoot,'.data/hub/registry.json');
      if((await sdk.runtimeStatus(registry))?.running)await sdk.controlRequest(registry,'stop');
      await until(async()=>!(await sdk.runtimeStatus(registry)),15000);
    }
    await Promise.race([Promise.allSettled(pendingCloses),sleep(5000)]);
    await fixture.close();
    await rm(area,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    await checkpoint(mode+': 精确停止隔离测试Hub并移除临时身份');
  }
}
await mkdir(artifacts,{recursive:true});
try{
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('此真实Windows桌面验收必须在Windows x64执行；不会用skip代替通过。');
  if(!onlyPackaged){await access(resolve(sourcePayload,'CLIENT_MANIFEST.json'));await access(sourceNode)}
  if(onlyPackaged&&!executable)throw Error('--packaged-only必须同时提供--exe。');
  if(!onlyPackaged){const electronExe=developmentExecutable?resolve(developmentExecutable):require('electron');await access(electronExe);await run('development',electronExe)}
  if(executable){await access(resolve(executable));await run('packaged',resolve(executable));report.executableSha256=sha(await readFile(resolve(executable)));report.appAsarSha256=sha(await readFile(resolve(dirname(resolve(executable)),'resources/app.asar')))}
  else report.packagedExeTested=false;
  report.packagedExeTested=!!executable;report.passed=true;report.finished=new Date().toISOString();
}catch(e){report.error=failMessage(e);console.error(report.error);process.exitCode=1}
finally{await writeFile(resolve(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('验收记录：',resolve(artifacts,'report.json'))}
