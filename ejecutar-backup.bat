@echo off
REM Este archivo ejecuta el backup automático del sistema de facturación.
REM Lo usa el Programador de Tareas de Windows para correr todos los días sin
REM que tengas que acordarte de hacerlo manualmente.

cd /d "%~dp0"
npx ts-node backup-completo.ts >> backups\log-backups.txt 2>&1
