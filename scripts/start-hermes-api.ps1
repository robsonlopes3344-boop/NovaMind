$ErrorActionPreference = 'Stop'

# Use the existing Hermes profile on this PC; otherwise use the official Windows default.
if (-not $env:HERMES_HOME -or -not (Test-Path $env:HERMES_HOME)) {
    $custom = 'E:\Hermes\Data'
    if (Test-Path (Join-Path $custom '.env')) {
        $env:HERMES_HOME = $custom
    } else {
        $env:HERMES_HOME = Join-Path $env:LOCALAPPDATA 'hermes'
    }
}
New-Item -ItemType Directory -Force -Path $env:HERMES_HOME | Out-Null

$hermes = Get-Command hermes -ErrorAction SilentlyContinue
if (-not $hermes) {
    $candidate = Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe'
    if (Test-Path $candidate) { $hermes = @{ Source = $candidate } }
}
if (-not $hermes) { throw "Hermes Agent não encontrado. Execute INSTALAR_NOVAMIND.bat primeiro." }

$envFile = Join-Path $env:HERMES_HOME '.env'
$key = $null
if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*API_SERVER_KEY=' } | Select-Object -Last 1
    if ($line) { $key = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'") }
}
if (-not $key) {
    $bytes = New-Object byte[] 36
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes); $rng.Dispose()
    $key = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

& $hermes.Source config set API_SERVER_ENABLED true | Out-Null
& $hermes.Source config set API_SERVER_HOST 127.0.0.1 | Out-Null
& $hermes.Source config set API_SERVER_PORT 8642 | Out-Null
& $hermes.Source config set API_SERVER_KEY $key | Out-Null

# If the API is already running, do not start a second gateway process.
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8642/health' -TimeoutSec 2
    if ($health.status -eq 'ok') { exit 0 }
} catch { }

& $hermes.Source gateway