<#
  One-command dev run for QLens.
    1. starts the private PostgreSQL cluster (port 5544) if it is not already running
    2. applies migrations
    3. starts uvicorn (8000) and Vite (5173) as background jobs of this window
  Ctrl+C (or closing the window) stops the two servers it started. The database cluster is left
  running on purpose; stop it with:  cd backend; uv run python -m qlens.pg_local stop
  Usage:  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

foreach ($port in 8000, 5173) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use. Stop whatever is listening there and run this again."
    }
}

Push-Location $backend
try {
    uv run python -m qlens.pg_local start
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the PostgreSQL cluster (see backend\.pgdata\server.log).' }
    uv run python -m qlens.migrate
    if ($LASTEXITCODE -ne 0) { throw 'Migrations failed.' }
} finally { Pop-Location }

$api = Start-Job -Name qlens-api -ScriptBlock {
    param($dir) Set-Location $dir; uv run uvicorn qlens.main:app --port 8000 2>&1
} -ArgumentList $backend
$web = Start-Job -Name qlens-web -ScriptBlock {
    param($dir) Set-Location $dir; npm run dev 2>&1
} -ArgumentList $frontend

Write-Host ''
Write-Host 'QLens is starting:  http://localhost:5173   (API on http://localhost:8000)' -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop both servers.' -ForegroundColor DarkGray
Write-Host ''

try {
    while ($true) {
        Receive-Job $api, $web | ForEach-Object { Write-Host $_ }
        if ($api.State -ne 'Running' -or $web.State -ne 'Running') {
            Receive-Job $api, $web | ForEach-Object { Write-Host $_ }
            Write-Host 'A server exited, shutting down.' -ForegroundColor Yellow
            break
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    # Stop-Job ends the job's process tree start point; uvicorn/node children are killed by PID tree below.
    foreach ($j in $api, $web) {
        if ($j) { Stop-Job $j -ErrorAction SilentlyContinue; Remove-Job $j -Force -ErrorAction SilentlyContinue }
    }
    foreach ($port in 8000, 5173) {
        Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
}
