param([switch]$Run,[switch]$Stop)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repoDir = Split-Path -Parent $PSScriptRoot
Set-Location $repoDir
function Test-Node { try { if (!(Get-Command node -ErrorAction SilentlyContinue)) { return $false }; & node -e 'process.exit(parseInt(process.versions.node)>=22?0:1)' | Out-Null; if ($LASTEXITCODE -ne 0 -or !(Get-Command npm.cmd -ErrorAction SilentlyContinue)) { return $false }; & npm.cmd --version | Out-Null; return $LASTEXITCODE -eq 0 } catch { return $false } }
if (!(Test-Node)) {
  $privateDir = Join-Path $repoDir '.data\node-runtime'
  if (Test-Path (Join-Path $privateDir 'node.exe')) { $env:PATH = "$privateDir;$env:PATH" }
  if (!(Test-Node)) {
    if (($env:PROCESSOR_ARCHITEW6432 -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') -or (!$env:PROCESSOR_ARCHITEW6432 -and $env:PROCESSOR_ARCHITECTURE -ne 'AMD64')) { throw '此架构请自行安装 Node.js 22+。' }
    $version = 'v24.19.0'
    $archive = "node-$version-win-x64.zip"
    $temporaryDir = Join-Path $repoDir ('.data\node-download-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $temporaryDir | Out-Null
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Write-Host '正在下载项目私有 Node.js，不修改系统安装…'
      Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/$archive" -OutFile (Join-Path $temporaryDir $archive)
      Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -OutFile (Join-Path $temporaryDir 'SHASUMS256.txt')
      $checksumLine = Get-Content (Join-Path $temporaryDir 'SHASUMS256.txt') | Where-Object { ($_ -split '\s+')[1] -eq $archive }
      if (!$checksumLine) { throw '官方校验清单中未找到安装包。' }
      $expectedHash = ($checksumLine -split '\s+')[0]
      $actualHash = (Get-FileHash -Algorithm SHA256 (Join-Path $temporaryDir $archive)).Hash
      if ($expectedHash -ne $actualHash) { throw 'Node.js 校验失败，已停止安装。' }
      Expand-Archive -Path (Join-Path $temporaryDir $archive) -DestinationPath $temporaryDir
      & (Join-Path $temporaryDir "node-$version-win-x64\node.exe") --version
      if ($LASTEXITCODE -ne 0) { throw 'Node.js 运行验证失败。' }
      if (Test-Path $privateDir) { throw '现有私有运行时无效，请检查 .data\node-runtime 后重试。' }
      Move-Item (Join-Path $temporaryDir "node-$version-win-x64") $privateDir
      $env:PATH = "$privateDir;$env:PATH"
    } finally { Remove-Item -Recurse -Force $temporaryDir -ErrorAction SilentlyContinue }
  }
}
if ($Stop) { & node scripts/serve.mjs --stop } elseif ($Run) { & node scripts/serve.mjs } else { & node scripts/setup/server.mjs }
exit $LASTEXITCODE
