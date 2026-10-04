export const DEFAULT_PREFERENCES=Object.freeze({openAtLogin:false,stopHubOnExit:false});
export function readPreferences(value){
  return {openAtLogin:value?.openAtLogin===true,stopHubOnExit:value?.stopHubOnExit===true};
}
export function validatePreferences(value){
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_PREFERENCES,k))||typeof value.openAtLogin!=="boolean"||typeof value.stopHubOnExit!=="boolean")throw Error("设置参数无效。");
  return {...value};
}
export function loginItemOptions(executable,enabled){
  return {openAtLogin:enabled,path:executable,args:["--hub-only","--startup"]};
}
// Resolve the decision before any async shutdown; changing UI state midway
// through a stop cannot make us quit without confirming the selected policy.
export async function applyExitPolicy({settings,stopHub,quit}){
  if(settings.stopHubOnExit)await stopHub();
  await quit();
}
