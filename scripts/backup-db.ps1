# Respaldo de la base de datos de CADA empresa registrada (backend/empresas-registry.json)
# — no solo DATABASE_URL, que según ese mismo registro solo importa en el
# primer arranque del sistema. Corre como tarea programada diaria de Windows
# (registrada aparte con Register-ScheduledTask) y también se puede correr a mano.
#
# Uso manual: powershell -File backup-db.ps1 [-CarpetaDestino "C:\Backups\facturacion-app\db"]

param(
    [string]$CarpetaDestino = "C:\Backups\facturacion-app\db",
    [int]$DiasRetencion = 14
)

$ErrorActionPreference = "Stop"
$rutaScript = Split-Path -Parent $MyInvocation.MyCommand.Path
$rutaRegistry = Join-Path (Split-Path -Parent $rutaScript) "empresas-registry.json"

if (-not (Test-Path $rutaRegistry)) {
    Write-Error "No se encontró empresas-registry.json en $rutaRegistry"
    exit 1
}

$empresas = Get-Content $rutaRegistry -Raw | ConvertFrom-Json
$fechaHora = Get-Date -Format "yyyyMMdd_HHmmss"

foreach ($empresa in $empresas) {
    if (-not $empresa.activa) { continue }

    $carpetaEmpresa = Join-Path $CarpetaDestino $empresa.id
    if (-not (Test-Path $carpetaEmpresa)) {
        New-Item -ItemType Directory -Path $carpetaEmpresa -Force | Out-Null
    }

    $archivoDestino = Join-Path $carpetaEmpresa "$($empresa.id)_$fechaHora.sql"
    Write-Output "Respaldando '$($empresa.nombre)' ($($empresa.id)) -> $archivoDestino"

    & pg_dump $empresa.databaseUrl -f $archivoDestino
    if ($LASTEXITCODE -ne 0) {
        Write-Error "pg_dump falló para '$($empresa.id)' (código $LASTEXITCODE)"
        continue
    }

    # Retención: borra respaldos de ESTA empresa más viejos que $DiasRetencion días.
    $limite = (Get-Date).AddDays(-$DiasRetencion)
    Get-ChildItem $carpetaEmpresa -Filter "$($empresa.id)_*.sql" |
        Where-Object { $_.LastWriteTime -lt $limite } |
        Remove-Item -Force
}

Write-Output "Backup de base de datos completo."
