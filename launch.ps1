param([switch]$Admin, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1')
$ownedServer = $null
$ready = $false
try { $null = Invoke-RestMethod 'http://127.0.0.1:4320/api/content/operations' -TimeoutSec 2; $ready = $true } catch { }
try {
    if (-not $ready) {
        $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')
        $ownedServer = Start-Process -FilePath (Get-Command node).Source -ArgumentList @((Join-Path $appRoot 'web\dist\output\server\index.mjs')) -WorkingDirectory (Join-Path $appRoot 'web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appRoot "logs\web-$stamp.log") -RedirectStandardError (Join-Path $appRoot "logs\web-$stamp.err.log") -PassThru
        @{pid=$ownedServer.Id;start_ticks=$ownedServer.StartTime.ToUniversalTime().Ticks;app_root=$appRoot} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appRoot 'data\web-server.json') -Encoding UTF8
        for ($attempt=0; $attempt -lt 40; $attempt++) {
            if ($ownedServer.HasExited) { throw '网站服务未能启动，请查看 logs 目录。' }
            try { $null = Invoke-RestMethod 'http://127.0.0.1:4320/api/content/operations' -TimeoutSec 2; $ready=$true; break } catch { Start-Sleep -Milliseconds 500 }
        }
        if (-not $ready) { throw '本机服务没有就绪，请检查4320端口是否被占用。' }
    }
    $url = 'http://127.0.0.1:4320/'
    if ($Admin) {
        $null = Invoke-RestMethod 'http://127.0.0.1:4320/api/admin/session' -TimeoutSec 5
        $localKey = (Get-Content -LiteralPath (Join-Path $appRoot 'data\operations\admin-key.txt') -Raw).Trim()
        $url = "http://127.0.0.1:4320/admin#access=$localKey"
    }
    if (-not $NoBrowser) { Start-Process $url }
    Write-Output '知潮已启动：http://127.0.0.1:4320/'
    Write-Output '此窗口保持网站运行。Ctrl+C停止；关闭浏览器不会停止采集。'
    if ($ownedServer) { Wait-Process -Id $ownedServer.Id }
} finally {
    if ($ownedServer) {
        $ownedServer.Refresh()
        if (-not $ownedServer.HasExited) {
            $current = Get-Process -Id $ownedServer.Id -ErrorAction SilentlyContinue
            if ($current -and $current.StartTime -eq $ownedServer.StartTime) { Stop-Process -Id $ownedServer.Id }
        }
    }
}
