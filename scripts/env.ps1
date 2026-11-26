$appRoot = Split-Path -Parent $PSScriptRoot
$env:HOST = '127.0.0.1'
$env:PORT = '4320'
$env:CONTENT_DATA_DIR = Join-Path $appRoot 'data'
$env:CONTENT_DB_PATH = Join-Path $appRoot 'data\content.sqlite3'
$env:ENABLE_CACHE = 'true'
$env:INIT_TABLE = 'true'
$env:G_CLIENT_ID = ''
$env:G_CLIENT_SECRET = ''
$env:JWT_SECRET = ''
$env:NODE_OPTIONS = '--use-env-proxy'
$env:NO_PROXY = '127.0.0.1,localhost,::1'
$env:PYTHONUTF8 = '1'
$env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'
$env:COREPACK_ENABLE_AUTO_PIN = '0'
$env:COREPACK_HOME = Join-Path $appRoot '.cache\corepack'
$env:npm_config_cache = Join-Path $appRoot '.cache\npm'
$env:npm_config_devdir = Join-Path $appRoot '.cache\node-gyp'
$env:XDG_CACHE_HOME = Join-Path $appRoot '.cache\xdg'
$env:UV_CACHE_DIR = Join-Path $appRoot '.cache\uv'
$env:HF_HOME = Join-Path $appRoot '.cache\huggingface'
$env:TEMP = Join-Path $appRoot '.cache\temp'
$env:TMP = $env:TEMP
$env:PORTAL_APP_ROOT = $appRoot
$env:PORTAL_POWERSHELL = (Get-Process -Id $PID).Path
$collectorPython = if ($env:CONTENT_PYTHON) { $env:CONTENT_PYTHON } else { Join-Path $appRoot '.runtime\python-env\Scripts\python.exe' }
foreach ($folder in @('data','data\outbox','data\imported','data\rejected','logs','.cache\temp','.cache\corepack','web\.data')) {
    [IO.Directory]::CreateDirectory((Join-Path $appRoot $folder)) | Out-Null
}
$env:PIP_CACHE_DIR = Join-Path $appRoot '.cache\pip'
$env:PNPM_HOME = Join-Path $appRoot '.runtime\pnpm'
$env:npm_config_store_dir = Join-Path $appRoot '.cache\pnpm-store'
