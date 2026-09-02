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

  function csvEscape(value) {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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

  function htmlEscape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  async function exportHtml() {
    const { headers, rows } = exportRows();
    const table = `<table><thead><tr>${headers.map((item) => `<th>${htmlEscape(item)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((item) => `<td>${htmlEscape(item)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    const report = `<!doctype html><meta charset="utf-8"><title>Medha Fault ${detail.fault.fault_code}</title><style>body{font:13px Segoe UI;margin:25px;color:#183247}h1{color:#0b3b61}table{border-collapse:collapse}th,td{padding:6px 8px;border:1px solid #cadce7;white-space:nowrap}th{background:#0c4f78;color:white;position:sticky;top:0}tr:nth-child(even){background:#f1f9fd}</style><h1>MEDHA DATA ANALYSER</h1><p>Developed by ELS/ED</p><h2>Fault ${htmlEscape(detail.fault.fault_code)} — ${htmlEscape(detail.fault.timestamp)}</h2><p>${htmlEscape(detail.fault.fault_message)}</p>${table}`;
    const filename = `fault_${detail.fault.fault_code}_${detail.fault.timestamp.replaceAll(":", "-")}.html`;
    try {
      const result = await window.MedhaDesktop.saveExport(filename, new TextEncoder().encode(report));
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
