@echo off
rem Inject TPS Bar into ZCode app.asar. Fully quit ZCode first (asar is locked while running).
chcp 65001 >nul
node "%~dp0scripts\patch-asar.mjs" install
pause
