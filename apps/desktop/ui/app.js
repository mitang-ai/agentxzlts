const $ = id => document.getElementById(id);
const bridge = window.islandDesktop;
let statusRequest = null;
let settingsBusy = false;
let progressActive = false;

function notice(message) {
  $('notice').textContent = message;
}

async function invoke(action, data) {
  try {
    if (!bridge) throw new Error('无法读取本机状态，请从已安装的协作岛打开小管家。');
    return await bridge.invoke(action, data);
  } catch (error) {
    notice(error.message || '操作未完成，请稍后再试。');
    throw error;
  }
}

function render(status) {
  if (!settingsBusy && status.settings) {
    $('autostart').checked = status.settings.openAtLogin === true;
    $('stop-hub-on-exit').checked = status.settings.stopHubOnExit === true;
    $('autostart').disabled = false;
    $('stop-hub-on-exit').disabled = false;
  }
  $('version').textContent = status.version ? `版本 ${status.version}` : '';
  const running = status.hub?.running === true;
  $('hub').textContent = status.statusError ? '状态暂时无法核实' : !status.installed ? '小管家尚未就绪' : running ? '小管家正在运行' : '小管家未运行';
  if (status.statusError) notice(status.statusError);
  $('hub').dataset.running = String(running);
  if (!progressActive) $('progress-box').hidden = true;
  const identities = $('identities');
  identities.replaceChildren();
  if (!status.identities?.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '暂未发现本客户端登记的 Agent。已有连接不会因刷新而被删除。';
    identities.append(empty);
    return;
  }
  for (const identity of status.identities) {
    const row = document.createElement('div');
    row.className = 'identity';
    const name = document.createElement('strong');
    name.textContent = identity.name || identity.host || 'Agent';
    const detail = document.createElement('span');
    detail.textContent = identity.running ? (identity.connected ? '连接已建立' : '运行中 · 尚未连接') : '已停止';
    row.append(name, detail);
    identities.append(row);
  }
}

async function load() {
  if (statusRequest) return statusRequest;
  statusRequest = invoke('status').then(status => { render(status); return status; });
  try { return await statusRequest; } finally { statusRequest = null; }
}

$('refresh').onclick = async () => {
  $('refresh').disabled = true;
  try {
    const status = await load();
    if (!status.statusError) notice('状态已刷新，不会重新连接或停止小管家。');
  } catch { /* invoke already displays the error */ }
  finally { $('refresh').disabled = false; }
};

async function saveSettings(changedInput) {
  settingsBusy = true;
  $('autostart').disabled = true;
  $('stop-hub-on-exit').disabled = true;
  try {
    await invoke('settings', {
      openAtLogin: $('autostart').checked,
      stopHubOnExit: $('stop-hub-on-exit').checked,
    });
    notice('后台偏好已保存。');
  } catch { changedInput.checked = !changedInput.checked; }
  finally {
    settingsBusy = false;
    $('autostart').disabled = false;
    $('stop-hub-on-exit').disabled = false;
  }
}

for (const id of ['autostart', 'stop-hub-on-exit']) {
  $(id).onchange = event => saveSettings(event.target);
}

$('check-update').onclick = async () => {
  $('check-update').disabled = true;
  $('open-update').hidden = true;
  $('update-result').textContent = '正在查询官方 GitHub 发布…';
  try {
    const result = await invoke('check-update');
    if (result.status === 'error' || result.stale || result.error) {
      const message = result.error?.message || 'GitHub 暂时无法访问';
      $('update-result').textContent = `${message}，尚未确认是否有更新。`;
      if (result.stale && result.latestVersion) {
        $('update-result').textContent += ` 上次查询到的版本为 ${result.latestVersion}（旧缓存，仅供参考）。`;
      }
      return;
    }
    if (result.status === 'available') {
      $('update-result').textContent = `发现新版本 ${result.latestVersion}，当前版本 ${result.currentVersion}。更新不会自动下载安装。`;
      $('open-update').hidden = false;
    } else if (result.status === 'current') {
      $('update-result').textContent = `当前 ${result.currentVersion} 已是最新正式版本。`;
    } else if (result.status === 'ahead') {
      $('update-result').textContent = `当前版本 ${result.currentVersion} 高于 GitHub 最新正式版本 ${result.latestVersion}，无需降级。`;
    } else {
      throw new Error('未能确认 GitHub 最新发布，请稍后重试。');
    }
    if (result.cached) $('update-result').textContent += '（使用近期查询结果）';
  } catch (error) {
    $('update-result').textContent = error.message || 'GitHub 暂时无法访问，尚未确认是否有更新。';
  } finally { $('check-update').disabled = false; }
};

$('open-update').onclick = async () => {
  $('open-update').disabled = true;
  try { await invoke('open-update'); }
  catch { /* invoke already displays the error */ }
  finally { $('open-update').disabled = false; }
};

$('guide').onclick = async () => {
  try { await invoke('guide'); } catch { /* invoke already displays the error */ }
};

bridge?.onProgress(progress => {
  if (progress.phase === 'view') return;
  if (progress.phase === 'ready') {
    progressActive = false;
    $('progress-box').hidden = true;
    load().catch(() => {});
    return;
  }
  progressActive = true;
  $('progress-box').hidden = false;
  if (Number.isFinite(progress.percent)) {
    $('progress').value = Math.max(0, Math.min(100, progress.percent));
  } else {
    $('progress').removeAttribute('value');
  }
  if (progress.message) $('progress-label').textContent = progress.message;
});

load().catch(() => {});
setInterval(() => {
  if (!document.hidden) load().catch(() => {});
}, 10000);
