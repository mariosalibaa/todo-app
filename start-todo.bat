@echo off
start "" http://localhost:8081
tasklist /fi "imagename eq node.exe" /fo csv 2>NUL | find /i "node.exe" >NUL
if errorlevel 1 (
    start "" /min node D:\vscode\todo\server.js
    timeout /t 1 /nobreak >NUL
    start "" http://localhost:8081
)
