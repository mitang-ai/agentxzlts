import {describe,it,expect} from 'vitest';
// @ts-ignore Executable desktop module.
import {readPreferences,validatePreferences,loginItemOptions,applyExitPolicy} from '../apps/desktop/src/preferences.mjs';
// @ts-ignore
import {ACTIONS} from '../apps/desktop/src/security.mjs';
describe('协作岛小管家偏好与退出策略',()=>{
  it('默认保留后台，旧设置兼容但不把字符串当作授权',()=>{
    expect(readPreferences()).toEqual({openAtLogin:false,stopHubOnExit:false});
    expect(readPreferences({openAtLogin:true})).toEqual({openAtLogin:true,stopHubOnExit:false});
    expect(readPreferences({openAtLogin:'true',stopHubOnExit:'true'})).toEqual({openAtLogin:false,stopHubOnExit:false});
  });
  it('只接受两项明确布尔值，不接受程序、路径或任意操作',()=>{
    const valid={openAtLogin:true,stopHubOnExit:true};
    expect(validatePreferences(valid)).toEqual(valid);
    expect(validatePreferences(valid)).not.toBe(valid);
    for(const invalid of [null,[],{},true,{openAtLogin:true},{openAtLogin:true,stopHubOnExit:1},{...valid,command:'cmd.exe'},{...valid,path:'private'}])expect(()=>validatePreferences(invalid)).toThrow();
  });
  it('开机启动只运行小管家，不打开网站；关闭仍指向同一启动项',()=>{
    for(const enabled of [true,false])expect(loginItemOptions('C:\\with spaces\\Island.exe',enabled)).toEqual({openAtLogin:enabled,path:'C:\\with spaces\\Island.exe',args:['--hub-only','--startup']});
  });
  it('默认退出不停止共享Hub',async()=>{
    const calls:string[]=[];
    await applyExitPolicy({settings:readPreferences(),stopHub:async()=>calls.push('stop'),quit:async()=>calls.push('quit')});
    expect(calls).toEqual(['quit']);
  });
  it('明确选择同时退出时先确认Hub停止，再退出GUI',async()=>{
    const calls:string[]=[];
    await applyExitPolicy({settings:{stopHubOnExit:true},stopHub:async()=>calls.push('confirmed-stop'),quit:async()=>calls.push('quit')});
    expect(calls).toEqual(['confirmed-stop','quit']);
  });
  it('Hub停止失败必须阻止退出，不掩盖为成功',async()=>{
    let quit=false;
    await expect(applyExitPolicy({settings:{stopHubOnExit:true},stopHub:async()=>{throw Error('fixture stop failure')},quit:async()=>{quit=true}})).rejects.toThrow('fixture stop failure');
    expect(quit).toBe(false);
  });
  it('桌面IPC不再暴露手动配对、路径选择或身份执行器操作',()=>{
    for(const removed of ['add','start','stop','pick-workspace','pick-command','copy-mcp','website','manager'])expect(ACTIONS.has(removed)).toBe(false);
    expect([...ACTIONS].sort()).toEqual(['status','prepare','guide','refresh','settings','check-update','open-update'].sort());
  });
});
