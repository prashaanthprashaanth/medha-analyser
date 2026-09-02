#!/usr/bin/env python3
"""Local HTTP bridge used by the Electron Medha desktop application."""

from __future__ import annotations

import argparse
import base64
import json
import sys
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from medha_analyser import FormatError
from medha_service import AnalysisService


def make_excel(payload: dict[str, Any]) -> dict[str, str]:
    """Create a styled XLSX workbook for desktop renderer exports."""

    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    headers = list(payload.get("headers") or [])
    rows = list(payload.get("rows") or [])
    if not headers:
        raise ValueError("Excel export requires column headings")
    if len(headers) * (len(rows) + 1) > 600_000:
        raise ValueError("Excel export is too large; reduce the selected time range")
    workbook = Workbook()
    sheet = workbook.active
    title = str(payload.get("sheet") or "Medha Data")
    for character in "[]:*?/\\":
        title = title.replace(character, "_")
    sheet.title = title[:31] or "Medha Data"
    sheet.append(headers)
    for row in rows:
        sheet.append(list(row))
    fill = PatternFill("solid", fgColor="0C4F78")
    font = Font(color="FFFFFF", bold=True)
    for cell in sheet[1]:
        cell.fill = fill
        cell.font = font
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for index, header in enumerate(headers, start=1):
        observed = [len(str(header))]
        for row in rows[:250]:
            if index - 1 < len(row):
                observed.append(len(str(row[index - 1] if row[index - 1] is not None else "")))
        sheet.column_dimensions[sheet.cell(1, index).column_letter].width = min(55, max(10, max(observed) + 2))
    output = BytesIO()
    workbook.save(output)
    return {"base64": base64.b64encode(output.getvalue()).decode("ascii")}


class ApiHandler(BaseHTTPRequestHandler):
    service: AnalysisService

    def log_message(self, message: str, *args: object) -> None:
        print(message % args, file=sys.stderr)

    def _json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _send(self, status: int, value: object) -> None:
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlsplit(self.path).path
        try:
            if path == "/health":
                self._send(200, {"ok": True})
            elif path == "/status":
                self._send(200, self.service.status())
            elif path == "/faults":
                self._send(200, {"faults": self.service.get_faults(), "status": self.service.status()})
            elif path == "/fault-parameters":
                self._send(200, self.service.fault_parameters())
            else:
                self._send(404, {"error": "Unknown endpoint"})
        except Exception as exc:
            self._send(500, {"error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlsplit(self.path).path
        try:
            body = self._json_body()
            if path == "/load":
                result = self.service.load_archive(body.get("path", ""))
            elif path == "/fault-detail":
                result = self.service.fault_detail(
                    int(body["row_index"]), int(body.get("snapshot_choice", 0))
                )
            elif path == "/fault-comparison":
                result = self.service.fault_comparison(
                    body.get("row_indices", []), body.get("parameters", [])
                )
            elif path == "/history":
                result = self.service.history_page(
                    body["memory"],
                    body.get("parameters"),
                    body.get("start"),
                    body.get("end"),
                    body.get("offset", 0),
                    body.get("limit", 1000),
                    body.get("newest_first", True),
                )
            elif path == "/history-chart":
                result = self.service.history_chart(
                    body["memory"],
                    body.get("parameters", []),
                    body.get("start"),
                    body.get("end"),
                    body.get("max_points", 12000),
                )
            elif path == "/make-excel":
                result = make_excel(body)
            else:
                self._send(404, {"error": "Unknown endpoint"})
                return
            self._send(200, result)
        except (FormatError, KeyError, TypeError, ValueError, OSError) as exc:
            self._send(400, {"error": str(exc)})
        except Exception as exc:
            self._send(500, {"error": str(exc)})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    service = AnalysisService()
    ApiHandler.service = service
    server = ThreadingHTTPServer((args.host, args.port), ApiHandler)
    host, port = server.server_address
    print(json.dumps({"ready": True, "host": host, "port": port}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
