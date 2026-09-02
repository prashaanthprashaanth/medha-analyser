# Medha Data Analyser

Portable Electron desktop application for MEC628 locomotive ALL-data ZIP files.
It loads the fault log first, indexes fault/history data in prioritized
background workers, and does not use Streamlit.

## Included functions

- continuously scrollable fault log;
- separate 10-sample Fault Data Pack window;
- expandable bitwise sub-signals such as `VCU DIP112-127`;
- independent long-term and short-term tabs;
- interactive parameter/time charts with zoom and A/B selection bars;
- PNG/PDF chart downloads and Excel/HTML data exports;
- multi-fault Depth Analysis;
- whole-log Population Analysis.

## Run on another Windows system

Install Python 3.11+, Node.js 20+, and Git. Then clone the repository and run:

```powershell
python -m pip install -r requirements.txt
Set-Location medha_desktop
npm install
npm start
```

Alternatively, double-click `Start Medha Desktop.bat`; it performs the same
dependency setup and starts the application.

Upload the original locomotive ZIP whose filename contains `ALL`. The ZIP must
contain `ERRORLOG.DAT`, `FLTPACK.DAT`, `LONGMEM.DAT`, `SHORTMEM.DAT`, and
`STATUS.DAT`.

## Source layout

- `medha_analyser.py` — MEC628 binary-memory decoder.
- `medha_service.py` — priority/background analysis service.
- `medha_backend.py` — local desktop API and Excel generation.
- `medha_definition_v506.json.gz` — required compiled fixed-format definition.
- `medha_desktop/` — Electron main process and user interface.

Raw locomotive files, Excel reports, vendor applications, caches,
`node_modules`, and generated installers are deliberately excluded from Git.
