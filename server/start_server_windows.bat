@echo off
title AE Background Removal Server

set COMFYUI_PATH=%USERPROFILE%\ComfyUI
if not exist "%COMFYUI_PATH%" set COMFYUI_PATH=D:\NewComfy\ComfyUI-Easy-Install\ComfyUI
if not exist "%COMFYUI_PATH%" set COMFYUI_PATH=C:\ComfyUI
if not exist "%COMFYUI_PATH%" set COMFYUI_PATH=C:\AI\ComfyUI

if not exist "%COMFYUI_PATH%" (
    echo ComfyUI non trovato.
    set /p COMFYUI_PATH="Inserisci il percorso di ComfyUI: "
)

echo.
echo ============================================================
echo   AE Background Removal Server
echo   ComfyUI : %COMFYUI_PATH%
echo   Porta   : 9876
echo ============================================================
echo.

set PYTHON_EXE=%COMFYUI_PATH%\python_embeded\python.exe
if not exist "%PYTHON_EXE%" set PYTHON_EXE=python

"%PYTHON_EXE%" "%~dp0rmbg_server.py" --comfyui "%COMFYUI_PATH%" --port 9876

pause
