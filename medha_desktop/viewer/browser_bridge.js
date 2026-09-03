(() => {
  "use strict";
  if (window.MedhaDesktop) return;

  const query = new URLSearchParams(location.search);
  const token = query.get("session") || "";

  function sessionHeaders(extra = {}) {
    return { ...extra, "X-Medha-Token": token };
  }

  async function api(endpoint, payload = null, method = "POST") {
    const options = { method, cache: "no-store", headers: sessionHeaders() };
    if (payload !== null) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(endpoint, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Decoder request failed");
    return result;
  }

  function uploadOverlay() {
    const shade = document.createElement("div");
    shade.style.cssText = "position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:rgba(4,40,64,.66);backdrop-filter:blur(3px)";
    shade.innerHTML = `<div style="width:min(460px,86vw);padding:24px;border-radius:16px;background:#fff;box-shadow:0 24px 70px rgba(0,0,0,.3);font:600 15px Segoe UI,Arial;color:#123c56"><div style="font-size:18px;margin-bottom:13px">Opening locomotive ALL-data ZIP</div><div style="height:12px;overflow:hidden;border-radius:10px;background:#dcecf4"><i style="display:block;width:0;height:100%;background:linear-gradient(90deg,#0b6b9b,#2aa7cf);transition:width .12s"></i></div><p style="margin:11px 0 0;color:#517184">Uploading to the local analyser… 0%</p></div>`;
    document.body.appendChild(shade);
    return {
      update(percent) {
        shade.querySelector("i").style.width = `${percent}%`;
        shade.querySelector("p").textContent = `Uploading to the local analyser… ${percent}%`;
      },
      remove() { shade.remove(); }
    };
  }

  function chooseFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".zip,application/zip";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        input.remove();
        resolve(file || null);
      }, { once: true });
      input.addEventListener("cancel", () => {
        input.remove();
        resolve(null);
      }, { once: true });
      input.click();
    });
  }

  async function selectArchive() {
    await api("/browser-busy", {});
    const file = await chooseFile();
    await api("/heartbeat", {});
    if (!file) return null;
    const overlay = uploadOverlay();
    try {
      return await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/upload");
        request.responseType = "json";
        request.setRequestHeader("X-Medha-Token", token);
        request.setRequestHeader("X-Medha-Filename", encodeURIComponent(file.name));
        request.upload.onprogress = (event) => {
          if (event.lengthComputable) overlay.update(Math.min(100, Math.round(event.loaded * 100 / event.total)));
        };
        request.onerror = () => reject(new Error("The ZIP could not be transferred to the local analyser"));
        request.onload = () => {
          const result = request.response || {};
          if (request.status >= 200 && request.status < 300) resolve(result.path);
          else reject(new Error(result.error || "The ZIP upload failed"));
        };
        request.send(file);
      });
    } finally {
      overlay.remove();
    }
  }

  function contentType(filename) {
    const extension = filename.split(".").pop().toLowerCase();
    return ({ csv: "text/csv", html: "text/html", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", png: "image/png", pdf: "application/pdf" })[extension] || "application/octet-stream";
  }

  function download(filename, bytes, type = contentType(filename)) {
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { destination: filename };
  }

  function imageFromUrl(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to prepare the chart PDF"));
      image.src = url;
    });
  }

  function canvasJpeg(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
      if (!blob) reject(new Error("Unable to encode the chart PDF"));
      else resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/jpeg", 0.92));
  }

  function pdfWithJpeg(jpeg, width, height) {
    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = [0];
    let length = 0;
    const append = (value) => {
      const bytes = typeof value === "string" ? encoder.encode(value) : value;
      chunks.push(bytes);
      length += bytes.length;
    };
    append("%PDF-1.4\n");
    const object = (number, body) => {
      offsets[number] = length;
      append(`${number} 0 obj\n${body}\nendobj\n`);
    };
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    const pageWidth = 841.89, pageHeight = 595.28, margin = 24;
    const scale = Math.min((pageWidth - margin * 2) / width, (pageHeight - margin * 2) / height);
    const drawWidth = width * scale, drawHeight = height * scale;
    const x = (pageWidth - drawWidth) / 2, y = (pageHeight - drawHeight) / 2;
    object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>");
    const commands = `q ${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;
    object(4, `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`);
    offsets[5] = length;
    append(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    append(jpeg);
    append("\nendstream\nendobj\n");
    const xref = length;
    append("xref\n0 6\n0000000000 65535 f \n");
    for (let number = 1; number <= 5; number += 1) append(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
    append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const output = new Uint8Array(length);
    let position = 0;
    chunks.forEach((chunk) => { output.set(chunk, position); position += chunk.length; });
    return output;
  }

  async function saveChartPdf(payload) {
    const image = await imageFromUrl(payload.imageDataUrl);
    const headerHeight = 112;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1100, image.naturalWidth);
    canvas.height = image.naturalHeight + headerHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#0b3b61";
    context.textAlign = "center";
    context.font = "700 26px Segoe UI,Arial";
    context.fillText("MEDHA DATA ANALYSER", canvas.width / 2, 34);
    context.font = "600 19px Segoe UI,Arial";
    context.fillText(payload.title || "Locomotive data chart", canvas.width / 2, 64);
    context.fillStyle = "#526f82";
    context.font = "14px Segoe UI,Arial";
    context.fillText((payload.details || "").slice(0, 150), canvas.width / 2, 89);
    context.drawImage(image, (canvas.width - image.naturalWidth) / 2, headerHeight);
    const jpeg = await canvasJpeg(canvas);
    return download(payload.filename || "medha_chart.pdf", pdfWithJpeg(jpeg, canvas.width, canvas.height), "application/pdf");
  }

  window.MedhaDesktop = {
    api,
    startupArchive: async () => null,
    startupTab: async () => query.get("tab"),
    selectArchive,
    openFault: async (rowIndex) => {
      const detail = new URL("/detail.html", location.origin);
      detail.searchParams.set("row", rowIndex);
      detail.searchParams.set("session", token);
      if (!window.open(detail, "_blank")) throw new Error("Allow pop-ups for this local analyser to open fault details");
      return true;
    },
    closeWindow: async () => { window.close(); },
    saveExport: async (filename, bytes) => download(filename, bytes),
    saveChartPdf
  };

  if (location.pathname === "/" || location.pathname.endsWith("/index.html")) {
    const heartbeat = () => fetch("/heartbeat", { method: "POST", headers: sessionHeaders(), cache: "no-store", keepalive: true }).catch(() => {});
    heartbeat();
    setInterval(heartbeat, 2000);
    window.addEventListener("pagehide", () => fetch("/browser-closing", { method: "POST", headers: sessionHeaders(), cache: "no-store", keepalive: true }).catch(() => {}));
  }
})();
