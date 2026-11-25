@echo off
setlocal
rem Forchetta CLI on Windows. Its own Node.js, put next to it by docs/install.ps1, when there is one; else the one in the PATH,
rem by its full path: by its name alone, Windows looks in the folder it is typed in first, and a repository could have one.
set "FK_ROOT=%~dp0.."
set "FK_NODE=%FK_ROOT%\..\forchetta-node\node.exe"
if not exist "%FK_NODE%" for %%I in (node.exe) do set "FK_NODE=%%~$PATH:I"
if not defined FK_NODE (
  echo forchetta: Node.js was not found: run the installer again, see https://forchetta.dev/windows/ 1>&2
  exit /b 1
)
"%FK_NODE%" "%FK_ROOT%\dist\cli.js" %*
exit /b %ERRORLEVEL%
