@echo off
rem Argon CLI launcher installed with the desktop app: runs the CLI with Argon's own runtime.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\Argon.exe" "%~dp0..\resources\app\dist\cli\main.js" %*
