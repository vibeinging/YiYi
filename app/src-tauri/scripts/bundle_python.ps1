# Bundle Python stdlib + pip for Windows distribution.
# Run from src-tauri/ directory.
# Usage: powershell -File scripts/bundle_python.ps1 [python_path]

param(
    [string]$PythonPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $PythonPath) {
    $PythonPath = & python -c "import sys; print(sys.executable)"
}
Write-Host "Using Python: $PythonPath"

$PYVER = & $PythonPath -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
$STDLIB = & $PythonPath -c "import sysconfig; print(sysconfig.get_path('stdlib'))"
$PLATSTDLIB = & $PythonPath -c "import sysconfig; print(sysconfig.get_path('platstdlib'))"
$DLLS = Join-Path (Split-Path $PythonPath) "DLLs"
$SITE_PACKAGES = & $PythonPath -c "import site; print(site.getsitepackages()[0])"

Write-Host "Python version: $PYVER"
Write-Host "Stdlib: $STDLIB"
Write-Host "DLLs: $DLLS"
Write-Host "Site-packages: $SITE_PACKAGES"

# Windows layout: python-stdlib/Lib/...  (no version subdirectory)
$DEST = "python-stdlib\Lib"
if (Test-Path "python-stdlib") { Remove-Item -Recurse -Force "python-stdlib" }
New-Item -ItemType Directory -Force -Path $DEST | Out-Null

# Also create DLLs directory for compiled extensions
$DESTDLLS = "python-stdlib\DLLs"
New-Item -ItemType Directory -Force -Path $DESTDLLS | Out-Null

# Exclusions
$Excludes = @("__pycache__", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip")

Write-Host "Copying stdlib..."
Get-ChildItem -Path $STDLIB -Recurse | Where-Object {
    $rel = $_.FullName.Substring($STDLIB.Length + 1)
    $skip = $false
    foreach ($ex in $Excludes) {
        if ($rel -like "$ex\*" -or $rel -like "*\$ex\*" -or $rel -eq $ex) { $skip = $true; break }
    }
    if ($_.Extension -eq ".pyc") { $skip = $true }
    -not $skip
} | ForEach-Object {
    $rel = $_.FullName.Substring($STDLIB.Length + 1)
    $target = Join-Path $DEST $rel
    if ($_.PSIsContainer) {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
    } else {
        $targetDir = Split-Path $target
        if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
        Copy-Item $_.FullName -Destination $target -Force
    }
}

# Copy DLLs (compiled extensions like _ssl.pyd, _sqlite3.pyd, etc.)
if (Test-Path $DLLS) {
    Write-Host "Copying DLLs..."
    Copy-Item "$DLLS\*" -Destination $DESTDLLS -Recurse -Force
}

# Copy pip from site-packages
$PipDir = Join-Path $SITE_PACKAGES "pip"
if (Test-Path $PipDir) {
    Write-Host "Copying pip..."
    $PipDest = Join-Path $DEST "pip"
    Copy-Item $PipDir -Destination $PipDest -Recurse -Force
    # Remove __pycache__ from pip
    Get-ChildItem -Path $PipDest -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
}

# Size
$size = (Get-ChildItem -Path "python-stdlib" -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ""
Write-Host "Done! Bundled Python stdlib to: python-stdlib\"
Write-Host ("Size: {0:N1} MB" -f $size)
Write-Host "Contents:"
Get-ChildItem $DEST | Select-Object -First 20 -ExpandProperty Name
Write-Host "..."
