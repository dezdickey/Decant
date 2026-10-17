@echo off
rem Double-click to start Offload. The real work is in start.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
