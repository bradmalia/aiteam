$ErrorActionPreference = "Stop"
$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
node (Join-Path $rootDir "src\server.mjs") @args
