@echo off
setlocal
set "ROOT=%~dp0.."
node "%ROOT%\src\server.mjs" %*
