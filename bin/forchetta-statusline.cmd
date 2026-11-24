@echo off
setlocal
rem Status line of Claude Code on Windows, through Forchetta, when its path cannot be written without quotes: see src/hook/main.ts.
set "FK_ROOT=%~dp0.."
set "FK_NODE=%FK_ROOT%\..\forchetta-node\node.exe"
if not exist "%FK_NODE%" set "FK_NODE=node.exe"
"%FK_NODE%" "%FK_ROOT%\dist\windows\forchetta-hooks.js" status %1
exit /b 0
