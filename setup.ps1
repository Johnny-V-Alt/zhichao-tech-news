param([string]$PythonExecutable = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1')
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装Node.js 24和Corepack，再运行setup.ps1。' }
if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw '未找到Corepack。请安装Corepack并重新打开PowerShell。' }
$nodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion.Split('.')[0] -ne 24) { throw '当前版本已验证Node.js 24，请使用Node.js 24。' }
& node --use-env-proxy -e 'process.exit(0)'
if ($LASTEXITCODE -ne 0) { throw '当前Node.js版本不支持项目的代理选项，请更新Node.js 24。' }
if (-not (Test-Path -LiteralPath $collectorPython)) {
    $pythonArgs = @()
    if ($PythonExecutable) { $pythonBinary = $PythonExecutable }
    elseif (Get-Command py -ErrorAction SilentlyContinue) { $pythonBinary = (Get-Command py).Source; $pythonArgs = @('-3.12') }
    elseif (Get-Command python -ErrorAction SilentlyContinue) { $pythonBinary = (Get-Command python).Source }
    else { throw '请先安装Python 3.12。' }
    $pythonVersion = & $pythonBinary @pythonArgs --version
    if ($LASTEXITCODE -ne 0 -or $pythonVersion -notmatch '^Python 3\.12\.') { throw '请使用Python 3.12；也可传入-PythonExecutable完整路径。' }
    & $pythonBinary @pythonArgs -m venv (Join-Path $appRoot '.runtime\python-env')
    if ($LASTEXITCODE -ne 0) { throw 'Python虚拟环境创建失败。' }
}
Push-Location $appRoot
try {
    & $collectorPython -m pip install -r collector/requirements.lock.txt
    if ($LASTEXITCODE -ne 0) { throw 'Python依赖安装失败。请检查网络和终端输出。' }
    Push-Location (Join-Path $appRoot 'web')
    try {
        corepack pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Node依赖安装失败。' }
        corepack pnpm exec tsx scripts/editorial-content.ts status
        if ($LASTEXITCODE -ne 0) { throw '数据库初始化失败。' }
        corepack pnpm run build
        if ($LASTEXITCODE -ne 0) { throw '网站构建失败。' }
    } finally { Pop-Location }
} finally { Pop-Location }
Write-Output '安装完成。双击启动网站.cmd阅读，双击打开管理.cmd进入本机后台。'
Write-Output '首次内容库为空，启动后会采集。AI默认关闭，需要另行配置模型。'
