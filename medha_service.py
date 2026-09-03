#!/usr/bin/env python3
"""Stateful decoding service shared by the Medha desktop application."""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, time
from pathlib import Path
from threading import Event, Lock
from typing import Any, Sequence

from medha_analyser import CompiledDefinition, DasDefinition, FormatError, LocoFiles, Mec628Decoder


APP_DIR = Path(__file__).resolve().parent
DEFAULT_DEFINITION = (
    APP_DIR
    / "MEC628V2"
    / "MEC628Analysis_SW_Shed_VER_5.06"
    / "MEC628Analysis SW_Shed_VER 5.06.das"
)
COMPILED_DEFINITION = APP_DIR / "medha_definition_v506.json.gz"
REQUIRED_FILES = {
    "ERRORLOG.DAT",
    "FLTPACK.DAT",
    "LONGMEM.DAT",
    "SHORTMEM.DAT",
    "STATUS.DAT",
}


class AnalysisService:
    """Own one uploaded archive and its priority-aware background indexes."""

    def __init__(self, definition_path: str | Path | None = None):
        if definition_path is not None:
            self.definition = DasDefinition.from_path(definition_path)
        elif COMPILED_DEFINITION.is_file():
            self.definition = CompiledDefinition.from_path(COMPILED_DEFINITION)
        else:
            self.definition = DasDefinition.from_path(DEFAULT_DEFINITION)
        self.archive_path: Path | None = None
        self.loco: LocoFiles | None = None
        self.decoder: Mec628Decoder | None = None
        self.fault_rows: list[dict[str, object]] = []
        self.fault_by_index: dict[int, dict[str, object]] = {}
        self.snapshot_lookup: dict[tuple[str, int], tuple[int, ...]] | None = None
        self.executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="medha-data")
        self.futures: dict[str, Future] = {}
        self.progress = {"FDP": 0.0, "LGM": 0.0, "SHM": 0.0}
        self.errors: dict[str, str] = {}
        self.history_run = Event()
        self.history_run.set()
        self.lock = Lock()
        self.report_lock = Lock()
        self.report_active = False
        self.report_progress = 0.0
        self.report_cache: tuple[str, bytes, dict[str, object]] | None = None

    def require_decoder(self) -> Mec628Decoder:
        if self.decoder is None:
            raise FormatError("Upload an ALL-data locomotive ZIP first")
        return self.decoder

    def load_archive(self, path: str | Path) -> dict[str, Any]:
        if not self.report_lock.acquire(blocking=False):
            raise FormatError("Wait for the Fault + FDP HTML report to finish before opening another ZIP")
        try:
            return self._load_archive(path)
        finally:
            self.report_lock.release()

    def _load_archive(self, path: str | Path) -> dict[str, Any]:
        source = Path(path)
        if not source.is_file():
            raise FormatError(f"Archive does not exist: {source}")
        if source.suffix.lower() != ".zip":
            raise FormatError("Select the original locomotive ALL-data ZIP")

        loco = LocoFiles(source, validate_crc=False)
        missing = sorted(REQUIRED_FILES - set(loco.names))
        if missing:
            loco.close()
            raise FormatError("ALL-data ZIP is missing: " + ", ".join(missing))
        decoder = Mec628Decoder(self.definition, loco)
        faults = decoder.faults(include_hidden=True)

        if self.loco is not None:
            self.loco.close()
        self.archive_path = source
        self.loco = loco
        self.decoder = decoder
        self.fault_rows = faults
        self.fault_by_index = {int(row["row_index"]): row for row in faults}
        self.snapshot_lookup = None
        self.futures = {}
        self.errors = {}
        self.progress = {"FDP": 0.0, "LGM": 0.0, "SHM": 0.0}
        with self.lock:
            self.report_cache = None
            self.report_progress = 0.0
        self.history_run.set()
        self.start_background()
        return {
            "archive": source.name,
            "faults": self.get_faults(),
            "status": self.status(),
        }

    def _new_decoder(self) -> tuple[LocoFiles, Mec628Decoder]:
        if self.archive_path is None:
            raise FormatError("No archive is loaded")
        loco = LocoFiles(self.archive_path, validate_crc=False)
        return loco, Mec628Decoder(self.definition, loco)

    def _set_progress(self, name: str, value: float) -> None:
        with self.lock:
            self.progress[name] = max(0.0, min(1.0, value))

    def _index_fdp(self) -> tuple[list, dict[tuple[str, int], tuple[int, ...]]]:
        loco, decoder = self._new_decoder()
        try:
            records = decoder.raw_records(
                "FDP", progress_callback=lambda value: self._set_progress("FDP", value * 0.72)
            )
            self._set_progress("FDP", 0.76)
            lookup_lists: dict[tuple[str, int], list[int]] = {}
            for record in decoder.fdp_records(("Packet Index",)):
                key = (str(record["timestamp"]), int(record["values"]["Packet Index"]))
                lookup_lists.setdefault(key, []).append(int(record["row_index"]))
            lookup = {key: tuple(indices) for key, indices in lookup_lists.items()}
            self._set_progress("FDP", 1.0)
            return records, lookup
        finally:
            loco.close()

    def _index_history(self, short_name: str) -> list:
        loco, decoder = self._new_decoder()
        try:
            def update(value: float) -> None:
                self.history_run.wait()
                self._set_progress(short_name, value)

            return decoder.raw_records(short_name, progress_callback=update)
        finally:
            loco.close()

    def _record_failure(self, name: str, future: Future) -> None:
        error = future.exception()
        if error is not None:
            with self.lock:
                self.errors[name] = str(error)

    def start_background(self) -> None:
        if self.decoder is None:
            return
        jobs = (("FDP", self._index_fdp), ("LGM", lambda: self._index_history("LGM")),
                ("SHM", lambda: self._index_history("SHM")))
        for name, work in jobs:
            if name in self.futures:
                continue
            future = self.executor.submit(work)
            future.add_done_callback(lambda item, job=name: self._record_failure(job, item))
            self.futures[name] = future

    def sync_completed(self) -> None:
        decoder = self.require_decoder()
        for name, future in tuple(self.futures.items()):
            if not future.done() or name in self.errors:
                continue
            if name == "FDP":
                records, lookup = future.result()
                decoder.cache_raw_records("FDP", records)
                self.snapshot_lookup = lookup
            else:
                decoder.cache_raw_records(name, future.result())

    def status(self) -> dict[str, Any]:
        if self.decoder is not None:
            self.sync_completed()
        with self.lock:
            progress = {name: round(value * 100, 1) for name, value in self.progress.items()}
            errors = dict(self.errors)
            report = {
                "active": self.report_active,
                "progress": round(self.report_progress * 100, 1),
                "cached": self.report_cache is not None,
            }
        ready = {
            "faults": self.decoder is not None,
            "FDP": self.snapshot_lookup is not None,
            "LGM": bool(self.decoder and self.decoder.records_loaded("LGM")),
            "SHM": bool(self.decoder and self.decoder.records_loaded("SHM")),
        }
        return {"ready": ready, "progress": progress, "errors": errors, "report": report}

    def _set_report_progress(self, value: float) -> None:
        with self.lock:
            self.report_progress = max(0.0, min(1.0, value))

    def fault_fdp_html_report(self) -> tuple[str, bytes, dict[str, object]]:
        """Build or reuse the visible-fault + retained-FDP offline report."""

        with self.lock:
            cached = self.report_cache
        if cached is not None:
            return cached
        # A second detail/main window shares the first build instead of starting
        # another 807-column decode or failing while that build is in progress.
        self.report_lock.acquire()
        report_started = False
        try:
            with self.lock:
                cached = self.report_cache
                if cached is not None:
                    return cached
                self.report_active = True
                self.report_progress = 0.0
            report_started = True
            self.history_run.clear()
            self._ensure_fdp()
            from medha_report import build_fault_fdp_html

            report, stats = build_fault_fdp_html(self, self._set_report_progress)
            archive = self.archive_path.stem if self.archive_path else "medha_all_data"
            safe_archive = "".join(
                character
                if character.isascii() and (character.isalnum() or character in "-_")
                else "_"
                for character in archive
            ).strip("_")[:90]
            filename = f"{safe_archive or 'medha_all_data'}_faults_fdp.html"
            cached = (filename, report, stats)
            with self.lock:
                self.report_cache = cached
                self.report_progress = 1.0
            return cached
        finally:
            if report_started:
                self.history_run.set()
                with self.lock:
                    self.report_active = False
            self.report_lock.release()

    def get_faults(self) -> list[dict[str, object]]:
        self.sync_completed()
        output = []
        for fault in self.fault_rows:
            row = dict(fault)
            if self.snapshot_lookup is None:
                row["environment"] = "Indexing"
            else:
                key = (str(fault["timestamp"]), int(fault["packet_index"]))
                row["environment"] = "Available" if key in self.snapshot_lookup else "Not retained"
            output.append(row)
        return output

    def _ensure_fdp(self) -> None:
        self.start_background()
        future = self.futures["FDP"]
        future.result()
        if "FDP" in self.errors:
            raise FormatError(self.errors["FDP"])
        self.sync_completed()

    def fault_detail(self, fault_row_index: int, snapshot_choice: int = 0) -> dict[str, Any]:
        decoder = self.require_decoder()
        try:
            fault = self.fault_by_index[int(fault_row_index)]
        except KeyError as exc:
            raise FormatError(f"Fault row does not exist: {fault_row_index}") from exc

        self.history_run.clear()
        try:
            self._ensure_fdp()
            key = (str(fault["timestamp"]), int(fault["packet_index"]))
            matches = self.snapshot_lookup.get(key, ()) if self.snapshot_lookup else ()
            if not matches:
                return {"fault": fault, "retained": False, "matches": 0}
            choice = max(0, min(int(snapshot_choice), len(matches) - 1))
            instant_index = matches[choice]
            window = decoder.fdp_window(str(fault["timestamp"]), instant_index)
            indices = [int(item["row_index"]) for item in window if item["row_index"] is not None]
            decoded = decoder.parameter_records("FDP", row_indices=indices)
            by_index = {int(item["row_index"]): item for item in decoded}
            samples = []
            for item in window:
                row_index = item["row_index"]
                sample = dict(item)
                if row_index is not None:
                    environment = by_index[int(row_index)]
                    sample.update(
                        values=environment["values"],
                        units=environment["units"],
                        display=environment["display"],
                    )
                samples.append(sample)
            flag_definitions = decoder.flag_metadata("FDP")
            parameters = [
                {
                    "name": row["NAME"],
                    "unit": row["UNIT"],
                    "visible": row["VISIBLE"].upper().startswith("T"),
                    "children": flag_definitions.get(row["NAME"], []),
                }
                for row in decoder.parameter_metadata("FDP")
            ]
            return {
                "fault": fault,
                "retained": True,
                "matches": len(matches),
                "snapshot_choice": choice,
                "config": decoder.fdp_window_config(),
                "parameters": parameters,
                "samples": samples,
            }
        finally:
            self.history_run.set()

    def fault_parameters(self) -> dict[str, Any]:
        """Return the fixed FDP parameter catalogue for comparison controls."""

        decoder = self.require_decoder()
        return {
            "parameters": [
                {
                    "name": row["NAME"],
                    "unit": row["UNIT"],
                    "visible": row["VISIBLE"].upper().startswith("T"),
                }
                for row in decoder.parameter_metadata("FDP")
            ]
        }

    def fault_comparison(
        self, fault_row_indices: Sequence[int], parameters: Sequence[str]
    ) -> dict[str, Any]:
        """Decode a compact multi-fault FDP matrix for pattern/trend comparison."""

        decoder = self.require_decoder()
        requested_faults = list(dict.fromkeys(int(item) for item in fault_row_indices))
        requested_parameters = list(dict.fromkeys(str(item) for item in parameters))
        if len(requested_faults) < 2:
            raise FormatError("Select at least two faults for Depth Analysis")
        if len(requested_faults) > 12:
            raise FormatError("Depth Analysis supports up to 12 faults at a time")
        if not requested_parameters:
            raise FormatError("Select at least one FDP parameter")
        if len(requested_parameters) > 6:
            raise FormatError("Select up to 6 parameters so comparison charts remain readable")

        metadata = {row["NAME"].casefold(): row for row in decoder.parameter_metadata("FDP")}
        selected_metadata = []
        for name in requested_parameters:
            try:
                selected_metadata.append(metadata[name.casefold()])
            except KeyError as exc:
                raise FormatError(f"Unknown FDP parameter: {name}") from exc
        canonical_names = [row["NAME"] for row in selected_metadata]

        self.history_run.clear()
        try:
            self._ensure_fdp()
            prepared: list[tuple[dict[str, object], list[dict[str, object]] | None]] = []
            needed_indices: set[int] = set()
            for row_index in requested_faults:
                try:
                    fault = self.fault_by_index[row_index]
                except KeyError as exc:
                    raise FormatError(f"Fault row does not exist: {row_index}") from exc
                key = (str(fault["timestamp"]), int(fault["packet_index"]))
                matches = self.snapshot_lookup.get(key, ()) if self.snapshot_lookup else ()
                if not matches:
                    prepared.append((fault, None))
                    continue
                window = decoder.fdp_window(str(fault["timestamp"]), int(matches[0]))
                needed_indices.update(
                    int(item["row_index"]) for item in window if item["row_index"] is not None
                )
                prepared.append((fault, window))

            decoded = decoder.parameter_records(
                "FDP", canonical_names, row_indices=sorted(needed_indices)
            )
            by_index = {int(item["row_index"]): item for item in decoded}
            output_faults = []
            for fault, window in prepared:
                if window is None:
                    output_faults.append({"fault": fault, "retained": False, "samples": []})
                    continue
                samples = []
                for item in window:
                    row_index = item["row_index"]
                    sample = dict(item)
                    if row_index is not None:
                        values = by_index[int(row_index)]
                        sample.update(values=values["values"], display=values["display"])
                    else:
                        sample.update(values={}, display={})
                    samples.append(sample)
                output_faults.append({"fault": fault, "retained": True, "samples": samples})
            return {
                "config": decoder.fdp_window_config(),
                "parameters": [
                    {
                        "name": row["NAME"],
                        "unit": row["UNIT"],
                        "visible": row["VISIBLE"].upper().startswith("T"),
                    }
                    for row in selected_metadata
                ],
                "faults": output_faults,
            }
        finally:
            self.history_run.set()

    def _ensure_history(self, short_name: str) -> bool:
        decoder = self.require_decoder()
        self.start_background()
        future = self.futures[short_name]
        if not future.done():
            return False
        future.result()
        if short_name in self.errors:
            raise FormatError(self.errors[short_name])
        self.sync_completed()
        return decoder.records_loaded(short_name)

    @staticmethod
    def _date_bounds(records: list, start: str | None, end: str | None) -> tuple[int, int]:
        lower = 0
        upper = len(records)
        if start:
            lower_dt = datetime.fromisoformat(start)
            if len(start) <= 10:
                lower_dt = datetime.combine(lower_dt.date(), time.min)
            lower = bisect_left(records, lower_dt, key=lambda record: record.timestamp)
        if end:
            upper_dt = datetime.fromisoformat(end)
            if len(end) <= 10:
                upper_dt = datetime.combine(upper_dt.date(), time.max)
            upper = bisect_right(records, upper_dt, key=lambda record: record.timestamp)
        return lower, upper

    def history_page(
        self,
        short_name: str,
        parameters: Sequence[str] | None = None,
        start: str | None = None,
        end: str | None = None,
        offset: int = 0,
        limit: int = 1000,
        newest_first: bool = True,
    ) -> dict[str, Any]:
        key = short_name.upper()
        if key not in ("LGM", "SHM"):
            raise FormatError(f"Unsupported history memory: {short_name}")
        if not self._ensure_history(key):
            return {"ready": False, "status": self.status()}
        decoder = self.require_decoder()
        records = decoder.raw_records(key)
        lower, upper = self._date_bounds(records, start, end)
        total = max(0, upper - lower)
        offset = max(0, min(int(offset), total))
        limit = max(1, min(int(limit), 5000))
        count = min(limit, total - offset)
        if newest_first:
            high = upper - offset
            low = high - count
            indices = range(high - 1, low - 1, -1)
        else:
            indices = range(lower + offset, lower + offset + count)
        metadata = decoder.parameter_metadata(key)
        names = [row["NAME"] for row in metadata]
        selected = list(parameters) if parameters else names
        rows = decoder.parameter_records(key, selected, indices)
        return {
            "ready": True,
            "memory": key,
            "total_records": len(records),
            "matching_records": total,
            "offset": offset,
            "limit": limit,
            "first_timestamp": records[0].timestamp.isoformat(sep=" "),
            "last_timestamp": records[-1].timestamp.isoformat(sep=" "),
            "parameters": [
                {"name": row["NAME"], "unit": row["UNIT"], "visible": row["VISIBLE"].upper().startswith("T")}
                for row in metadata
            ],
            "rows": rows,
        }

    def history_chart(
        self,
        short_name: str,
        parameters: Sequence[str],
        start: str | None = None,
        end: str | None = None,
        max_points: int = 12000,
    ) -> dict[str, Any]:
        key = short_name.upper()
        if not self._ensure_history(key):
            return {"ready": False, "status": self.status()}
        decoder = self.require_decoder()
        records = decoder.raw_records(key)
        lower, upper = self._date_bounds(records, start, end)
        count = max(0, upper - lower)
        max_points = max(100, min(int(max_points), 25000))
        step = max(1, (count + max_points - 1) // max_points)
        indices = list(range(lower, upper, step))
        if upper > lower and (not indices or indices[-1] != upper - 1):
            indices.append(upper - 1)
        rows = decoder.parameter_records(key, parameters, indices)
        return {
            "ready": True,
            "source_records": count,
            "points": len(rows),
            "downsample_step": step,
            "rows": rows,
        }
