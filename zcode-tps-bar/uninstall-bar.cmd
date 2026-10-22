@echo off
rem Remove TPS Bar injection from ZCode app.asar. Fully quit ZCode first.
chcp 65001 >nul
node "%~dp0scripts\patch-asar.mjs" remove
pause
