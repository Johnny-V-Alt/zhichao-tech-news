$ErrorActionPreference = 'Stop'
$metadataPath = Join-Path $PSScriptRoot 'data\web-server.json'
if (-not (Test-Path -LiteralPath $metadataPath)) { Write-Output '没有由启动器记录的服务；若手动运行了start-web.ps1，请在其窗口按Ctrl+C。'; exit 0 }
$info = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ([IO.Path]::GetFullPath($info.app_root) -ne [IO.Path]::GetFullPath($PSScriptRoot)) { throw '服务记录与当前项目不匹配。' }
$serviceProcess = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
if ($serviceProcess -and $serviceProcess.ProcessName -eq 'node' -and $serviceProcess.StartTime.ToUniversalTime().Ticks -eq $info.start_ticks) {
    Stop-Process -Id $serviceProcess.Id
    Write-Output '已停止本项目的网站服务。已开始的采集任务会自行完成并记录状态。'
} else { Write-Output '记录中的服务已退出，没有停止其他进程。' }
