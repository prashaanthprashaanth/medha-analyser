# Medha Data Analyser v1.0

Windows application for MEC628 locomotive `ALL`-data ZIP files. The preferred
portable edition is a single 12.7 MB EXE and uses the staff computer's existing
default browser, so Chromium is not bundled.

## Included functions

- fault log loads first in one continuously scrollable list;
- each fault opens in a separate browser tab with 10 time snapshots;
- all fault parameters display immediately; an optional unchecked picker can
  reduce the table to only the required readings;
- 807 fault parameters and expandable bitwise sub-signals;
- long-term and short-term data load only when requested or while idle, with
  their complete available time ranges filled automatically;
- interactive charts with parameter selection, date/time range, zoom, and A/B
  time-selection bars;
- chart download as PNG or PDF and data download as Excel;
- one compact offline HTML report matches the main definition-visible Fault Log
  and contains its retained FDP/environment readings only; it deliberately
  excludes hidden/undefined faults, long-term, short-term, population, depth,
  and chart data;
- multi-fault Depth Analysis and whole-log Population Analysis.

## Run the portable app

Double-click `Medha_Data_Analyser_v1.0.exe` and select the original locomotive
ZIP whose filename contains `ALL`. No Python or Node.js installation is needed
on the staff computer.

On first launch, the EXE installs its 12.7 MB analyser engine under
`%LOCALAPPDATA%\MedhaDataAnalyser\1.0`. Uploaded locomotive data is copied only
to a temporary working folder and is removed when the app closes. A fresh
authenticated localhost session and random port are used on every launch, with
browser caching disabled. Closing the main analyser browser tab automatically
stops the local server within a few seconds.

The app is unsigned, so Windows SmartScreen may initially show an unknown
publisher warning. Use **More info > Run anyway** only when the EXE was received
from the approved project source.

## Build version 1.0

Build requirements are Windows, Python 3.13, and .NET Framework 4.8. From
PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build_v1.ps1
```

The result is `release\Medha_Data_Analyser_v1.0.exe`. PyInstaller dependencies
are downloaded only into the ignored `.build_v1` directory. The Electron source
is retained as an optional development shell, but it is not bundled in the
portable version because that would increase the installer to about 99 MB.

## Source layout

- `medha_analyser.py` - MEC628 binary-memory decoder.
- `medha_service.py` - priority and interruptible background analysis service.
- `medha_report.py` - compressed definition-visible fault + FDP offline report.
- `medha_backend.py` - authenticated local API, browser lifetime, and exports.
- `medha_definition_v506.json.gz` - fixed compiled Medha data definition.
- `medha_desktop/viewer/` - browser user interface.
- `packaging/MedhaLauncher.cs` - small Windows launcher and startup screen.
- `build_v1.ps1` - reproducible portable EXE build.

Raw locomotive archives, exports, dependencies, caches, and generated EXEs are
deliberately excluded from Git.
