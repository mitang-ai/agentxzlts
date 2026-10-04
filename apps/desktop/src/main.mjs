import {app,BrowserWindow,WebContentsView,ipcMain,protocol,net,dialog,shell,clipboard,Tray,Menu,nativeImage} from 'electron';
import {resolve,dirname,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {DesktopController} from './controller.mjs';
import {ACTIONS,OFFICIAL_ORIGIN,permittedNavigation} from './security.mjs';
const here=dirname(fileURLToPath(import.meta.url)),ui=resolve(here,'../ui');
if(process.env.ISLAND_DESKTOP_TEST==='1'&&!process.argv.includes('--smoke-test'))throw Error('测试标志缺少 --smoke-test，拒绝回退真实用户目录。');
const test=process.env.ISLAND_DESKTOP_TEST==='1'&&process.argv.includes('--smoke-test');
const home=test?process.env.ISLAND_DESKTOP_TEST_HOME:homedir();
if(!home||!isAbsolute(home)||(test&&resolve(home)===resolve(homedir())))throw Error('测试必须指定隔离目录。');
const origin=test?process.env.ISLAND_DESKTOP_TEST_ORIGIN:OFFICIAL_ORIGIN;
if(test&&(!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin||'')))throw Error('测试来源必须为本机回环。');
const resource=app.isPackaged?process.resourcesPath:resolve(here,'../../../.data/desktop-release/resources');
const options={home,origin,version:app.getVersion(),desktopExe:process.execPath,
  payload:test&&process.env.ISLAND_DESKTOP_TEST_PAYLOAD||resolve(resource,'client-payload'),
  nodeSource:test&&process.env.ISLAND_DESKTOP_TEST_NODE||resolve(resource,'runtime/node.exe')};
if(test)app.setPath('userData',resolve(home,'desktop-session'));
const preparing=process.argv.includes('--prepare-client');
protocol.registerSchemesAsPrivileged([{scheme:'island-desktop',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let window,remote,controller,tray,quitting=false,current='manager',busy=false,settings={openAtLogin:false};
const cloudContents=new Set();
const settingsFile=resolve(home,'.island-node/desktop-settings.json');
const report=p=>{if(window&&!window.isDestroyed())window.webContents.send('island-progress',p)};
const statusSafeError=e=>String(e?.message||e).replace(/(?:Bearer\s+|token["']?\s*[:=]\s*["']?)[a-z0-9._~-]+/ig,'[已脱敏]').slice(0,900);
async function external(url){
  let u;try{u=new URL(url)}catch{return}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return;
  const result=await dialog.showMessageBox(window,{type:'question',buttons:['取消','在浏览器打开'],defaultId:0,cancelId:0,message:'离开协作岛，打开外部链接？',detail:u.origin});
  if(result.response===1)await shell.openExternal(u.href);
}
function resize(){if(!window||!remote)return;const [w,h]=window.getContentSize();remote.setBounds({x:0,y:52,width:w,height:Math.max(1,h-104)})}
async function show(mode){
  if(mode==='guide'){await popup(origin+'/guide');return{view:current,popup:true}}
  current=mode;remote.setVisible(mode!=='manager');
  if(mode==='website'&&!remote.webContents.getURL())await remote.webContents.loadURL(origin+'/');
  window.webContents.send('island-progress',{phase:'view',view:mode});
  return{view:mode};
}
function lockCloud(web){
  cloudContents.add(web);web.once('destroyed',()=>cloudContents.delete(web));
  web.setWindowOpenHandler(({url})=>{if(permittedNavigation(url,origin))void popup(url);else void external(url);return{action:'deny'}});
  web.on('will-navigate',(event,url)=>{if(!permittedNavigation(url,origin)){event.preventDefault();void external(url)}});
  web.on('will-redirect',(event,url)=>{if(!permittedNavigation(url,origin))event.preventDefault()});
  web.on('will-attach-webview',event=>event.preventDefault());
}
async function popup(url){
  if(!permittedNavigation(url,origin))throw Error('网页来源无效。');
  const child=new BrowserWindow({parent:window,width:1000,height:800,title:'协作岛 · 查看',webPreferences:{partition:test?'persist:island-test':'persist:island-cloud',nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  child.setMenuBarVisibility(false);lockCloud(child.webContents);await child.loadURL(url);
}
async function refresh(){
  if(current==='manager')return controller.status();
  if(!permittedNavigation(remote.webContents.getURL(),origin))return{refreshed:false};
  const handled=await remote.webContents.executeJavaScript("!window.dispatchEvent(new CustomEvent('island-desktop-refresh',{cancelable:true}))");
  if(handled)return{refreshed:true,preservedDrafts:true};
  const decision=await dialog.showMessageBox(window,{type:'question',buttons:['取消','刷新页面'],defaultId:0,cancelId:0,message:'此页面需要重新加载。',detail:'登录会保留，但尚未保存的表单内容可能丢失。'});
  if(decision.response===1){remote.webContents.reload();return{refreshed:true,preservedDrafts:false}}
  return{refreshed:false};
}
async function create(){
  window=new BrowserWindow({width:1280,height:900,minWidth:850,minHeight:620,show:false,title:'协作岛',icon:resolve(here,'../assets/island.png'),backgroundColor:'#f7f7f4',
    webPreferences:{preload:resolve(here,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.setMenuBarVisibility(false);
  remote=new WebContentsView({webPreferences:{partition:test?'persist:island-test':'persist:island-cloud',nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  window.contentView.addChildView(remote);remote.setVisible(false);resize();
  lockCloud(remote.webContents);
  remote.webContents.session.setPermissionRequestHandler((web,permission,callback,details)=>callback(cloudContents.has(web)&&permission==='clipboard-sanitized-write'&&permittedNavigation(details.requestingUrl||web.getURL(),origin)));
  remote.webContents.session.setPermissionCheckHandler((web,permission,requestingOrigin)=>cloudContents.has(web)&&permission==='clipboard-sanitized-write'&&requestingOrigin===origin);
  remote.webContents.on('did-fail-load',(_event,code,_desc,_url,isMain)=>{if(isMain&&code!==-3)report({phase:'offline',message:'网页暂时无法连接；本机管理仍可使用。'})});
  remote.webContents.session.on('will-download',(_event,item)=>item.setSaveDialogOptions({title:'保存文件（不会自动执行）',defaultPath:item.getFilename()}));
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('island-desktop://app/'))event.preventDefault()});
  window.on('resize',resize);
  window.on('close',event=>{if(!quitting&&!test){event.preventDefault();window.hide()}});
  await window.loadURL('island-desktop://app/index.html');window.show();
  if(!test||process.env.ISLAND_DESKTOP_TEST_TRAY==='1'){
    tray=new Tray(nativeImage.createFromPath(resolve(here,'../assets/island.png')).resize({width:16,height:16}));tray.setToolTip('协作岛 · 本机 Agent 管理');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'打开协作岛',click:()=>{window.show();window.focus()}},{label:'退出桌面界面（保留 Hub 连接）',click:()=>{quitting=true;app.quit()}}]));tray.on('double-click',()=>{window.show();window.focus()});
  }
  try{await controller.prepare();report({phase:'ready',percent:100,message:'本机客户端已就绪。'});}
  catch(e){report({phase:'error',message:statusSafeError(e)});}
  if(process.argv.includes('--startup')&&settings.openAtLogin){for(const p of await controller.profiles())if(p.enabled)await controller.startIdentity(p.config.node_id).catch(e=>report({phase:'error',message:statusSafeError(e)}));}
}
// An ESM entry must finish evaluation before Electron can emit ready.
// Top-level await app.whenReady() would deadlock the packaged application.
app.whenReady().then(async()=>{
controller=new DesktopController({...options,onProgress:report});
if(preparing){try{await controller.prepare();app.exit(0)}catch(e){console.error(statusSafeError(e));app.exit(1)}}else{
  if(!app.requestSingleInstanceLock()){app.quit()}else{
    app.on('second-instance',()=>{if(window){window.show();window.focus()}});
    protocol.handle('island-desktop',request=>{
      const u=new URL(request.url),allowed=new Set(['index.html','app.js','style.css']);
      const file=u.pathname.slice(1);if(u.hostname!=='app'||!allowed.has(file))return new Response('Not found',{status:404});
      return net.fetch(pathToFileURL(resolve(ui,file)).href);
    });
    try{const s=JSON.parse(await readFile(settingsFile,'utf8'));settings.openAtLogin=s.openAtLogin===true}catch(e){if(e.code!=='ENOENT')console.error('桌面设置读取失败，使用默认不开机启动。')}
    ipcMain.handle('island-desktop',async(event,action,data)=>{
      if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||!event.senderFrame.url.startsWith('island-desktop://app/')||!ACTIONS.has(action))throw Error('拒绝非本机界面的调用。');
      const mutations=['prepare','add','start','stop','settings'];
      if(mutations.includes(action)&&busy)throw Error('另一项本机操作正在进行，请稍候。');
      if(mutations.includes(action))busy=true;
      try{
        if(action==='status')return{...await controller.status(),settings:{...settings}};
        if(action==='prepare')return controller.prepare();
        if(action==='add')return controller.addIdentity(data);
        if(action==='start')return controller.startIdentity(data?.node_id);
        if(action==='stop')return controller.stopIdentity(data?.node_id);
        if(action==='pick-workspace'||action==='pick-command'){
          const result=await dialog.showOpenDialog(window,{title:action==='pick-workspace'?'选择此 Agent 专属工作目录':'选择 Agent 程序',properties:action==='pick-workspace'?['openDirectory','createDirectory']:['openFile']});return{path:result.canceled?'':result.filePaths[0]};
        }
        if(action==='copy-mcp'){clipboard.writeText(await controller.mcpConfiguration(data?.node_id));return{copied:true}}
        if(['website','manager','guide'].includes(action))return show(action);
        if(action==='refresh')return refresh();
        if(action==='settings'){
          if(typeof data?.openAtLogin!=='boolean'||Object.keys(data).some(k=>k!=='openAtLogin'))throw Error('设置参数无效。');
          if(!test)app.setLoginItemSettings({openAtLogin:data.openAtLogin,path:process.execPath,args:['--startup']});
          settings={openAtLogin:data.openAtLogin};await mkdir(dirname(settingsFile),{recursive:true});await writeFile(settingsFile,JSON.stringify(settings),{mode:0o600});return settings;
        }
      }catch(e){throw Error(statusSafeError(e))}finally{if(mutations.includes(action))busy=false}
    });
    await create();
  }
}
}).catch(e=>{console.error(statusSafeError(e));app.exit(1)});
app.on('before-quit',()=>{quitting=true});
app.on('window-all-closed',()=>app.quit());
