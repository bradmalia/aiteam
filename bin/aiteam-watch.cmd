@echo off
setlocal
set "ROOT=%~dp0.."
set "PORT=%AITEAM_WATCH_PORT%"
if "%PORT%"=="" set "PORT=4317"
set "REPO=%~1"
if "%REPO%"=="" set "REPO=%CD%"
node "%ROOT%\src\watch-server.mjs" --repo "%REPO%" --port "%PORT%"
