#!/usr/bin/env python3
"""Compact, offline Fault Log + FDP report generation.

The report deliberately contains no long-memory, short-memory, population,
depth-analysis, or chart code.  Its JSON payload is written column-by-column
into a level-9 gzip stream so a complete locomotive report can be produced
without first constructing the many-million-cell document in memory.
"""

from __future__ import annotations

import base64
import gzip
import json
import tempfile
from collections.abc import Callable, Iterable
from typing import Any


ProgressCallback = Callable[[float], None]


_HTML_PREFIX = b"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Medha Fault Log + FDP Environment Report</title>
<style>
:root{--navy:#003b63;--blue:#087eae;--sky:#e9f6fc;--line:#cfe1ec;--ink:#082f4d;--muted:#607b8d;--white:#fff;--good:#087b5a;--bad:#9b4d00;--row:68px}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font:14px/1.45 "Segoe UI",Arial,sans-serif;color:var(--ink);background:#f5fbfe}button,input,select{font:inherit}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 24px;color:#fff;background:linear-gradient(120deg,var(--navy),var(--blue));box-shadow:0 4px 18px #003b6324}
.brand{font-size:22px;font-weight:800;letter-spacing:.2px}.credit{text-align:right;font-size:12px;letter-spacing:.8px;text-transform:uppercase}.credit b{display:block;font-size:14px}
.shell{max-width:1900px;margin:auto;padding:18px}.card{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 26px #03466b0c}
.summary{display:grid;grid-template-columns:repeat(5,minmax(125px,1fr));gap:1px;overflow:hidden;margin-bottom:16px;background:var(--line)}.metric{padding:13px 16px;background:#fff}.metric span{display:block;color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase}.metric b{font-size:20px}
.fault-card{overflow:hidden}.toolbar{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}.toolbar h2{margin:0;font-size:18px;white-space:nowrap}.search{width:100%;min-width:160px;padding:10px 12px;border:1px solid #b9d2df;border-radius:9px;color:var(--ink);outline:none}.search:focus{border-color:var(--blue);box-shadow:0 0 0 3px #0b8eb21f}.count{white-space:nowrap;color:var(--muted)}
.fault-head,.fault-row{display:grid;grid-template-columns:180px 95px minmax(320px,1fr) 110px 105px 115px;align-items:center;gap:10px}.fault-head{padding:9px 16px;color:#fff;background:#075c86;font-size:12px;font-weight:700;text-transform:uppercase}.fault-viewport{height:476px;overflow:auto;position:relative;scrollbar-gutter:stable}.fault-spacer{position:relative;min-width:940px}.fault-rows{position:absolute;left:0;right:0;top:0}.fault-row{height:var(--row);width:100%;padding:7px 16px;border:0;border-bottom:1px solid #e4eff5;background:#fff;color:var(--ink);text-align:left;cursor:pointer}.fault-row:hover,.fault-row.active{background:#e5f5fc}.fault-row.active{box-shadow:inset 5px 0 var(--blue)}.fault-code{font-size:16px;font-weight:800}.fault-message{overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}.pill{justify-self:start;padding:3px 8px;border-radius:99px;background:#e7f7f1;color:var(--good);font-size:12px;font-weight:700}.pill.missing{background:#fff1e4;color:var(--bad)}
.detail{margin-top:16px;overflow:hidden}.empty{min-height:230px;display:grid;place-items:center;padding:30px;text-align:center;color:var(--muted)}.detail-main{display:none}.fault-banner{padding:16px 18px;border-bottom:1px solid var(--line);background:linear-gradient(100deg,#f7fcff,#e8f6fc)}.fault-banner h2{margin:0 0 4px;font-size:20px}.fault-meta{color:var(--muted)}
.detail-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}.detail-tools label{display:flex;align-items:center;gap:7px}.detail-tools .search{flex:1}.detail-status{margin-left:auto;color:var(--muted);font-weight:600}.variant{padding:8px 10px;border:1px solid #b9d2df;border-radius:8px;background:#fff;color:var(--ink)}
.table-wrap{max-height:70vh;overflow:auto;scrollbar-gutter:stable;border-top:0}.fdp{width:100%;min-width:1200px;border-collapse:separate;border-spacing:0}.fdp th{position:sticky;top:0;z-index:3;padding:9px 8px;color:#fff;background:#075c86;border-right:1px solid #4384a4;white-space:nowrap}.fdp th:first-child{left:0;z-index:5;min-width:250px}.fdp th:nth-child(2){left:250px;z-index:5;min-width:78px}.fdp td{padding:8px;border-right:1px solid #deebf2;border-bottom:1px solid #deebf2;vertical-align:top;white-space:nowrap}.fdp td:first-child{position:sticky;left:0;z-index:2;min-width:250px;background:inherit;white-space:normal}.fdp td:nth-child(2){position:sticky;left:250px;z-index:2;min-width:78px;background:inherit}.fdp tr:nth-child(even){background:#f8fcfe}.fdp tr.child{background:#edf8fd;color:#205b77}.fdp tr.child td:first-child{padding-left:34px}.expand{width:25px;height:25px;margin-right:7px;border:1px solid #8db9ce;border-radius:6px;background:#fff;color:#006b9a;font-weight:900;cursor:pointer}.meaning{display:block;color:#4f7185;font-size:12px}.load-error{margin:30px;padding:22px;border:1px solid #df9c9c;border-radius:10px;background:#fff0f0;color:#8b2424}
.loading{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:#f5fbfe}.loading-box{width:min(430px,86vw);padding:28px;text-align:center}.bar{height:8px;margin-top:18px;overflow:hidden;border-radius:99px;background:#d5e9f3}.bar:after{content:"";display:block;width:38%;height:100%;border-radius:inherit;background:var(--blue);animation:move 1.1s infinite ease-in-out}@keyframes move{from{transform:translateX(-105%)}to{transform:translateX(275%)}}
@media(max-width:900px){.summary{grid-template-columns:repeat(2,1fr)}.credit{display:none}.shell{padding:10px}.fault-head{display:none}.fault-row{grid-template-columns:145px 80px minmax(290px,1fr) 90px 90px 105px}.toolbar{flex-wrap:wrap}}
@media print{.top{position:static}.fault-viewport{height:auto;overflow:visible}.fault-spacer{height:auto!important}.fault-rows{position:static;transform:none!important}.detail{break-before:page}.detail-tools{display:none}.table-wrap{max-height:none;overflow:visible}.fdp th{position:static}.fdp td:first-child,.fdp td:nth-child(2){position:static}}
</style>
</head>
<body>
<header class="top"><div class="brand">Medha Data Analyser</div><div class="credit"><b>Fault Log + FDP Environment</b>Developed by ELS / ED</div></header>
<main class="shell">
  <section class="summary card" aria-label="Report summary">
    <div class="metric"><span>Fault log rows</span><b id="faultTotal">--</b></div>
    <div class="metric"><span>Faults with FDP</span><b id="retainedTotal">--</b></div>
    <div class="metric"><span>FDP samples included</span><b id="recordTotal">--</b></div>
    <div class="metric"><span>FDP parameters</span><b id="parameterTotal">--</b></div>
    <div class="metric"><span>Report source</span><b id="archiveName" style="font-size:14px">--</b></div>
  </section>
  <section class="fault-card card">
    <div class="toolbar"><h2>Fault log</h2><input id="faultSearch" class="search" type="search" placeholder="Search date, code, description, DMC or role"><span id="faultCount" class="count"></span></div>
    <div class="fault-head"><span>Date and time</span><span>Fault code</span><span>Description</span><span>DMC</span><span>Role</span><span>FDP</span></div>
    <div id="faultViewport" class="fault-viewport"><div id="faultSpacer" class="fault-spacer"><div id="faultRows" class="fault-rows"></div></div></div>
  </section>
  <section class="detail card">
    <div id="detailEmpty" class="empty"><div><h2>Select a fault</h2><p>Click any fault above to open its retained pre-fault, occurrence, fault-instant and post-fault FDP readings.</p></div></div>
    <div id="detailMain" class="detail-main">
      <div class="fault-banner"><h2 id="detailTitle"></h2><div id="detailMeta" class="fault-meta"></div></div>
      <div class="detail-tools">
        <label id="variantLabel">Snapshot <select id="variantPicker" class="variant"></select></label>
        <input id="parameterSearch" class="search" type="search" placeholder="Search all FDP parameters or sub-signals">
        <label><input id="visibleOnly" type="checkbox"> Definition-visible only</label>
        <span id="detailStatus" class="detail-status"></span>
      </div>
      <div id="tableWrap" class="table-wrap"><table class="fdp"><thead id="fdpHead"></thead><tbody id="fdpBody"></tbody></table></div>
    </div>
  </section>
</main>
<div id="loading" class="loading"><div class="loading-box card"><h2>Opening fault report</h2><p>Decompressing the main Fault Log and retained FDP environment data locally...</p><div class="bar"></div></div></div>
<script id="medha-payload" type="application/octet-stream">"""


_HTML_SUFFIX = b"""</script>
<script>
(function(){"use strict";
const $=id=>document.getElementById(id),E=v=>String(v==null?"":v).replace(/[&<>"']/g,c=>"&#"+c.charCodeAt(0)+";");
const ROW=68,OVERSCAN=6;let D,F,P,C,T,filtered=[],searchText=[],selected=-1,variant=0,expanded=new Set(),displayMaps=[];
const fmt=v=>v==null||v===""?"--":String(v),num=v=>Number(v||0).toLocaleString();
function sampleDefs(){const out=[];for(let n=-C[1];n<0;n++)out.push([n+" s",n]);if(C[3])out.push(["Occurrence",0]);if(C[4])out.push(["Fault instant",0]);for(let n=1;n<=C[2];n++)out.push(["+"+n+" s",n]);return out}
function renderFaults(){const view=$("faultViewport"),height=filtered.length*ROW,start=Math.max(0,Math.floor(view.scrollTop/ROW)-OVERSCAN),end=Math.min(filtered.length,Math.ceil((view.scrollTop+view.clientHeight)/ROW)+OVERSCAN);$("faultSpacer").style.height=height+"px";let html="";for(let p=start;p<end;p++){const i=filtered[p],g=F[12][i],active=i===selected?" active":"";html+='<button class="fault-row'+active+'" data-f="'+i+'" style="position:absolute;top:'+(p*ROW)+'px"><span>'+E(F[1][i])+'</span><span class="fault-code">'+E(F[2][i])+'</span><span class="fault-message">'+E(F[3][i])+'</span><span>'+E(fmt(F[4][i]))+'</span><span>'+E(fmt(F[5][i]))+'</span><span class="pill'+(g<0?' missing':'')+'">'+(g<0?'Not retained':'Available')+'</span></button>'}$("faultRows").innerHTML=html;$("faultCount").textContent=num(filtered.length)+" displayed"}
function filterFaults(){const q=$("faultSearch").value.trim().toLocaleLowerCase();filtered=q?searchText.reduce((a,v,i)=>(v.includes(q)&&a.push(i),a),[]):Array.from({length:F[0].length},(_,i)=>i);$("faultViewport").scrollTop=0;renderFaults()}
function openFault(i){selected=i;variant=0;expanded.clear();$("parameterSearch").value="";renderFaults();const group=F[12][i],title=F[2][i]+" - "+F[3][i];$("detailEmpty").style.display="none";$("detailMain").style.display="block";$("detailTitle").textContent=title;$("detailMeta").textContent=F[1][i]+" | DMC: "+fmt(F[4][i])+" | Role: "+fmt(F[5][i])+" | Priority: "+fmt(F[8][i])+" | Recovery: "+fmt(F[9][i])+" | Reset: "+fmt(F[10][i]);if(group<0){$("variantLabel").style.display="none";$("tableWrap").style.display="none";$("detailStatus").textContent="FDP environment was not retained for this fault";return}const variants=D.e[group];$("tableWrap").style.display="block";$("variantLabel").style.display=variants.length>1?"flex":"none";$("variantPicker").innerHTML=variants.map((_,n)=>'<option value="'+n+'">'+(n+1)+" of "+variants.length+'</option>').join("");renderDetail();$("detailMain").scrollIntoView({behavior:"smooth",block:"start"})}
function displayAt(pi,ri){if(ri<0)return"";let m=displayMaps[pi];if(!m){m=new Map();for(const group of D.d[pi][1])for(const row of group[1])m.set(row,group[0]);displayMaps[pi]=m}return m.get(ri)||""}
function cell(pi,ri){if(ri<0)return'<span class="meaning">Not retained</span>';const v=D.d[pi][0][ri],meaning=displayAt(pi,ri);return E(fmt(v))+(meaning?'<span class="meaning">'+E(meaning)+'</span>':"")}
function bitCell(pi,ri,ch){if(ri<0)return'<span class="meaning">Not retained</span>';const raw=D.d[pi][0][ri],n=Number(raw);if(!Number.isFinite(n))return"--";let bit;try{bit=Number((BigInt(Math.trunc(n))>>BigInt(ch[2]))&1n)}catch(_){bit=Math.floor(n/Math.pow(2,ch[2]))%2}const msg=bit?ch[3]:ch[4];return String(bit)+(msg?'<span class="meaning">'+E(msg)+'</span>':"")}
function renderDetail(){if(selected<0||F[12][selected]<0)return;const variants=D.e[F[12][selected]],rows=variants[Math.min(variant,variants.length-1)],defs=sampleDefs(),q=$("parameterSearch").value.trim().toLocaleLowerCase(),visibleOnly=$("visibleOnly").checked;let shown=0,children=0,html="";for(let pi=0;pi<P.length;pi++){const p=P[pi],parentHit=!q||p[0].toLocaleLowerCase().includes(q),childHit=p[3].some(ch=>ch[0].toLocaleLowerCase().includes(q));if((q&&!parentHit&&!childHit)||(visibleOnly&&!p[2]))continue;shown++;children+=p[3].length;html+="<tr><td>"+(p[3].length?'<button class="expand" data-p="'+pi+'">'+(expanded.has(pi)?"-":"+")+"</button>":"")+E(p[0])+"</td><td>"+E(p[1])+"</td>"+rows.map(ri=>"<td>"+cell(pi,ri)+"</td>").join("")+"</tr>";if(expanded.has(pi)||q&&childHit)for(const ch of p[3]){if(q&&!parentHit&&!ch[0].toLocaleLowerCase().includes(q)||visibleOnly&&!ch[5])continue;html+='<tr class="child"><td>Bit '+ch[2]+": "+E(ch[0])+"</td><td>"+E(ch[1])+"</td>"+rows.map(ri=>"<td>"+bitCell(pi,ri,ch)+"</td>").join("")+"</tr>"}}$("fdpHead").innerHTML="<tr><th>Parameter</th><th>Unit</th>"+defs.map((d,n)=>"<th>"+E(d[0])+"<br><small>"+E(rows[n]>=0?(T[rows[n]]||"").slice(11,19):"Not retained")+"</small></th>").join("")+"</tr>";$("fdpBody").innerHTML=html||'<tr><td colspan="'+(defs.length+2)+'">No matching FDP parameter.</td></tr>';$("detailStatus").textContent=num(shown)+" parameters | "+num(children)+" sub-signals"}
async function boot(){try{if(typeof DecompressionStream!=="function")throw new Error("This report needs a current Microsoft Edge or Google Chrome browser.");const b64=$("medha-payload").textContent.trim(),binary=atob(b64),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));D=await new Response(stream).json();F=D.f;P=D.p;C=D.c;T=D.t;searchText=F[0].map((_,i)=>[F[1][i],F[2][i],F[3][i],F[4][i],F[5][i]].join(" ").toLocaleLowerCase());$("faultTotal").textContent=num(D.z[0]);$("retainedTotal").textContent=num(D.z[1]);$("recordTotal").textContent=num(D.z[2]);$("parameterTotal").textContent=num(D.z[3]);$("archiveName").textContent=D.a;filterFaults();$("loading").remove()}catch(err){$("loading").innerHTML='<div class="load-error"><h2>Report could not be opened</h2><p>'+E(err&&err.message||err)+'</p></div>'}}
$("faultViewport").addEventListener("scroll",renderFaults,{passive:true});$("faultRows").addEventListener("click",e=>{const row=e.target.closest("[data-f]");if(row)openFault(Number(row.dataset.f))});let searchTimer;$("faultSearch").addEventListener("input",()=>{clearTimeout(searchTimer);searchTimer=setTimeout(filterFaults,100)});$("variantPicker").addEventListener("change",e=>{variant=Number(e.target.value);expanded.clear();renderDetail()});$("parameterSearch").addEventListener("input",renderDetail);$("visibleOnly").addEventListener("change",renderDetail);$("fdpBody").addEventListener("click",e=>{const b=e.target.closest("[data-p]");if(!b)return;const p=Number(b.dataset.p);expanded.has(p)?expanded.delete(p):expanded.add(p);renderDetail()});boot();
})();
</script>
</body>
</html>
"""


class _GzipTextWriter:
    """Write UTF-8 text to gzip while recording its uncompressed byte count."""

    def __init__(self, stream: gzip.GzipFile):
        self.stream = stream
        self.byte_count = 0

    def write(self, value: str) -> None:
        encoded = value.encode("utf-8")
        self.byte_count += len(encoded)
        self.stream.write(encoded)


_JSON_ENCODER = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"))


def _write_json(writer: _GzipTextWriter, value: object) -> None:
    """Encode one value incrementally instead of materialising its JSON text."""

    for part in _JSON_ENCODER.iterencode(value):
        writer.write(part)


def _write_sequence(
    writer: _GzipTextWriter,
    values: Iterable[object],
) -> None:
    writer.write("[")
    separator = ""
    for value in values:
        writer.write(separator)
        _write_json(writer, value)
        separator = ","
    writer.write("]")


def _notify(callback: ProgressCallback | None, value: float) -> None:
    if callback is not None:
        callback(max(0.0, min(1.0, value)))


def _sample_configuration(config: dict[str, object]) -> list[object]:
    return [
        str(config.get("name", "FDP")),
        int(config.get("previous_seconds", 0)),
        int(config.get("next_seconds", 0)),
        1 if config.get("fault_occurrence") else 0,
        1 if config.get("fault_instant") else 0,
        int(config.get("resolution_ms", 1000)),
    ]


def build_fault_fdp_html(
    service: Any,
    progress_callback: ProgressCallback | None = None,
) -> tuple[bytes, dict[str, object]]:
    """Return a compact offline HTML report and generation statistics.

    ``service`` is an archive-loaded :class:`medha_service.AnalysisService`.
    The returned payload contains the definition-visible fault log shown by
    default in the main browser, every FDP sample referenced by those faults,
    and every associated snapshot variant. Large cell data is JSON
    column-major and is never held as one uncompressed report object.
    """

    _notify(progress_callback, 0.0)
    history_event = getattr(service, "history_run", None)
    history_was_running = bool(history_event is not None and history_event.is_set())
    if history_event is not None:
        history_event.clear()

    try:
        # The method is intentionally called here as well as by the HTTP layer
        # so this public report function remains correct when invoked directly.
        service._ensure_fdp()
        decoder = service.require_decoder()
        # Match the main Fault Log's default view. Definition-hidden and
        # undefined rows remain available in the app's optional checkbox, but
        # are deliberately omitted from this lightweight shareable report.
        faults = [
            dict(row)
            for row in reversed(service.fault_rows)
            if row.get("visible")
        ]
        snapshot_lookup = {
            (str(key[0]), int(key[1])): tuple(int(index) for index in matches)
            for key, matches in (service.snapshot_lookup or {}).items()
        }
        archive_name = service.archive_path.name if service.archive_path else "ALL data"
        raw_records = decoder.raw_records("FDP")
        parameter_rows = list(decoder.parameter_metadata("FDP"))
        flag_rows = decoder.flag_metadata("FDP")
        config = decoder.fdp_window_config()
        _notify(progress_callback, 0.035)

        parameters: list[list[object]] = []
        sub_signal_count = 0
        for row in parameter_rows:
            children = [
                [
                    str(child.get("name", "")),
                    str(child.get("unit", "")),
                    int(child.get("bit_position", 0)),
                    str(child.get("on_message", "")),
                    str(child.get("off_message", "")),
                    1 if child.get("visible") else 0,
                ]
                for child in flag_rows.get(row["NAME"], ())
            ]
            sub_signal_count += len(children)
            parameters.append(
                [
                    row["NAME"],
                    row["UNIT"],
                    1 if row["VISIBLE"].upper().startswith("T") else 0,
                    children,
                ]
            )

        # Each unique fault timestamp/packet pair owns one environment group.
        # Repeated fault-log rows reference the same group, and every matching
        # fault-instant record becomes a separately selectable snapshot.
        environment_index: dict[tuple[str, int], int] = {}
        environments: list[list[list[int]]] = []
        fault_environment_ids: list[int] = []
        for fault in faults:
            key = (str(fault["timestamp"]), int(fault["packet_index"]))
            matches = snapshot_lookup.get(key, ())
            if not matches:
                fault_environment_ids.append(-1)
                continue
            group_index = environment_index.get(key)
            if group_index is None:
                group_index = len(environments)
                environment_index[key] = group_index
                variants: list[list[int]] = []
                for instant_index in matches:
                    variants.append(
                        [
                            int(sample["row_index"])
                            if sample["row_index"] is not None
                            else -1
                            for sample in decoder.fdp_window(key[0], instant_index)
                        ]
                    )
                environments.append(variants)
            fault_environment_ids.append(group_index)

        retained_fault_count = sum(index >= 0 for index in fault_environment_ids)
        snapshot_variant_count = sum(len(group) for group in environments)

        # Only FDP rows reachable from a displayed fault are serialized. Remap
        # their original decoder indexes to a dense report-local sequence.
        included_row_indices = sorted(
            {
                row_index
                for group in environments
                for variant in group
                for row_index in variant
                if row_index >= 0
            }
        )
        report_row_index = {
            source_index: report_index
            for report_index, source_index in enumerate(included_row_indices)
        }
        environments = [
            [
                [
                    report_row_index[row_index] if row_index >= 0 else -1
                    for row_index in variant
                ]
                for variant in group
            ]
            for group in environments
        ]
        raw_timestamps = [
            raw_records[row_index].timestamp.isoformat(sep=" ")
            for row_index in included_row_indices
        ]
        _notify(progress_callback, 0.075)

        fault_column_names = (
            "row_index",
            "timestamp",
            "fault_code",
            "fault_message",
            "dmc",
            "mastership",
            "packet_index",
            "visible",
            "priority",
            "recovery",
            "reset",
            "fdp_show",
        )

        with tempfile.TemporaryFile(mode="w+b") as compressed_file:
            with gzip.GzipFile(
                filename="",
                mode="wb",
                compresslevel=9,
                fileobj=compressed_file,
                mtime=0,
            ) as gzip_stream:
                writer = _GzipTextWriter(gzip_stream)
                writer.write('{"v":1,"a":')
                _write_json(writer, archive_name)
                writer.write(',"c":')
                _write_json(writer, _sample_configuration(config))
                writer.write(',"p":')
                _write_json(writer, parameters)
                writer.write(',"f":[')
                for column_index, name in enumerate(fault_column_names):
                    if column_index:
                        writer.write(",")
                    if name == "visible":
                        column = [1 if fault.get(name) else 0 for fault in faults]
                    else:
                        column = [fault.get(name, "") for fault in faults]
                    _write_json(writer, column)
                    del column
                writer.write(",")
                _write_json(writer, fault_environment_ids)
                writer.write(",")
                _write_json(writer, [fault.get("source_offset", 0) for fault in faults])
                writer.write('],"e":')
                _write_json(writer, environments)
                writer.write(',"t":')
                _write_json(writer, raw_timestamps)
                writer.write(',"d":[')

                parameter_count = len(parameter_rows)
                for parameter_index, row in enumerate(parameter_rows):
                    if parameter_index:
                        writer.write(",")
                    name = row["NAME"]
                    # Decode one parameter column at a time.  At most one FDP
                    # column and its sparse display messages exist in memory.
                    decoded = decoder.parameter_records(
                        "FDP", (name,), row_indices=included_row_indices
                    )
                    values: list[object] = []
                    display_groups: dict[str, list[int]] = {}
                    for item in decoded:
                        values.append(item["values"][name])
                        message = item["display"].get(name, "")
                        if message:
                            display_groups.setdefault(str(message), []).append(
                                report_row_index[int(item["row_index"])]
                            )
                    writer.write("[")
                    _write_json(writer, values)
                    writer.write(",")
                    _write_json(
                        writer,
                        [[message, indices] for message, indices in display_groups.items()],
                    )
                    writer.write("]")
                    del decoded, values, display_groups
                    if parameter_count:
                        _notify(
                            progress_callback,
                            0.09 + 0.84 * (parameter_index + 1) / parameter_count,
                        )

                stats_values = [
                    len(faults),
                    retained_fault_count,
                    len(included_row_indices),
                    len(parameter_rows),
                    sub_signal_count,
                    len(environments),
                    snapshot_variant_count,
                ]
                writer.write('],"z":')
                _write_json(writer, stats_values)
                writer.write("}")
                uncompressed_json_bytes = writer.byte_count

            compressed_size = compressed_file.tell()
            _notify(progress_callback, 0.96)
            compressed_file.seek(0)
            html = bytearray(_HTML_PREFIX)
            # 98,304 is divisible by three, so concatenated chunks remain one
            # canonical base64 stream without carrying boundary bytes.
            while chunk := compressed_file.read(98_304):
                html.extend(base64.b64encode(chunk))
            html.extend(_HTML_SUFFIX)

        if decoder is not service.require_decoder():
            raise RuntimeError("The loaded archive changed while its report was being generated")

        report = bytes(html)
        stats: dict[str, object] = {
            "fault_count": len(faults),
            "retained_fault_count": retained_fault_count,
            "fdp_record_count": len(included_row_indices),
            "parameter_count": len(parameter_rows),
            "sub_signal_count": sub_signal_count,
            "environment_group_count": len(environments),
            "snapshot_variant_count": snapshot_variant_count,
            "uncompressed_json_bytes": uncompressed_json_bytes,
            "compressed_json_bytes": compressed_size,
            "html_bytes": len(report),
        }
        _notify(progress_callback, 1.0)
        return report, stats
    finally:
        if history_event is not None and history_was_running:
            history_event.set()
