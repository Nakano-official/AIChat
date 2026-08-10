@echo off
chcp 65001 >nul
title Ollama チャット
echo Ollama チャットツールを起動します...
node "%~dp0src\chat-server.js"
pause
