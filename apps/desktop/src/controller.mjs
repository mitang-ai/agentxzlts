import {readFile,mkdir,access,realpath} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {installClient} from "./install.mjs";
import {validateIdentityInput,publicStatus} from "./security.mjs";
export class DesktopController{
  constructor(options){Object.assign(this,options);this.version||="0.4.0";this.clientRoot=resolve(this.home,".island-node/client");this.pending=null;}
  async prepare(){this.locator=await installClient(this);this.node=this.locator.node;return{ready:true,reused:this.locator.reused,version:this.version}}
  async sdk(){return import(pathToFileURL(resolve(this.clientRoot,"packages/node/src/runtime.mjs")).href)}
  async profiles(){
    const {hubProfilePath}=await import(pathToFileURL(resolve(this.clientRoot,"packages/node/src/hub.mjs")).href);
    let registry;try{registry=JSON.parse(await readFile(resolve(this.clientRoot,".data/hub/registry.json"),"utf8"))}catch(e){if(e.code==="ENOENT")return[];throw e}
    const out=[];for(const p of registry.agents||[]){
      const file=await hubProfilePath(this.clientRoot,p.file),c=JSON.parse(await readFile(file,"utf8"));
      if(c.node_id!==p.node_id)throw Error("本机身份记录不匹配。");
      if(c.server===this.origin)out.push({file,config:c,enabled:p.enabled===true});
    }return out;
  }
  async owned(id){if(!/^[a-f0-9-]{36}$/i.test(id||""))throw Error("无效的设备身份。");const p=(await this.profiles()).find(p=>p.config.node_id===id);if(!p)throw Error("此身份不属于当前客户端和网站。");return p}
  async status(){
    try{
      await access(resolve(this.clientRoot,"packages/node/bin/island-node.mjs"));const sdk=await this.sdk(),hub=await sdk.runtimeStatus(resolve(this.clientRoot,".data/hub/registry.json"));
      const identities=[];for(const p of await this.profiles()){
        const live=await sdk.runtimeStatus(p.file);
        identities.push(publicStatus({...live,enabled:p.enabled,node_id:p.config.node_id,name:p.config.agent_name,adapter:p.config.adapter,host:p.config.host_name,state:live?.state||"stopped"}));
      }return{installed:true,version:this.version,hub:publicStatus(hub||{}),identities};
    }catch(e){if(e.code==="ENOENT")return{installed:false,version:this.version,hub:publicStatus(),identities:[]};throw e}
  }
  async run(args){
    if(!this.node)await this.prepare();
    return new Promise((yes,no)=>{
      const child=spawn(this.node,[resolve(this.clientRoot,"packages/node/bin/island-node.mjs"),...args],{cwd:this.clientRoot,windowsHide:true,stdio:["ignore","pipe","pipe"],shell:false,env:{...process.env,ISLAND_NODE_CONFIG:""}});
      let output="",errors="";child.stdout.on("data",b=>{output=(output+b).slice(-32768)});child.stderr.on("data",b=>{errors=(errors+b).slice(-32768)});
      const timer=setTimeout(()=>{child.kill();no(Error("本机操作超时；请检查客户端状态，不重复配对。"))},90000);
      child.once("error",e=>{clearTimeout(timer);no(e)});child.once("exit",code=>{clearTimeout(timer);if(code===0)yes(output);else no(Error((errors||output||"Agent 操作失败。").replace(/(?:Bearer\s+|token["']?\s*[:=]\s*["']?)[a-z0-9._~-]+/ig,"[已脱敏]").slice(-900)))});
    });
  }
  async addIdentity(raw){
    if(this.pending)throw Error("当前正在连接一个 Agent，请等待完成。");
    this.pending=true;
    try{return await this.doAddIdentity(raw)}finally{this.pending=null}
  }
  async doAddIdentity(raw){
    const d=validateIdentityInput(raw);if(d.server&&d.server!==this.origin)throw Error("连接地址与当前协作岛不一致。");
    await this.prepare();await mkdir(d.workspace,{recursive:true});
    const workspace=await realpath(d.workspace);
    for(const p of await this.profiles()){const other=await realpath(p.config.workspace);if(workspace===other||workspace.startsWith(other+"/")||workspace.startsWith(other+"\\")||other.startsWith(workspace+"/")||other.startsWith(workspace+"\\"))throw Error("各 Agent 必须选择互不重叠的工作目录。")}
    const file=resolve(this.clientRoot,".data/connections",randomUUID(),"config.json");
    const args=["bootstrap","--hub","--non-interactive","--background","--server",this.origin,"--code",d.code,"--config",file,"--adapter",d.adapter,"--host",{codex:"Codex",claude:"Claude Code",opencode:"OpenCode"}[d.adapter]||d.name,"--name","本机私有设备","--agent-name",d.name,"--workspace",workspace,d.allowDevelopment?"--allow-development":"--no-development"];
    if(d.command)args.push("--command",d.command);if(d.args.length)args.push("--args",JSON.stringify(d.args));if(d.endpoint)args.push("--endpoint",d.endpoint);
    await this.run(args);const c=JSON.parse(await readFile(file,"utf8"));if(d.adapter==="mcp")await this.run(["start","--managed","--background","--config",file]);return{node_id:c.node_id,paired:true,manualOnly:d.adapter==="mcp"};
  }
  async startIdentity(id){const p=await this.owned(id);await this.run(["start",...(p.config.adapter==='mcp'?['--managed']:[]),"--background","--config",p.file]);return{ok:true}}
  async stopIdentity(id){const p=await this.owned(id);const sdk=await this.sdk();const live=await sdk.runtimeStatus(p.file);if(live)await sdk.controlRequest(p.file,"stop");return{ok:true}}
  async mcpConfiguration(id){const p=await this.owned(id);if(p.config.adapter!=="mcp")throw Error("此身份不是手动 MCP 方式。");if(!this.node)await this.prepare();return JSON.stringify({mcpServers:{["island-"+id]:{command:this.node,args:[resolve(this.clientRoot,"packages/node/bin/island-node.mjs"),"mcp","--config",p.file]}}},null,2)}
}
