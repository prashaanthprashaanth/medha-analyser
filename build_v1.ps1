param(
    [string]$OutputDirectory = "release",
    [string]$Python313 = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildRoot = Join-Path $projectRoot ".build_v1"
$venvDirectory = Join-Path $buildRoot "venv313"
$python = Join-Path $venvDirectory "Scripts\python.exe"
$engineDist = Join-Path $buildRoot "engine"
$pyInstallerWork = Join-Path $buildRoot "pyinstaller"
$outputPath = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory
} else {
    Join-Path $projectRoot $OutputDirectory
}

New-Item -ItemType Directory -Force -Path $buildRoot, $outputPath | Out-Null

if (-not (Test-Path -LiteralPath $python)) {
    $basePython = $Python313
    if (-not $basePython) {
        $registered = & py -0p 2>$null
        foreach ($line in $registered) {
            if ($line -match "3\.13" -and $line -match "([A-Za-z]:\\.*python\.exe)\s*$") {
                $basePython = $Matches[1]
                break
            }
        }
    }
    if (-not $basePython -or -not (Test-Path -LiteralPath $basePython)) {
        throw "Python 3.13 is required. Install it, then run this script again."
    }
    & $basePython -m venv $venvDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Python 3.13 is required. Install it, then run this script again."
    }
}

& $python -m pip install --disable-pip-version-check --quiet `
    -r (Join-Path $projectRoot "requirements.txt") "pyinstaller==6.22.2"
if ($LASTEXITCODE -ne 0) { throw "Python build dependencies could not be installed." }

& $python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --console `
    --name "MedhaEngine" `
    --distpath $engineDist `
    --workpath $pyInstallerWork `
    --specpath $buildRoot `
    --add-data ((Join-Path $projectRoot "medha_definition_v506.json.gz") + ";.") `
    --add-data ((Join-Path $projectRoot "medha_desktop\viewer") + ";viewer") `
    (Join-Path $projectRoot "medha_backend.py")
if ($LASTEXITCODE -ne 0) { throw "The Medha analyser engine build failed." }

$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
    throw ".NET Framework 4.8 C# compiler was not found."
}

$engine = Join-Path $engineDist "MedhaEngine.exe"
$launcherSource = Join-Path $projectRoot "packaging\MedhaLauncher.cs"
$finalExe = Join-Path $outputPath "Medha_Data_Analyser_v1.0.exe"
& $compiler `
    /nologo `
    /target:winexe `
    /optimize+ `
    "/out:$finalExe" `
    "/resource:$engine,MedhaEngine" `
    /reference:System.Windows.Forms.dll `
    /reference:System.Drawing.dll `
    $launcherSource
if ($LASTEXITCODE -ne 0) { throw "The Medha launcher build failed." }

$file = Get-Item -LiteralPath $finalExe
$hash = Get-FileHash -LiteralPath $finalExe -Algorithm SHA256
Write-Host ("Built {0:N2} MB: {1}" -f ($file.Length / 1MB), $file.FullName)
Write-Host ("SHA-256: {0}" -f $hash.Hash)
