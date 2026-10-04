const $=id=>document.getElementById(id),bridge=window.islandDesktop;
let mode='manager';
const notice=message=>{$('notice').textContent=message};
async function invoke(action,data){try{return await bridge.invoke(action,data)}catch(e){notice(e.message);throw e}}
function render(s){
  if(s.settings)$('autostart').checked=s.settings.openAtLogin===true;
  $('hub').textContent=!s.installed?'客户端尚未就绪':s.hub.running?'共享 Hub 正在运行':'客户端已安装，尚无运行中的 Hub';
  const box=$('identities');box.replaceChildren();
  if(!s.identities.length){box.textContent='尚无登记身份。已有身份不会因刷新、更新界面而被删除。';return}
  for(const p of s.identities){
    const row=document.createElement('div');row.className='identity';
    const info=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('p');
    title.textContent=p.name||p.host||p.adapter;detail.textContent=`${p.adapter} · ${p.running?'运行中':'已停止'} · ${p.connected?'传输已连接':'传输未连接'} · ${p.modelReady?'执行器就绪':p.adapter==='mcp'?'手动领取任务':'模型执行能力需任务验证'}`;
    info.append(title,detail);row.append(info);
    for(const[action,label]of [[p.running?'stop':'start',p.running?'停止此 Agent':'启动此 Agent'],...(p.adapter==='mcp'?[['copy-mcp','复制 MCP 配置']]:[])]){
      const button=document.createElement('button');button.textContent=label;button.onclick=async()=>{button.disabled=true;try{await invoke(action,{node_id:p.node_id});await load();notice(action==='copy-mcp'?'已复制到本机剪贴板，未上传云端。':'操作完成。')}finally{button.disabled=false}};row.append(button);
    }box.append(row);
  }
}
async function load(){render(await invoke('status'))}
async function view(next){const r=await invoke(next);mode=r.view||next;$('local').hidden=mode!=='manager';for(const id of ['web','manager','guide'])$(id).classList.toggle('active',id===(mode==='website'?'web':mode));if(mode==='manager')await load()}
$('web').onclick=()=>view('website');$('manager').onclick=()=>view('manager');$('guide').onclick=()=>view('guide');$('back').onclick=()=>view('manager');
$('refresh').onclick=async()=>{const result=await invoke('refresh');if(mode==='manager')render(result);notice(result.refreshed===false?'已取消刷新，保留当前页面。':'已刷新；不会重启 Hub、清除登录或重新生成配对码。')};
$('prepare').onclick=async()=>{await invoke('prepare');await load()};
for(const kind of ['workspace','command'])$('pick-'+kind).onclick=async()=>{const r=await invoke('pick-'+kind);if(r.path)$('add-form').elements[kind].value=r.path};
$('add-form').onsubmit=async event=>{
  event.preventDefault();const f=event.currentTarget.elements;let args;try{args=JSON.parse(f.args.value)}catch{notice('程序参数必须是 JSON 字符串数组。');return}
  $('add-submit').disabled=true;
  try{const r=await invoke('add',{code:f.code.value,name:f.name.value,adapter:f.adapter.value,workspace:f.workspace.value,command:f.command.value,endpoint:f.endpoint.value,args,allowDevelopment:f.allowDevelopment.checked});f.code.value='';$('add-result').textContent=r.manualOnly?'已配对，请把 MCP 配置添加到宿主并主动领取任务。':'已登记，房间审批和执行器就绪状态请分别查看。';await load()}
  catch(e){$('add-result').textContent=e.message}finally{$('add-submit').disabled=false}
};
$('autostart').onchange=async event=>{try{await invoke('settings',{openAtLogin:event.target.checked});notice('启动偏好已保存。')}catch{event.target.checked=!event.target.checked}};
bridge.onProgress(p=>{
  if(p.phase==='view')return;
  if(Number.isFinite(p.percent))$('progress').value=p.percent;
  if(p.message){$('progress-label').textContent=p.message;notice(p.message)}
  if(p.phase==='ready')load().catch(()=>{});
});
load().catch(()=>{});
setInterval(()=>{if(mode==='manager')load().catch(()=>{})},10000);
