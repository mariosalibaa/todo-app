@echo off
title To-Do SANDBOX (port 8083)
set TEAM_ID=sandbox
set PORT=8083
cd /d "%~dp0"
node server.js
