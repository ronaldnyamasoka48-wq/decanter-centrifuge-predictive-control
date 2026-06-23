@echo off
cd /d "%~dp0decanterCentrifuge\twin"
start "" http://localhost:3000
npm run dev
