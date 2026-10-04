#Requires -Version 5.1
param(
  [string]$ManifestUrl = 'https://www.51wanai.com/desktop/release.json',
  [switch]$Quiet,
  [ValidateRange(1, 1800)][int]$LockTimeoutSeconds = 300,
  [switch]$TestMode,
  [string]$TestHome,
  [string]$TestInstallRoot,
  [switch]$FunctionsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$script:Ui = $null
$script:Progress = $null
$script:Status = $null
$script:CurrentStage = ''
$script:SupportedVersion = '0.4.0'
$script:DownloadTimeoutSeconds = 600

function Update-SetupProgress([string]$Stage, [int]$Percent = -1) {
  if ($script:CurrentStage -ne $Stage) {
    $script:CurrentStage = $Stage
    Write-Output ('ISLAND_SETUP ' + $Stage)
  }
  if ($null -ne $script:Ui) {
    $script:Status.Text = $Stage
    if ($Percent -lt 0) {
      $script:Progress.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
    } else {
      $script:Progress.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
      $script:Progress.Value = [Math]::Min(100, [Math]::Max(0, $Percent))
    }
    [System.Windows.Forms.Application]::DoEvents()
  }
}

function Wait-SetupTask($Task) {
  while (!$Task.IsCompleted) {
    if ($null -ne $script:Ui) { [System.Windows.Forms.Application]::DoEvents() }
    Start-Sleep -Milliseconds 40
  }
  return $Task.GetAwaiter().GetResult()
}

function Assert-SafeSetupPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $part = $full
  while (![string]::IsNullOrEmpty($part)) {
    if ([System.IO.File]::Exists($part) -or [System.IO.Directory]::Exists($part)) {
      if (([System.IO.File]::GetAttributes($part) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'INSTALL_PATH_REPARSE: 安装路径存在链接，已停止；不会覆盖或删除。'
      }
    }
    $parent = [System.IO.Path]::GetDirectoryName($part)
    if ($parent -eq $part) { break }
    $part = $parent
  }
  return $full
}

function Assert-SetupChild([string]$Path, [string]$Root) {
  $full = Assert-SafeSetupPath $Path
  $base = (Assert-SafeSetupPath $Root).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if (!$full.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'INSTALL_PATH_OUTSIDE: 安装路径超出专用目录，已停止。'
  }
  return $full
}

function Get-SetupPaths {
  $homePath = $env:USERPROFILE
  $installPath = Join-Path $env:LOCALAPPDATA 'Programs\Island'
  if ($TestMode) {
    if ([string]::IsNullOrWhiteSpace($TestHome) -or [string]::IsNullOrWhiteSpace($TestInstallRoot)) {
      throw 'TEST_PATH_REQUIRED: 隔离测试必须显式指定两个临时目录。'
    }
    $tempRoot = [System.IO.Path]::GetTempPath()
    $homePath = Assert-SetupChild $TestHome $tempRoot
    $installPath = Assert-SetupChild $TestInstallRoot $tempRoot
  } elseif ($TestHome -or $TestInstallRoot -or $FunctionsOnly) {
    throw 'TEST_MODE_REQUIRED: 测试选项只能在显式 TestMode 下使用。'
  }
  $homePath = Assert-SafeSetupPath $homePath
  $installPath = Assert-SafeSetupPath $installPath
  $statePath = Assert-SafeSetupPath (Join-Path $homePath '.island-node')
  return @{
    Home = $homePath; Install = $installPath; State = $statePath
    Client = (Join-Path $statePath 'client')
    Runtime = (Join-Path $statePath 'runtime')
    Locator = (Join-Path $statePath 'desktop-install.json')
    Lock = (Join-Path $statePath 'desktop-setup.lock')
    Exe = (Join-Path $installPath 'Island.exe')
  }
}

function Assert-SetupUrl([string]$Url, [string]$Kind) {
  $uri = $null
  if (![System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri) -or
      $uri.UserInfo -or $uri.Fragment -or $uri.Query) {
    throw 'RELEASE_URL_INVALID: 下载地址格式无效。'
  }
  if ($TestMode -and $uri.IsLoopback -and $uri.Scheme -eq 'http') { return $uri }
  if ($uri.Scheme -ne 'https' -or !$uri.IsDefaultPort) {
    throw 'RELEASE_URL_INVALID: 下载必须使用官方 HTTPS 地址。'
  }
  if ($Kind -eq 'manifest') {
    if ($uri.Host -ne 'www.51wanai.com' -or $uri.AbsolutePath -ne '/desktop/release.json') {
      throw 'RELEASE_URL_INVALID: 不是官方桌面版本清单。'
    }
  } elseif ($Kind -eq 'installer') {
    $expected = '/mitang-ai/agentxzlts/releases/download/desktop-v' + $script:SupportedVersion + '/Island-Setup-' + $script:SupportedVersion + '-x64.exe'
    if ($uri.Host -ne 'github.com' -or $uri.AbsolutePath -cne $expected) {
      throw 'RELEASE_URL_INVALID: 不是官方桌面安装包。'
    }
  } else { throw 'RELEASE_URL_INVALID: 未知下载类型。' }
  return $uri
}

function New-SetupHttpClient {
  Add-Type -AssemblyName System.Net.Http
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds($script:DownloadTimeoutSeconds)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('Island-Desktop-Setup/0.4.0')
  return $client
}

function Open-SetupResponse($Client, [System.Uri]$Uri, [string]$Kind) {
  $current = $Uri
  for ($redirect = 0; $redirect -le 4; $redirect++) {
    $response = Wait-SetupTask ($Client.GetAsync($current, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead))
    $status = [int]$response.StatusCode
    if ($status -in @(301, 302, 303, 307, 308)) {
      $location = $response.Headers.Location
      $response.Dispose()
      if ($null -eq $location -or $redirect -eq 4) { throw 'DOWNLOAD_REDIRECT: 下载跳转无效或过多。' }
      $next = New-Object System.Uri($current, $location)
      if ($Kind -eq 'manifest') {
        if ($next.AbsoluteUri -ne $Uri.AbsoluteUri) { throw 'DOWNLOAD_REDIRECT: 版本清单禁止转移到其他地址。' }
      } elseif ($TestMode -and $Uri.IsLoopback) {
        if (!$next.IsLoopback -or $next.Scheme -ne 'http' -or $next.Port -ne $Uri.Port -or $next.UserInfo) {
          throw 'DOWNLOAD_REDIRECT: 测试下载只能在同一 loopback 服务跳转。'
        }
      } elseif ($next.Scheme -ne 'https' -or !$next.IsDefaultPort -or $next.UserInfo -or $next.Fragment -or
                $next.Host -notin @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) {
        throw 'DOWNLOAD_REDIRECT: 安装包跳转超出官方发行地址。'
      }
      $current = $next
      continue
    }
    if ($status -ne 200) {
      $response.Dispose()
      throw ('DOWNLOAD_HTTP_' + $status + ': 下载失败，保留已有安装。')
    }
    return $response
  }
  throw 'DOWNLOAD_REDIRECT: 下载跳转过多。'
}

function Get-SetupManifest($Client) {
  $uri = Assert-SetupUrl $ManifestUrl 'manifest'
  $response = Open-SetupResponse $Client $uri 'manifest'
  $stream = $null
  $memory = New-Object System.IO.MemoryStream
  $cancel = New-Object System.Threading.CancellationTokenSource
  $cancel.CancelAfter(30000)
  try {
    if ($response.Content.Headers.ContentLength -gt 65536) { throw 'MANIFEST_SIZE: 版本清单过大。' }
    $stream = Wait-SetupTask ($response.Content.ReadAsStreamAsync())
    $buffer = New-Object byte[] 8192
    while (($count = Wait-SetupTask ($stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token))) -gt 0) {
      $memory.Write($buffer, 0, $count)
      if ($memory.Length -gt 65536) { throw 'MANIFEST_SIZE: 版本清单过大。' }
    }
    $json = [System.Text.Encoding]::UTF8.GetString($memory.ToArray())
    try { $manifest = $json | ConvertFrom-Json } catch { throw 'MANIFEST_JSON: 版本清单不是有效 JSON。' }
    return Test-SetupManifest $manifest
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $cancel.Dispose(); $memory.Dispose(); $response.Dispose()
  }
}

function Test-SetupManifest($Manifest) {
  foreach ($key in @('schema', 'version', 'platform', 'arch', 'url', 'sha256', 'size', 'signed')) {
    if ($null -eq $Manifest -or $null -eq $Manifest.PSObject.Properties[$key]) {
      throw 'MANIFEST_FIELDS: 版本清单缺少必要字段。'
    }
  }
  if ($Manifest.schema -is [string] -or $Manifest.schema -is [bool] -or $Manifest.schema -ne 1 -or $Manifest.version -cne $script:SupportedVersion -or
      $Manifest.platform -cne 'win32' -or $Manifest.arch -cne 'x64' -or
      $Manifest.sha256 -isnot [string] -or $Manifest.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $Manifest.signed -isnot [bool] -or $Manifest.size -is [string] -or
      $Manifest.size -is [bool] -or $Manifest.size -le 0 -or $Manifest.size -gt 1073741824 -or
      [Math]::Floor([double]$Manifest.size) -ne [double]$Manifest.size) {
    throw 'MANIFEST_INVALID: 版本、平台、摘要或大小不兼容，已停止。'
  }
  $null = Assert-SetupUrl $Manifest.url 'installer'
  return $Manifest
}

function Enter-SetupLock($Paths) {
  $null = Assert-SafeSetupPath $Paths.State
  $null = [System.IO.Directory]::CreateDirectory($Paths.State)
  $null = Assert-SafeSetupPath $Paths.Lock
  $deadline = [DateTime]::UtcNow.AddSeconds($LockTimeoutSeconds)
  while ($true) {
    try {
      return [System.IO.File]::Open($Paths.Lock, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw 'INSTALL_LOCK_TIMEOUT: 另一安装仍在进行；本次停止，不并发下载或覆盖。'
      }
      Update-SetupProgress '等待已有安装完成' | Out-Host
      Start-Sleep -Milliseconds 100
    }
  }
}

function Get-SetupLocator($Paths, [string]$Version) {
  $null = Assert-SafeSetupPath $Paths.Locator
  if (![System.IO.File]::Exists($Paths.Locator)) { return $null }
  if ((Get-Item -LiteralPath $Paths.Locator).Length -gt 16384) { throw 'LOCATOR_INVALID: 本机安装记录过大，已停止。' }
  try { $locator = [System.IO.File]::ReadAllText($Paths.Locator) | ConvertFrom-Json }
  catch { throw 'LOCATOR_INVALID: 本机安装记录损坏，已停止；不会覆盖。' }
  foreach ($key in @('schema', 'version', 'exe', 'node', 'clientRoot', 'root', 'ready', 'runtimeVersion')) {
    if ($null -eq $locator.PSObject.Properties[$key]) { throw 'LOCATOR_INVALID: 本机安装记录不完整，需人工诊断。' }
  }
  if ($locator.schema -ne 1 -or $locator.ready -isnot [bool] -or !$locator.ready -or $locator.version -cne $Version -or
      $locator.runtimeVersion -isnot [string] -or $locator.runtimeVersion -cnotmatch '^\d+\.\d+\.\d+$') {
    throw 'LOCATOR_INCOMPATIBLE: 已有版本未就绪或不兼容，保留原安装，先备份并人工升级。'
  }
  $expectedNode = Join-Path (Join-Path $Paths.Runtime $locator.runtimeVersion) 'node.exe'
  foreach ($pair in @(@($locator.exe, $Paths.Exe), @($locator.node, $expectedNode), @($locator.clientRoot, $Paths.Client), @($locator.root, $Paths.Client))) {
    if ($pair[0] -isnot [string] -or ![System.IO.Path]::IsPathRooted($pair[0]) -or
        !(Assert-SafeSetupPath $pair[0]).Equals([System.IO.Path]::GetFullPath($pair[1]), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'LOCATOR_PATH: 本机安装记录路径不可信，已停止；不执行记录中的程序。'
    }
  }
  $required = @($Paths.Exe, $expectedNode, (Join-Path $Paths.Client 'connect.cmd'),
    (Join-Path $Paths.Client 'packages\node\bin\island-node.mjs'),
    (Join-Path $Paths.Client 'node_modules\ws\package.json'),
    (Join-Path $Paths.Client 'node_modules\proper-lockfile\package.json'),
    (Join-Path $Paths.Client 'node_modules\zod\package.json'),
    (Join-Path $Paths.Client 'node_modules\yauzl\package.json'),
    (Join-Path $Paths.Client 'node_modules\yazl\package.json'),
    (Join-Path $Paths.Client 'CLIENT_VERSION.txt'))
  foreach ($file in $required) {
    $null = Assert-SafeSetupPath $file
    if (![System.IO.File]::Exists($file)) { throw 'LOCATOR_INCOMPLETE: 已有安装组件缺失，需人工修复；不会重新配对。' }
  }
  if ([System.IO.File]::ReadAllText((Join-Path $Paths.Client 'CLIENT_VERSION.txt')).Trim() -cne 'hub-1') {
    throw 'LOCATOR_CLIENT_VERSION: 已有 Hub 版本不兼容，保留配置并停止。'
  }
  $exeVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Paths.Exe).ProductVersion
  $nodeVersion = [string][System.Diagnostics.FileVersionInfo]::GetVersionInfo($expectedNode).ProductVersion
  if ($exeVersion -notmatch ('^' + [regex]::Escape($Version) + '(?:\.0)?$') -or
      $nodeVersion.TrimStart('v') -cne $locator.runtimeVersion -or [int]($locator.runtimeVersion.Split('.')[0]) -lt 22) {
    throw 'LOCATOR_BINARY_VERSION: 本机程序版本与记录不一致，已停止。'
  }
  return $locator
}

function Save-SetupInstaller($Client, $Manifest, [string]$Target) {
  $response = Open-SetupResponse $Client (Assert-SetupUrl $Manifest.url 'installer') 'installer'
  $stream = $null; $output = $null
  $cancel = New-Object System.Threading.CancellationTokenSource
  $cancel.CancelAfter($script:DownloadTimeoutSeconds * 1000)
  try {
    if ($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne $Manifest.size) {
      throw 'INSTALLER_SIZE: 安装包响应大小与清单不一致，未执行。'
    }
    $stream = Wait-SetupTask ($response.Content.ReadAsStreamAsync())
    $output = [System.IO.File]::Open($Target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $buffer = New-Object byte[] 65536
    [long]$total = 0
    $deadline = [DateTime]::UtcNow.AddSeconds($script:DownloadTimeoutSeconds)
    while (($count = Wait-SetupTask ($stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token))) -gt 0) {
      $total += $count
      if ($total -gt $Manifest.size -or [DateTime]::UtcNow -gt $deadline) {
        throw 'INSTALLER_DOWNLOAD_LIMIT: 下载超出清单大小或超时，未执行。'
      }
      $output.Write($buffer, 0, $count)
      Update-SetupProgress '下载安装包' ([int]([double]$total / $Manifest.size * 65)) | Out-Host
    }
    $output.Dispose(); $output = $null
    if ($total -ne $Manifest.size) { throw 'INSTALLER_SIZE: 安装包下载不完整，未执行。' }
    Update-SetupProgress '校验安装包完整性' | Out-Host
    $hashStream = [System.IO.File]::OpenRead($Target)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $hashStream.Dispose() }
    if ($hash -cne $Manifest.sha256) { throw 'INSTALLER_SHA256: 安装包 SHA-256 不匹配，未执行。' }
    if ($Manifest.signed) {
      # PS7父进程可能传入不同PSModulePath；显式加载PS5.1自身的安全模块。
      Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
      if ((Get-AuthenticodeSignature -LiteralPath $Target).Status -ne 'Valid') {
        throw 'INSTALLER_SIGNATURE: 清单要求有效签名，但签名验证失败，未执行。'
      }
    }
    if (!$TestMode) {
      # 保留来自Internet的标记，交由Windows正常执行下载程序的安全检查。
      # ADS不改变EXE主体摘要；无法保存标记时停止，不悄悄降低系统检查。
      [System.IO.File]::WriteAllText($Target + ':Zone.Identifier', "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=" + $Manifest.url + "`r`n")
    }
  } finally {
    if ($null -ne $output) { $output.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
    $cancel.Dispose(); $response.Dispose()
  }
}

function New-SetupInstallerProcess([string]$Target, [string]$Work, $Paths) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Target; $info.Arguments = '/S'; $info.UseShellExecute = $true
  $info.WorkingDirectory = $Work
  if ($TestMode) {
    $uri = Assert-SetupUrl $ManifestUrl 'manifest'
    if (!$uri.IsLoopback) { throw 'TEST_ORIGIN_REQUIRED: 安装产物隔离测试必须使用 loopback 清单。' }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    # NSIS要求 /D 是最后一个参数，后面的完整文本就是目录，不额外加引号。
    $info.Arguments = '/S /D=' + $Paths.Install
    $info.EnvironmentVariables['ISLAND_DESKTOP_TEST'] = '1'
    $info.EnvironmentVariables['ISLAND_DESKTOP_TEST_HOME'] = $Paths.Home
    $info.EnvironmentVariables['ISLAND_DESKTOP_TEST_ORIGIN'] = $uri.GetLeftPart([System.UriPartial]::Authority)
    $info.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  }
  return $info
}

function Show-SetupWindow {
  if ($Quiet) { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $script:Ui = New-Object System.Windows.Forms.Form
    $script:Ui.Text = '协作岛 · 准备桌面客户端'
    $script:Ui.ClientSize = New-Object System.Drawing.Size(440, 130)
    $script:Ui.StartPosition = 'CenterScreen'
    $script:Ui.FormBorderStyle = 'FixedDialog'
    $script:Ui.MaximizeBox = $false; $script:Ui.MinimizeBox = $false
    $script:Ui.ControlBox = $false
    $script:Status = New-Object System.Windows.Forms.Label
    $script:Status.Location = New-Object System.Drawing.Point(20, 20)
    $script:Status.Size = New-Object System.Drawing.Size(400, 35)
    $script:Progress = New-Object System.Windows.Forms.ProgressBar
    $script:Progress.Location = New-Object System.Drawing.Point(20, 67)
    $script:Progress.Size = New-Object System.Drawing.Size(400, 24)
    $script:Ui.Controls.Add($script:Status); $script:Ui.Controls.Add($script:Progress)
    $script:Ui.Show()
    [System.Windows.Forms.Application]::DoEvents()
  } catch {
    if ($null -ne $script:Ui) { $script:Ui.Dispose() }
    $script:Ui = $null
    Write-Output 'ISLAND_SETUP 无法显示进度窗口；继续输出实际安装阶段。'
  }
}

function Invoke-DesktopSetup {
  $lock = $null; $http = $null; $work = $null
  try {
    $nativeArchitecture = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrEmpty($nativeArchitecture)) { $nativeArchitecture = $env:PROCESSOR_ARCHITECTURE }
    if (![Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Major -lt 10 -or $nativeArchitecture -ne 'AMD64') {
      throw 'WINDOWS_UNSUPPORTED: 需要 Windows 10 或以上的 64 位系统。'
    }
    $paths = Get-SetupPaths
    Show-SetupWindow
    Update-SetupProgress '检查已有安装' | Out-Host
    $lock = Enter-SetupLock $paths
    $http = New-SetupHttpClient
    $manifest = Get-SetupManifest $http
    $locator = Get-SetupLocator $paths $manifest.version
    if ($null -ne $locator) {
      Update-SetupProgress '已复用现有桌面客户端和 Hub' 100 | Out-Host
      Write-Output ('ISLAND_SETUP_RESULT ' + (@{ installed = $false; reused = $true; version = $manifest.version; client = 'hub-1' } | ConvertTo-Json -Compress))
      return
    }
    # 未知已有桌面目录不擅自覆盖；旧的兼容 Hub1由安装器独立验证与复用。
    if ([System.IO.Directory]::Exists($paths.Install) -and @(Get-ChildItem -LiteralPath $paths.Install -Force).Count -gt 0) {
      throw 'INSTALLATION_UNKNOWN: 已有桌面程序但没有可信记录，保留原目录并停止。'
    }
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ('island-desktop-setup-' + [guid]::NewGuid().ToString('N'))
    $null = Assert-SafeSetupPath $work
    $null = [System.IO.Directory]::CreateDirectory($work)
    $target = Join-Path $work 'Island-Setup.exe'
    Save-SetupInstaller $http $manifest $target
    Update-SetupProgress '部署内置组件，无需安装系统 Node' | Out-Host
    $info = New-SetupInstallerProcess $target $work $paths
    $child = [System.Diagnostics.Process]::Start($info)
    if ($null -eq $child) { throw 'INSTALLER_START: 安装程序未能启动。' }
    try {
      # 不杀进程、不绕过Windows安全提示、不把等待时间伪装成百分比。
      while (!$child.WaitForExit(100)) {
        if ($null -ne $script:Ui) { [System.Windows.Forms.Application]::DoEvents() }
      }
      if ($child.ExitCode -ne 0) { throw ('INSTALLER_EXIT_' + $child.ExitCode + ': 安装程序失败，保留已有配置。') }
    } finally { $child.Dispose() }
    Update-SetupProgress '验证本机客户端' | Out-Host
    $locator = Get-SetupLocator $paths $manifest.version
    if ($null -eq $locator) { throw 'INSTALLER_NOT_READY: 安装程序未生成可信就绪记录，不能报告安装成功。' }
    Update-SetupProgress '安装完成，等待独立 Agent 配对' 100 | Out-Host
    Write-Output ('ISLAND_SETUP_RESULT ' + (@{ installed = $true; reused = $false; version = $manifest.version; client = 'hub-1' } | ConvertTo-Json -Compress))
  } finally {
    if ($null -ne $http) { $http.Dispose() }
    if ($null -ne $lock) { $lock.Dispose() }
    # 只删除本次GUID临时目录中的自己两个文件，不递归删除任何用户目录。
    if ($null -ne $work -and [System.IO.Directory]::Exists($work)) {
      try {
        $null = Assert-SetupChild $work ([System.IO.Path]::GetTempPath())
        foreach ($name in @('Island-Setup.exe')) {
          $ownedFile = Join-Path $work $name
          if ([System.IO.File]::Exists($ownedFile)) { Remove-Item -LiteralPath $ownedFile -Force }
        }
        if (@(Get-ChildItem -LiteralPath $work -Force).Count -eq 0) { Remove-Item -LiteralPath $work }
      } catch {
        # 杀毒扫描可能短时占用下载文件；显式告知保留，不覆盖主要验证结果或扩大删除。
        Write-Warning 'OWNED_TEMP_RETAINED: 本次临时安装文件暂无法清理，已保留；不会清理其他目录。'
      }
    }
    if ($null -ne $script:Ui) { $script:Ui.Dispose(); $script:Ui = $null }
  }
}

if ($FunctionsOnly) {
  if (!$TestMode) { throw 'TEST_MODE_REQUIRED: 函数测试必须显式使用 TestMode。' }
} else {
  try { Invoke-DesktopSetup }
  catch {
    $detail = $_.Exception.Message
    if ($detail -notmatch '^[A-Z0-9_]+:') { $detail = 'SETUP_FAILED: 网络、磁盘或安装检查失败；原身份及配置保留，请诊断后重试。' }
    [Console]::Error.WriteLine($detail)
    exit 1
  }
}
