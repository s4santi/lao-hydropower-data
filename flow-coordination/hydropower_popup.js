/* ============================================================================
 * Hydropower dam map popup — compact + inline-expanded operations card
 * ----------------------------------------------------------------------------
 * Shows when a hydropower dam marker is clicked on the map. Displays dam
 * operations data: water level vs FSL/MOL, storage %, generation, releases,
 * inflow, downstream level, and a multi-series chart with range tabs.
 *
 * Data source: window.CASCADE (already loaded by flow.js as data/cascade.json).
 *   Each dam has:
 *     - Static reservoir geometry: fsl_masl, mol_masl, crest_masl,
 *       dam_height_m, total_storage_mcm, capacity_mw, dam_type, operator
 *     - latest_reading: water_level_masl, storage_mcm, generation_mw,
 *       inflow_cms, total_release_cms, turbine_discharge_cms,
 *       spillway_discharge_cms, downstream_level_masl, rainfall_mm,
 *       status_normal/watch/warning/evacuate flags, ingested_at_utc
 *     - history: [{date, level, inflow, generation, spillway, turbine,
 *                  release, downstream, rainfall}, ...]
 *
 * Pattern: mirrors mrc_popup.js — module-level _activePopup ref, per-popup
 * generation counter for sparkline race prevention, Chart.js destroy on
 * close/collapse/recreate, popup-alive guards before all async DOM writes,
 * 44px touch targets, z-index 2000 when expanded.
 * ==========================================================================*/
(function () {
  'use strict';

  // ---- DOM utilities --------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtNum = (v, digits = 2, unit = '') => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return unit ? `${n.toFixed(digits)} ${unit}` : n.toFixed(digits);
  };

  const fmtPct = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—';
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? esc(iso) : d.toISOString().slice(0, 10);
  };

  const relTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
    return `${Math.round(diff / 86400)} d ago`;
  };

  // ---- Status helpers -------------------------------------------------------
  // Mirror flow.js computeStorage / computeOperatorAlert so this module is
  // self-contained (those helpers live in flow.js module scope, not on window).
  const parseBool = (v) => {
    if (typeof v === 'boolean') return v;
    if (v == null) return false;
    return String(v).toUpperCase() === 'TRUE';
  };

  function computeStorage(d) {
    const lr = d.latest_reading || {};
    const wl = Number(lr.water_level_masl);
    const fsl = Number(d.fsl_masl);
    const mol = Number(d.mol_masl);
    const valid = Number.isFinite(wl) && Number.isFinite(fsl) && Number.isFinite(mol) &&
                  fsl > mol && mol > 0 && wl > 0 && wl >= mol - (fsl - mol) * 0.5;
    if (!valid) return { status: 'no_data', fillPct: null };
    const fillPct = (wl - mol) / (fsl - mol);
    if (fillPct >= 0.95) return { status: 'critical_high', fillPct };
    if (fillPct >= 0.85) return { status: 'high',          fillPct };
    if (fillPct >= 0.70) return { status: 'watch',         fillPct };
    if (fillPct >= 0.40) return { status: 'normal',        fillPct };
    if (fillPct >= 0.15) return { status: 'rising',        fillPct };
    return                       { status: 'low',          fillPct };
  }

  function computeOperatorAlert(d) {
    const lr = d.latest_reading || {};
    if (parseBool(lr.status_evacuate)) return 'evacuate';
    if (parseBool(lr.status_warning))  return 'warning';
    if (parseBool(lr.status_watch))    return 'watch';
    return null;
  }

  const STORAGE_LABEL = {
    critical_high: 'Critical High',
    high:          'High',
    watch:         'Watch',
    normal:        'Normal',
    rising:        'Rising',
    low:           'Low',
    no_data:       'No data',
  };

  const ALERT_LABEL = {
    evacuate: 'EVACUATE',
    warning:  'WARNING',
    watch:    'WATCH',
  };

  // ---- Module-level state ---------------------------------------------------
  let _activePopup = null;

  // ---- History helpers ------------------------------------------------------
  /** Build {x: Date, y: value} arrays from a dam's history array. Skips
   *  rows where the numeric coercion produces NaN — the upstream sheet may
   *  contain literal "NaN" or empty strings that Number() turns into NaN. */
  function seriesFromHistory(dam) {
    const h = Array.isArray(dam && dam.history) ? dam.history : [];
    if (!h.length) return null;
    const level = [], gen = [], release = [], inflow = [], rain = [];
    const pushIfFinite = (arr, t, raw) => {
      const y = Number(raw);
      if (Number.isFinite(y)) arr.push({ x: t, y });
    };
    for (let i = 0; i < h.length; i++) {
      const row = h[i];
      if (!row || !row.date) continue;
      const t = new Date(row.date);
      if (isNaN(t)) continue;
      if (row.level != null)      pushIfFinite(level, t, row.level);
      if (row.generation != null) pushIfFinite(gen, t, row.generation);
      if (row.release != null)    pushIfFinite(release, t, row.release);
      if (row.inflow != null)     pushIfFinite(inflow, t, row.inflow);
      if (row.rainfall != null) {
        const r = Number(row.rainfall);
        if (Number.isFinite(r) && r > 0) rain.push({ x: t, y: r });
      }
    }
    return { level, gen, release, inflow, rain };
  }

  /** Slice series to last N days based on the most recent point. Pass
   *  `days == null` (not 0) to mean "return all". */
  function sliceLastDays(arr, days) {
    if (!arr || !arr.length || days == null) return arr || [];
    const cutoff = arr[arr.length - 1].x.getTime() - days * 86400 * 1000;
    let i = 0;
    while (i < arr.length && arr[i].x.getTime() < cutoff) i++;
    return arr.slice(i);
  }

  // Time range presets — 'all' renders full history (≤ ~1y for most dams)
  const RANGES = [
    { id: '30d', label: '30 days', days: 30 },
    { id: '90d', label: '90 days', days: 90 },
    { id: '1y',  label: '1 year',  days: 365 },
    { id: 'all', label: 'All',     days: null },
  ];

  // ---- HTML builders --------------------------------------------------------
  function statusPillHtml(status) {
    const cls = `hp-pop-status hp-pop-status-${status || 'no_data'}`;
    return `<span class="${cls}">${esc(STORAGE_LABEL[status] || 'No data')}</span>`;
  }

  function operatorAlertHtml(alert) {
    if (!alert) return '';
    return `<div class="hp-pop-alert hp-pop-alert-${esc(alert)}">${esc(ALERT_LABEL[alert] || alert.toUpperCase())} — operator advisory in effect</div>`;
  }

  /**
   * Vertical reservoir profile mini-chart: FSL (top) → current level → MOL (bottom).
   * Uses inline svg for crisp rendering at any size.
   */
  function reservoirProfileHtml(d) {
    const wl = Number(d.latest_reading && d.latest_reading.water_level_masl);
    const fsl = Number(d.fsl_masl), mol = Number(d.mol_masl);
    if (!Number.isFinite(wl) || !Number.isFinite(fsl) || !Number.isFinite(mol) || fsl <= mol) {
      return `<div class="hp-pop-profile-na">Reservoir geometry unavailable.</div>`;
    }
    const pct = Math.max(0, Math.min(1, (wl - mol) / (fsl - mol)));
    const fillPctStr = `${Math.round(pct * 100)}%`;
    return `
      <div class="hp-pop-profile">
        <div class="hp-pop-profile-col">
          <div class="hp-pop-profile-label">FSL</div>
          <div class="hp-pop-profile-val">${fsl.toFixed(2)} m</div>
        </div>
        <div class="hp-pop-profile-bar">
          <div class="hp-pop-profile-fill" style="height:${(pct * 100).toFixed(1)}%"></div>
          <div class="hp-pop-profile-current" style="bottom:${(pct * 100).toFixed(1)}%"></div>
          <div class="hp-pop-profile-current-lbl" style="bottom:${(pct * 100).toFixed(1)}%">${wl.toFixed(2)} m · ${fillPctStr}</div>
        </div>
        <div class="hp-pop-profile-col">
          <div class="hp-pop-profile-label">MOL</div>
          <div class="hp-pop-profile-val">${mol.toFixed(2)} m</div>
        </div>
      </div>`;
  }

  function compactPopupHtml(d) {
    const s = computeStorage(d);
    const alert = computeOperatorAlert(d);
    const lr = d.latest_reading || {};
    const lastDate = fmtDate(lr.date);
    const lastRel = relTime(lr.ingested_at_utc || lr.date);
    const gen = Number(lr.generation_mw);
    const cap = Number(d.capacity_mw);
    const genPct = (Number.isFinite(gen) && Number.isFinite(cap) && cap > 0)
      ? ` · ${Math.round((gen / cap) * 100)}% of ${cap.toFixed(0)} MW`
      : (Number.isFinite(cap) ? ` · cap ${cap.toFixed(0)} MW` : '');

    return `
      <div class="hp-pop">
        <div class="hp-pop-header">
          <div class="hp-pop-title-wrap">
            <div class="hp-pop-title">${esc(d.name_en || 'Dam')}</div>
            <div class="hp-pop-sub">${esc(d.name_lo || '')}${d.name_lo ? ' · ' : ''}${esc(d.river || '')} · ${esc(d.country || '')} · ${esc(d.code || '')}</div>
          </div>
          ${statusPillHtml(s.status)}
        </div>

        ${operatorAlertHtml(alert)}

        <div class="hp-pop-latest">
          <div class="hp-pop-latest-val">${fmtNum(lr.water_level_masl, 2)}<span class="hp-pop-latest-unit">m</span></div>
          <div class="hp-pop-latest-lbl">Water level (masl)</div>
          <div class="hp-pop-latest-time">${esc(lastDate)}${lastRel ? ` · ${esc(lastRel)}` : ''}</div>
          ${s.fillPct != null ? `<div class="hp-pop-fill">Reservoir ${fmtPct(s.fillPct)} full</div>` : ''}
        </div>

        <div class="hp-pop-metrics">
          <div class="hp-pop-metric">
            <div class="hp-pop-metric-val">${fmtNum(lr.generation_mw, 1)}<span class="hp-pop-metric-unit">MW</span></div>
            <div class="hp-pop-metric-lbl">Generation${genPct}</div>
          </div>
          <div class="hp-pop-metric">
            <div class="hp-pop-metric-val">${fmtNum(lr.total_release_cms, 1)}<span class="hp-pop-metric-unit">m³/s</span></div>
            <div class="hp-pop-metric-lbl">Total release</div>
          </div>
          <div class="hp-pop-metric">
            <div class="hp-pop-metric-val">${fmtNum(lr.inflow_cms, 1)}<span class="hp-pop-metric-unit">m³/s</span></div>
            <div class="hp-pop-metric-lbl">Inflow</div>
          </div>
          <div class="hp-pop-metric">
            <div class="hp-pop-metric-val">${fmtNum(lr.storage_mcm, 0)}<span class="hp-pop-metric-unit">MCM</span></div>
            <div class="hp-pop-metric-lbl">Storage</div>
          </div>
        </div>

        ${reservoirProfileHtml(d)}

        <div class="hp-pop-sparkline-wrap" data-hp-spark="${esc(d.code)}">
          <div class="hp-pop-sparkline-empty">Loading 30-day generation trend…</div>
        </div>

        <div class="hp-pop-actions">
          <button class="hp-pop-cta hp-pop-cta-primary" type="button" data-hp-open-chart="${esc(d.code)}">Show chart</button>
          <button class="hp-pop-cta hp-pop-cta-secondary" type="button" data-hp-open-detail="${esc(d.code)}">Full panel</button>
        </div>

        <div class="hp-pop-source">${esc(d.operator || 'Operator unknown')}${d.dam_type ? ` · ${esc(d.dam_type)}` : ''}</div>
      </div>`;
  }

  function expandedPopupHtml(d) {
    const s = computeStorage(d);
    const alert = computeOperatorAlert(d);
    const lr = d.latest_reading || {};
    const rangesHtml = RANGES.map((r, i) =>
      `<button type="button" class="hp-rng-btn ${i === 0 ? 'hp-rng-on' : ''}" data-hp-rng="${r.id}">${esc(r.label)}</button>`
    ).join('');

    // Determine which legend entries to show based on what data exists
    // across the full history (legend lives in static HTML; the chart
    // dataset rules at render time may show fewer series, but the legend
    // reflects what data exists overall).
    const series = seriesFromHistory(d);
    const showGen = series && series.gen.some(p => p.y > 0);
    const showRelease = series && series.release.some(p => p.y > 0);
    const showFsl = Number.isFinite(Number(d.fsl_masl));
    const showMol = Number.isFinite(Number(d.mol_masl));

    return `
      <div class="hp-pop hp-pop-expanded-body">
        <div class="hp-pop-header">
          <div class="hp-pop-title-wrap">
            <div class="hp-pop-title">${esc(d.name_en || 'Dam')}</div>
            <div class="hp-pop-sub">Operations chart · ${esc(d.code || '')} · ${esc(d.river || '')} · ${esc(d.country || '')}</div>
          </div>
          ${statusPillHtml(s.status)}
        </div>

        ${operatorAlertHtml(alert)}

        <div class="hp-pop-stats-grid">
          <div class="hp-pop-stat"><div class="hp-pop-stat-val">${fmtNum(lr.water_level_masl, 2)}</div><div class="hp-pop-stat-lbl">Level (masl)</div></div>
          <div class="hp-pop-stat"><div class="hp-pop-stat-val">${s.fillPct != null ? fmtPct(s.fillPct) : '—'}</div><div class="hp-pop-stat-lbl">Fill</div></div>
          <div class="hp-pop-stat"><div class="hp-pop-stat-val">${fmtNum(lr.generation_mw, 1)}</div><div class="hp-pop-stat-lbl">Gen (MW)</div></div>
          <div class="hp-pop-stat"><div class="hp-pop-stat-val">${fmtNum(lr.inflow_cms, 1)}</div><div class="hp-pop-stat-lbl">Inflow (m³/s)</div></div>
          <div class="hp-pop-stat"><div class="hp-pop-stat-val">${fmtNum(lr.total_release_cms, 1)}</div><div class="hp-pop-stat-lbl">Release (m³/s)</div></div>
          <div class="hp-pop-stat"><div class="hp-pop-stat-val">${fmtNum(lr.storage_mcm, 0)}</div><div class="hp-pop-stat-lbl">Storage (MCM)</div></div>
        </div>

        <div class="hp-pop-rng">${rangesHtml}</div>

        <div class="hp-pop-chart-wrap">
          <canvas class="hp-pop-chart"></canvas>
          <div class="hp-pop-chart-loading">Building chart…</div>
        </div>

        <div class="hp-pop-legend">
          <span class="hp-leg hp-leg-level"><span class="hp-leg-line"></span> Water level (m)</span>
          ${showGen ? '<span class="hp-leg hp-leg-gen"><span class="hp-leg-line"></span> Generation (MW)</span>' : ''}
          ${showRelease ? '<span class="hp-leg hp-leg-release"><span class="hp-leg-line"></span> Release (m³/s)</span>' : ''}
          ${showFsl ? '<span class="hp-leg hp-leg-fsl"><span class="hp-leg-dash"></span> FSL</span>' : ''}
          ${showMol ? '<span class="hp-leg hp-leg-mol"><span class="hp-leg-dash"></span> MOL</span>' : ''}
        </div>

        <div class="hp-pop-spec">
          <span class="hp-spec-cell" title="Installed capacity">Capacity: <b>${fmtNum(d.capacity_mw, 0, 'MW')}</b></span>
          <span class="hp-spec-cell" title="Full supply level">FSL: <b>${fmtNum(d.fsl_masl, 2, 'm')}</b></span>
          <span class="hp-spec-cell" title="Minimum operating level">MOL: <b>${fmtNum(d.mol_masl, 2, 'm')}</b></span>
          <span class="hp-spec-cell" title="Crest elevation">Crest: <b>${fmtNum(d.crest_masl, 2, 'm')}</b></span>
          <span class="hp-spec-cell" title="Dam height">Height: <b>${fmtNum(d.dam_height_m, 1, 'm')}</b></span>
          <span class="hp-spec-cell" title="Total reservoir storage">Storage: <b>${fmtNum(d.total_storage_mcm, 0, 'MCM')}</b></span>
        </div>

        <div class="hp-pop-actions">
          <button class="hp-pop-cta hp-pop-cta-collapse" type="button" data-hp-collapse>← Show less</button>
          <button class="hp-pop-cta hp-pop-cta-secondary" type="button" data-hp-open-detail="${esc(d.code)}">Full panel</button>
        </div>

        <div class="hp-pop-source">${esc(d.operator || 'Operator unknown')}${d.dam_type ? ` · ${esc(d.dam_type)}` : ''} · Updated ${esc(fmtDate(lr.date))}</div>
      </div>`;
  }

  // ---- Sparkline (compact view, 30d generation) -----------------------------
  function drawSparkline(canvas, points, opts) {
    if (!points || !points.length || !canvas) return false;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 280;
    const h = canvas.clientHeight || 48;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    let minY = Infinity, maxY = -Infinity;
    points.forEach(p => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return false;
    if (minY === maxY) { minY -= 0.5; maxY += 0.5; }
    const padY = Math.max(0.0001, (maxY - minY) * 0.1);
    minY -= padY; maxY += padY;
    // Generation always starts at 0 for nice baseline if non-negative data
    if ((opts && opts.zeroBase) && minY > 0) minY = 0;

    const t0 = points[0].x.getTime();
    const t1 = points[points.length - 1].x.getTime();
    const span = t1 - t0 || 1;

    const xy = (p) => [((p.x.getTime() - t0) / span) * w, h - ((p.y - minY) / (maxY - minY || 1)) * h];

    const color = (opts && opts.color) || '#fbbf24';

    // Area
    ctx.beginPath();
    points.forEach((p, i) => {
      const [x, y] = xy(p);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + '55');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    points.forEach((p, i) => {
      const [x, y] = xy(p);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = color;
    ctx.stroke();

    // Last point dot
    const last = xy(points[points.length - 1]);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return true;
  }

  /**
   * After compact popup renders, fill the sparkline with 30-day generation
   * (falls back to water level if no generation data is non-zero).
   */
  function hydrateSparkline(popup, dam) {
    const myGen = (popup._hpSparkGen = (popup._hpSparkGen || 0) + 1);
    const stillCurrent = () => isPopupAlive(popup) && popup._hpSparkGen === myGen;

    const root = popup.getElement();
    if (!root) return;
    const wrap = root.querySelector(`[data-hp-spark="${CSS.escape(String(dam.code || ''))}"]`);
    if (!wrap) return;

    const series = seriesFromHistory(dam);
    if (!series) {
      wrap.innerHTML = '<div class="hp-pop-sparkline-empty">No history data.</div>';
      return;
    }
    const gen30 = sliceLastDays(series.gen, 30);
    const lvl30 = sliceLastDays(series.level, 30);
    const hasGen = gen30.length && gen30.some(p => Number.isFinite(p.y) && p.y > 0);
    const points = hasGen ? gen30 : lvl30;
    const label = hasGen ? '30d generation' : '30d water level';
    const color = hasGen ? '#fbbf24' : '#60a5fa';

    if (!points.length) {
      wrap.innerHTML = '<div class="hp-pop-sparkline-empty">No recent readings.</div>';
      return;
    }

    wrap.innerHTML = `<canvas class="hp-pop-sparkline-canvas"></canvas><div class="hp-pop-sparkline-lbl">${esc(label)}</div>`;
    const canvas = wrap.querySelector('canvas');
    requestAnimationFrame(() => {
      if (!stillCurrent()) return;
      drawSparkline(canvas, points, { color, zeroBase: hasGen });
    });
  }

  // ---- Chart.js full chart (expanded view) ---------------------------------
  function buildChartConfig(series, dam, rangeId) {
    const range = RANGES.find(r => r.id === rangeId) || RANGES[0];
    const slice = (arr) => range.days == null ? arr : sliceLastDays(arr, range.days);

    const level = slice(series.level);
    const gen   = slice(series.gen);
    const release = slice(series.release);

    const datasets = [];

    // Water level (left axis, meters)
    datasets.push({
      label: 'Water level',
      data: level,
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96,165,250,0.10)',
      borderWidth: 1.8,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: true,
      tension: 0.2,
      yAxisID: 'y',
    });

    // Generation (right axis, MW)
    const hasGen = gen.some(p => Number.isFinite(p.y) && p.y > 0);
    if (hasGen) {
      datasets.push({
        label: 'Generation',
        data: gen,
        borderColor: '#fbbf24',
        backgroundColor: 'rgba(251,191,36,0.12)',
        borderWidth: 1.6,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.2,
        yAxisID: 'y1',
      });
    }

    // Release (right axis if no gen, secondary y2 if gen present — but we keep
    // it simple and overlay on y1 since release units differ. Show release as
    // a second light line on its own axis.)
    const hasRelease = release.some(p => Number.isFinite(p.y) && p.y > 0);
    if (hasRelease) {
      datasets.push({
        label: 'Release',
        data: release,
        borderColor: '#34d399',
        backgroundColor: 'rgba(52,211,153,0.06)',
        borderWidth: 1.4,
        borderDash: [4, 3],
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: false,
        tension: 0.2,
        yAxisID: 'y2',
      });
    }

    // FSL / MOL horizontal reference lines
    const xMin = level.length ? level[0].x : null;
    const xMax = level.length ? level[level.length - 1].x : null;
    const addRefLine = (label, val, color) => {
      const v = Number(val);
      if (!Number.isFinite(v) || !xMin || !xMax) return;
      datasets.push({
        label: `${label} (${v.toFixed(2)} m)`,
        data: [{ x: xMin, y: v }, { x: xMax, y: v }],
        borderColor: color,
        borderDash: [6, 4],
        borderWidth: 1.4,
        pointRadius: 0,
        fill: false,
        yAxisID: 'y',
      });
    };
    addRefLine('FSL', dam.fsl_masl, '#ef4444');
    addRefLine('MOL', dam.mol_masl, '#94a3b8');

    return {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 200 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                if (!Number.isFinite(v)) return ctx.dataset.label;
                const lbl = ctx.dataset.label || '';
                if (lbl.startsWith('Generation')) return `Gen: ${v.toFixed(1)} MW`;
                if (lbl.startsWith('Release'))    return `Release: ${v.toFixed(1)} m³/s`;
                if (lbl.startsWith('Water'))      return `Level: ${v.toFixed(2)} m`;
                return `${lbl}: ${v.toFixed(2)}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'time',
            time: {
              tooltipFormat: 'PP',
              displayFormats: { day: 'MMM d', week: 'MMM d', month: 'MMM yyyy' }
            },
            ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true, autoSkipPadding: 18 },
            grid: { color: 'rgba(255,255,255,0.06)' }
          },
          y: {
            position: 'left',
            title: { display: true, text: 'Level [m]', color: '#cbd5e1', font: { size: 11 } },
            ticks: { color: '#94a3b8' },
            grid: { color: 'rgba(255,255,255,0.06)' }
          },
          y1: hasGen ? {
            position: 'right',
            title: { display: true, text: 'Gen [MW]', color: '#fbbf24', font: { size: 11 } },
            ticks: { color: '#fbbf24' },
            grid: { display: false },
            beginAtZero: true,
          } : { display: false },
          y2: hasRelease ? {
            position: 'right',
            display: false,                     // share visual space with y1 axis
            ticks: { color: '#34d399' },
            grid: { display: false },
            beginAtZero: true,
          } : { display: false },
        }
      }
    };
  }

  // ---- Lifecycle helpers ----------------------------------------------------
  function isPopupAlive(popup) {
    if (!popup) return false;
    try {
      if (typeof popup.isOpen === 'function' && !popup.isOpen()) return false;
      const el = popup.getElement && popup.getElement();
      return !!(el && el.isConnected);
    } catch (_) { return false; }
  }

  function destroyChart(popup) {
    if (popup && popup._hpChart) {
      try { popup._hpChart.destroy(); } catch (_) {}
      popup._hpChart = null;
    }
  }

  function renderChart(popup, dam, rangeId) {
    if (!isPopupAlive(popup)) return;
    const root = popup.getElement();
    if (!root) return;
    const wrap = root.querySelector('.hp-pop-chart-wrap');
    if (!wrap) return;
    const canvas = wrap.querySelector('canvas.hp-pop-chart');
    const loading = wrap.querySelector('.hp-pop-chart-loading');
    if (!canvas) return;

    const series = seriesFromHistory(dam);
    if (!series || !series.level.length) {
      wrap.innerHTML = '<div class="hp-pop-chart-loading">No history available for this dam.</div>';
      return;
    }
    if (loading) loading.style.display = 'none';

    destroyChart(popup);
    if (typeof Chart === 'undefined') {
      wrap.innerHTML = '<div class="hp-pop-chart-loading">Chart.js not loaded.</div>';
      return;
    }
    if (!isPopupAlive(popup)) return;
    popup._hpChart = new Chart(canvas, buildChartConfig(series, dam, rangeId));
  }

  function wireRangeTabs(popup, dam) {
    const root = popup.getElement();
    if (!root) return;
    root.querySelectorAll('[data-hp-rng]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!isPopupAlive(popup)) return;
        root.querySelectorAll('[data-hp-rng]').forEach(b => b.classList.remove('hp-rng-on'));
        btn.classList.add('hp-rng-on');
        renderChart(popup, dam, btn.getAttribute('data-hp-rng'));
      });
    });
  }

  function wireCollapse(popup, dam) {
    const root = popup.getElement();
    if (!root) return;
    const btn = root.querySelector('[data-hp-collapse]');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!isPopupAlive(popup)) return;
      destroyChart(popup);
      popup.setMaxWidth(popup._hpCompactMaxWidth || '340px');
      const el = popup.getElement();
      if (el) el.classList.remove('hp-pop-expanded');
      popup.setHTML(popup._hpCompactHtml);
      popup._hpSparkGen = (popup._hpSparkGen || 0) + 1;
      wireCompactButtons(popup, dam);
      hydrateSparkline(popup, dam);
    }, { once: true });
  }

  function wireDetailButton(popup, dam) {
    const root = popup.getElement();
    if (!root) return;
    root.querySelectorAll('[data-hp-open-detail]').forEach(btn => {
      btn.addEventListener('click', () => {
        // Re-trigger selectDam side panel; flow.js exposes it via window if available.
        if (typeof window.selectDam === 'function') {
          window.selectDam(dam.code, { fly: false });
        }
        // Scroll the side panel into view on mobile
        const damHeader = document.getElementById('damHeader');
        if (damHeader && damHeader.scrollIntoView) {
          damHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, { once: true });
    });
  }

  function expandPopup(popup, dam) {
    if (!isPopupAlive(popup)) return;
    destroyChart(popup);
    if (!popup._hpCompactHtml) popup._hpCompactHtml = compactPopupHtml(dam);

    popup.setMaxWidth('480px');
    popup.setHTML(expandedPopupHtml(dam));
    const el = popup.getElement();
    if (el) el.classList.add('hp-pop-expanded');

    wireCollapse(popup, dam);
    wireDetailButton(popup, dam);
    wireRangeTabs(popup, dam);

    // Render default range (30d)
    renderChart(popup, dam, '30d');
  }

  // Note: this is called once on initial open and again on each collapse.
  // It relies on the invariant that `setHTML` always replaces the DOM (so
  // each call wires fresh nodes and the prior listeners are GC'd along with
  // the discarded nodes). Don't add an expand/collapse code path that mutates
  // existing DOM in place without re-rendering — that would accumulate
  // listeners since wireDetailButton uses {once: true} per-node.
  function wireCompactButtons(popup, dam) {
    const root = popup.getElement();
    if (!root) return;
    const showChartBtn = root.querySelector('[data-hp-open-chart]');
    if (showChartBtn) {
      showChartBtn.addEventListener('click', () => expandPopup(popup, dam), { once: true });
    }
    wireDetailButton(popup, dam);
  }

  // ---- Public entry --------------------------------------------------------
  function openHydropowerPopup(dam, opts) {
    const MAP = window.MAP;
    if (!MAP || !dam) return null;

    // Anchor: if a specific subdam point was passed in opts.point, use it.
    // Otherwise fall back to the dam's main lat/lon.
    const anchor = (opts && opts.point) || dam;
    const lng = Number(anchor.lon), lat = Number(anchor.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      // try dam-level coords
      const dLng = Number(dam.lon), dLat = Number(dam.lat);
      if (!Number.isFinite(dLng) || !Number.isFinite(dLat)) return null;
      return openAt(dam, dLng, dLat);
    }
    return openAt(dam, lng, lat);
  }

  function openAt(dam, lng, lat) {
    const MAP = window.MAP;

    // Close any open hydropower popup before opening a new one.
    if (_activePopup) {
      try { _activePopup.remove(); } catch (_) {}
      _activePopup = null;
    }

    const html = compactPopupHtml(dam);
    // closeOnClick: false — without this, tapping the map to pan would
    // dismiss the popup on every gesture (especially painful on mobile).
    // The popup has an explicit close button + auto-closes when another
    // hp-popup or mrc-popup opens.
    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: '340px',
      className: 'hp-pop-wrap',
      offset: 14,
    })
      .setLngLat([lng, lat])
      .setHTML(html)
      .addTo(MAP);

    popup._hpCompactHtml = html;
    popup._hpCompactMaxWidth = '340px';
    popup._hpSparkGen = 0;

    _activePopup = popup;

    popup.on('close', () => {
      destroyChart(popup);
      if (_activePopup === popup) _activePopup = null;
    });

    wireCompactButtons(popup, dam);
    hydrateSparkline(popup, dam);

    return popup;
  }

  // ---- Expose --------------------------------------------------------------
  window.openHydropowerPopup = openHydropowerPopup;
})();
