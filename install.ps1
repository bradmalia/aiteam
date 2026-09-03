# AITEAM Windows PowerShell Installer
$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path $PSScriptRoot).Path
$binDir = Join-Path $env:USERPROFILE ".local\bin"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

$mcpCmdContent = @"
@echo off
setlocal
node "$rootDir\src\server.mjs" %*
"@
Set-Content -Path (Join-Path $binDir "aiteam-mcp.cmd") -Value $mcpCmdContent -Encoding ASCII

$watchCmdContent = @"
@echo off
setlocal
set "PORT=%AITEAM_WATCH_PORT%"
if "%PORT%"=="" set "PORT=4317"
set "REPO=%~1"
if "%REPO%"=="" set "REPO=%CD%"
node "$rootDir\src\watch-server.mjs" --repo "%REPO%" --port "%PORT%"
"@
Set-Content -Path (Join-Path $binDir "aiteam-watch.cmd") -Value $watchCmdContent -Encoding ASCII

$mcpPs1Content = @"
`$ErrorActionPreference = "Stop"
node "$rootDir\src\server.mjs" @args
"@
Set-Content -Path (Join-Path $binDir "aiteam-mcp.ps1") -Value $mcpPs1Content -Encoding UTF8

$watchPs1Content = @"
`$ErrorActionPreference = "Stop"
`$repo = if (`$args.Count -gt 0 -and `$args[0]) { `$args[0] } else { (Get-Location).Path }
`$port = if (`$env:AITEAM_WATCH_PORT) { `$env:AITEAM_WATCH_PORT } else { "4317" }
node "$rootDir\src\watch-server.mjs" --repo `$repo --port `$port
"@
Set-Content -Path (Join-Path $binDir "aiteam-watch.ps1") -Value $watchPs1Content -Encoding UTF8

Write-Host "Installed AITEAM MCP launcher: $binDir\aiteam-mcp.cmd"
Write-Host "Installed AITEAM dashboard launcher: $binDir\aiteam-watch.cmd"
Write-Host ""
Write-Host "========================================="
Write-Host " GitHub Copilot Configuration (Windows)"
Write-Host "========================================="
Write-Host "Add this to your Copilot / VS Code / Claude MCP configuration:"
Write-Host ""
Write-Host '{'
Write-Host '  "mcpServers": {'
Write-Host '    "aiteam": {'
Write-Host "      `"command`": `"$($binDir.Replace('\', '\\'))\\aiteam-mcp.cmd`","
Write-Host '      "env": {'
Write-Host '        "AITEAM_RUNNER": "copilot"'
Write-Host '      }'
Write-Host '    }'
Write-Host '  }'
Write-Host '}'
Write-Host ""
Write-Host "========================================="
Write-Host " Codex Configuration (~/.codex/config.toml)"
Write-Host "========================================="
Write-Host "[mcp_servers.aiteam]"
Write-Host "command = `"$($binDir.Replace('\', '/'))/aiteam-mcp.cmd`""
Write-Host 'env_vars = ['
Write-Host '  "AITEAM_RUNNER",'
Write-Host '  "AITEAM_CODEX_BIN",'
Write-Host '  "AITEAM_CODEX_PREFIX_ARGS_JSON",'
Write-Host '  "AITEAM_CODEX_HOME",'
Write-Host '  "AITEAM_CODEX_WRITABLE_SANDBOX",'
Write-Host '  "AITEAM_CODEX_MODEL",'
Write-Host '  "AITEAM_CODEX_REASONING_EFFORT",'
Write-Host '  "AITEAM_CODEX_PROVIDER",'
Write-Host '  "AITEAM_CODEX_PROVIDER_NAME",'
Write-Host '  "AITEAM_CODEX_BASE_URL",'
Write-Host '  "AITEAM_CODEX_WIRE_API",'
Write-Host '  "AITEAM_CODEX_REQUIRES_OPENAI_AUTH",'
Write-Host '  "AITEAM_CODEX_CONTEXT_WINDOW",'
Write-Host '  "AITEAM_CODEX_AUTO_COMPACT_LIMIT",'
Write-Host '  "AITEAM_COORDINATOR_READ_ONLY",'
Write-Host '  "AITEAM_WATCH_PORT",'
Write-Host ']'
Write-Host "startup_timeout_sec = 10"
Write-Host "tool_timeout_sec = 7200"
Write-Host ""
Write-Host "Then append templates/AGENTS.aiteam.md to the target project's AGENTS.md or workspace prompt instructions."
