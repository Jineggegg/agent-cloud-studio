$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'dist-server\server\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Build Agent Cloud Studio before starting it.' }
$data = Join-Path $root '.data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$runtimeConfig = Join-Path $data 'runtime.json'
if (Test-Path -LiteralPath $runtimeConfig) {
    $node = (Get-Content -LiteralPath $runtimeConfig -Raw | ConvertFrom-Json).nodeExecutable
} else {
    $node = (Get-Command node -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $node)) { throw 'The configured Node runtime is unavailable.' }
$env:NODE_ENV = 'production'
$process = Start-Process -FilePath $node -ArgumentList @('dist-server/server/index.js') `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $data 'studio-output.log') `
    -RedirectStandardError (Join-Path $data 'studio-error.log')
$process.WaitForExit()
exit $process.ExitCode
