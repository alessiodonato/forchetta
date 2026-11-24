@echo off
setlocal
rem Forchetta CLI on Windows. Its own Node.js, put next to it by docs/install.ps1, when there is one; else the one in the PATH.
set "FK_ROOT=%~dp0.."
set "FK_NODE=%FK_ROOT%\..\forchetta-node\node.exe"
if not exist "%FK_NODE%" set "FK_NODE=node.exe"
"%FK_NODE%" "%FK_ROOT%\dist\cli.js" %*
exit /b %ERRORLEVEL%
