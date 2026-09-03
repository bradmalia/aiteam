$ErrorActionPreference = "Stop"
$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repo = if ($args.Count -gt 0 -and $args[0]) { $args[0] } else { (Get-Location).Path }
$port = if ($env:AITEAM_WATCH_PORT) { $env:AITEAM_WATCH_PORT } else { "4317" }
node (Join-Path $rootDir "src\watch-server.mjs") --repo $repo --port $port
