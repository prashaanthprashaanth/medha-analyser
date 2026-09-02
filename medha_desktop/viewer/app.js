(() => {
  "use strict";

  const ROW_HEIGHT = 44;
  const OVERSCAN = 12;
  const state = {
    loaded: false,
    archive: "",
    faults: [],
    faultIndex: new Map(),
    filteredFaults: [],
    status: { ready: {}, progress: {} },
    fdpSynced: false,
    currentTab: "faults",
    history: { memory: null, offset: 0, limit: 500, data: null, loading: false, chartLoaded: false, chartLoading: false },
    depth: {
      selected: new Set(), parameters: [], selectedParameters: new Set(),
      metadataLoading: false, comparisonLoading: false
    },
    population: { subtab: "counts", rows: [], ranking: [] }
  };

  const el = Object.fromEntries([
    "openArchive", "fileStatus", "visibleFaultCount", "allFaultCount", "snapshotCount", "rangeText",
    "fdpProgress", "fdpPercent", "lgmProgress", "lgmPercent", "shmProgress", "shmPercent",
    "faultView", "historyView", "overviewView", "faultSearch", "environmentFilter", "faultFrom",
    "faultTo", "includeHidden", "clearFaultFilters", "filteredFaultCount", "faultViewport",
    "faultSpacer", "faultRows", "faultEmpty", "faultCsv", "loadingOverlay", "loadingTitle",
    "loadingText", "toast", "historyTitle", "historySubtitle", "historyReadyBadge", "historyWaiting",
    "historyWaitProgress", "historyWaitingText", "historyContent", "historyFrom", "historyTo",
    "historyLimit", "historyApply", "historySummary", "historyTable", "historyPrevious", "historyNext",
    "historyPageText", "overviewCards", "chartParameters", "loadChart", "resetChart",
    "viewSelectedRange", "chartStatus", "historyChart", "chartTooltip", "chartSelection",
    "chartPng", "chartPdf", "depthTab", "depthView", "depthBadge", "depthClear",
    "depthFaultList", "depthParameterSearch", "depthParameters", "depthRun", "depthProgress",
    "depthResults", "populationView", "populationCsv", "populationFrom", "populationTo",
    "populationHidden", "populationApply", "populationSummary", "populationContent", "historyExcel"
  ].map((id) => [id, document.getElementById(id)]));

  const historyChart = new window.MedhaHistoryChart(
    el.historyChart, el.chartSelection, el.chartTooltip
  );

  const api = (endpoint, payload = null, method = "POST") =>
    window.MedhaDesktop.api(endpoint, payload, method);

  function showToast(message, error = false) {
    el.toast.textContent = message;
    el.toast.classList.toggle("error", error);
    el.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { el.toast.hidden = true; }, 4500);
  }

  function setLoading(show, title = "Opening ALL data", text = "Reading ERRORLOG.DAT first…") {
    el.loadingTitle.textContent = title;
    el.loadingText.textContent = text;
    el.loadingOverlay.hidden = !show;
  }

  function escapeCsv(value) {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function bytesFromBase64(value) {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }

  async function saveExcel(filename, sheet, headers, rows) {
    const workbook = await api("/make-excel", { sheet, headers, rows });
    return window.MedhaDesktop.saveExport(filename, bytesFromBase64(workbook.base64));
  }

  async function downloadFaultCsv() {
    const headers = ["Date & Time", "Fault Code", "Fault", "DMC", "Role", "Packet Index", "Environment"];
    const rows = state.filteredFaults.map((fault) => [
      fault.timestamp, fault.fault_code, fault.fault_message, fault.dmc,
      fault.mastership, fault.packet_index, fault.environment
    ]);
    try {
      const result = await saveExcel("medha_fault_log.xlsx", "Fault Log", headers, rows);
      showToast(`Excel saved to ${result.destination}`);
    } catch (error) { showToast(error.message, true); }
  }

  function shortDateRange(faults) {
    if (!faults.length) return "—";
    return `${faults[0].timestamp.slice(0, 10)} to ${faults[faults.length - 1].timestamp.slice(0, 10)}`;
  }

  function setFaultControls(enabled) {
    [el.faultSearch, el.environmentFilter, el.faultFrom, el.faultTo, el.includeHidden,
      el.clearFaultFilters, el.faultCsv].forEach((control) => { control.disabled = !enabled; });
  }

  function updateSummary() {
    const visible = state.faults.filter((fault) => fault.visible);
    el.visibleFaultCount.textContent = visible.length.toLocaleString();
    el.allFaultCount.textContent = state.faults.length.toLocaleString();
    el.rangeText.textContent = shortDateRange(state.faults);
    if (state.status.ready?.FDP) {
      const available = visible.filter((fault) => fault.environment === "Available").length;
      el.snapshotCount.textContent = available.toLocaleString();
    } else {
      el.snapshotCount.textContent = "Indexing…";
    }
  }

  function updateWorkers(status) {
    state.status = status;
    for (const key of ["FDP", "LGM", "SHM"]) {
      const lower = key.toLowerCase();
      const value = status.progress?.[key] || 0;
      el[`${lower}Progress`].value = value;
      el[`${lower}Percent`].textContent = status.ready?.[key] ? "Ready" : `${Math.round(value)}%`;
      document.querySelector(`[data-worker="${key}"]`)?.classList.toggle("ready", Boolean(status.ready?.[key]));
    }
    if (state.currentTab === "LGM" || state.currentTab === "SHM") updateHistoryWaiting();
    renderOverview();
  }

  async function refreshStatus() {
    if (!state.loaded) return;
    try {
      const previousFdp = Boolean(state.status.ready?.FDP);
      const status = await api("/status", null, "GET");
      updateWorkers(status);
      if (!previousFdp && status.ready?.FDP && !state.fdpSynced) {
        const result = await api("/faults", null, "GET");
        state.faults = result.faults;
        state.faultIndex = new Map(state.faults.map((fault) => [Number(fault.row_index), fault]));
        state.fdpSynced = true;
        applyFaultFilters();
        updateSummary();
        if (state.currentTab === "population") renderPopulation();
      }
      const key = state.currentTab;
      if ((key === "LGM" || key === "SHM") && status.ready?.[key] && !state.history.data && !state.history.loading) {
        loadHistory(true);
      }
    } catch (error) {
      console.error(error);
    }
  }

  function enableArchive(result) {
    state.loaded = true;
    state.archive = result.archive;
    state.faults = result.faults;
    state.faultIndex = new Map(state.faults.map((fault) => [Number(fault.row_index), fault]));
    state.depth.selected.clear();
    state.depth.parameters = [];
    state.depth.selectedParameters.clear();
    state.fdpSynced = Boolean(result.status.ready?.FDP);
    el.fileStatus.textContent = result.archive;
    const visible = state.faults.filter((fault) => fault.visible);
    if (visible.length) {
      const dates = visible.map((fault) => fault.timestamp.slice(0, 10));
      el.faultFrom.value = dates[0];
      el.faultTo.value = dates[dates.length - 1];
      el.faultFrom.min = el.faultTo.min = dates[0];
      el.faultFrom.max = el.faultTo.max = dates[dates.length - 1];
    }
    setFaultControls(true);
    updateWorkers(result.status);
    updateSummary();
    applyFaultFilters();
    renderOverview();
    renderDepthSelection();
    initialisePopulationDates();
  }

  async function loadArchivePath(path) {
    try {
      if (!path) return;
      setLoading(true);
      const result = await api("/load", { path });
      enableArchive(result);
      setLoading(false);
      showToast("Fault log ready. Other datasets are indexing in the background.");
    } catch (error) {
      setLoading(false);
      showToast(error.message, true);
    }
  }

  async function openArchive() {
    try {
      const path = await window.MedhaDesktop.selectArchive();
      await loadArchivePath(path);
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function applyFaultFilters() {
    if (!state.loaded) return;
    const query = el.faultSearch.value.trim().toLocaleLowerCase();
    const environment = el.environmentFilter.value;
    const from = el.faultFrom.value;
    const to = el.faultTo.value;
    state.filteredFaults = state.faults.filter((fault) => {
      if (!el.includeHidden.checked && !fault.visible) return false;
      if (environment !== "all" && fault.environment !== environment) return false;
      const day = fault.timestamp.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (query) {
        const haystack = `${fault.fault_message} ${fault.fault_code} ${fault.dmc} ${fault.mastership}`.toLocaleLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    }).reverse();
    el.filteredFaultCount.textContent = state.filteredFaults.length.toLocaleString();
    el.faultViewport.scrollTop = 0;
    el.faultSpacer.style.height = `${Math.max(1, state.filteredFaults.length * ROW_HEIGHT)}px`;
    el.faultEmpty.hidden = state.filteredFaults.length > 0;
    renderVirtualFaults();
  }

  function environmentPill(fault) {
    const pill = document.createElement("span");
    pill.className = "env-pill ";
    if (fault.environment === "Available") pill.className += "env-available";
    else if (fault.environment === "Not retained") pill.className += "env-missing";
    else pill.className += "env-indexing";
    pill.textContent = fault.environment;
    return pill;
  }

  function faultCell(text, className = "") {
    const cell = document.createElement("span");
    cell.className = className;
    cell.textContent = text == null ? "" : String(text);
    cell.title = cell.textContent;
    return cell;
  }

  function renderVirtualFaults() {
    const count = state.filteredFaults.length;
    if (!count) {
      el.faultRows.textContent = "";
      return;
    }
    const start = Math.max(0, Math.floor(el.faultViewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(el.faultViewport.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(count, start + visibleCount);
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const fault = state.filteredFaults[index];
      const row = document.createElement("div");
      row.className = "fault-row";
      row.style.top = `${index * ROW_HEIGHT}px`;
      row.role = "row";
      row.tabIndex = 0;
      row.title = "Open diagnostic data in a separate window";
      row.append(
        (() => {
          const holder = document.createElement("span");
          holder.className = "fault-compare-cell";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = state.depth.selected.has(Number(fault.row_index));
          checkbox.disabled = fault.environment !== "Available";
          checkbox.title = checkbox.disabled
            ? "Comparison is available only when this retained FDP snapshot is ready"
            : "Select this fault for Depth Analysis";
          checkbox.addEventListener("click", (event) => event.stopPropagation());
          checkbox.addEventListener("change", () => toggleDepthFault(fault, checkbox));
          holder.appendChild(checkbox);
          return holder;
        })(),
        faultCell(fault.timestamp),
        faultCell(fault.fault_code),
        faultCell(fault.fault_message, "fault-message"),
        faultCell(fault.dmc),
        faultCell(fault.mastership),
        faultCell(fault.packet_index)
      );
      const envCell = document.createElement("span");
      envCell.appendChild(environmentPill(fault));
      row.appendChild(envCell);
      const open = () => window.MedhaDesktop.openFault(fault.row_index)
        .catch((error) => showToast(error.message, true));
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
      });
      fragment.appendChild(row);
    }
    el.faultRows.replaceChildren(fragment);
  }

  function clearFaultFilters() {
    el.faultSearch.value = "";
    el.environmentFilter.value = "all";
    el.includeHidden.checked = false;
    const visible = state.faults.filter((fault) => fault.visible);
    if (visible.length) {
      el.faultFrom.value = visible[0].timestamp.slice(0, 10);
      el.faultTo.value = visible[visible.length - 1].timestamp.slice(0, 10);
    }
    applyFaultFilters();
  }

  function selectTab(key) {
    state.currentTab = key;
    document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === key));
    el.faultView.hidden = key !== "faults";
    el.historyView.hidden = key !== "LGM" && key !== "SHM";
    el.depthView.hidden = key !== "depth";
    el.populationView.hidden = key !== "population";
    el.overviewView.hidden = key !== "overview";
    if (key === "LGM" || key === "SHM") openHistory(key);
    if (key === "depth") {
      renderDepthSelection();
      loadDepthParameters();
    }
    if (key === "population") renderPopulation();
    if (key === "faults") requestAnimationFrame(renderVirtualFaults);
  }

  function historyName(key) { return key === "LGM" ? "Long-Term Data" : "Short-Term Data"; }

  function openHistory(key) {
    state.history = {
      memory: key, offset: 0, limit: Number(el.historyLimit.value), data: null,
      loading: false, chartLoaded: false, chartLoading: false
    };
    el.chartParameters.dataset.memory = "";
    el.chartParameters.replaceChildren();
    el.loadChart.disabled = true;
    el.resetChart.disabled = true;
    el.viewSelectedRange.disabled = true;
    el.chartPng.disabled = true;
    el.chartPdf.disabled = true;
    el.historyExcel.disabled = true;
    el.chartStatus.textContent = "Waiting for decoded history parameters.";
    historyChart.clear("Waiting for history data");
    el.historyTitle.textContent = historyName(key);
    el.historySubtitle.textContent = key === "LGM"
      ? "Historical operating samples decoded from LONGMEM.DAT."
      : "Recent higher-resolution operating samples decoded from SHORTMEM.DAT.";
    updateHistoryWaiting();
    if (state.status.ready?.[key]) loadHistory(true);
  }

  function updateHistoryWaiting() {
    const key = state.currentTab;
    if (key !== "LGM" && key !== "SHM") return;
    if (!state.loaded) {
      el.historyWaiting.hidden = false;
      el.historyContent.hidden = true;
      el.historyReadyBadge.textContent = "Waiting for upload";
      el.historyWaitingText.textContent = "Upload the locomotive ALL-data ZIP first.";
      return;
    }
    const ready = Boolean(state.status.ready?.[key]);
    const progress = state.status.progress?.[key] || 0;
    el.historyWaiting.hidden = ready;
    el.historyContent.hidden = !ready;
    el.historyWaitProgress.value = progress;
    el.historyReadyBadge.textContent = ready ? "Ready" : `${Math.round(progress)}% indexed`;
    el.historyWaitingText.textContent = `${Math.round(progress)}% complete. You may return to Fault Log at any time.`;
  }

  async function loadHistory(resetDates = false) {
    const key = state.history.memory;
    if (!key || state.history.loading) return;
    state.history.loading = true;
    try {
      const result = await api("/history", {
        memory: key,
        start: el.historyFrom.value || null,
        end: el.historyTo.value || null,
        offset: state.history.offset,
        limit: Number(el.historyLimit.value),
        newest_first: true
      });
      if (!result.ready) { updateWorkers(result.status); return; }
      state.history.data = result;
      state.history.limit = result.limit;
      if (resetDates && !el.historyFrom.value && !el.historyTo.value) {
        el.historyFrom.value = result.first_timestamp.replace(" ", "T");
        el.historyTo.value = result.last_timestamp.replace(" ", "T");
      }
      renderHistory(result);
      populateChartParameters(result.parameters, key);
      if (!state.history.chartLoaded && !state.history.chartLoading) loadHistoryChart();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      state.history.loading = false;
    }
  }

  function renderHistory(data) {
    updateHistoryWaiting();
    const tableHead = el.historyTable.querySelector("thead");
    const tableBody = el.historyTable.querySelector("tbody");
    const names = data.parameters.map((parameter) => parameter.name);
    const units = Object.fromEntries(data.parameters.map((parameter) => [parameter.name, parameter.unit]));
    const headings = ["Date & Time", ...names.map((name) => units[name] ? `${name} [${units[name]}]` : name)];
    const headRow = document.createElement("tr");
    headings.forEach((heading) => { const th = document.createElement("th"); th.textContent = heading; headRow.appendChild(th); });
    tableHead.replaceChildren(headRow);
    const fragment = document.createDocumentFragment();
    data.rows.forEach((record) => {
      const row = document.createElement("tr");
      row.appendChild(faultCell(record.timestamp));
      names.forEach((name) => {
        const td = document.createElement("td");
        const meaning = record.display[name];
        td.textContent = meaning ? `${record.values[name]} — ${meaning}` : record.values[name];
        row.appendChild(td);
      });
      fragment.appendChild(row);
    });
    tableBody.replaceChildren(fragment);
    const start = data.matching_records ? data.offset + 1 : 0;
    const end = Math.min(data.offset + data.rows.length, data.matching_records);
    el.historySummary.textContent = `${data.total_records.toLocaleString()} total records · showing ${start.toLocaleString()}–${end.toLocaleString()} of ${data.matching_records.toLocaleString()} in this time range`;
    const page = Math.floor(data.offset / data.limit) + 1;
    const pages = Math.max(1, Math.ceil(data.matching_records / data.limit));
    el.historyPageText.textContent = `Page ${page.toLocaleString()} of ${pages.toLocaleString()}`;
    el.historyPrevious.disabled = data.offset <= 0;
    el.historyNext.disabled = data.offset + data.rows.length >= data.matching_records;
    el.historyExcel.disabled = !data.rows.length;
  }

  async function downloadHistoryExcel() {
    const data = state.history.data;
    if (!data?.rows?.length) return;
    const names = data.parameters.map((parameter) => parameter.name);
    const headers = ["Date & Time", ...data.parameters.map((parameter) =>
      parameter.unit ? `${parameter.name} [${parameter.unit}]` : parameter.name)];
    const rows = data.rows.map((record) => [record.timestamp, ...names.map((name) => {
      const meaning = record.display[name];
      return meaning ? `${record.values[name]} — ${meaning}` : record.values[name];
    })]);
    try {
      const memory = state.history.memory === "LGM" ? "Long Term" : "Short Term";
      const result = await saveExcel(
        `medha_${state.history.memory.toLowerCase()}_displayed_rows.xlsx`, memory, headers, rows
      );
      showToast(`Excel saved to ${result.destination}`);
    } catch (error) { showToast(error.message, true); }
  }

  function populateChartParameters(parameters, memory) {
    if (el.chartParameters.dataset.memory === memory && el.chartParameters.options.length) return;
    const visible = parameters.filter((parameter) => parameter.visible);
    const defaults = new Set(["Loco speed", "OHE Volt (KV)"]);
    const fragment = document.createDocumentFragment();
    visible.forEach((parameter, index) => {
      const option = document.createElement("option");
      option.value = parameter.name;
      option.textContent = parameter.unit ? `${parameter.name} [${parameter.unit}]` : parameter.name;
      option.selected = defaults.has(parameter.name) || (!defaults.size && index < 2);
      fragment.appendChild(option);
    });
    el.chartParameters.replaceChildren(fragment);
    if (![...el.chartParameters.options].some((option) => option.selected)) {
      [...el.chartParameters.options].slice(0, 2).forEach((option) => { option.selected = true; });
    }
    el.chartParameters.dataset.memory = memory;
    el.loadChart.disabled = false;
  }

  async function loadHistoryChart() {
    const key = state.history.memory;
    if (!key || state.history.chartLoading || !state.status.ready?.[key]) return;
    const parameters = [...el.chartParameters.selectedOptions].map((option) => option.value);
    if (!parameters.length) {
      showToast("Select at least one chart parameter.", true);
      return;
    }
    if (parameters.length > 8) {
      showToast("Select up to 8 parameters so the chart remains readable.", true);
      return;
    }
    state.history.chartLoading = true;
    el.loadChart.disabled = true;
    el.chartStatus.textContent = "Preparing chart points…";
    historyChart.clear("Loading chart data…");
    try {
      const result = await api("/history-chart", {
        memory: key,
        parameters,
        start: el.historyFrom.value || null,
        end: el.historyTo.value || null,
        max_points: 12000
      });
      if (!result.ready) {
        updateWorkers(result.status);
        el.chartStatus.textContent = "History indexing is still in progress.";
        return;
      }
      const units = Object.fromEntries(
        state.history.data.parameters.map((parameter) => [parameter.name, parameter.unit])
      );
      historyChart.setData(result.rows, parameters, units);
      state.history.chartLoaded = true;
      el.resetChart.disabled = result.rows.length < 2;
      el.viewSelectedRange.disabled = result.rows.length < 2;
      el.chartPng.disabled = !result.rows.length;
      el.chartPdf.disabled = !result.rows.length;
      const sampled = result.downsample_step > 1 ? ` · sampled every ${result.downsample_step} records` : "";
      el.chartStatus.textContent = `${result.points.toLocaleString()} chart points from ${result.source_records.toLocaleString()} records${sampled}`;
    } catch (error) {
      historyChart.clear("Unable to draw chart");
      el.chartStatus.textContent = error.message;
      showToast(error.message, true);
    } finally {
      state.history.chartLoading = false;
      el.loadChart.disabled = false;
    }
  }

  function chartFilename(extension) {
    const memory = state.history.memory === "LGM" ? "long_term" : "short_term";
    const from = (el.historyFrom.value || "start").replaceAll(":", "-");
    const to = (el.historyTo.value || "end").replaceAll(":", "-");
    return `medha_${memory}_${from}_to_${to}.${extension}`;
  }

  async function downloadChartPng() {
    try {
      const blob = await new Promise((resolve, reject) => {
        el.historyChart.toBlob((value) => value ? resolve(value) : reject(new Error("Unable to create chart image")), "image/png");
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await window.MedhaDesktop.saveExport(chartFilename("png"), bytes);
      showToast(`Chart image saved to ${result.destination}`);
    } catch (error) { showToast(error.message, true); }
  }

  async function downloadChartPdf() {
    try {
      const selected = [...el.chartParameters.selectedOptions].map((option) => option.textContent).join(", ");
      const result = await window.MedhaDesktop.saveChartPdf({
        filename: chartFilename("pdf"),
        imageDataUrl: el.historyChart.toDataURL("image/png"),
        title: `${historyName(state.history.memory)} chart`,
        details: `${el.chartSelection.textContent} · Parameters: ${selected}`
      });
      showToast(`Chart PDF saved to ${result.destination}`);
    } catch (error) { showToast(error.message, true); }
  }

  function toggleDepthFault(fault, checkbox) {
    const rowIndex = Number(fault.row_index);
    if (checkbox.checked) {
      if (state.depth.selected.size >= 12) {
        checkbox.checked = false;
        showToast("Select up to 12 faults for one comparison.", true);
        return;
      }
      state.depth.selected.add(rowIndex);
    } else {
      state.depth.selected.delete(rowIndex);
    }
    renderDepthSelection();
    renderVirtualFaults();
  }

  function renderDepthSelection() {
    const faults = [...state.depth.selected]
      .map((rowIndex) => state.faultIndex.get(rowIndex))
      .filter(Boolean);
    el.depthTab.textContent = `Depth Analysis (${faults.length})`;
    el.depthBadge.textContent = `${faults.length} fault${faults.length === 1 ? "" : "s"} selected`;
    if (!faults.length) {
      const placeholder = document.createElement("p");
      placeholder.className = "depth-placeholder";
      placeholder.textContent = "Use the Compare checkboxes in the Fault Log. Up to 12 retained faults can be selected.";
      el.depthFaultList.replaceChildren(placeholder);
    } else {
      const fragment = document.createDocumentFragment();
      faults.forEach((fault) => {
        const item = document.createElement("div");
        item.className = "depth-fault-item";
        const timestamp = document.createElement("strong"); timestamp.textContent = fault.timestamp;
        const code = document.createElement("span"); code.textContent = `#${fault.fault_code}`;
        const message = document.createElement("span"); message.textContent = fault.fault_message; message.title = fault.fault_message;
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "Remove from comparison";
        remove.addEventListener("click", () => {
          state.depth.selected.delete(Number(fault.row_index));
          renderDepthSelection();
          renderVirtualFaults();
        });
        item.append(timestamp, code, message, remove); fragment.appendChild(item);
      });
      el.depthFaultList.replaceChildren(fragment);
    }
    const parameterCount = state.depth.selectedParameters.size;
    el.depthRun.disabled = faults.length < 2 || parameterCount < 1 || state.depth.comparisonLoading;
    if (!state.depth.comparisonLoading) {
      el.depthProgress.textContent = faults.length < 2
        ? "Select at least two retained faults."
        : parameterCount < 1
          ? "Select one to six FDP parameters."
          : `${faults.length} faults and ${parameterCount} parameters ready for comparison.`;
    }
  }

  async function loadDepthParameters() {
    if (!state.loaded) {
      el.depthProgress.textContent = "Upload an ALL Data ZIP first.";
      return;
    }
    if (state.depth.parameters.length || state.depth.metadataLoading) return;
    state.depth.metadataLoading = true;
    el.depthProgress.textContent = "Loading the fixed FDP parameter catalogue…";
    try {
      const result = await api("/fault-parameters", null, "GET");
      state.depth.parameters = result.parameters;
      const defaults = ["Loco speed", "OHE Volt (KV)", "OHE Current", "TE/BE Demand%"];
      defaults.filter((name) => result.parameters.some((item) => item.name === name))
        .forEach((name) => state.depth.selectedParameters.add(name));
      renderDepthParameterOptions();
      el.depthParameters.disabled = false;
      renderDepthSelection();
    } catch (error) {
      el.depthProgress.textContent = error.message;
      showToast(error.message, true);
    } finally {
      state.depth.metadataLoading = false;
    }
  }

  function renderDepthParameterOptions() {
    const query = el.depthParameterSearch.value.trim().toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    state.depth.parameters
      .filter((parameter) => !query || `${parameter.name} ${parameter.unit}`.toLocaleLowerCase().includes(query))
      .forEach((parameter) => {
        const option = document.createElement("option");
        option.value = parameter.name;
        option.textContent = `${parameter.name}${parameter.unit ? ` [${parameter.unit}]` : ""}${parameter.visible ? "" : " · hidden in definition"}`;
        option.selected = state.depth.selectedParameters.has(parameter.name);
        fragment.appendChild(option);
      });
    el.depthParameters.replaceChildren(fragment);
  }

  function updateDepthParameterSelection() {
    const shown = [...el.depthParameters.options];
    shown.forEach((option) => state.depth.selectedParameters.delete(option.value));
    const chosen = shown.filter((option) => option.selected);
    if (state.depth.selectedParameters.size + chosen.length > 6) {
      showToast("Select up to 6 parameters for readable pattern charts.", true);
    }
    chosen.slice(0, Math.max(0, 6 - state.depth.selectedParameters.size))
      .forEach((option) => state.depth.selectedParameters.add(option.value));
    shown.forEach((option) => { option.selected = state.depth.selectedParameters.has(option.value); });
    renderDepthSelection();
  }

  async function runDepthComparison() {
    if (state.depth.selected.size < 2 || !state.depth.selectedParameters.size || state.depth.comparisonLoading) return;
    state.depth.comparisonLoading = true;
    el.depthRun.disabled = true;
    el.depthProgress.textContent = `Comparing ${state.depth.selected.size} fault snapshots at high priority…`;
    el.depthResults.replaceChildren();
    try {
      const result = await api("/fault-comparison", {
        row_indices: [...state.depth.selected],
        parameters: [...state.depth.selectedParameters]
      });
      renderDepthComparison(result);
    } catch (error) {
      el.depthProgress.textContent = error.message;
      showToast(error.message, true);
    } finally {
      state.depth.comparisonLoading = false;
      renderDepthSelection();
    }
  }

  const COMPARISON_COLORS = ["#0876b9", "#ef8354", "#1c9b73", "#8b6bc8", "#d5a021", "#d64f73", "#4f6f8f", "#25a9b7", "#a95b32", "#627f35", "#805c9d", "#bb4265"];

  function renderDepthComparison(result) {
    const retained = result.faults.filter((item) => item.retained);
    const missing = result.faults.length - retained.length;
    el.depthProgress.textContent = `${retained.length} retained fault windows compared${missing ? ` · ${missing} selected fault snapshots were no longer retained` : ""}.`;
    const fragment = document.createDocumentFragment();
    result.parameters.forEach((parameter) => {
      const card = document.createElement("article"); card.className = "comparison-card";
      const title = document.createElement("h3");
      title.textContent = `${parameter.name}${parameter.unit ? ` [${parameter.unit}]` : ""}`;
      const legend = document.createElement("div"); legend.className = "comparison-legend";
      retained.forEach((item, index) => {
        const label = document.createElement("span");
        const swatch = document.createElement("i"); swatch.className = "legend-swatch"; swatch.style.background = COMPARISON_COLORS[index % COMPARISON_COLORS.length];
        label.append(swatch, document.createTextNode(`#${item.fault.fault_code} · ${item.fault.timestamp}`));
        legend.appendChild(label);
      });
      const canvas = document.createElement("canvas"); canvas.height = 265;
      card.append(title, legend, canvas); fragment.appendChild(card);
      requestAnimationFrame(() => drawDepthChart(canvas, retained, parameter));
    });
    el.depthResults.replaceChildren(fragment);
  }

  function drawDepthChart(canvas, faults, parameter) {
    const width = Math.max(440, canvas.clientWidth || 620), height = 265;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d"); ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const left = 57, right = width - 15, top = 15, bottom = height - 42;
    let minimum = Infinity, maximum = -Infinity;
    faults.forEach((item) => item.samples.forEach((sample) => {
      const value = Number(sample.values?.[parameter.name]);
      if (Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    }));
    if (!Number.isFinite(minimum)) {
      ctx.fillStyle = "#637b8c"; ctx.font = "12px Segoe UI"; ctx.textAlign = "center";
      ctx.fillText("No numeric readings for this parameter", width / 2, height / 2); return;
    }
    if (minimum === maximum) { minimum -= .5; maximum += .5; }
    const pad = (maximum - minimum) * .08; minimum -= pad; maximum += pad;
    ctx.font = "10px Segoe UI"; ctx.fillStyle = "#637b8c"; ctx.strokeStyle = "#dce9f1";
    for (let tick = 0; tick <= 4; tick += 1) {
      const y = top + (bottom - top) * tick / 4;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.fillText(Number((maximum - (maximum - minimum) * tick / 4).toFixed(2)), left - 7, y + 3);
    }
    const sampleCount = faults[0]?.samples.length || 10;
    const xAt = (index) => left + (right - left) * index / Math.max(1, sampleCount - 1);
    const yAt = (value) => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
    const labels = faults[0]?.samples.map((sample) => sample.label) || [];
    labels.forEach((label, index) => {
      ctx.fillStyle = "#637b8c"; ctx.textAlign = "center"; ctx.fillText(label.replace("Fault instant", "Instant"), xAt(index), bottom + 18);
    });
    faults.forEach((item, faultIndex) => {
      ctx.beginPath(); ctx.strokeStyle = COMPARISON_COLORS[faultIndex % COMPARISON_COLORS.length]; ctx.lineWidth = 1.8;
      let active = false;
      item.samples.forEach((sample, index) => {
        const value = Number(sample.values?.[parameter.name]);
        if (!Number.isFinite(value)) { active = false; return; }
        if (!active) { ctx.moveTo(xAt(index), yAt(value)); active = true; } else ctx.lineTo(xAt(index), yAt(value));
      });
      ctx.stroke();
    });
    const occurrence = labels.indexOf("Occurrence"), instant = labels.indexOf("Fault instant");
    [occurrence, instant].filter((index) => index >= 0).forEach((index) => {
      ctx.strokeStyle = "rgba(239,131,84,.55)"; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(xAt(index), top); ctx.lineTo(xAt(index), bottom); ctx.stroke(); ctx.setLineDash([]);
    });
  }

  function initialisePopulationDates() {
    const days = state.faults.map((fault) => fault.timestamp.slice(0, 10)).sort();
    if (!days.length) return;
    el.populationFrom.value = days[0];
    el.populationTo.value = days[days.length - 1];
    el.populationFrom.min = el.populationTo.min = days[0];
    el.populationFrom.max = el.populationTo.max = days[days.length - 1];
  }

  function populationRows() {
    const from = el.populationFrom.value;
    const to = el.populationTo.value;
    return state.faults.filter((fault) => {
      if (!el.populationHidden.checked && !fault.visible) return false;
      const day = fault.timestamp.slice(0, 10);
      return (!from || day >= from) && (!to || day <= to);
    });
  }

  function groupedCounts(rows, valueFor) {
    const counts = new Map();
    rows.forEach((row) => {
      const value = String(valueFor(row) || "Unknown");
      counts.set(value, (counts.get(value) || 0) + 1);
    });
    return [...counts].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function renderPopulation() {
    if (!state.loaded) {
      el.populationContent.innerHTML = '<div class="depth-placeholder">Upload an ALL Data ZIP to analyse the complete fault population.</div>';
      el.populationCsv.disabled = true;
      return;
    }
    const rows = populationRows();
    state.population.rows = rows;
    const uniqueCodes = new Set(rows.map((fault) => fault.fault_code)).size;
    const retained = rows.filter((fault) => fault.environment === "Available").length;
    const recovered = rows.filter((fault) => /recovered/i.test(fault.fault_message)).length;
    const metrics = [
      [rows.length.toLocaleString(), "fault records analysed"],
      [uniqueCodes.toLocaleString(), "unique fault codes"],
      [retained.toLocaleString(), "retained FDP snapshots"],
      [recovered.toLocaleString(), "recovered indications"]
    ];
    const summary = document.createDocumentFragment();
    metrics.forEach(([value, label]) => {
      const card = document.createElement("article");
      const strong = document.createElement("strong"); strong.textContent = value;
      const span = document.createElement("span"); span.textContent = label;
      card.append(strong, span); summary.appendChild(card);
    });
    el.populationSummary.replaceChildren(summary);
    document.querySelectorAll(".population-subtab").forEach((button) =>
      button.classList.toggle("active", button.dataset.population === state.population.subtab));
    if (state.population.subtab === "counts") renderPopulationCounts(rows);
    else if (state.population.subtab === "timeline") renderPopulationTimeline(rows);
    else if (state.population.subtab === "distribution") renderPopulationDistribution(rows);
    else renderPopulationRetention(rows);
  }

  function renderPopulationCounts(rows) {
    const grouped = new Map();
    rows.forEach((fault) => {
      const key = `${fault.fault_code}`;
      let item = grouped.get(key);
      if (!item) {
        item = { code: fault.fault_code, message: fault.fault_message, count: 0, retained: 0, latest: fault.timestamp };
        grouped.set(key, item);
      }
      item.count += 1;
      if (fault.environment === "Available") item.retained += 1;
      if (fault.timestamp > item.latest) item.latest = fault.timestamp;
    });
    const ranking = [...grouped.values()].sort((a, b) => b.count - a.count || Number(a.code) - Number(b.code));
    state.population.ranking = ranking;
    el.populationCsv.disabled = !ranking.length;
    const wrap = document.createElement("div"); wrap.className = "population-table-wrap";
    const table = document.createElement("table"); table.className = "population-table";
    const thead = document.createElement("thead");
    const heading = document.createElement("tr");
    ["Rank", "Fault code", "Fault description", "Count", "% of population", "Relative population", "FDP retained", "Latest occurrence"].forEach((text) => {
      const th = document.createElement("th"); th.textContent = text; heading.appendChild(th);
    });
    thead.appendChild(heading);
    const tbody = document.createElement("tbody");
    const maximum = ranking[0]?.count || 1;
    ranking.forEach((item, index) => {
      const row = document.createElement("tr");
      const values = [index + 1, item.code, item.message, item.count.toLocaleString(), rows.length ? `${(item.count * 100 / rows.length).toFixed(2)}%` : "0%"];
      values.forEach((value) => { const td = document.createElement("td"); td.textContent = value; row.appendChild(td); });
      const barCell = document.createElement("td");
      const bar = document.createElement("div"); bar.className = "population-bar";
      const fill = document.createElement("i"); fill.style.width = `${item.count * 100 / maximum}%`;
      const label = document.createElement("span"); label.textContent = `${item.count.toLocaleString()} occurrences`;
      bar.append(fill, label); barCell.appendChild(bar); row.appendChild(barCell);
      [item.retained.toLocaleString(), item.latest].forEach((value) => { const td = document.createElement("td"); td.textContent = value; row.appendChild(td); });
      tbody.appendChild(row);
    });
    table.append(thead, tbody); wrap.appendChild(table); el.populationContent.replaceChildren(wrap);
  }

  function renderPopulationTimeline(rows) {
    el.populationCsv.disabled = true;
    const daily = groupedCounts(rows, (fault) => fault.timestamp.slice(0, 10)).sort((a, b) => a.name.localeCompare(b.name));
    const card = document.createElement("section"); card.className = "population-chart-card";
    const title = document.createElement("h3"); title.textContent = "Fault occurrences by day";
    const canvas = document.createElement("canvas"); canvas.height = 350;
    card.append(title, canvas); el.populationContent.replaceChildren(card);
    requestAnimationFrame(() => drawPopulationTimeline(canvas, daily));
  }

  function drawPopulationTimeline(canvas, daily) {
    const width = Math.max(720, canvas.clientWidth || 1100), height = 350, scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d"); ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const left = 62, right = width - 18, top = 20, bottom = height - 46;
    const maximum = Math.max(1, ...daily.map((item) => item.count));
    ctx.font = "10px Segoe UI"; ctx.strokeStyle = "#dce9f1"; ctx.fillStyle = "#637b8c";
    for (let tick = 0; tick <= 5; tick += 1) {
      const y = top + (bottom - top) * tick / 5;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.fillText(Math.round(maximum * (5 - tick) / 5), left - 8, y + 3);
    }
    if (!daily.length) { ctx.textAlign = "center"; ctx.fillText("No faults in this date range", width / 2, height / 2); return; }
    const xAt = (index) => left + (right - left) * index / Math.max(1, daily.length - 1);
    ctx.beginPath(); ctx.strokeStyle = "#1684b8"; ctx.lineWidth = 2;
    daily.forEach((item, index) => {
      const x = xAt(index), y = bottom - item.count / maximum * (bottom - top);
      if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
    daily.forEach((item, index) => {
      const x = xAt(index), y = bottom - item.count / maximum * (bottom - top);
      ctx.fillStyle = "#0876b9"; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
    });
    const labels = Math.min(7, daily.length);
    for (let tick = 0; tick < labels; tick += 1) {
      const index = labels === 1 ? 0 : Math.round((daily.length - 1) * tick / (labels - 1));
      ctx.fillStyle = "#637b8c"; ctx.textAlign = tick === 0 ? "left" : tick === labels - 1 ? "right" : "center";
      ctx.fillText(daily[index].name, xAt(index), bottom + 20);
    }
  }

  function distributionCard(title, items, total) {
    const card = document.createElement("section"); card.className = "distribution-card";
    const heading = document.createElement("h3"); heading.textContent = title;
    const table = document.createElement("table"); const body = document.createElement("tbody");
    items.forEach((item) => {
      const row = document.createElement("tr");
      const name = document.createElement("td"); name.textContent = item.name;
      const count = document.createElement("td"); count.textContent = `${item.count.toLocaleString()} (${total ? (item.count * 100 / total).toFixed(1) : 0}%)`;
      row.append(name, count); body.appendChild(row);
    });
    table.appendChild(body); card.append(heading, table); return card;
  }

  function renderPopulationDistribution(rows) {
    el.populationCsv.disabled = true;
    const grid = document.createElement("div"); grid.className = "distribution-grid";
    grid.append(
      distributionCard("DMC population", groupedCounts(rows, (fault) => fault.dmc), rows.length),
      distributionCard("Master / slave role", groupedCounts(rows, (fault) => fault.mastership), rows.length)
    );
    el.populationContent.replaceChildren(grid);
  }

  function renderPopulationRetention(rows) {
    el.populationCsv.disabled = true;
    const grid = document.createElement("div"); grid.className = "distribution-grid";
    grid.append(
      distributionCard("Fault Data Pack retention", groupedCounts(rows, (fault) => fault.environment), rows.length),
      distributionCard("Fault priority", groupedCounts(rows, (fault) => fault.priority || "Not assigned"), rows.length),
      distributionCard("Recovery rule", groupedCounts(rows, (fault) => fault.recovery || "Not assigned"), rows.length),
      distributionCard("Reset rule", groupedCounts(rows, (fault) => fault.reset || "Not assigned"), rows.length)
    );
    el.populationContent.replaceChildren(grid);
  }

  async function downloadPopulationCsv() {
    const headers = ["Rank", "Fault Code", "Fault Description", "Count", "Population Percent", "FDP Retained", "Latest Occurrence"];
    const total = state.population.rows.length;
    const rows = state.population.ranking.map((item, index) => [
      index + 1, item.code, item.message, item.count, total ? (item.count * 100 / total).toFixed(4) : 0,
      item.retained, item.latest
    ]);
    try {
      const result = await saveExcel(
        "medha_fault_population_ranking.xlsx", "Population Ranking", headers, rows
      );
      showToast(`Excel saved to ${result.destination}`);
    } catch (error) { showToast(error.message, true); }
  }

  function renderOverview() {
    const cards = [
      ["Fault Log", state.loaded ? `${state.faults.length.toLocaleString()} decoded entries` : "Waiting for upload"],
      ["Fault Data Pack", state.status.ready?.FDP ? "Retained snapshots ready" : `${Math.round(state.status.progress?.FDP || 0)}% indexed`],
      ["Long-Term Data", state.status.ready?.LGM ? "LONGMEM.DAT ready" : `${Math.round(state.status.progress?.LGM || 0)}% indexed`],
      ["Short-Term Data", state.status.ready?.SHM ? "SHORTMEM.DAT ready" : `${Math.round(state.status.progress?.SHM || 0)}% indexed`]
    ];
    const fragment = document.createDocumentFragment();
    cards.forEach(([title, text]) => {
      const card = document.createElement("article");
      card.className = "overview-card";
      const h3 = document.createElement("h3"); h3.textContent = title;
      const p = document.createElement("p"); p.textContent = text;
      card.append(h3, p); fragment.appendChild(card);
    });
    el.overviewCards.replaceChildren(fragment);
  }

  let searchTimer = null;
  el.openArchive.addEventListener("click", openArchive);
  el.faultViewport.addEventListener("scroll", () => requestAnimationFrame(renderVirtualFaults));
  el.faultSearch.addEventListener("input", () => {
    clearTimeout(searchTimer); searchTimer = setTimeout(applyFaultFilters, 130);
  });
  [el.environmentFilter, el.faultFrom, el.faultTo, el.includeHidden].forEach((control) =>
    control.addEventListener("change", applyFaultFilters));
  el.clearFaultFilters.addEventListener("click", clearFaultFilters);
  el.faultCsv.addEventListener("click", downloadFaultCsv);
  document.querySelectorAll(".tab").forEach((button) =>
    button.addEventListener("click", () => selectTab(button.dataset.tab)));
  el.historyApply.addEventListener("click", () => {
    state.history.offset = 0;
    state.history.chartLoaded = false;
    loadHistory(false);
    loadHistoryChart();
  });
  el.historyLimit.addEventListener("change", () => { state.history.offset = 0; loadHistory(false); });
  el.historyPrevious.addEventListener("click", () => {
    state.history.offset = Math.max(0, state.history.offset - state.history.limit); loadHistory(false);
  });
  el.historyNext.addEventListener("click", () => {
    state.history.offset += state.history.limit; loadHistory(false);
  });
  el.historyExcel.addEventListener("click", downloadHistoryExcel);
  el.loadChart.addEventListener("click", loadHistoryChart);
  el.resetChart.addEventListener("click", () => historyChart.resetView());
  el.viewSelectedRange.addEventListener("click", () => historyChart.viewSelection());
  el.chartPng.addEventListener("click", downloadChartPng);
  el.chartPdf.addEventListener("click", downloadChartPdf);
  el.depthClear.addEventListener("click", () => {
    state.depth.selected.clear();
    el.depthResults.replaceChildren();
    renderDepthSelection();
    renderVirtualFaults();
  });
  el.depthParameterSearch.addEventListener("input", renderDepthParameterOptions);
  el.depthParameters.addEventListener("change", updateDepthParameterSelection);
  el.depthRun.addEventListener("click", runDepthComparison);
  el.populationApply.addEventListener("click", renderPopulation);
  el.populationCsv.addEventListener("click", downloadPopulationCsv);
  document.querySelectorAll(".population-subtab").forEach((button) => button.addEventListener("click", () => {
    state.population.subtab = button.dataset.population;
    renderPopulation();
  }));

  setFaultControls(false);
  renderOverview();
  setInterval(refreshStatus, 650);
  Promise.all([window.MedhaDesktop.startupArchive(), window.MedhaDesktop.startupTab()])
    .then(async ([path, tab]) => {
      if (path) await loadArchivePath(path);
      if (["faults", "LGM", "SHM", "depth", "population", "overview"].includes(tab)) selectTab(tab);
    })
    .catch((error) => showToast(error.message, true));
})();
