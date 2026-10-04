import {app,BrowserWindow,ipcMain,protocol,net,dialog,shell,Tray,Menu,nativeImage} from 'electron';
import {resolve,dirname,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,writeFile,mkdir,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DesktopController} from './controller.mjs';
import {ACTIONS,OFFICIAL_ORIGIN,permittedNavigation} from './security.mjs';
import {readPreferences,validatePreferences,loginItemOptions,applyExitPolicy} from './preferences.mjs';
import {createUpdateChecker} from './updates.mjs';
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
// Legacy 0.4.0 startup entries are also quiet. Respect Windows startup approval:
// registration is changed only by the user's settings action, not each launch.
const preparing=process.argv.includes('--prepare-client'),backgroundOnly=process.argv.includes('--hub-only')||process.argv.includes('--startup');
protocol.registerSchemesAsPrivileged([{scheme:'island-desktop',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let window,keeper,controller,tray,quitting=false,busy=false,exitPromise,readyPromise,settings=readPreferences(),lastProgress={phase:'idle',percent:0,message:'正在检查小管家…'},lastUpdate;
const updates=createUpdateChecker({currentVersion:options.version});
const cloudContents=new Set(),settingsFile=resolve(home,'.island-node/desktop-settings.json');
const report=p=>{lastProgress=p;if(keeper&&!keeper.isDestroyed())keeper.webContents.send('island-progress',p)};
const statusSafeError=e=>String(e?.message||e).replace(/(?:Bearer\s+|token["']?\s*[:=]\s*["']?)[a-z0-9._~-]+/ig,'[已脱敏]').slice(0,900);
async function external(url){
  let u;try{u=new URL(url)}catch{return}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return;
  const result=await dialog.showMessageBox(window&&!window.isDestroyed()?window:keeper,{type:'question',buttons:['取消','在浏览器打开'],defaultId:0,cancelId:0,message:'离开协作岛，打开外部链接？',detail:u.origin});
  if(result.response===1)await shell.openExternal(u.href);
}
function lockCloud(web){
  cloudContents.add(web);web.once('destroyed',()=>cloudContents.delete(web));
  web.setWindowOpenHandler(({url})=>{if(permittedNavigation(url,origin))void popup(url);else void external(url);return{action:'deny'}});
  web.on('will-navigate',(event,url)=>{if(!permittedNavigation(url,origin)){event.preventDefault();void external(url)}});
  web.on('will-redirect',(event,url)=>{if(!permittedNavigation(url,origin))event.preventDefault()});
  web.on('will-attach-webview',event=>event.preventDefault());
}
function cloudPreferences(){return{partition:test?'persist:island-test':'persist:island-cloud',nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}}
async function popup(url){
  if(!permittedNavigation(url,origin))throw Error('网页来源无效。');
  const child=new BrowserWindow({parent:window,width:1000,height:800,title:'协作岛 · 查看',webPreferences:cloudPreferences()});
  child.setMenuBarVisibility(false);lockCloud(child.webContents);await child.loadURL(url);
}
async function showWebsite(){
  if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();return}
  window=new BrowserWindow({width:1280,height:900,minWidth:850,minHeight:620,show:false,title:'协作岛',icon:resolve(here,'../assets/island.png'),backgroundColor:'#f7f7f4',webPreferences:cloudPreferences()});
  window.setMenuBarVisibility(false);lockCloud(window.webContents);
  window.webContents.session.setPermissionRequestHandler((web,permission,callback,details)=>callback(cloudContents.has(web)&&permission==='clipboard-sanitized-write'&&permittedNavigation(details.requestingUrl||web.getURL(),origin)));
  window.webContents.session.setPermissionCheckHandler((web,permission,requestingOrigin)=>cloudContents.has(web)&&permission==='clipboard-sanitized-write'&&requestingOrigin===origin);
  window.webContents.session.on('will-download',(_event,item)=>item.setSaveDialogOptions({title:'保存文件（不会自动执行）',defaultPath:item.getFilename()}));
  window.webContents.on('did-fail-load',(_event,code,_desc,_url,isMain)=>{if(isMain&&code!==-3)report({phase:'offline',message:'网站暂时无法连接；可从托盘打开小管家查看本机状态。'})});
  window.on('close',event=>{if(!quitting){event.preventDefault();if(settings.stopHubOnExit)void requestExit();else window.hide()}});
  await window.loadURL(origin+'/').catch(e=>report({phase:'offline',message:'网站暂时无法连接，可从托盘打开小管家。'+statusSafeError(e)}));window.show();
}
async function showKeeper(){
  if(keeper&&!keeper.isDestroyed()){if(keeper.isMinimized())keeper.restore();keeper.show();keeper.focus();return}
  keeper=new BrowserWindow({width:650,height:760,minWidth:470,minHeight:540,show:false,title:'协作岛小管家',icon:resolve(here,'../assets/island.png'),backgroundColor:'#f7f7f4',webPreferences:{preload:resolve(here,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  keeper.setMenuBarVisibility(false);keeper.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  keeper.webContents.on('will-navigate',(event,url)=>{if(url!=='island-desktop://app/index.html')event.preventDefault()});
  await keeper.loadURL('island-desktop://app/index.html');keeper.show();report(lastProgress);
}
async function requestExit(){
  if(exitPromise)return exitPromise;
  exitPromise=(async()=>{
    try{
      const selected={...settings};
      await applyExitPolicy({settings:selected,stopHub:async()=>{await readyPromise;await controller.stopHub()},quit:async()=>{quitting=true;app.quit()}});
    }catch(e){
      report({phase:'error',message:'未能确认小管家停止，暂不退出：'+statusSafeError(e)});
      await showKeeper();
      await dialog.showMessageBox(keeper,{type:'error',message:'小管家没有确认退出',detail:statusSafeError(e),buttons:['返回检查']});
    }finally{exitPromise=null}
  })();return exitPromise;
}
function createTray(){
  tray=new Tray(nativeImage.createFromPath(resolve(here,'../assets/island.png')).resize({width:16,height:16}));tray.setToolTip('协作岛小管家');
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'打开协作岛',click:()=>void showWebsite()},
    {label:'协作岛小管家 · 状态与设置',click:()=>void showKeeper()},
    {type:'separator'},
    {label:'退出协作岛（遵循小管家设置）',click:()=>void requestExit()},
  ]));tray.on('double-click',()=>void showWebsite());
}
async function saveSettings(data){
  const selected=validatePreferences(data),prior={...settings};
  const temp=settingsFile+'.'+randomUUID()+'.tmp';
  try{
    if(!test){
      const registration=loginItemOptions(process.execPath,selected.openAtLogin);app.setLoginItemSettings(registration);
      const actual=app.getLoginItemSettings({path:registration.path,args:registration.args});
      if(actual.openAtLogin!==selected.openAtLogin||(selected.openAtLogin&&!actual.executableWillLaunchAtLogin))throw Error('Windows 开机启动设置未能确认，未保存为成功。');
    }
    await mkdir(dirname(settingsFile),{recursive:true,mode:0o700});
    await writeFile(temp,JSON.stringify(selected),{mode:0o600,flag:'wx'});await rename(temp,settingsFile);
    settings=selected;return{...settings};
  }catch(e){
    if(!test)app.setLoginItemSettings(loginItemOptions(process.execPath,prior.openAtLogin));
    await unlink(temp).catch(error=>{if(error.code!=='ENOENT')console.error('设置暂存文件保留，请检查。')});throw e;
  }
}
// ESM must finish evaluation before ready; do not top-level-await app.whenReady().
app.whenReady().then(async()=>{
  controller=new DesktopController({...options,onProgress:report});
  if(preparing){try{await controller.prepare();app.exit(0)}catch(e){console.error(statusSafeError(e));app.exit(1)}return}
  if(!app.requestSingleInstanceLock()){quitting=true;app.quit();return}
  app.on('second-instance',(_event,args)=>{if(!args.includes('--hub-only')&&!args.includes('--startup'))void showWebsite()});
  protocol.handle('island-desktop',request=>{
    const u=new URL(request.url),allowed=new Set(['index.html','app.js','style.css']),file=u.pathname.slice(1);
    if(u.hostname!=='app'||!allowed.has(file))return new Response('Not found',{status:404});
    return net.fetch(pathToFileURL(resolve(ui,file)).href);
  });
  try{const text=await readFile(settingsFile,'utf8');if(text.length>4096)throw Error('设置文件过大。');settings=readPreferences(JSON.parse(text))}catch(e){if(e.code!=='ENOENT')console.error('小管家设置读取失败，使用安全默认设置。')}
  ipcMain.handle('island-desktop',async(event,action,data)=>{
    if(!keeper||keeper.isDestroyed()||event.sender!==keeper.webContents||event.senderFrame!==keeper.webContents.mainFrame||event.senderFrame.url!=='island-desktop://app/index.html'||!ACTIONS.has(action))throw Error('拒绝非本机小管家界面的调用。');
    const mutation=['prepare','settings'].includes(action);
    if(mutation&&busy)throw Error('另一项本机操作正在进行，请稍候。');
    if(mutation)busy=true;
    try{
      if(action==='status'||action==='refresh'){
        let state;try{state=await controller.status()}catch(e){state={installed:null,version:options.version,hub:{running:false,state:'unknown'},identities:[],statusError:statusSafeError(e)}}
        return{...state,settings:{...settings},progress:lastProgress};
      }
      if(action==='prepare'){await readyPromise;return await controller.prepare()}
      if(action==='guide'){await popup(origin+'/guide');return{opened:true}}
      if(action==='settings')return await saveSettings(data);
      if(action==='check-update'){if(data!=null)throw Error('更新检查不接受地址或凭据。');lastUpdate=await updates.check({force:true});return lastUpdate}
      if(action==='open-update'){
        if(data!=null||!lastUpdate?.url||!/^https:\/\/github\.com\/mitang-ai\/agentxzlts\/releases\/tag\/desktop-v\d+\.\d+\.\d+$/.test(lastUpdate.url))throw Error('请先检查有效的 GitHub 桌面版发布。');
        await shell.openExternal(lastUpdate.url);return{opened:true};
      }
    }catch(e){throw Error(statusSafeError(e))}finally{if(mutation)busy=false}
  });
  if(backgroundOnly&&process.argv.includes('--startup')&&!settings.openAtLogin){quitting=true;app.quit();return}
  if(!test||process.env.ISLAND_DESKTOP_TEST_TRAY==='1')createTray();
  readyPromise=(async()=>{try{await controller.prepare();if(backgroundOnly&&settings.openAtLogin)await controller.startHub();report({phase:'ready',percent:100,message:'小管家组件已就绪。'})}catch(e){report({phase:'error',message:statusSafeError(e)})}})();
  if(!backgroundOnly)await showWebsite();
  // Automated fixture opt-in only. Production settings are opened from tray.
  if(test&&process.argv.includes('--show-keeper'))await showKeeper();
}).catch(e=>{console.error(statusSafeError(e));app.exit(1)});
app.on('before-quit',event=>{if(!quitting&&!preparing){event.preventDefault();void requestExit()}});
// Closing the keeper/settings window must not terminate the website or Hub.
app.on('window-all-closed',()=>{});
