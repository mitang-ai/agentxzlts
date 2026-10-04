import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {resolve,dirname,isAbsolute,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {DesktopController} from '../apps/desktop/src/controller.mjs';
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
// Packaged Electron ignores Node's -r loader. A newly-created window's empty
// CDP target can hold Playwright's initial-page gate until first navigation.
// Defer only that empty target; never navigate or change the product window.
async function nativePackaged(exe,env,extraArgs=[]){
  // This is the visible application under test, not a console background helper.
  // SW_HIDE startup flags would suppress Electron's first native ShowWindow.
  const child=spawn(exe,['--inspect=0','--remote-debugging-port=0','--smoke-test',...extraArgs],{env,windowsHide:false,stdio:['ignore','pipe','pipe']});
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
        // Observe the actual Electron URL if its first targetInfoChanged
        // notification was emitted before the CDP transport was attached.
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
  // Playwright context close maps to native window close. A tray-first product
  // deliberately hides on X, so request application quit explicitly instead.
  application.evaluate(({app})=>{app.quit()}).catch(()=>{});
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
  <body><aside><h2>协作岛</h2><p>房间 · 任务 · 文件 · 我的 Agent</p><a href="/guide">操作指南</a></aside><main><h1>聊天室 fixture</h1><p>此页面验证桌面网页视图，不代表真实服务器或商业模型验收。</p><textarea data-testid="cloud-draft" placeholder="未发送消息"></textarea><p data-testid="cloud-refresh-count">0</p><button data-testid="cloud-mcp-probe">检查网页权限隔离</button><button data-testid="cloud-refresh">刷新</button></main>
  <script>let refreshCount=0;window.addEventListener('island-desktop-refresh',e=>{e.preventDefault();document.querySelector('[data-testid=cloud-refresh-count]').textContent=String(++refreshCount);fetch('/refresh',{method:'POST'}).catch(()=>{})});
  document.querySelector('[data-testid=cloud-refresh]').onclick=()=>window.dispatchEvent(new Event('island-desktop-refresh',{cancelable:true}));
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
  let app,manager,clientRoot,sdk,fixtureController,hubPID;
  const env={...process.env,ISLAND_DESKTOP_TEST:'1',ISLAND_DESKTOP_TEST_TRAY:'1',ISLAND_DESKTOP_TEST_HOME:home,ISLAND_DESKTOP_TEST_ORIGIN:fixture.origin,ISLAND_DESKTOP_TEST_PAYLOAD:sourcePayload,ISLAND_DESKTOP_TEST_NODE:sourceNode};
  delete env.ELECTRON_RUN_AS_NODE;
  if(mode==='packaged'){
    delete env.ISLAND_DESKTOP_TEST_PAYLOAD;delete env.ISLAND_DESKTOP_TEST_NODE;
  }
  const readinessLoader=resolve(dirname(require.resolve('playwright-core/package.json')),'lib/server/electron/loader.js');
  const launch=(args=['--show-keeper'])=>mode==='packaged'?nativePackaged(exe,env,args):electron.launch({executablePath:exe,args:['-r',readinessLoader,resolve(root,'apps/desktop/src/main.mjs'),'--smoke-test',...args],env,timeout:90000});
  const invoke=(action,data)=>manager.evaluate(({action,data})=>window.islandDesktop.invoke(action,data),{action,data});
  const getCloud=()=>until(async()=>(await app.windows()).find(p=>p.url()===fixture.origin+'/'));
  const getKeeper=()=>until(async()=>(await app.windows()).find(p=>p.url()==='island-desktop://app/index.html'));
  const focus=async page=>{
    const owner=await app.browserWindow(page);
    await owner.evaluate(w=>{if(w.isMinimized())w.restore();w.show();w.focus()});
    assert.equal(await owner.evaluate(w=>w.isVisible()),true);
  };
  try{
    app=await launch();manager=await getKeeper();
    await manager.getByTestId('desktop-refresh').waitFor();
    const cloud=await getCloud();
    assert.equal(await cloud.locator('header,footer').count(),0);
    assert.equal(await manager.locator('nav,footer,form,select,input:not([type=checkbox])').count(),0);
    assert.equal(await manager.locator('input[type=checkbox]').count(),2);
    await until(async()=>{
      const s=await invoke('status');
      if(s.progress?.phase==='error')throw Error('桌面客户端安装失败：'+s.progress.message);
      return s.installed&&s.progress?.phase==='ready';
    },90000);
    const locator=JSON.parse(await readFile(resolve(home,'.island-node/desktop-install.json'),'utf8'));
    assert.equal(locator.ready,true);clientRoot=locator.clientRoot;
    const packagedNode=mode==='packaged'?resolve(dirname(exe),'resources/runtime/node.exe'):sourceNode;
    assert.notEqual(locator.node,exe);assert.equal(sha(await readFile(locator.node)),sha(await readFile(packagedNode)));
    sdk=await import(pathToFileURL(resolve(clientRoot,'packages/node/src/runtime.mjs')).href);
    const status=await invoke('status');assert.equal(status.installed,true);assert.equal(status.hub.running,false);
    assert.deepEqual(status.settings,{openAtLogin:false,stopHubOnExit:false});
    const mainWindow=await app.browserWindow(cloud),keeperWindow=await app.browserWindow(manager);
    await keeperWindow.evaluate(w=>{if(w.isMinimized())w.restore();w.show();w.focus()});
    assert.equal(await keeperWindow.evaluate(w=>w.isVisible()),true);
    const bounds=await mainWindow.evaluate(w=>({bounds:w.getContentBounds(),children:w.contentView.children.length}));
    assert.equal(bounds.children,0,'website is a direct BrowserWindow, not a nested webview or tool shell');
    await checkpoint(mode+': 完整网页独立默认窗口、轻量小管家、中文路径与专用运行时',{runtime:locator.runtimeVersion});

    await focus(manager);await manager.getByTestId('desktop-refresh').click();
    await until(async()=>(await manager.locator('#notice').textContent()).includes('状态已刷新'));
    assert.equal((await invoke('status')).hub.running,false);
    for(const[action,data]of [['run',{command:'cmd.exe'}],['start',{node_id:'../../outside/config.json'}],['stop',{node_id:randomUUID()}],['copy-mcp',{node_id:randomUUID()}],['settings',{openAtLogin:true,stopHubOnExit:false,command:'cmd.exe'}],['add',{token:'not accepted'}],['check-update',{url:'https://attacker.invalid'}],['open-update',{url:'https://attacker.invalid'}]]){
      const result=await manager.evaluate(async({action,data})=>{try{await window.islandDesktop.invoke(action,data);return{allowed:true}}catch(e){return{allowed:false,message:e.message}}},{action,data});
      assert.equal(result.allowed,false,action+' must reject invalid IPC');
    }
    await checkpoint(mode+': 刷新不启动Hub，已删除身份操作、未知动作及越界参数拒绝');

    const intruderPreload=mode==='development'?resolve(root,'apps/desktop/src/preload.cjs'):resolve(dirname(exe),'resources/app.asar/src/preload.cjs');
    const intruder=await app.evaluate(async({BrowserWindow,webContents},preload)=>{
      const owner=webContents.getAllWebContents().find(w=>w.getURL()==='island-desktop://app/index.html');
      if(!owner)throw Error('local owner window missing');
      const test=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false}});
      try{await test.loadURL('island-desktop://app/index.html');return await test.webContents.executeJavaScript("typeof window.islandDesktop==='undefined'?({bridge:false,allowed:false}):window.islandDesktop.invoke('status').then(()=>({bridge:true,allowed:true}),e=>({bridge:true,allowed:false,message:e.message}))")}
      finally{test.destroy()}
    },intruderPreload);
    assert.equal(intruder.bridge,true);assert.equal(intruder.allowed,false);assert.match(intruder.message,/拒绝非本机/);
    await checkpoint(mode+': 同URL/同preload的非小管家窗口不能调用IPC');

    await focus(cloud);await cloud.getByTestId('cloud-draft').fill('保留未发送消息');
    assert.deepEqual(await cloud.evaluate(()=>({bridge:typeof window.islandDesktop,require:typeof require,node:typeof process})),{bridge:'undefined',require:'undefined',node:'undefined'});
    const preferences=await app.evaluate(({webContents},origin)=>{
      const w=webContents.getAllWebContents().find(w=>w.getURL().startsWith(origin+'/')),p=w.getLastWebPreferences();
      return{nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,sandbox:p.sandbox,preload:!!p.preload,webSecurity:p.webSecurity};
    },fixture.origin);
    assert.deepEqual(preferences,{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:false,webSecurity:true});
    const visits=fixture.stats().visits;
    await focus(cloud);await cloud.getByTestId('cloud-refresh').click();
    await until(async()=>fixture.stats().refreshes===1);
    assert.equal(await cloud.getByTestId('cloud-draft').inputValue(),'保留未发送消息');
    assert.equal(await cloud.getByTestId('cloud-refresh-count').textContent(),'1');
    assert.equal(fixture.stats().visits,visits);
    await cloud.evaluate(()=>{location.href='island-desktop://app/index.html'});
    await sleep(300);assert.ok(cloud.url().startsWith(fixture.origin+'/'));
    await checkpoint(mode+': 网站无Node/preload/IPC，网页刷新保留草稿，不允许本地协议跳转');
    await focus(manager);await manager.locator('#guide').click();
    const guide=await until(async()=>(await app.windows()).find(p=>p.url()===fixture.origin+'/guide'));
    assert.equal(await guide.evaluate(()=>typeof window.islandDesktop),'undefined');
    assert.equal(await cloud.getByTestId('cloud-draft').inputValue(),'保留未发送消息');
    await guide.close();
    await checkpoint(mode+': 指南独立沙箱窗口，不替换聊天或丢失草稿');

    // Fixture setup uses controller API, NOT removed GUI enrollment IPC.
    fixtureController=new DesktopController({home,origin:fixture.origin,payload:mode==='packaged'?resolve(dirname(exe),'resources/client-payload'):sourcePayload,nodeSource:packagedNode,desktopExe:exe,version:status.version});
    const workspace=resolve(home,'workspaces','agent one'),secondWorkspace=resolve(home,'workspaces','agent two');
    await mkdir(workspace,{recursive:true});await mkdir(secondWorkspace,{recursive:true});
    const runner=resolve(workspace,'fixture-agent.mjs');
    await writeFile(runner,"if(process.argv.includes('--version'))console.log('desktop fixture');else{for await(const b of process.stdin){}console.log(JSON.stringify({message:'fixture only',done:true,acknowledge:false}))}\n");
    await fixtureController.addIdentity({code:'DESKTOP-FIXTURE-1',name:'独立执行器一',adapter:'cli',command:locator.node,args:[runner],workspace,allowDevelopment:false});
    const first=await until(async()=>{const s=await invoke('status');return s.identities.length===1&&s.identities[0].connected?s:false},90000);
    hubPID=first.hub.pid;assert.ok(hubPID>0);assert.equal(fixture.paired.size,1);
    const firstID=first.identities[0].node_id;
    await fixtureController.startIdentity(firstID);
    assert.equal((await invoke('status')).hub.pid,hubPID);assert.equal([...fixture.paired.values()][0].connections,1);
    await fixtureController.addIdentity({code:'DESKTOP-FIXTURE-2',name:'独立执行器二',adapter:'cli',command:locator.node,args:[runner],workspace:secondWorkspace,allowDevelopment:false});
    const both=await until(async()=>{const s=await invoke('status');return s.identities.length===2&&s.identities.every(p=>p.connected)?s:false},90000);
    assert.equal(both.hub.pid,hubPID);
    for(const p of fixture.paired.values())assert.ok(!JSON.stringify(both).includes(p.token));
    assert.ok(!JSON.stringify(both).includes(home.replaceAll('\\','\\\\')));
    // The independent website/guide may have foregrounded or minimized this
    // native settings window. Restore it before user input, without force-click.
    await focus(manager);await manager.getByTestId('desktop-refresh').click();
    await until(async()=>(await manager.locator('#notice').textContent()).includes('状态已刷新'));
    await manager.locator('#identities').getByText('独立执行器二').waitFor();
    assert.equal(await manager.locator('#identities button').count(),0);
    await fixtureController.stopIdentity(firstID);
    await until(async()=>!(await invoke('status')).identities.find(p=>p.node_id===firstID).running);
    assert.ok((await invoke('status')).identities.find(p=>p.node_id!==firstID).connected);
    await fixtureController.startIdentity(firstID);
    await until(async()=>(await invoke('status')).identities.every(p=>p.connected));
    await checkpoint(mode+': 预置双身份只读显示、凭据路径不外泄、复用Hub与单身份隔离（非GUI配对）');

    const registry=JSON.parse(await readFile(resolve(clientRoot,'.data/hub/registry.json'),'utf8'));
    const configHashes=new Map(await Promise.all(registry.agents.map(async p=>[p.file,sha(await readFile(p.file))])));
    await mainWindow.evaluate(w=>w.close());
    await until(async()=>!(await mainWindow.evaluate(w=>w.isVisible())));
    assert.equal((await sdk.runtimeStatus(resolve(clientRoot,'.data/hub/registry.json'))).pid,hubPID);
    await focus(manager);await manager.getByTestId('desktop-refresh').click();
    assert.equal((await invoke('status')).hub.pid,hubPID);
    await checkpoint(mode+': 正式窗口X默认隐藏托盘，不退出GUI、不停止Hub');
    await focus(manager);await manager.locator('#stop-hub-on-exit').check();
    await until(async()=>(await invoke('status')).settings.stopHubOnExit===true);
    await manager.screenshot({path:resolve(artifacts,mode+'-keeper.png')});
    await mainWindow.evaluate(w=>{w.show();w.close()});
    await until(async()=>!(await sdk.runtimeStatus(resolve(clientRoot,'.data/hub/registry.json'))),30000);
    const stoppedApp=app;app=null;await exitGUI(stoppedApp);
    await checkpoint(mode+': 开启退出小管家后X确认Hub停止再退出GUI');

    app=await launch();manager=await getKeeper();
    await until(async()=>(await invoke('status')).progress?.phase==='ready',90000);
    const reopened=await invoke('status');assert.equal(reopened.hub.running,false);assert.equal(reopened.identities.length,2);
    for(const [file,hash]of configHashes)assert.equal(sha(await readFile(file)),hash);
    assert.equal(fixture.paired.size,2);
    await invoke('settings',{openAtLogin:true,stopHubOnExit:false});
    assert.deepEqual(JSON.parse(await readFile(resolve(home,'.island-node/desktop-settings.json'),'utf8')),{openAtLogin:true,stopHubOnExit:false});
    const snapshotCloud=await getCloud();await focus(snapshotCloud);
    await snapshotCloud.screenshot({path:resolve(artifacts,mode+'-website.png')});
    const reopenedApp=app;app=null;await exitGUI(reopenedApp);
    await checkpoint(mode+': 重开配置SHA与配对次数不变，偏好保存到隔离home');

    const beforeStartupVisits=fixture.stats().visits;
    app=await launch(['--hub-only','--startup']);
    await until(async()=>(await sdk.runtimeStatus(resolve(clientRoot,'.data/hub/registry.json')))?.running,90000);
    assert.equal((await app.windows()).length,0);
    assert.equal(fixture.stats().visits,beforeStartupVisits);
    assert.equal(fixture.paired.size,2);
    const backgroundPID=app.process().pid;
    const backgroundArgs=mode==='packaged'?['--smoke-test','--hub-only','--startup']:[resolve(root,'apps/desktop/src/main.mjs'),'--smoke-test','--hub-only','--startup'];
    const repeatedBackground=spawn(exe,backgroundArgs,{env,windowsHide:true,stdio:'ignore'});
    await until(()=>repeatedBackground.exitCode!==null,20000);assert.equal(repeatedBackground.exitCode,0);
    assert.equal((await app.windows()).length,0);
    assert.equal(fixture.stats().visits,beforeStartupVisits);
    const legacyStartup=spawn(exe,mode==='packaged'?['--smoke-test','--startup']:[resolve(root,'apps/desktop/src/main.mjs'),'--smoke-test','--startup'],{env,windowsHide:true,stdio:'ignore'});
    await until(()=>legacyStartup.exitCode!==null,20000);assert.equal(legacyStartup.exitCode,0);
    assert.equal((await app.windows()).length,0);
    assert.equal(fixture.stats().visits,beforeStartupVisits);
    const second=spawn(exe,mode==='packaged'?['--smoke-test']: [resolve(root,'apps/desktop/src/main.mjs'),'--smoke-test'],{env,windowsHide:true,stdio:'ignore'});
    await until(()=>second.exitCode!==null,20000);assert.equal(second.exitCode,0);
    const reopenedCloud=await getCloud();assert.equal(app.process().pid,backgroundPID);
    assert.equal(await reopenedCloud.evaluate(()=>typeof window.islandDesktop),'undefined');
    assert.equal(fixture.paired.size,2);
    for(const [file,hash]of configHashes)assert.equal(sha(await readFile(file)),hash);
    await checkpoint(mode+': 后台及重复/旧startup启动不弹网站，普通第二实例复用同一GUI（非真实开机验收）');
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
