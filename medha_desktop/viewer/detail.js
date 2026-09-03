(() => {
  "use strict";

  const rowIndex = Number(new URLSearchParams(location.search).get("row"));
  let detail = null;
  const expanded = new Set();
  const el = Object.fromEntries([
    "closeWindow", "detailCsv", "detailHtml", "faultCard", "faultTime", "faultCode", "faultDmc",
    "faultRole", "faultMessage", "faultMeta", "detailContent", "windowDescription", "parameterCount",
    "sampleStrip", "parameterSearch", "showAllParameters", "fdpHead", "fdpBody", "notRetained",
    "detailError", "loadingOverlay", "detailLoadingText", "detailProgress", "toast"
  ].map((id) => [id, document.getElementById(id)]));

  const api = (endpoint, payload = null, method = "POST") =>
    window.MedhaDesktop.api(endpoint, payload, method);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function showToast(message, error = false) {
    el.toast.textContent = message;
    el.toast.classList.toggle("error", error);
    el.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { el.toast.hidden = true; }, 4500);
  }

  function valueAt(sample, parameter) {
    if (sample.row_index == null || !sample.values) return "";
    const value = sample.values[parameter.name];
    const meaning = sample.display?.[parameter.name];
    return meaning ? `${value} — ${meaning}` : value;
  }

  function childValue(sample, parent, child) {
    if (sample.row_index == null || !sample.values) return "";
    const parentValue = Number(sample.values[parent.name]);
    if (!Number.isFinite(parentValue)) return "";
    const state = Math.floor(parentValue / (2 ** child.bit_position)) % 2;
    const message = state ? child.on_message : child.off_message;
    return message ? `${state} — ${message}` : String(state);
  }

  function renderSamples() {
    const fragment = document.createDocumentFragment();
    detail.samples.forEach((sample) => {
      const card = document.createElement("article");
      card.className = `sample-card${sample.label === "Fault instant" ? " instant" : ""}${sample.row_index == null ? " missing" : ""}`;
      const strong = document.createElement("strong"); strong.textContent = sample.label;
      const time = document.createElement("time"); time.textContent = sample.timestamp.slice(11);
      const status = document.createElement("span"); status.textContent = sample.row_index == null ? "Missing" : "Available";
      card.append(strong, time, status); fragment.appendChild(card);
    });
    el.sampleStrip.replaceChildren(fragment);
  }

  function cell(text, className = "") {
    const td = document.createElement("td");
    td.className = className;
    td.textContent = text == null ? "" : String(text);
    td.title = td.textContent;
    return td;
  }

  function renderTable() {
    if (!detail?.retained) return;
    const query = el.parameterSearch.value.trim().toLocaleLowerCase();
    const showAll = el.showAllParameters.checked;
    const parameters = detail.parameters.filter((parameter) => {
      if (!showAll && !parameter.visible) return false;
      if (!query) return true;
      if (parameter.name.toLocaleLowerCase().includes(query)) return true;
      return parameter.children.some((child) => child.name.toLocaleLowerCase().includes(query));
    });

    const headRow = document.createElement("tr");
    ["Parameter", "Unit", ...detail.samples.map((sample) => sample.label)].forEach((heading) => {
      const th = document.createElement("th"); th.textContent = heading; headRow.appendChild(th);
    });
    el.fdpHead.replaceChildren(headRow);

    const fragment = document.createDocumentFragment();
    parameters.forEach((parameter) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      if (parameter.children.length) {
        const button = document.createElement("button");
        button.className = "tree-toggle";
        button.type = "button";
        button.textContent = expanded.has(parameter.name) ? "−" : "+";
        button.title = `${expanded.has(parameter.name) ? "Hide" : "Show"} ${parameter.children.length} bit-level sub-signals`;
        button.addEventListener("click", () => {
          if (expanded.has(parameter.name)) expanded.delete(parameter.name); else expanded.add(parameter.name);
          renderTable();
        });
        nameCell.append(button, document.createTextNode(parameter.name));
      } else {
        nameCell.textContent = parameter.name;
      }
      row.append(nameCell, cell(parameter.unit));
      detail.samples.forEach((sample) => row.appendChild(cell(valueAt(sample, parameter))));
      fragment.appendChild(row);

      const showChildren = expanded.has(parameter.name) || (query && parameter.children.some((child) => child.name.toLocaleLowerCase().includes(query)));
      if (showChildren) {
        parameter.children
          .filter((child) => showAll || child.visible)
          .filter((child) => !query || parameter.name.toLocaleLowerCase().includes(query) || child.name.toLocaleLowerCase().includes(query))
          .forEach((child) => {
            const childRow = document.createElement("tr"); childRow.className = "flag-child-row";
            childRow.append(cell(`↳ Bit ${child.bit_position}: ${child.name}`, "flag-name"), cell(child.unit));
            detail.samples.forEach((sample) => childRow.appendChild(cell(childValue(sample, parameter, child))));
            fragment.appendChild(childRow);
          });
      }
    });
    el.fdpBody.replaceChildren(fragment);
    const childCount = parameters.reduce((total, parameter) => total + parameter.children.length, 0);
    el.parameterCount.textContent = `${parameters.length.toLocaleString()} parameters · ${childCount.toLocaleString()} defined sub-signals`;
  }

  function exportRows() {
    const headers = ["Parameter", "Unit", ...detail.samples.map((sample) => `${sample.label} ${sample.timestamp}`)];
    const rows = [];
    detail.parameters.forEach((parameter) => {
      rows.push([parameter.name, parameter.unit, ...detail.samples.map((sample) => valueAt(sample, parameter))]);
      parameter.children.forEach((child) => {
        rows.push([`Bit ${child.bit_position}: ${child.name}`, child.unit, ...detail.samples.map((sample) => childValue(sample, parameter, child))]);
      });
    });
    return { headers, rows };
  }

  function bytesFromBase64(value) {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }

  async function exportCsv() {
    const { headers, rows } = exportRows();
    const filename = `fault_${detail.fault.fault_code}_${detail.fault.timestamp.replaceAll(":", "-")}.xlsx`;
    try {
      const workbook = await api("/make-excel", {
        sheet: `Fault ${detail.fault.fault_code}`,
        headers,
        rows
      });
      const result = await window.MedhaDesktop.saveExport(filename, bytesFromBase64(workbook.base64));
      showToast(`Excel saved to ${result.destination}`);
    } catch (error) { showToast(error.message, true); }
  }

  async function exportHtml() {
    const parameters = detail.parameters.map((parameter) => [
      parameter.name,
      parameter.unit,
      parameter.visible ? 1 : 0,
      parameter.children.map((child) => [
        child.name, child.unit, child.bit_position, child.on_message, child.off_message,
        child.visible ? 1 : 0
      ])
    ]);
    const samples = detail.samples.map((sample) => [
      sample.label,
      sample.timestamp,
      sample.row_index == null ? 0 : 1,
      detail.parameters.map((parameter) => {
        if (sample.row_index == null || !sample.values) return null;
        const value = sample.values[parameter.name];
        const meaning = sample.display?.[parameter.name];
        return meaning ? [value, meaning] : value;
      })
    ]);
    const payload = {
      v: 1,
      f: [
        detail.fault.timestamp, detail.fault.fault_code, detail.fault.dmc,
        detail.fault.mastership, detail.fault.fault_message, detail.fault.priority,
        detail.fault.recovery, detail.fault.reset
      ],
      c: detail.config,
      p: parameters,
      s: samples
    };
    const payloadJson = JSON.stringify(payload).replaceAll("<", "\\u003c");
    const report = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="Medha Data Analyser 1.0"><title>Medha Fault Report</title><style>
*{box-sizing:border-box}body{margin:0;padding:18px;font:12px "Segoe UI",Arial;color:#17334a;background:#f5fbfe}header,.card{max-width:100%;margin:0 0 12px;padding:15px;border:1px solid #d5e5ee;border-radius:11px;background:#fff}header{text-align:center}h1{margin:0;color:#0b3b61;letter-spacing:.08em}h2{margin:7px 0;color:#0c4f78}p{margin:5px 0;color:#617b8d}.meta{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:8px;margin-top:12px}.meta b{display:block;padding:10px;border-radius:7px;background:#eef8fc;color:#0b3b61}.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.tools input[type=search]{min-width:320px;flex:1;padding:9px;border:1px solid #bdd4e1;border-radius:7px}.wrap{max-height:72vh;overflow:auto;border:1px solid #cfdee7;border-radius:8px}table{width:100%;border-collapse:collapse}th,td{padding:7px 9px;border-bottom:1px solid #e3edf3;white-space:nowrap;text-align:left}th{position:sticky;top:0;z-index:2;color:#fff;background:#0c4f78}td:first-child{position:sticky;left:0;background:#f4fafe;font-weight:600}tr:nth-child(even) td{background:#f9fcfe}tr.child td{color:#365b71;background:#eaf6fb}button{width:23px;height:23px;margin-right:7px;padding:0;border:0;border-radius:5px;color:#fff;background:#0b6b9b;font-weight:800;cursor:pointer}.summary{font-weight:700;color:#0b6b9b}@media(max-width:850px){.meta{grid-template-columns:1fr 1fr}}
</style></head><body><header><h1>MEDHA DATA ANALYSER</h1><p>Developed by ELS/ED · Compact interactive fault report</p><h2 id="faultTitle"></h2><p id="faultMessage"></p><div class="meta"><b id="dmc"></b><b id="role"></b><b id="priority"></b><b id="window"></b></div></header><section class="card"><div class="tools"><input id="search" type="search" placeholder="Search parameter or sub-signal"><label><input id="all" type="checkbox" checked> Show all definition parameters</label><span id="summary" class="summary"></span></div><div class="wrap"><table><thead id="head"></thead><tbody id="body"></tbody></table></div></section><script id="data" type="application/json">${payloadJson}</script><script>
(function(){"use strict";var D=JSON.parse(document.getElementById("data").textContent),F=D.f,P=D.p,S=D.s,X=new Set(),Q=document.getElementById("search"),A=document.getElementById("all"),B=document.getElementById("body"),E=function(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","'":"&#39;"}[c]})},V=function(v){return Array.isArray(v)?String(v[0])+" — "+String(v[1]):v==null?"":String(v)},C=function(v,c){v=Array.isArray(v)?v[0]:v;var n=Number(v);if(!Number.isFinite(n))return"";var z=Math.floor(n/Math.pow(2,c[2]))%2,m=z?c[3]:c[4];return String(z)+(m?" — "+m:"")};document.getElementById("faultTitle").textContent="Fault "+F[1]+" — "+F[0];document.getElementById("faultMessage").textContent=F[4];document.getElementById("dmc").textContent="DMC: "+(F[2]||"—");document.getElementById("role").textContent="Role: "+(F[3]||"—");document.getElementById("priority").textContent="Priority: "+(F[5]||"—")+" · Recovery: "+(F[6]||"—")+" · Reset: "+(F[7]||"—");document.getElementById("window").textContent=D.c.previous_seconds+" s before · occurrence · instant · "+D.c.next_seconds+" s after";document.getElementById("head").innerHTML="<tr><th>Parameter</th><th>Unit</th>"+S.map(function(s){return"<th>"+E(s[0])+"<br>"+E(s[1])+"</th>"}).join("")+"</tr>";function R(){var q=Q.value.trim().toLowerCase(),all=A.checked,out="",count=0,children=0;P.forEach(function(p,i){var hit=!q||p[0].toLowerCase().includes(q)||p[3].some(function(c){return c[0].toLowerCase().includes(q)});if(!hit||(!all&&!p[2]))return;count++;children+=p[3].length;out+="<tr><td>"+(p[3].length?"<button data-i=\""+i+"\">"+(X.has(i)?"−":"+")+"</button>":"")+E(p[0])+"</td><td>"+E(p[1])+"</td>"+S.map(function(s){return"<td>"+E(V(s[3][i]))+"</td>"}).join("")+"</tr>";if(X.has(i)||q&&p[3].some(function(c){return c[0].toLowerCase().includes(q)}))p[3].forEach(function(c){if(!all&&!c[5]||q&&!p[0].toLowerCase().includes(q)&&!c[0].toLowerCase().includes(q))return;out+="<tr class=\"child\"><td>↳ Bit "+c[2]+": "+E(c[0])+"</td><td>"+E(c[1])+"</td>"+S.map(function(s){return"<td>"+E(C(s[3][i],c))+"</td>"}).join("")+"</tr>"})});B.innerHTML=out;document.getElementById("summary").textContent=count.toLocaleString()+" parameters · "+children.toLocaleString()+" sub-signals"}B.onclick=function(e){var b=e.target.closest("button[data-i]");if(!b)return;var i=Number(b.dataset.i);X.has(i)?X.delete(i):X.add(i);R()};Q.oninput=R;A.onchange=R;R()})();
</script></body></html>`;
    // Attribute quotes inside the embedded script are consumed by this outer
    // template literal. Keep those two generated attributes unquoted instead.
    const compactReport = report
      .replaceAll('data-i=""+i+""', 'data-i="+i+"')
      .replaceAll('class="child"', 'class=child');
    const filename = `fault_${detail.fault.fault_code}_${detail.fault.timestamp.replaceAll(":", "-")}.html`;
    try {
      const result = await window.MedhaDesktop.saveExport(filename, new TextEncoder().encode(compactReport));
      showToast(`Saved to ${result.destination}`);
    } catch (error) { showToast(error.message, true); }
  }

  function showDetail(result) {
    detail = result;
    const fault = result.fault;
    el.faultTime.textContent = fault.timestamp;
    el.faultCode.textContent = fault.fault_code;
    el.faultDmc.textContent = fault.dmc || "—";
    el.faultRole.textContent = fault.mastership || "—";
    el.faultMessage.textContent = fault.fault_message;
    el.faultMeta.textContent = `Priority: ${fault.priority || "—"} · Recovery: ${fault.recovery || "—"} · Reset: ${fault.reset || "—"}`;
    el.faultCard.hidden = false;
    if (!result.retained) {
      el.notRetained.hidden = false;
      return;
    }
    el.windowDescription.textContent = `${result.config.previous_seconds} seconds before + occurrence + fault instant + ${result.config.next_seconds} seconds after · ${result.config.resolution_ms} ms resolution`;
    renderSamples();
    renderTable();
    el.detailContent.hidden = false;
    el.detailCsv.disabled = false;
    el.detailHtml.disabled = false;
  }

  async function load() {
    if (!Number.isInteger(rowIndex) || rowIndex < 0) {
      el.loadingOverlay.hidden = true;
      el.detailError.hidden = false;
      el.detailError.querySelector("p").textContent = "Invalid fault selection.";
      return;
    }
    try {
      while (true) {
        const status = await api("/status", null, "GET");
        const value = status.progress?.FDP || 0;
        el.detailProgress.value = value;
        el.detailLoadingText.textContent = status.ready?.FDP
          ? "Decoding the 10-sample environment window…"
          : `${Math.round(value)}% — Fault Data Pack has priority`;
        if (status.ready?.FDP) break;
        await wait(180);
      }
      const result = await api("/fault-detail", { row_index: rowIndex });
      showDetail(result);
    } catch (error) {
      el.detailError.hidden = false;
      el.detailError.querySelector("p").textContent = error.message;
    } finally {
      el.loadingOverlay.hidden = true;
    }
  }

  el.closeWindow.addEventListener("click", () => window.MedhaDesktop.closeWindow());
  el.parameterSearch.addEventListener("input", renderTable);
  el.showAllParameters.addEventListener("change", renderTable);
  el.detailCsv.addEventListener("click", exportCsv);
  el.detailHtml.addEventListener("click", exportHtml);
  load();
})();
