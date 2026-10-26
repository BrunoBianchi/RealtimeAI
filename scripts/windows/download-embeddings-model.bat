@echo off
rem Hybrid RAG: downloads the local embedding model (about 118 MB, once).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-embeddings-model.ps1"
pause
