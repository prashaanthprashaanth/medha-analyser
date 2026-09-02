#!/usr/bin/env python3
"""Read Medha MEC628 DAS definitions and locomotive memory archives.

This implementation is based on the file formats used by DASAPP 1.0.9 and
DecodingDll.  It reads source files without changing them.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import sys
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Iterable, Iterator, Sequence


DAS_PASSWORD = b"DASAPP"
DAS_SALT = b"Ivan Medvedev"

DEFAULT_ENVIRONMENT_PARAMETERS = (
    "Packet Index",
    "Loco speed",
    "OHE Volt (KV)",
    "OHE Current",
    "Line frequency",
    "TE/BE Demand%",
    "OP-Mode",
    "TE/BE BG1 (KN)",
    "TE/BE BG2 (KN)",
    "Bogie1 DCLV",
    "Bogie2 DCLV",
    "Battery Volt",
    "BP Pressure",
    "Pneu Demand %",
    "TM1 RPM",
    "TM2 RPM",
    "TM3 RPM",
    "TM4 RPM",
    "TM5 RPM",
    "TM6 RPM",
    "TI1 Phase Temp",
    "TI2 Phase Temp",
    "TI3 Phase Temp",
    "TI4 Phase Temp",
    "TI5 Phase Temp",
    "TI6 Phase Temp",
    "LC1 Phase Temp",
    "LC2 Phase Temp",
    "LC3 Phase Temp",
    "LC4 Phase Temp",
    "Conv1 Coolant Temp",
    "Conv2 Coolant Temp",
    "Conv1 Coolant Pressure",
    "Conv2 Coolant Pressure",
    "Bogie1 T/F Oil Temp",
    "Bogie2 T/F Oil Temp",
    "Bogie1 T/F Oil Pressure",
    "Bogie2 T/F Oil Pressure",
)


class FormatError(ValueError):
    """The input does not match the expected Medha format."""


def _password_derive_bytes_material() -> tuple[bytes, bytes]:
    """Reproduce the PasswordDeriveBytes calls in DASAPP's decrypt routine.

    DASAPP calls GetBytes(32), followed by GetBytes(16), on the same legacy
    PasswordDeriveBytes object.  The IV expression below preserves that .NET
    implementation's buffer behavior for this exact call sequence.
    """

    base = hashlib.sha1(DAS_PASSWORD + DAS_SALT).digest()
    for _ in range(1, 99):
        base = hashlib.sha1(base).digest()
    block0 = hashlib.sha1(base).digest()
    block1 = hashlib.sha1(b"1" + base).digest()
    block2 = hashlib.sha1(b"2" + base).digest()
    key = (block0 + block1)[:32]
    iv = key[8:16] + block2[:8]
    return key, iv


def decrypt_das(data: bytes) -> bytes:
    """Decrypt a DASAPP `.das` byte stream and remove PKCS#7 padding."""

    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as exc:  # pragma: no cover - dependency error path
        raise RuntimeError("Install the 'cryptography' Python package to read .das files") from exc

    if not data or len(data) % 16:
        raise FormatError("Encrypted DAS length is not a non-zero AES block multiple")
    key, iv = _password_derive_bytes_material()
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    plain = decryptor.update(data) + decryptor.finalize()
    padding = plain[-1]
    if padding < 1 or padding > 16 or plain[-padding:] != bytes([padding]) * padding:
        raise FormatError("DAS decryption produced invalid PKCS#7 padding")
    return plain[:-padding]


@dataclass(frozen=True)
class Field:
    name: str
    field_type: str
    width: int
    decimals: int


@dataclass(frozen=True)
class PackedTable:
    name: str
    record_length: int
    record_count: int
    fields: tuple[Field, ...]
    data: memoryview

    def rows(self) -> Iterator[dict[str, str]]:
        for index in range(self.record_count):
            record = self.data[index * self.record_length : (index + 1) * self.record_length]
            if len(record) != self.record_length:
                raise FormatError(f"Truncated record {index} in {self.name}")
            position = 1  # dBASE deletion flag retained by the packed container
            result: dict[str, str] = {}
            for field in self.fields:
                raw = bytes(record[position : position + field.width])
                position += field.width
                result[field.name] = raw.decode("latin-1").strip(" \x00")
            yield result


class DasDefinition:
    """In-memory view of a decrypted DASAPP definition container."""

    def __init__(self, raw: bytes):
        if raw[:12].rstrip(b" \x00") != b"SFT_DTLS.txt":
            raise FormatError("Definition does not start with SFT_DTLS.txt")
        self.raw = raw
        self.metadata: list[str] = []
        self.tables: dict[str, PackedTable] = {}
        self.creation_timestamp = ""
        self._parse()

    @classmethod
    def from_path(cls, path: str | Path) -> "DasDefinition":
        source = Path(path)
        raw = source.read_bytes()
        if raw[:12].rstrip(b" \x00") != b"SFT_DTLS.txt":
            raw = decrypt_das(raw)
        return cls(raw)

    @staticmethod
    def _looks_like_table_name(raw: bytes) -> bool:
        if len(raw) != 12:
            return False
        name = raw.rstrip(b" \x00")
        return name.endswith(b".DBF") and all(32 <= value < 127 for value in name)

    def _parse(self) -> None:
        data = self.raw
        position = 12
        while position + 12 <= len(data) and not self._looks_like_table_name(data[position : position + 12]):
            if len(self.metadata) >= 64:
                raise FormatError("Could not locate the first packed DBF table")
            length = data[position]
            position += 1
            if position + length > len(data):
                raise FormatError("Truncated DAS metadata")
            self.metadata.append(data[position : position + length].decode("latin-1").strip())
            position += length

        end_of_tables = len(data) - 25
        while position < end_of_tables:
            if position + 19 > end_of_tables:
                raise FormatError("Truncated packed DBF header")
            name_raw = data[position : position + 12]
            if not self._looks_like_table_name(name_raw):
                raise FormatError(f"Invalid packed DBF name at offset {position}")
            name = name_raw.decode("ascii").strip(" \x00")
            position += 12
            record_length = int.from_bytes(data[position : position + 2], "little")
            position += 2
            record_count = int.from_bytes(data[position : position + 4], "little")
            position += 4
            field_count = data[position]
            position += 1
            fields: list[Field] = []
            for _ in range(field_count):
                field_name = data[position : position + 10].decode("ascii").strip(" \x00")
                field_type = chr(data[position + 10])
                width = data[position + 11]
                decimals = data[position + 12]
                fields.append(Field(field_name, field_type, width, decimals))
                position += 13
            byte_count = record_length * record_count
            if position + byte_count > end_of_tables:
                raise FormatError(f"Packed DBF {name} exceeds the DAS container")
            table_data = memoryview(data)[position : position + byte_count]
            position += byte_count
            self.tables[name.upper()] = PackedTable(
                name, record_length, record_count, tuple(fields), table_data
            )

        if position != end_of_tables:
            raise FormatError("Packed DBF data does not end at the DAS timestamp")
        self.creation_timestamp = data[end_of_tables:].decode("latin-1").strip()

    def rows(self, table_name: str) -> list[dict[str, str]]:
        try:
            table = self.tables[table_name.upper()]
        except KeyError as exc:
            raise FormatError(f"Definition table is missing: {table_name}") from exc
        return list(table.rows())

    def memory_options(self, version: str, dmc: str, download: str = "IN") -> list[dict[str, str]]:
        return [
            row
            for row in self.rows("MEM_OPTS.DBF")
            if row["VERSN_NUM"].upper() == version.upper()
            and row["DMC_NAME"].upper() == dmc.upper()
            and row["DNLD_OPT"].upper() == download.upper()
        ]

    def software_info(self, version: str, dmc: str, download: str = "IN") -> dict[str, str]:
        matches = [
            row
            for row in self.rows("SFT_INFO.DBF")
            if row["VERSN_NUM"].upper() == version.upper()
            and row["DMC_NAME"].upper() == dmc.upper()
            and row["DNLD_OPT"].upper() == download.upper()
        ]
        if len(matches) != 1:
            raise FormatError(f"Expected one SFT_INFO row for {version}/{dmc}/{download}")
        return matches[0]


class CompiledDefinition:
    """Compact runtime form containing only tables needed by the analyser."""

    def __init__(self, payload: dict[str, object]):
        self.metadata = list(payload.get("metadata", []))
        self.creation_timestamp = str(payload.get("creation_timestamp", ""))
        raw_tables = payload.get("tables", {})
        if not isinstance(raw_tables, dict):
            raise FormatError("Compiled definition has an invalid tables section")
        self.tables: dict[str, list[dict[str, str]]] = {
            str(name).upper(): list(rows) for name, rows in raw_tables.items()
        }

    @classmethod
    def from_path(cls, path: str | Path) -> "CompiledDefinition":
        source = Path(path)
        raw = source.read_bytes()
        if source.suffix.lower() == ".gz":
            raw = gzip.decompress(raw)
        payload = json.loads(raw.decode("utf-8"))
        if payload.get("format") != "medha-compiled-definition-v1":
            raise FormatError("Unsupported compiled definition format")
        return cls(payload)

    def rows(self, table_name: str) -> list[dict[str, str]]:
        try:
            return self.tables[table_name.upper()]
        except KeyError as exc:
            raise FormatError(f"Definition table is missing: {table_name}") from exc

    def memory_options(self, version: str, dmc: str, download: str = "IN") -> list[dict[str, str]]:
        return [
            row
            for row in self.rows("MEM_OPTS.DBF")
            if row["VERSN_NUM"].upper() == version.upper()
            and row["DMC_NAME"].upper() == dmc.upper()
            and row["DNLD_OPT"].upper() == download.upper()
        ]

    def software_info(self, version: str, dmc: str, download: str = "IN") -> dict[str, str]:
        matches = [
            row
            for row in self.rows("SFT_INFO.DBF")
            if row["VERSN_NUM"].upper() == version.upper()
            and row["DMC_NAME"].upper() == dmc.upper()
            and row["DNLD_OPT"].upper() == download.upper()
        ]
        if len(matches) != 1:
            raise FormatError(f"Expected one SFT_INFO row for {version}/{dmc}/{download}")
        return matches[0]


class LocoFiles:
    """Read a locomotive ZIP, ZIP bytes, or extracted directory by basename."""

    def __init__(
        self,
        source: str | Path | bytes | bytearray | memoryview,
        validate_crc: bool = True,
    ):
        self._buffer: io.BytesIO | None = None
        if isinstance(source, (bytes, bytearray, memoryview)):
            self.source = Path("uploaded-locomotive-data.zip")
            self._buffer = io.BytesIO(bytes(source))
            archive_source: str | Path | io.BytesIO = self._buffer
        else:
            self.source = Path(source)
            archive_source = self.source
        self._zip: zipfile.ZipFile | None = None
        self._names: dict[str, str | Path] = {}
        if self._buffer is None and self.source.is_dir():
            for path in self.source.rglob("*"):
                if path.is_file():
                    self._add(path.name, path)
        elif zipfile.is_zipfile(archive_source):
            if self._buffer is not None:
                self._buffer.seek(0)
            self._zip = zipfile.ZipFile(archive_source)
            if validate_crc:
                bad = self._zip.testzip()
                if bad:
                    raise FormatError(f"ZIP CRC failed for {bad}")
            for info in self._zip.infolist():
                if not info.is_dir():
                    self._add(Path(info.filename).name, info.filename)
        else:
            raise FormatError(f"Not a ZIP file or directory: {self.source}")

    def _add(self, basename: str, value: str | Path) -> None:
        key = basename.upper()
        if key in self._names:
            raise FormatError(f"Duplicate archive basename: {basename}")
        self._names[key] = value

    @property
    def names(self) -> list[str]:
        return sorted(self._names)

    def read(self, basename: str) -> bytes:
        try:
            value = self._names[basename.upper()]
        except KeyError as exc:
            raise FormatError(f"Locomotive data is missing {basename}") from exc
        if self._zip is not None:
            return self._zip.read(str(value))
        return Path(value).read_bytes()

    def close(self) -> None:
        if self._zip is not None:
            self._zip.close()
        if self._buffer is not None:
            self._buffer.close()

    def __enter__(self) -> "LocoFiles":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def _number(value: str, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _bcd_style_byte(value: int) -> int:
    # Matches Convert.ToInt32($"{value:X}") in DecodingDll.
    return int(f"{value:X}")


def _record_datetime(record: bytes) -> datetime | None:
    try:
        year, month, day, hour, minute, second = map(_bcd_style_byte, record[4:10])
        return datetime(2000 + year, month, day, hour, minute, second)
    except (ValueError, TypeError):
        return None


@dataclass(frozen=True)
class RawRecord:
    offset: int
    timestamp: datetime
    data: bytes


def _parse_markers(value: str) -> bytes:
    return bytes(int(part.strip(), 16) for part in value.split(",") if part.strip())


def scan_memory_records(
    data: bytes,
    status: bytes,
    software: dict[str, str],
    memory: dict[str, str],
    progress_callback: Callable[[float], None] | None = None,
) -> list[RawRecord]:
    sector_size_pos = int(software["SECSZ_POS"])
    sector_size_bytes = int(software["SECSZ_BYTS"])
    sector_multiplier = int(software["SECSZ_KVAL"])
    sector_size = int.from_bytes(
        status[sector_size_pos : sector_size_pos + sector_size_bytes], "big"
    ) * sector_multiplier
    count_pos = int(memory["SECTS_POS"] or 0)
    count_bytes = int(memory["SECTS_BYTS"] or 0)
    if count_bytes:
        sector_count = int.from_bytes(status[count_pos : count_pos + count_bytes], "big")
    else:
        sector_count = max(1, len(data) // sector_size)
    if sector_size <= 0 or sector_count <= 0 or len(data) < sector_size * sector_count:
        raise FormatError(f"Invalid sector geometry for {memory['FILE_NAME']}")

    record_size = int(memory["RECRD_SIZE"])
    start = _parse_markers(memory["STRT_BYTES"])
    end = _parse_markers(memory["END_BYTES"])
    length_parts = memory.get("RECLN_FRMT", "2,MSBLSB").split(",")
    length_bytes = int(length_parts[0] or 2)
    byte_order = "little" if len(length_parts) > 1 and length_parts[1] == "LSBMSB" else "big"
    records: list[RawRecord] = []
    progress_step = max(1, sector_count // 50)
    for sector_index in range(sector_count):
        sector_offset = sector_index * sector_size
        sector_end = sector_offset + sector_size
        for offset in range(sector_offset, sector_end - record_size + 1, record_size):
            record = data[offset : offset + record_size]
            if not record.startswith(start) or not record.endswith(end):
                continue
            encoded_length = int.from_bytes(
                record[len(start) : len(start) + length_bytes], byte_order
            )
            if encoded_length != record_size:
                continue
            timestamp = _record_datetime(record)
            if timestamp is not None:
                records.append(RawRecord(offset, timestamp, record))
        if progress_callback and (
            (sector_index + 1) % progress_step == 0 or sector_index + 1 == sector_count
        ):
            progress_callback((sector_index + 1) / sector_count)
    # Ring buffers become chronological when ordered by their embedded RTC.
    records.sort(key=lambda item: item.timestamp)
    return records


def _positive_schema_bits(payload: bytes, schema: Sequence[dict[str, str]]) -> list[int]:
    bits: list[int] = []
    position = 0
    for field in schema:
        size = int(_number(field["BYTE_SIZE"]))
        if size <= 0:
            continue
        raw = int.from_bytes(payload[position : position + size], "big")
        position += size
        bits.extend((raw >> bit) & 1 for bit in range(size * 8))
    return bits


def _bits_value(bits: Sequence[int], start: int, count: int) -> int:
    return sum(bits[start + bit] << bit for bit in range(count))


class Mec628Decoder:
    def __init__(
        self,
        definition: DasDefinition | CompiledDefinition,
        loco: LocoFiles,
        version: str = "V2",
        dmc: str = "WAP7",
        download: str = "IN",
    ):
        self.definition = definition
        self.loco = loco
        self.version = version.upper()
        self.dmc = dmc.upper()
        self.download = download.upper()
        self.software = definition.software_info(self.version, self.dmc, self.download)
        self.memories = {
            row["SHORT_NAME"].upper(): row
            for row in definition.memory_options(self.version, self.dmc, self.download)
        }
        self.prefix = self.software["DMC_FCHAR"]
        self.status = loco.read(self.software["SECSZ_FILE"])
        self._record_cache: dict[str, list[RawRecord]] = {}
        self._fdp_time_index: dict[datetime, list[int]] | None = None

    def _schema(self, short_name: str) -> list[dict[str, str]]:
        return self.definition.rows(f"{self.prefix}{short_name}L{self.version}.DBF")

    def raw_records(
        self,
        short_name: str,
        progress_callback: Callable[[float], None] | None = None,
    ) -> list[RawRecord]:
        """Return chronological valid records for a configured memory."""

        key = short_name.upper()
        try:
            memory = self.memories[key]
        except KeyError as exc:
            raise FormatError(f"Memory is not configured: {short_name}") from exc
        if key not in self._record_cache:
            self._record_cache[key] = scan_memory_records(
                self.loco.read(memory["FILE_NAME"]),
                self.status,
                self.software,
                memory,
                progress_callback=progress_callback,
            )
        elif progress_callback:
            progress_callback(1.0)
        return self._record_cache[key]

    def records_loaded(self, short_name: str) -> bool:
        """Return whether a memory has already been indexed in this decoder."""

        return short_name.upper() in self._record_cache

    def cache_raw_records(self, short_name: str, records: list[RawRecord]) -> None:
        """Attach records produced by a background decoder for the same archive."""

        key = short_name.upper()
        if key not in self.memories:
            raise FormatError(f"Memory is not configured: {short_name}")
        self._record_cache.setdefault(key, records)

    def fdp_window_config(self) -> dict[str, object]:
        """Return the vendor-defined pre/post-fault display configuration."""

        candidates = [
            row
            for row in self.definition.rows("FDP_INFO.DBF")
            if row["VERSN_NUM"].upper() == self.version
            and row["DMC_NAME"].upper() == self.dmc
            and row["SHORT_NAME"].upper() == "FDP"
        ]
        exact_download = [
            row for row in candidates if row.get("DNLD_OPT", "").upper() == self.download
        ]
        if exact_download:
            candidates = exact_download
        else:
            candidates = [row for row in candidates if not row.get("DNLD_OPT", "").strip()]
        if not candidates:
            raise FormatError(
                f"No FDP_INFO display configuration for {self.version}/{self.dmc}/{self.download}"
            )
        row = candidates[0]
        return {
            "name": row["RDBTN_NAME"],
            "previous_seconds": int(row["PREV_SECS"] or 0),
            "next_seconds": int(row["NEXT_SECS"] or 0),
            "fault_occurrence": row["FLT_OCUR"].upper().startswith("T"),
            "fault_instant": row["FLT_INST"].upper().startswith("T"),
            "resolution_ms": int(row["SEC_RSLTN"] or 1000),
        }

    def fdp_window(
        self, fault_timestamp: str | datetime, instant_row_index: int
    ) -> list[dict[str, object]]:
        """Select the vendor-defined pre/occurrence/instant/post FDP records.

        DASAPP selects surrounding records by exact second.  At the fault
        second, the packet-zero row is the occurrence sample and the joined
        packet-index row is the fault-instant sample.
        """

        timestamp = (
            datetime.fromisoformat(fault_timestamp)
            if isinstance(fault_timestamp, str)
            else fault_timestamp
        )
        records = self.raw_records("FDP")
        if instant_row_index < 0 or instant_row_index >= len(records):
            raise FormatError(f"FDP row index is out of range: {instant_row_index}")
        if self._fdp_time_index is None:
            time_index: dict[datetime, list[int]] = {}
            for index, record in enumerate(records):
                time_index.setdefault(record.timestamp, []).append(index)
            self._fdp_time_index = time_index

        config = self.fdp_window_config()
        output: list[dict[str, object]] = []

        def append_sample(label: str, relative_seconds: int, row_index: int | None) -> None:
            output.append(
                {
                    "label": label,
                    "relative_seconds": relative_seconds,
                    "row_index": row_index,
                    "timestamp": (
                        records[row_index].timestamp.isoformat(sep=" ")
                        if row_index is not None
                        else (timestamp + timedelta(seconds=relative_seconds)).isoformat(sep=" ")
                    ),
                }
            )

        previous = int(config["previous_seconds"])
        following = int(config["next_seconds"])
        for seconds in range(-previous, 0):
            candidates = self._fdp_time_index.get(timestamp + timedelta(seconds=seconds), [])
            append_sample(f"{seconds} s", seconds, candidates[0] if candidates else None)

        same_second = self._fdp_time_index.get(timestamp, [])
        if config["fault_occurrence"]:
            occurrence = next(
                (index for index in same_second if index != instant_row_index), None
            )
            append_sample("Occurrence", 0, occurrence)
        if config["fault_instant"]:
            append_sample("Fault instant", 0, instant_row_index)

        for seconds in range(1, following + 1):
            candidates = self._fdp_time_index.get(timestamp + timedelta(seconds=seconds), [])
            append_sample(f"+{seconds} s", seconds, candidates[0] if candidates else None)
        return output

    def parameter_metadata(self, short_name: str) -> list[dict[str, str]]:
        """Return stored (non-calculated) parameter definitions for a memory."""

        return [row for row in self._schema(short_name.upper()) if int(_number(row["BYTE_SIZE"]))]

    def flag_metadata(self, short_name: str) -> dict[str, list[dict[str, object]]]:
        """Return bit-level child definitions grouped by their parent parameter."""

        key = short_name.upper()
        try:
            rows = self.definition.rows(f"{self.prefix}{key}F{self.version}.DBF")
        except FormatError:
            return {}
        grouped: dict[str, list[dict[str, object]]] = {}
        for row in rows:
            grouped.setdefault(row["HDR_NAME"], []).append(
                {
                    "name": row["FLG_NAME"],
                    "unit": row["FLG_UNIT"],
                    "bit_position": int(row["BIT_POS"] or 0),
                    "on_message": row["ON_MSG"],
                    "off_message": row["OFF_MSG"],
                    "condition": row["SUB_COND"],
                    "condition_input": row["SUB_CON_IN"],
                    "visible": row["VISIBLE"].upper().startswith("T"),
                    "display_order": int(row["BDISP_ORD"] or 0),
                }
            )
        for children in grouped.values():
            children.sort(key=lambda item: (int(item["display_order"]), int(item["bit_position"])))
        return grouped

    def _parameter_offsets(
        self, short_name: str
    ) -> tuple[dict[str, tuple[int, int, dict[str, str]]], dict[tuple[str, int], str]]:
        key = short_name.upper()
        memory = self.memories[key]
        length_parts = memory.get("RECLN_FRMT", "2,MSBLSB").split(",")
        length_bytes = int(length_parts[0] or 2)
        position = len(_parse_markers(memory["STRT_BYTES"])) + length_bytes + 6
        offsets: dict[str, tuple[int, int, dict[str, str]]] = {}
        for parameter in self._schema(key):
            size = int(_number(parameter["BYTE_SIZE"]))
            if size:
                offsets[parameter["NAME"].casefold()] = (position, size, parameter)
            position += size
        try:
            display_rows = self.definition.rows(f"{self.prefix}{key}M{self.version}.DBF")
        except FormatError:
            display_rows = []
        display_map = {
            (row["SUB_COND"], int(row["INVALUE"])): row["RESULT_MSG"]
            for row in display_rows
        }
        return offsets, display_map

    def parameter_records(
        self,
        short_name: str,
        parameters: Sequence[str] | None = None,
        row_indices: Iterable[int] | None = None,
    ) -> list[dict[str, object]]:
        """Decode selected parameters and rows from FDP/LGM/SHM-style memories.

        ``row_indices`` refers to the chronological indexes returned by
        :meth:`raw_records`.  Selecting rows keeps the large long- and
        short-term memories suitable for paged interactive viewing.
        """

        key = short_name.upper()
        offsets, display_map = self._parameter_offsets(key)
        if parameters is None:
            parameters = tuple(item[2]["NAME"] for item in offsets.values())
        requested: list[tuple[str, int, int, dict[str, str]]] = []
        for name in parameters:
            try:
                offset, size, parameter = offsets[name.casefold()]
            except KeyError as exc:
                raise FormatError(f"Unknown {key} parameter: {name}") from exc
            requested.append((parameter["NAME"], offset, size, parameter))

        records = self.raw_records(key)
        if row_indices is None:
            selected = enumerate(records)
        else:
            normalized = list(row_indices)
            invalid = next((index for index in normalized if index < 0 or index >= len(records)), None)
            if invalid is not None:
                raise FormatError(f"{key} row index is out of range: {invalid}")
            selected = ((index, records[index]) for index in normalized)

        output: list[dict[str, object]] = []
        for row_index, raw_record in selected:
            values: dict[str, object] = {}
            units: dict[str, str] = {}
            display: dict[str, str] = {}
            for name, offset, size, parameter in requested:
                raw_bytes = raw_record.data[offset : offset + size]
                value = self._decode_parameter(raw_bytes, parameter)
                values[name] = value
                if parameter["UNIT"]:
                    units[name] = parameter["UNIT"]
                if parameter["CONDITION"] == "P" and isinstance(value, int):
                    message = display_map.get((parameter["SUB_COND"], value), "")
                    if message:
                        display[name] = message
            output.append(
                {
                    "row_index": row_index,
                    "source_offset": raw_record.offset,
                    "timestamp": raw_record.timestamp.isoformat(sep=" "),
                    "values": values,
                    "units": units,
                    "display": display,
                }
            )
        return output

    def faults(self, include_hidden: bool = False) -> list[dict[str, object]]:
        memory = self.memories["ERL"]
        records = self.raw_records("ERL")
        schema = self._schema("ERL")
        lookups = {
            row["CODE"]: row
            for row in self.definition.rows(f"{self.prefix}ERCD{self.version}.DBF")
        }
        enum_rows = self.definition.rows(f"{self.prefix}ERLM{self.version}.DBF")
        enum_map = {
            (row["SUB_COND"], int(row["INVALUE"])): row["RESULT_MSG"] for row in enum_rows
        }
        code_field = next(row for row in schema if row["NAME"] == "Fault Code")
        packet_field = next(row for row in schema if row["NAME"] == "Packet Index")
        dmc_field = next(row for row in schema if row["NAME"].upper() == "DMC NUM")
        master_field = next(row for row in schema if row["NAME"] == "MASTERSHIP")
        payload_start = len(_parse_markers(memory["STRT_BYTES"])) + 2 + 6
        payload_size = sum(int(_number(row["BYTE_SIZE"])) for row in schema)
        output: list[dict[str, object]] = []
        for row_index, raw_record in enumerate(records):
            payload = raw_record.data[payload_start : payload_start + payload_size]
            bits = _positive_schema_bits(payload, schema)
            code = _bits_value(
                bits, int(code_field["BIT_START"]), int(code_field["BITS_COUNT"])
            )
            packet = _bits_value(
                bits, int(packet_field["BIT_START"]), int(packet_field["BITS_COUNT"])
            )
            dmc_value = _bits_value(bits, int(dmc_field["BIT_START"]), int(dmc_field["BITS_COUNT"]))
            master_value = _bits_value(
                bits, int(master_field["BIT_START"]), int(master_field["BITS_COUNT"])
            )
            lookup = lookups.get(str(code))
            visible = bool(lookup and lookup["VISIBLE"].upper().startswith("T"))
            if not include_hidden and not visible:
                continue
            output.append(
                {
                    "row_index": row_index,
                    "source_offset": raw_record.offset,
                    "timestamp": raw_record.timestamp.isoformat(sep=" "),
                    "fault_code": code,
                    "fault_message": lookup["REMARKS"] if lookup else "Undefined Code",
                    "dmc": enum_map.get((dmc_field["SUB_COND"], dmc_value), ""),
                    "mastership": enum_map.get((master_field["SUB_COND"], master_value), ""),
                    "packet_index": packet,
                    "visible": visible,
                    "priority": lookup["PRIORITY"] if lookup else "",
                    "recovery": lookup["RECOVERY"] if lookup else "",
                    "reset": lookup["RESET"] if lookup else "",
                    "fdp_show": lookup["FDP_SHOW"] if lookup else "",
                }
            )
        return output

    @staticmethod
    def _decode_vbn(raw: int) -> str:
        if not raw & 0x8000:
            return f"{raw >> 8:02X}.{raw & 0xFF:02X}.00"
        return f"{(raw >> 10) & 0x1F:02d}.{(raw >> 5) & 0x1F:02d}.{raw & 0x1F:02d}"

    @staticmethod
    def _decode_parameter(raw_bytes: bytes, parameter: dict[str, str]) -> object:
        condition = parameter["CONDITION"]
        if condition in ("G1", "G2"):
            return ".".join(
                str(int.from_bytes(raw_bytes[index : index + 2], "big"))
                for index in range(0, 6, 2)
            )
        if condition == "C":
            return raw_bytes.rstrip(b"\x00").decode("latin-1", errors="replace")
        raw = int.from_bytes(raw_bytes, "big")
        if condition == "VBN":
            return Mec628Decoder._decode_vbn(raw)
        if parameter["DATA_TYPE"] == "S":
            modulus = 1 << (len(raw_bytes) * 8)
            if raw > modulus // 2:  # matches the strict comparison in DecodingDll
                raw -= modulus
        value = (raw - _number(parameter["OFFSET_VAL"]))
        value *= _number(parameter["MUL_FACTOR"], 1) or 1
        value /= _number(parameter["DIV_FACTOR"], 1) or 1
        decimals = int(parameter["DECIMALS"] or 0)
        if decimals == 0:
            return int(round(value))
        rounded = float(f"{value:.{decimals}f}")
        return 0.0 if rounded == 0 else rounded

    def fdp_records(self, parameters: Sequence[str] = DEFAULT_ENVIRONMENT_PARAMETERS) -> list[dict[str, object]]:
        return self.parameter_records("FDP", parameters)

    def fault_environment(
        self,
        parameters: Sequence[str] = DEFAULT_ENVIRONMENT_PARAMETERS,
        include_hidden: bool = False,
    ) -> list[dict[str, object]]:
        faults = self.faults(include_hidden=include_hidden)
        fdp = self.fdp_records(parameters)
        by_key: dict[tuple[str, int], list[dict[str, object]]] = {}
        for record in fdp:
            packet = int(record["values"].get("Packet Index", 0))
            by_key.setdefault((str(record["timestamp"]), packet), []).append(record)
        output: list[dict[str, object]] = []
        for fault in faults:
            key = (str(fault["timestamp"]), int(fault["packet_index"]))
            for environment in by_key.get(key, []):
                output.append({"fault": fault, "environment": environment})
        return output


def _parameter_list(value: str | None) -> tuple[str, ...]:
    if not value:
        return DEFAULT_ENVIRONMENT_PARAMETERS
    names = tuple(part.strip() for part in value.split(",") if part.strip())
    if "Packet Index" not in names:
        names = ("Packet Index",) + names
    return names


def _write_json(value: object, output: str | None) -> None:
    text = json.dumps(value, indent=2, ensure_ascii=False)
    if output:
        Path(output).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)


def _write_fault_csv(rows: Sequence[dict[str, object]], output: str | None) -> None:
    stream: io.TextIOBase
    close = False
    if output:
        stream = Path(output).open("w", encoding="utf-8-sig", newline="")
        close = True
    else:
        stream = sys.stdout
    try:
        fieldnames = list(rows[0]) if rows else [
            "row_index", "source_offset", "timestamp", "fault_code", "fault_message",
            "dmc", "mastership", "packet_index", "visible", "priority", "recovery",
            "reset", "fdp_show",
        ]
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    finally:
        if close:
            stream.close()


def _write_fdp_csv(rows: Sequence[dict[str, object]], parameters: Sequence[str], output: str | None) -> None:
    stream: io.TextIOBase
    close = False
    if output:
        stream = Path(output).open("w", encoding="utf-8-sig", newline="")
        close = True
    else:
        stream = sys.stdout
    try:
        fields = ["row_index", "source_offset", "timestamp", *parameters]
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            flat = {key: row[key] for key in ("row_index", "source_offset", "timestamp")}
            flat.update(row["values"])
            writer.writerow(flat)
    finally:
        if close:
            stream.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--definition", required=True, help="Encrypted .das or decrypted definition file")
    parser.add_argument("--version", default="V2", help="Controller definition version (default: V2)")
    parser.add_argument("--dmc", default="WAP7", help="DMC/module name (default: WAP7)")
    parser.add_argument("--download", default="IN", help="Download option (default: IN)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="Inventory and map the ZIP's raw memories")
    inspect_parser.add_argument("source", help="Locomotive ZIP or extracted directory")
    inspect_parser.add_argument("--output")

    faults_parser = subparsers.add_parser("faults", help="Decode ERRORLOG.DAT")
    faults_parser.add_argument("source")
    faults_parser.add_argument("--all", action="store_true", help="Include hidden and undefined codes")
    faults_parser.add_argument("--output", help="CSV output path; stdout when omitted")

    fdp_parser = subparsers.add_parser("fdp", help="Decode FLTPACK.DAT environment records")
    fdp_parser.add_argument("source")
    fdp_parser.add_argument("--parameters", help="Comma-separated parameter names")
    fdp_parser.add_argument("--output", help="CSV output path; stdout when omitted")

    join_parser = subparsers.add_parser(
        "fault-environment", help="Join fault events to their exact FDP snapshot"
    )
    join_parser.add_argument("source")
    join_parser.add_argument("--parameters", help="Comma-separated parameter names")
    join_parser.add_argument("--all", action="store_true", help="Include hidden fault events")
    join_parser.add_argument("--output", help="JSON output path; stdout when omitted")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        definition = DasDefinition.from_path(args.definition)
        with LocoFiles(args.source) as loco:
            decoder = Mec628Decoder(definition, loco, args.version, args.dmc, args.download)
            if args.command == "inspect":
                mapped = []
                for memory in decoder.memories.values():
                    mapped.append(
                        {
                            "raw_file": memory["FILE_NAME"],
                            "short_name": memory["SHORT_NAME"],
                            "das_extension": memory["MEMRY_EXT"],
                            "record_size": int(memory["RECRD_SIZE"]),
                            "sector_count_status_offset": int(memory["SECTS_POS"] or 0),
                            "present": memory["FILE_NAME"].upper() in loco.names,
                        }
                    )
                result = {
                    "source": str(loco.source),
                    "definition_creation_timestamp": definition.creation_timestamp,
                    "definition_metadata": definition.metadata,
                    "configuration": {
                        "version": decoder.version,
                        "dmc": decoder.dmc,
                        "download": decoder.download,
                        "definition_tables": len(definition.tables),
                    },
                    "archive_files": loco.names,
                    "mapped_memories": mapped,
                    "unmapped_archive_files": sorted(
                        set(loco.names) - {item["raw_file"].upper() for item in mapped}
                    ),
                }
                _write_json(result, args.output)
            elif args.command == "faults":
                _write_fault_csv(decoder.faults(include_hidden=args.all), args.output)
            elif args.command == "fdp":
                parameters = _parameter_list(args.parameters)
                _write_fdp_csv(decoder.fdp_records(parameters), parameters, args.output)
            elif args.command == "fault-environment":
                parameters = _parameter_list(args.parameters)
                _write_json(
                    decoder.fault_environment(parameters, include_hidden=args.all), args.output
                )
    except (OSError, FormatError, RuntimeError, zipfile.BadZipFile) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
