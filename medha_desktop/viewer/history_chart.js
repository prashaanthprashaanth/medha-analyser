(() => {
  "use strict";

  const COLORS = ["#0876b9", "#6fbdf0", "#ef8354", "#1c9b73", "#8b6bc8", "#d5a021", "#d64f73", "#4f6f8f"];

  class MedhaHistoryChart {
    constructor(canvas, summary, tooltip) {
      this.canvas = canvas;
      this.context = canvas.getContext("2d");
      this.summary = summary;
      this.tooltip = tooltip;
      this.rows = [];
      this.parameters = [];
      this.units = {};
      this.viewStart = 0;
      this.viewEnd = 0;
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.dragging = null;
      this.message = "No chart data";
      this.plot = null;
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(canvas.parentElement);
      canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
      canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
      canvas.addEventListener("pointerup", () => this.pointerUp());
      canvas.addEventListener("pointercancel", () => this.pointerUp());
      canvas.addEventListener("pointerleave", () => {
        if (!this.dragging) this.tooltip.hidden = true;
      });
      canvas.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
      canvas.addEventListener("dblclick", () => this.resetView());
      this.draw();
    }

    clear(message = "No chart data") {
      this.rows = [];
      this.parameters = [];
      this.message = message;
      this.summary.textContent = "Selection bars will appear after chart data is loaded.";
      this.tooltip.hidden = true;
      this.draw();
    }

    setData(rows, parameters, units = {}) {
      this.rows = rows || [];
      this.parameters = parameters || [];
      this.units = units;
      this.viewStart = 0;
      this.viewEnd = Math.max(0, this.rows.length - 1);
      this.selectionStart = Math.floor(this.viewEnd * .25);
      this.selectionEnd = Math.max(this.selectionStart, Math.ceil(this.viewEnd * .75));
      this.message = this.rows.length ? "" : "No numeric data in this time range";
      this.updateSummary();
      this.draw();
    }

    resetView() {
      if (this.rows.length < 2) return;
      this.viewStart = 0;
      this.viewEnd = this.rows.length - 1;
      this.draw();
    }

    viewSelection() {
      if (this.rows.length < 2) return;
      this.viewStart = Math.min(this.selectionStart, this.selectionEnd);
      this.viewEnd = Math.max(this.selectionStart, this.selectionEnd);
      if (this.viewEnd - this.viewStart < 2) this.viewEnd = Math.min(this.rows.length - 1, this.viewStart + 2);
      this.draw();
    }

    canvasPoint(event) {
      const rectangle = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
    }

    indexToX(index) {
      const span = Math.max(1, this.viewEnd - this.viewStart);
      return this.plot.left + ((index - this.viewStart) / span) * this.plot.width;
    }

    xToIndex(x) {
      const ratio = Math.max(0, Math.min(1, (x - this.plot.left) / this.plot.width));
      return Math.round(this.viewStart + ratio * (this.viewEnd - this.viewStart));
    }

    pointerDown(event) {
      if (!this.plot || this.rows.length < 2) return;
      const { x } = this.canvasPoint(event);
      const left = this.indexToX(this.selectionStart);
      const right = this.indexToX(this.selectionEnd);
      this.dragging = Math.abs(x - left) <= Math.abs(x - right) ? "start" : "end";
      this.canvas.setPointerCapture(event.pointerId);
      this.moveBar(x);
    }

    pointerMove(event) {
      if (!this.plot || !this.rows.length) return;
      const point = this.canvasPoint(event);
      if (this.dragging) {
        this.moveBar(point.x);
        return;
      }
      if (point.x < this.plot.left || point.x > this.plot.right || point.y < this.plot.top || point.y > this.plot.bottom) {
        this.tooltip.hidden = true;
        return;
      }
      const index = this.xToIndex(point.x);
      const record = this.rows[index];
      if (!record) return;
      const values = this.parameters.map((name, number) => {
        const unit = this.units[name] ? ` ${this.units[name]}` : "";
        return `<span style="color:${COLORS[number % COLORS.length]}">●</span> ${this.escape(name)}: ${this.escape(record.values?.[name] ?? "—")}${this.escape(unit)}`;
      });
      this.tooltip.innerHTML = `<strong>${this.escape(record.timestamp)}</strong><br>${values.join("<br>")}`;
      const width = this.canvas.clientWidth;
      this.tooltip.style.left = `${Math.min(width - 310, Math.max(8, point.x + 14))}px`;
      this.tooltip.style.top = `${Math.max(8, point.y - 20)}px`;
      this.tooltip.hidden = false;
    }

    pointerUp() {
      this.dragging = null;
    }

    moveBar(x) {
      const index = this.xToIndex(x);
      if (this.dragging === "start") this.selectionStart = Math.min(index, this.selectionEnd);
      else this.selectionEnd = Math.max(index, this.selectionStart);
      this.updateSummary();
      this.draw();
    }

    wheel(event) {
      if (!this.plot || this.rows.length < 3) return;
      event.preventDefault();
      const point = this.canvasPoint(event);
      const currentSpan = this.viewEnd - this.viewStart + 1;
      const factor = event.deltaY < 0 ? .72 : 1.4;
      const targetSpan = Math.max(8, Math.min(this.rows.length, Math.round(currentSpan * factor)));
      const anchor = this.xToIndex(point.x);
      const ratio = Math.max(0, Math.min(1, (point.x - this.plot.left) / this.plot.width));
      let start = Math.round(anchor - targetSpan * ratio);
      start = Math.max(0, Math.min(this.rows.length - targetSpan, start));
      this.viewStart = start;
      this.viewEnd = Math.min(this.rows.length - 1, start + targetSpan - 1);
      this.draw();
    }

    updateSummary() {
      if (!this.rows.length) return;
      const first = this.rows[this.selectionStart]?.timestamp || "—";
      const last = this.rows[this.selectionEnd]?.timestamp || "—";
      this.summary.textContent = `A  ${first}   →   B  ${last}`;
    }

    escape(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    draw() {
      const cssWidth = Math.max(300, this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 900);
      const cssHeight = 350;
      const scale = window.devicePixelRatio || 1;
      if (this.canvas.width !== Math.round(cssWidth * scale) || this.canvas.height !== Math.round(cssHeight * scale)) {
        this.canvas.width = Math.round(cssWidth * scale);
        this.canvas.height = Math.round(cssHeight * scale);
      }
      const ctx = this.context;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      const left = 66, right = cssWidth - 20, top = 42, bottom = cssHeight - 50;
      this.plot = { left, right, top, bottom, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
      if (!this.rows.length || !this.parameters.length) {
        ctx.fillStyle = "#637b8c";
        ctx.font = "600 13px Segoe UI";
        ctx.textAlign = "center";
        ctx.fillText(this.message || "No chart data", cssWidth / 2, cssHeight / 2);
        return;
      }

      let minimum = Infinity, maximum = -Infinity;
      for (let index = this.viewStart; index <= this.viewEnd; index += 1) {
        const values = this.rows[index]?.values || {};
        this.parameters.forEach((name) => {
          const value = Number(values[name]);
          if (Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
        });
      }
      if (!Number.isFinite(minimum)) { minimum = 0; maximum = 1; }
      if (minimum === maximum) { minimum -= .5; maximum += .5; }
      const padding = (maximum - minimum) * .08;
      minimum -= padding; maximum += padding;

      ctx.strokeStyle = "#dce9f1";
      ctx.lineWidth = 1;
      ctx.font = "11px Segoe UI";
      ctx.fillStyle = "#637b8c";
      for (let tick = 0; tick <= 5; tick += 1) {
        const y = top + (this.plot.height * tick / 5);
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
        const value = maximum - (maximum - minimum) * tick / 5;
        ctx.textAlign = "right"; ctx.fillText(this.number(value), left - 8, y + 4);
      }
      for (let tick = 0; tick <= 5; tick += 1) {
        const index = Math.round(this.viewStart + (this.viewEnd - this.viewStart) * tick / 5);
        const x = left + this.plot.width * tick / 5;
        ctx.textAlign = tick === 0 ? "left" : tick === 5 ? "right" : "center";
        ctx.fillText(this.shortTime(this.rows[index]?.timestamp), x, bottom + 22);
      }

      const yFor = (value) => bottom - ((value - minimum) / (maximum - minimum)) * this.plot.height;
      this.parameters.forEach((name, number) => {
        ctx.beginPath();
        ctx.strokeStyle = COLORS[number % COLORS.length];
        ctx.lineWidth = 1.7;
        let active = false;
        for (let index = this.viewStart; index <= this.viewEnd; index += 1) {
          const value = Number(this.rows[index]?.values?.[name]);
          if (!Number.isFinite(value)) { active = false; continue; }
          const x = this.indexToX(index), y = yFor(value);
          if (!active) { ctx.moveTo(x, y); active = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });

      const startX = this.indexToX(this.selectionStart);
      const endX = this.indexToX(this.selectionEnd);
      const clippedStart = Math.max(left, Math.min(right, startX));
      const clippedEnd = Math.max(left, Math.min(right, endX));
      if (clippedEnd > clippedStart) {
        ctx.fillStyle = "rgba(46,155,200,.10)";
        ctx.fillRect(clippedStart, top, clippedEnd - clippedStart, this.plot.height);
      }
      this.drawBar(startX, "A", "#ef8354", left, right, top, bottom);
      this.drawBar(endX, "B", "#d64f73", left, right, top, bottom);

      let legendX = left;
      this.parameters.forEach((name, number) => {
        ctx.fillStyle = COLORS[number % COLORS.length];
        ctx.fillRect(legendX, 13, 13, 3);
        ctx.fillStyle = "#35576b";
        ctx.textAlign = "left";
        ctx.fillText(name, legendX + 18, 18);
        legendX += Math.min(210, ctx.measureText(name).width + 43);
      });
    }

    drawBar(x, label, color, left, right, top, bottom) {
      if (x < left || x > right) return;
      const ctx = this.context;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, top + 8, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "800 10px Segoe UI"; ctx.textAlign = "center"; ctx.fillText(label, x, top + 12);
    }

    shortTime(value) {
      if (!value) return "—";
      const text = String(value).replace("T", " ");
      return text.length > 16 ? text.slice(5, 16) : text;
    }

    number(value) {
      const absolute = Math.abs(value);
      if (absolute >= 10000 || (absolute > 0 && absolute < .01)) return value.toExponential(1);
      return Number(value.toFixed(2)).toLocaleString();
    }
  }

  window.MedhaHistoryChart = MedhaHistoryChart;
})();
