@echo off
title RMBG Test

set COMFYUI=D:\NewComfy\ComfyUI-Easy-Install\ComfyUI
set INSTALL_DIR=D:\NewComfy\ComfyUI-Easy-Install

set PY=
if exist "%COMFYUI%\python_embeded\python.exe"     set PY=%COMFYUI%\python_embeded\python.exe
if exist "%COMFYUI%\python_embedded\python.exe"    set PY=%COMFYUI%\python_embedded\python.exe
if exist "%INSTALL_DIR%\python_embeded\python.exe" set PY=%INSTALL_DIR%\python_embeded\python.exe
if exist "%INSTALL_DIR%\python_embedded\python.exe" set PY=%INSTALL_DIR%\python_embedded\python.exe

if "%PY%"=="" (
    echo Python non trovato. Uso python di sistema.
    set PY=python
)

echo Usando: %PY%
echo.
"%PY%" "%~dp0test_rmbg.py"
