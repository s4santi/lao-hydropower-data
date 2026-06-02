/* Flow Coordination dashboard — Phase 2
 * Glass-morphism dark theme with satellite map, glowing orbs, basemap switcher,
 * search, hover tooltips, and fullscreen.
 */

const DATA_URL = '../data/cascade.json';
let CASCADE = null;
let ACTIVE_CODE = null;
let CHARTS = {};
let FILTER_MODE = 'all';
let SEARCH_TERM = '';
let MAP = null;
let PENDING_UPLOAD = null;

// DOM marker registry (one entry per dam code; each value is an array of markers because some dams have sub-dam points)
let MARKERS = {};
let MRC_MARKERS = [];

// Dam icon mapping (status -> filename suffix in ../icons/)
const DAM_ICON_MAP = {
  low: 'low', rising: 'rising', normal: 'normal', watch: 'watch',
  high: 'high', critical_high: 'critical', no_data: 'nodata'
};

// MRC station layer
const MRC_POLL_MS = 5 * 60 * 1000;
let MRC_STATIONS = [];
let STATION_FILTER = new Set(['normal','alarm','flood','na','china']);

// Map-marker filter
const ALL_STORAGE_STATUSES = ['low','rising','normal','watch','high','critical_high','no_data'];
let STATUS_FILTER = new Set(ALL_STORAGE_STATUSES);

// Current basemap key
let CURRENT_BASEMAP = 'satellite';

const FRESHNESS_LABEL = {
  current:     'Reporting today',
  recent:      'Reported this week',
  stale:       'Reported this month',
  old:         'Last reading >30 days',
  no_readings: 'No operator readings',
};

const FRESH_COLOR = {
  current: '#34d399',
  recent:  '#3ddbd9',
  stale:   '#ffb84d',
  old:     '#ff8a65',
  no_readings: '#5d6c78',
};

// Storage status → orb color (matches legend)
const STORAGE_COLOR = {
  low:           '#ef4444',
  rising:        '#f59e0b',
  normal:        '#34d399',
  watch:         '#fbbf24',
  high:          '#f97316',
  critical_high: '#dc2626',
  no_data:       '#6b7a93',
};

// Station status → marker color
const STATION_COLOR = {
  normal: '#34d399',
  alarm:  '#fbbf24',
  flood:  '#ef4444',
  na:     '#6b7a93',
  china:  '#a78bfa',
};

/* ========================================================
 * Helpers
 * ====================================================== */
function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  return String(v).toUpperCase() === 'TRUE';
}
function computeStorage(d) {
  const lr = d.latest_reading || {};
  const wl = Number(lr.water_level_masl);
  const fsl = Number(d.fsl_masl);
  const mol = Number(d.mol_masl);
  const valid =
    Number.isFinite(wl) && Number.isFinite(fsl) && Number.isFinite(mol) &&
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

/* ========================================================
 * Boot
 * ====================================================== */
init();

async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    CASCADE = await res.json();
  } catch (e) {
    console.error('Failed to load cascade.json', e);
    document.body.innerHTML = `<div style="padding:80px;text-align:center;color:#ff6b6b">Could not load cascade.json.</div>`;
    return;
  }

  renderSummaryBar();
  renderFreshnessGrid();
  populateDamSelect();
  renderDamList();
  setupSliders();
  setupFormSubmit();
  setupUpload();
  setupFilters();
  setupLegendFilter();
  setupLegendToggle();
  setupMapTools();

  await initMap();
  placeDamMarkers();
  loadMRCStations();
  setInterval(loadMRCStations, MRC_POLL_MS);
  setupStationLegend();
  ffgsInit().catch(err => console.warn('[ffgs] init failed:', err));
  p3Init().catch(err => console.warn('[p3] init failed:', err));

  document.getElementById('sdClose').addEventListener('click', () => {
    document.getElementById('stationDetail').style.display = 'none';
    document.getElementById('damHeader').style.display = '';
  });

  const urlDam = new URLSearchParams(location.search).get('dam');
  const initial =
    (urlDam && CASCADE.dams.find(d => d.code === urlDam)) ||
    CASCADE.dams.find(d => d.reporting_status === 'current') ||
    CASCADE.dams[0];
  if (initial) selectDam(initial.code, { fly: true });
}

/* ========================================================
 * Summary bar
 * ====================================================== */
function renderSummaryBar() {
  const s = CASCADE.summary;
  document.getElementById('sb-total').textContent = s.total_dams;
  document.getElementById('sb-total-sub').textContent = `${s.dams_with_any_readings} with readings · ${s.total_dams - s.dams_with_any_readings} blank`;
  document.getElementById('sb-current').textContent = s.dams_reporting_current;
  document.getElementById('sb-with-readings').textContent = s.dams_with_any_readings;
  document.getElementById('sb-capacity').textContent = `${(s.total_installed_mw/1000).toFixed(2)} GW`;
  const gen = new Date(CASCADE.generated_at_utc);
  document.getElementById('sb-generated').textContent = gen.toISOString().slice(0,10);
  const sheet = CASCADE.clean_sheet_url;
  document.getElementById('sb-sheet').href = sheet;
  document.getElementById('freshLink').href = sheet;
  document.getElementById('footSheet').href = sheet;
  document.getElementById('footMeta').textContent = `Data ${gen.toISOString().slice(0,19)}Z · Phase 2 · Glass`;
}

/* ========================================================
 * Legend toggle + filter
 * ====================================================== */
function setupLegendToggle() {
  const btn = document.getElementById('lgToggle');
  const body = document.getElementById('lgBody');
  if (!btn || !body) return;
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    if (open) { body.hidden = true; btn.setAttribute('aria-expanded','false'); btn.textContent = 'Show'; }
    else      { body.hidden = false; btn.setAttribute('aria-expanded','true');  btn.textContent = 'Hide'; }
  });
}

function setupLegendFilter() {
  const chips = document.querySelectorAll('.lg-filter:not(.lg-mrc)');
  const resetBtn = document.getElementById('lgReset');

  function syncChips() {
    chips.forEach(c => {
      const on = STATUS_FILTER.has(c.dataset.status);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const isAll = STATUS_FILTER.size === ALL_STORAGE_STATUSES.length;
    if (resetBtn) resetBtn.hidden = isAll;
  }

  chips.forEach(chip => {
    chip.addEventListener('click', (ev) => {
      const status = chip.dataset.status;
      if (ev.shiftKey || ev.altKey) {
        STATUS_FILTER = new Set([status]);
      } else {
        if (STATUS_FILTER.has(status)) STATUS_FILTER.delete(status);
        else STATUS_FILTER.add(status);
        if (STATUS_FILTER.size === 0) STATUS_FILTER = new Set(ALL_STORAGE_STATUSES);
      }
      syncChips();
      refreshDamLayer();
    });
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      STATUS_FILTER = new Set(ALL_STORAGE_STATUSES);
      syncChips();
      refreshDamLayer();
    });
  }

  syncChips();
}

/* ========================================================
 * MAP — Phase 2 (satellite default, basemap switcher, glow orbs)
 * ====================================================== */

const BASEMAPS = {
  satellite: {
    sources: {
      'sat-img': {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: '© Esri · World Imagery',
        maxzoom: 19
      },
      'sat-labels': {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19
      }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#060d1c' } },
      { id: 'sat-img', type: 'raster', source: 'sat-img',
        paint: { 'raster-opacity': 0.92, 'raster-saturation': -0.10, 'raster-contrast': 0.05 } },
      { id: 'sat-labels', type: 'raster', source: 'sat-labels',
        paint: { 'raster-opacity': 0.55 } }
    ]
  },
  street: {
    sources: {
      'osm': {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
        maxzoom: 19
      }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a1628' } },
      { id: 'osm', type: 'raster', source: 'osm',
        paint: {
          'raster-saturation': -0.6,
          'raster-brightness-min': 0.05,
          'raster-brightness-max': 0.40,
          'raster-contrast': 0.20,
          'raster-opacity': 0.85,
        }
      }
    ]
  },
  terrain: {
    sources: {
      'topo': {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: '© Esri · World Topo',
        maxzoom: 19
      }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a1628' } },
      { id: 'topo', type: 'raster', source: 'topo',
        paint: { 'raster-opacity': 0.80, 'raster-saturation': -0.30, 'raster-brightness-max': 0.55 } }
    ]
  }
};

async function initMap() {
  const initial = BASEMAPS[CURRENT_BASEMAP];
  MAP = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: initial.sources, layers: initial.layers },
    center: [104.5, 18.5],
    zoom: 5.4,
    minZoom: 3.5,
    maxZoom: 14,
    attributionControl: { compact: true },
  });
  window.MAP = MAP;  // expose for phase36.js and other late-loaded modules (let doesn't auto-bind to window)
  MAP.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  // Target .map-wrap (not #map) so hazard buttons, basemap pills, search, and
  // legend all stay visible when the user goes fullscreen on mobile/desktop.
  MAP.addControl(new maplibregl.FullscreenControl({
    container: document.querySelector('.map-wrap')
  }), 'top-left');

  await new Promise(r => MAP.once('load', r));
  await addRiverNetwork();
  // DOM markers (placeDamMarkers + placeStations) are placed by init() after initMap returns.
}

/* Switch basemap. DOM markers persist across style swaps (they live in the marker layer, not the style),
   so we only need to re-add the river network overlay. */
async function switchBasemap(key) {
  if (!BASEMAPS[key] || key === CURRENT_BASEMAP) return;
  CURRENT_BASEMAP = key;
  const def = BASEMAPS[key];

  const center = MAP.getCenter(), zoom = MAP.getZoom(), bearing = MAP.getBearing(), pitch = MAP.getPitch();

  MAP.setStyle({ version: 8, sources: def.sources, layers: def.layers });
  await new Promise(r => MAP.once('styledata', r));
  MAP.jumpTo({ center, zoom, bearing, pitch });
  await addRiverNetwork();
  // Re-add FFGS layer if it was already loaded
  if (FFGS.state.geo) { ffgsAddLayer().catch(()=>{}); }
  // Re-add province layer if it was already loaded
  if (P3.provincesGeo) { p3AddProvinceLayer().catch(()=>{}); }
  // Re-add Phase 3.6 PDC disaster layers if they were loaded
  if (typeof window.p36EnsureLayers === 'function') {
    try { window.p36EnsureLayers(); } catch(e) { console.warn('[p36] re-add failed', e); }
  }

  // Update toolbar UI
  document.querySelectorAll('.basemap-pill button').forEach(b => {
    b.classList.toggle('on', b.dataset.basemap === key);
  });
}

/* River network */
async function addRiverNetwork() {
  const sources = [
    { id: 'country-borders', url: '../data/geo/country_borders.geojson' },
    { id: 'tributaries',     url: '../data/geo/tributaries.geojson' },
    { id: 'mekong',          url: '../data/geo/mekong_mainstream.geojson' },
  ];
  const datasets = await Promise.all(sources.map(async s => {
    try {
      const res = await fetch(s.url, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { id: s.id, data: await res.json() };
    } catch (e) {
      console.warn(`river layer ${s.id} failed`, e);
      return null;
    }
  }));
  for (const d of datasets) {
    if (!d) continue;
    if (!MAP.getSource(d.id)) MAP.addSource(d.id, { type: 'geojson', data: d.data });
  }

  if (MAP.getSource('country-borders') && !MAP.getLayer('country-borders-line')) {
    MAP.addLayer({
      id: 'country-borders-line', type: 'line', source: 'country-borders',
      paint: {
        'line-color': '#ffffff', 'line-opacity': 0.18,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 7, 1.0, 10, 1.6]
      }
    });
  }
  if (MAP.getSource('tributaries') && !MAP.getLayer('tributaries-glow')) {
    MAP.addLayer({
      id: 'tributaries-glow', type: 'line', source: 'tributaries',
      paint: {
        'line-color': '#60a5fa', 'line-opacity': 0.35, 'line-blur': 2,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.0, 7, 2.0, 10, 3.5]
      }
    });
    MAP.addLayer({
      id: 'tributaries-line', type: 'line', source: 'tributaries',
      paint: {
        'line-color': '#93c5fd', 'line-opacity': 0.85,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 7, 1.0, 10, 1.8]
      }
    });
  }
  if (MAP.getSource('mekong')) {
    if (!MAP.getLayer('mekong-glow')) {
      MAP.addLayer({
        id: 'mekong-glow', type: 'line', source: 'mekong',
        paint: {
          'line-color': '#3b82f6', 'line-opacity': 0.45, 'line-blur': 6,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 5, 7, 10, 10, 16]
        }
      });
    }
    if (!MAP.getLayer('mekong-core')) {
      MAP.addLayer({
        id: 'mekong-core', type: 'line', source: 'mekong',
        paint: {
          'line-color': '#dbeafe', 'line-opacity': 0.95,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 7, 3.0, 10, 4.5]
        }
      });
    }
  }
}

/* ========================================================
 * Dam markers — DOM markers using original PNG icons.
 * One marker per dam (or one per sub-dam for cascade groups).
 * Filter by storage status via STATUS_FILTER (legend chips).
 * ====================================================== */
function placeDamMarkers() {
  // Clear existing markers
  Object.values(MARKERS).flat().forEach(m => m.remove());
  MARKERS = {};
  if (!MAP || !CASCADE) return;

  CASCADE.dams.forEach(d => {
    const s = computeStorage(d);
    if (!STATUS_FILTER.has(s.status)) return;
    const alert = computeOperatorAlert(d);
    const pct = s.fillPct != null ? `${Math.round(s.fillPct * 100)}%` : '—';

    const points = Array.isArray(d.subdams) && d.subdams.length
      ? d.subdams.map(sd => ({ lat: sd.lat, lon: sd.lon, label: sd.name_en, key: sd.code }))
      : (d.lat != null && d.lon != null ? [{ lat: d.lat, lon: d.lon, label: d.name_en, key: d.code }] : []);

    const markersForDam = [];
    points.forEach(pt => {
      if (!Number.isFinite(pt.lat) || !Number.isFinite(pt.lon)) return;

      const wrap = document.createElement('div');
      wrap.className = `map-marker-wrap mms-${s.status}${alert ? ' mma-' + alert : ''}${d.code === ACTIVE_CODE ? ' mm-active' : ''}`;
      wrap.title = `${pt.label} (${pt.key}) — ${pct} of active storage`;
      wrap.addEventListener('click', (e) => {
        // Open compact operations popup at the clicked point AND keep the
        // side-panel detail (selectDam) so both surfaces stay in sync.
        // stopPropagation so the click doesn't bubble to MAP handlers.
        e.stopPropagation();
        selectDam(d.code, { fly: true });
        if (typeof window.openHydropowerPopup === 'function') {
          window.openHydropowerPopup(d, { point: pt });
        }
      });

      const dot = document.createElement('img');
      dot.className = `map-marker mm-storage-${s.status}`;
      dot.alt = s.status;
      dot.src = `../icons/dam_icon_${DAM_ICON_MAP[s.status]}.png`;
      wrap.appendChild(dot);

      if (alert) {
        const ind = document.createElement('span');
        ind.className = `map-marker-alert mma-dot-${alert}`;
        ind.title = `Operator alert: ${alert}`;
        dot.appendChild(ind);
      }

      const label = document.createElement('span');
      label.className = 'map-marker-label';
      label.textContent = pt.label;
      wrap.appendChild(label);

      const m = new maplibregl.Marker({ element: wrap, anchor: 'left' })
        .setLngLat([pt.lon, pt.lat])
        .addTo(MAP);
      markersForDam.push(m);
    });

    if (markersForDam.length) MARKERS[d.code] = markersForDam;
  });
}

/* Re-render markers when legend filter changes. */
function refreshDamLayer() {
  placeDamMarkers();
}

/* Mark a dam active by toggling .mm-active on its marker wrappers. */
function setActiveDamFilter(code) {
  Object.entries(MARKERS).forEach(([c, markers]) => {
    const isActive = c === code;
    markers.forEach(marker => {
      const el = marker.getElement();
      if (!el) return;
      el.classList.toggle('mm-active', isActive);
    });
  });
}

/* ========================================================
 * MRC station markers — DOM markers using PNG icons.
 * ====================================================== */
function placeStations() {
  MRC_MARKERS.forEach(m => m.remove());
  MRC_MARKERS = [];
  if (!MAP) return;
  MRC_STATIONS.forEach(s => {
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const status = s.status || 'na';
    if (!STATION_FILTER.has(status)) return;

    const wrap = document.createElement('div');
    wrap.className = `map-marker-wrap mrc-wrap mrc-${status}`;

    const img = document.createElement('img');
    img.src = `../icons/station_icon_solid_${status === 'flood' ? 'flood' : status}.png`;
    img.className = 'map-marker mrc-marker';
    img.alt = status;
    wrap.appendChild(img);

    const label = document.createElement('span');
    label.className = 'map-marker-label mrc-label';
    label.textContent = s.name || 'Station';
    wrap.appendChild(label);

    wrap.addEventListener('click', (e) => {
      // Open the map popup (compact card with sparkline + Show chart button).
      // Falls back to side-panel deep dive if popup module didn't load.
      // stopPropagation so the click doesn't bubble to MAP click handlers.
      e.stopPropagation();
      if (typeof window.openMrcStationPopup === 'function') {
        window.openMrcStationPopup(s);
      } else {
        openStationDetail(s.station_code);
      }
    });

    const m = new maplibregl.Marker({ element: wrap, anchor: 'left' })
      .setLngLat([lon, lat])
      .addTo(MAP);
    MRC_MARKERS.push(m);
  });
}

function refreshStationLayer() {
  placeStations();
}

/* Basemap switcher + search */
function setupMapTools() {
  document.querySelectorAll('.basemap-pill button').forEach(b => {
    b.addEventListener('click', () => switchBasemap(b.dataset.basemap));
  });

  const search = document.getElementById('mapSearch');
  const results = document.getElementById('mapSearchResults');
  if (!search) return;

  function close() { results.hidden = true; results.innerHTML = ''; }
  function open() { results.hidden = false; }

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return close();
    const dams = (CASCADE.dams || []).filter(d =>
      d.code.toLowerCase().includes(q) ||
      (d.name_en || '').toLowerCase().includes(q) ||
      (d.river || '').toLowerCase().includes(q)
    ).slice(0, 6);
    const stations = (MRC_STATIONS || []).filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.station_code || '').toLowerCase().includes(q)
    ).slice(0, 4);
    if (!dams.length && !stations.length) {
      results.innerHTML = `<div class="msr-empty">No matches</div>`;
      return open();
    }
    let html = '';
    if (dams.length) {
      html += `<div class="msr-group">DAMS</div>`;
      html += dams.map(d => `
        <div class="msr-row" data-kind="dam" data-id="${d.code}">
          <span class="msr-dot" style="background:${STORAGE_COLOR[computeStorage(d).status]}"></span>
          <div><div class="msr-name">${d.name_en}</div><div class="msr-sub">${d.code} · ${d.river || ''}</div></div>
        </div>
      `).join('');
    }
    if (stations.length) {
      html += `<div class="msr-group">MRC STATIONS</div>`;
      html += stations.map(s => `
        <div class="msr-row" data-kind="station" data-id="${s.station_code}">
          <span class="msr-dot" style="background:${STATION_COLOR[s.status || 'na']}"></span>
          <div><div class="msr-name">${s.name || 'Station'}</div><div class="msr-sub">${s.station_code} · ${s.country || ''}</div></div>
        </div>
      `).join('');
    }
    results.innerHTML = html;
    results.querySelectorAll('.msr-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.dataset.id, kind = row.dataset.kind;
        if (kind === 'dam') selectDam(id, { fly: true });
        else openStationDetail(id);
        search.value = '';
        close();
      });
    });
    open();
  });
  search.addEventListener('blur', () => setTimeout(close, 200));
}

/* ========================================================
 * MRC stations data load
 * ====================================================== */
async function loadMRCStations() {
  try {
    const res = await fetch('../data/mrc_stations.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    MRC_STATIONS = json.stations || [];
    if (typeof p3StampStations === 'function') p3StampStations();
    placeStations();
  } catch (e) {
    console.warn('MRC stations fetch failed:', e);
  }
}

function setupStationLegend() {
  document.querySelectorAll('.lg-filter.lg-mrc').forEach(chip => {
    chip.addEventListener('click', () => {
      const k = chip.dataset.station;
      if (STATION_FILTER.has(k)) STATION_FILTER.delete(k);
      else STATION_FILTER.add(k);
      if (STATION_FILTER.size === 0) STATION_FILTER = new Set(['normal','alarm','flood','na','china']);
      chip.setAttribute('aria-pressed', STATION_FILTER.has(k) ? 'true' : 'false');
      refreshStationLayer();
    });
  });
}

async function openStationDetail(stationCode) {
  const station = MRC_STATIONS.find(s => s.station_code === stationCode);
  if (!station) return;

  document.getElementById('damHeader').style.display = 'none';
  const stationDetail = document.getElementById('stationDetail');
  stationDetail.style.display = 'block';
  stationDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });

  renderStationHeader(station);
  try {
    const res = await fetch(`../data/mrc_timeseries/${stationCode}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('no timeseries');
    const ts = await res.json();
    renderStationChart(station, ts);
  } catch (e) {
    document.getElementById('stationChartWrap').innerHTML = '<div class="empty-ts">No recent time-series data for this station.</div>';
  }
}

function renderStationHeader(s) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
  const fmt = (v, unit = 'm', digits = 2) =>
    Number.isFinite(Number(v)) ? `${Number(v).toFixed(digits)} ${unit}` : '—';

  set('sd-code', `MRC · ${s.station_code}`);
  set('sd-country', s.country || s.country_code || '—');
  set('sd-name', s.name || 'Station');
  const subBits = [];
  if (s.river) subBits.push(s.river);
  if (s.station_type) subBits.push(s.station_type);
  set('sd-sub', subBits.length ? subBits.join(' · ') : 'Water Level');

  const pill = document.getElementById('sd-status');
  if (pill) {
    pill.textContent = (s.status || 'na').toUpperCase();
    pill.className = `sd-status-pill mrc-pill-${s.status || 'na'}`;
  }

  set('sd-level', fmt(s.latest_value));
  set('sd-alarm', fmt(s.alarm_level));
  set('sd-flood', fmt(s.flood_level));
  set('sd-msl',   fmt(s.msl_zero_gauge, 'm MSL'));
  set('sd-lowlying', s.low_lying_level == null ? 'N/A' : fmt(s.low_lying_level));

  const hrEl = document.getElementById('sd-headroom');
  if (hrEl) {
    if (Number.isFinite(Number(s.latest_value)) && Number.isFinite(Number(s.alarm_level))) {
      const hr = Number(s.alarm_level) - Number(s.latest_value);
      hrEl.textContent = `${hr >= 0 ? '+' : ''}${hr.toFixed(2)} m`;
    } else {
      hrEl.textContent = 'n/a';
    }
  }

  const rf = s.rainfall || {};
  const rfmt = v => Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)} mm` : '—';
  set('sd-rain-1h',   rfmt(rf.h1));
  set('sd-rain-6h',   rfmt(rf.h6));
  set('sd-rain-12h',  rfmt(rf.h12));
  set('sd-rain-24h',  rfmt(rf.h24));
  set('sd-rain-7to7', rfmt(rf.h7_to_7));

  const ts = s.latest_ts_iso ? new Date(s.latest_ts_iso) : null;
  set('sd-updated', ts ? ts.toLocaleString() : '—');

  const link = document.getElementById('sd-mrc-link');
  if (link) link.href = 'https://portal.mrcmekong.org/monitoring/river-monitoring-telemetry';
}

let STATION_CHART = null;
function renderStationChart(s, ts) {
  const wrap = document.getElementById('stationChartWrap');
  wrap.innerHTML = '<canvas id="stationChart"></canvas>';
  const canvas = document.getElementById('stationChart');

  const measurements = (ts.measurements || []).slice().reverse();
  const waterPoints = measurements.filter(m => m.w != null).map(m => ({ x: m.d, y: m.w }));
  const rainPoints  = measurements.filter(m => m.r != null).map(m => ({ x: m.d, y: m.r }));
  const hasRain = rainPoints.some(p => p.y > 0);

  const datasets = [{
    label: 'Water level (m)', data: waterPoints,
    borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.18)',
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.25, yAxisID: 'y',
  }];

  if (Number.isFinite(Number(s.alarm_level)) && waterPoints.length) {
    const xMin = waterPoints[0].x, xMax = waterPoints[waterPoints.length - 1].x;
    datasets.push({
      label: `Alarm (${Number(s.alarm_level).toFixed(2)} m)`,
      data: [{x:xMin, y:Number(s.alarm_level)}, {x:xMax, y:Number(s.alarm_level)}],
      borderColor: '#fbbf24', borderDash: [6,4], borderWidth: 1.5, pointRadius: 0, fill: false, yAxisID: 'y',
    });
  }
  if (Number.isFinite(Number(s.flood_level)) && waterPoints.length) {
    const xMin = waterPoints[0].x, xMax = waterPoints[waterPoints.length - 1].x;
    datasets.push({
      label: `Flood (${Number(s.flood_level).toFixed(2)} m)`,
      data: [{x:xMin, y:Number(s.flood_level)}, {x:xMax, y:Number(s.flood_level)}],
      borderColor: '#ef4444', borderDash: [6,4], borderWidth: 1.5, pointRadius: 0, fill: false, yAxisID: 'y',
    });
  }
  if (hasRain) {
    datasets.push({
      type: 'bar', label: 'Rainfall (mm)', data: rainPoints,
      backgroundColor: 'rgba(167,139,250,0.55)', borderWidth: 0, yAxisID: 'y1', barThickness: 2,
    });
  }

  if (STATION_CHART) STATION_CHART.destroy();
  STATION_CHART = new Chart(canvas, {
    type: 'line', data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#d6dde9', font: { size: 11 } } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { type: 'time', time: { tooltipFormat: 'PPp', displayFormats: { hour: 'MMM d, HH:mm', day: 'MMM d' } },
             ticks: { color: '#93a1b8' }, grid: { color: 'rgba(255,255,255,0.06)' } },
        y: { position: 'left', title: { display: true, text: 'Level (m)', color: '#d6dde9' },
             ticks: { color: '#93a1b8' }, grid: { color: 'rgba(255,255,255,0.06)' } },
        y1: hasRain ? { position: 'right', title: { display: true, text: 'Rain (mm)', color: '#a78bfa' },
                        ticks: { color: '#a78bfa' }, grid: { display: false }, beginAtZero: true }
                    : { display: false }
      }
    }
  });
}

/* ========================================================
 * Dam list (left panel)
 * ====================================================== */
function setupFilters() {
  document.querySelectorAll('.chip[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-filter]').forEach(b => b.classList.remove('chip-on'));
      btn.classList.add('chip-on');
      FILTER_MODE = btn.dataset.filter;
      renderDamList();
    });
  });
  document.getElementById('damSearch').addEventListener('input', e => {
    SEARCH_TERM = e.target.value.toLowerCase().trim();
    renderDamList();
  });
}

function filterDams() {
  let dams = [...CASCADE.dams];
  if (FILTER_MODE === 'reporting') {
    dams = dams.filter(d => d.reporting_status === 'current' || d.reporting_status === 'recent');
  } else if (FILTER_MODE === 'mainstream') {
    dams = dams.filter(d => (d.type || '').toLowerCase().includes('mainstream'));
  }
  if (SEARCH_TERM) {
    dams = dams.filter(d =>
      d.code.toLowerCase().includes(SEARCH_TERM) ||
      (d.name_en || '').toLowerCase().includes(SEARCH_TERM) ||
      (d.river || '').toLowerCase().includes(SEARCH_TERM)
    );
  }
  const order = { current: 0, recent: 1, stale: 2, old: 3, no_readings: 4 };
  dams.sort((a,b) => {
    const oa = order[a.reporting_status] ?? 9;
    const ob = order[b.reporting_status] ?? 9;
    if (oa !== ob) return oa - ob;
    return (b.capacity_mw || 0) - (a.capacity_mw || 0);
  });
  return dams;
}

function renderDamList() {
  const list = document.getElementById('damList');
  const dams = filterDams();
  if (!dams.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:13px;padding:12px;text-align:center">No matches.</div>`;
    return;
  }
  list.innerHTML = dams.map(d => {
    const active = d.code === ACTIVE_CODE ? 'active' : '';
    const cap = d.capacity_mw ? `${Number(d.capacity_mw).toLocaleString()} MW` : '—';
    const s = computeStorage(d);
    return `<div class="dam-row ${active}" data-code="${d.code}" style="border-left:3px solid ${STORAGE_COLOR[s.status]}">
      <div class="dr-name">${d.name_en}</div>
      <div class="dr-sub">${d.code} · ${d.river || '—'} · ${cap}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.dam-row').forEach(row => {
    row.addEventListener('click', () => selectDam(row.dataset.code, { fly: true }));
  });
}

/* ========================================================
 * Dam selection
 * ====================================================== */
function selectDam(code, opts = {}) {
  const d = CASCADE.dams.find(x => x.code === code);
  if (!d) return;
  ACTIVE_CODE = code;
  setActiveDamFilter(code);

  const flyLat = d.lat != null ? d.lat : (Array.isArray(d.subdams) && d.subdams[0] ? d.subdams[0].lat : null);
  const flyLon = d.lon != null ? d.lon : (Array.isArray(d.subdams) && d.subdams[0] ? d.subdams[0].lon : null);
  if (opts.fly && flyLat != null && flyLon != null && MAP) {
    MAP.flyTo({ center: [flyLon, flyLat], zoom: 8.5, duration: 900 });
  }

  // Show dam header, hide station detail
  document.getElementById('damHeader').style.display = '';
  document.getElementById('stationDetail').style.display = 'none';

  document.getElementById('dh-code').textContent = d.code;
  document.getElementById('dh-river').textContent = d.river || 'Lao PDR';
  document.getElementById('dh-name').textContent = d.name_en;
  document.getElementById('dh-sub').textContent =
    d.reporting_status === 'no_readings'
      ? `No operator readings on record. Source tab: ${d.source_sheet_tab}`
      : `${FRESHNESS_LABEL[d.reporting_status]} · ${d.rows_with_readings} readings on record · last on ${d.last_date}`;

  setText('kpi-capacity', d.capacity_mw ? `${Number(d.capacity_mw).toLocaleString()} MW` : '—');
  setText('kpi-fsl', d.fsl_masl ? `${d.fsl_masl} m` : '—');
  setText('kpi-mol', d.mol_masl ? `${d.mol_masl} m` : '—');
  const latest = d.latest_reading;
  setText('kpi-latest', latest && latest.date ? latest.date : '—');

  const fd = document.getElementById('f-dam');
  if (fd) fd.value = code;

  renderDamList();
  renderCharts(d);
  computeScenario();
}

function setText(id, t) { const el = document.getElementById(id); if (el) el.textContent = t; }

/* ========================================================
 * Charts
 * ====================================================== */
function chartCommonOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15,28,51,0.95)', borderColor: 'rgba(255,255,255,0.14)',
        borderWidth: 1, titleColor: '#f1f5fb', bodyColor: '#d6dde9', padding: 10,
      }
    },
    scales: {
      x: { ticks: { color: '#6b7a93', maxRotation: 0, autoSkipPadding: 20, font: { size: 10, family: 'JetBrains Mono' } },
           grid: { color: 'rgba(255,255,255,0.04)' } },
      y: { ticks: { color: '#93a1b8', font: { size: 10, family: 'JetBrains Mono' } },
           grid: { color: 'rgba(255,255,255,0.06)' } }
    }
  };
}
function chartBaseConfig(label, color, valueKey, history) {
  return {
    type: 'line',
    data: { labels: history.map(h => h.date),
      datasets: [{ label, data: history.map(h => h[valueKey]),
        borderColor: color, backgroundColor: color + '22',
        borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 4, fill: true, spanGaps: true, tension: 0.25,
      }] },
    options: chartCommonOptions(),
  };
}

function renderCharts(d) {
  Object.values(CHARTS).forEach(c => c.destroy());
  CHARTS = {};
  const history = (d.history || []).slice(-180);
  if (!history.length) {
    ['chart-level','chart-flow','chart-gen','chart-rain'].forEach(id => {
      const ctx = document.getElementById(id);
      if (ctx) {
        const cx = ctx.getContext('2d');
        cx.clearRect(0, 0, ctx.width, ctx.height);
        cx.fillStyle = '#6b7a93';
        cx.font = '13px Inter';
        cx.textAlign = 'center';
        cx.fillText('No data', ctx.width/2, ctx.height/2);
      }
    });
    return;
  }

  const lvlCfg = chartBaseConfig('Water level', '#60a5fa', 'level', history);
  if (d.fsl_masl || d.mol_masl) {
    const refDs = [];
    if (d.fsl_masl) refDs.push({ label: 'FSL', data: history.map(_ => d.fsl_masl), borderColor: '#ef4444', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: false });
    if (d.mol_masl) refDs.push({ label: 'MOL', data: history.map(_ => d.mol_masl), borderColor: '#a78bfa', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: false });
    lvlCfg.data.datasets.push(...refDs);
    lvlCfg.options.plugins.legend = { display: true, position: 'bottom', labels: { color: '#93a1b8', font: { size: 10 }, boxWidth: 14, padding: 8 } };
  }
  CHARTS.level = new Chart(document.getElementById('chart-level'), lvlCfg);

  CHARTS.flow = new Chart(document.getElementById('chart-flow'), {
    type: 'line',
    data: { labels: history.map(h => h.date),
      datasets: [
        { label: 'Inflow', data: history.map(h => h.inflow), borderColor: '#3ddbd9', backgroundColor: 'rgba(61,219,217,0.10)', borderWidth: 1.4, pointRadius: 0, fill: true, tension: 0.25, spanGaps: true },
        { label: 'Total release', data: history.map(h => h.release), borderColor: '#fbbf24', backgroundColor: 'rgba(251,191,36,0.08)', borderWidth: 1.4, pointRadius: 0, fill: false, tension: 0.25, spanGaps: true },
      ] },
    options: (() => {
      const o = chartCommonOptions();
      o.plugins.legend = { display: true, position: 'bottom', labels: { color: '#93a1b8', font: { size: 10 }, boxWidth: 14, padding: 8 } };
      return o;
    })()
  });

  CHARTS.gen = new Chart(document.getElementById('chart-gen'), chartBaseConfig('Generation', '#a78bfa', 'generation', history));
  CHARTS.rain = new Chart(document.getElementById('chart-rain'), {
    type: 'bar',
    data: { labels: history.map(h => h.date),
      datasets: [{ label: 'Rainfall', data: history.map(h => h.rainfall), backgroundColor: '#60a5fa', borderWidth: 0 }] },
    options: chartCommonOptions()
  });
}

/* ========================================================
 * Scenario sliders
 * ====================================================== */
function setupSliders() {
  ['sl-rain', 'sl-upstream', 'sl-turbine'].forEach(id => {
    const sl = document.getElementById(id);
    sl.addEventListener('input', () => { updateSliderLabels(); computeScenario(); });
  });
  document.getElementById('btnResetScenario').addEventListener('click', () => {
    ['sl-rain', 'sl-upstream', 'sl-turbine'].forEach(id => document.getElementById(id).value = 0);
    updateSliderLabels(); computeScenario();
  });
  updateSliderLabels();
}

function updateSliderLabels() {
  document.getElementById('lbl-rain').textContent     = signed(document.getElementById('sl-rain').value)     + '%';
  document.getElementById('lbl-upstream').textContent = signed(document.getElementById('sl-upstream').value) + '%';
  document.getElementById('lbl-turbine').textContent  = signed(document.getElementById('sl-turbine').value)  + '%';
}
function signed(v) { const n = Number(v); return (n >= 0 ? '+' : '') + n; }

function avg(arr) {
  const xs = arr.filter(x => x != null && !isNaN(x));
  if (!xs.length) return null;
  return xs.reduce((a,b) => a + Number(b), 0) / xs.length;
}

function computeScenario() {
  const d = CASCADE && CASCADE.dams.find(x => x.code === ACTIVE_CODE);
  if (!d) return;
  const recent = (d.history || []).slice(-14);
  const baseInflow  = avg(recent.map(r => r.inflow));
  const baseRelease = avg(recent.map(r => r.release));
  const baseLevel   = avg(recent.map(r => r.level));
  const baseRain    = avg(recent.map(r => r.rainfall));

  const rRain     = 1 + Number(document.getElementById('sl-rain').value) / 100;
  const rUpstream = 1 + Number(document.getElementById('sl-upstream').value) / 100;
  const rTurbine  = 1 + Number(document.getElementById('sl-turbine').value) / 100;

  const rainBoost = (baseRain || 0) * (rRain - 1) * 0.005;
  const projInflow  = baseInflow  != null ? baseInflow  * rUpstream * (1 + rainBoost) : null;
  const projRelease = baseRelease != null ? baseRelease * rTurbine : null;
  let netStorage = null;
  if (projInflow != null && projRelease != null) netStorage = (projInflow - projRelease) * 86400;

  setText('sr-inflow',  fmtCms(projInflow));
  setText('sr-release', fmtCms(projRelease));
  setText('sr-storage', fmtVol(netStorage));

  const flagEl = document.getElementById('sr-flag');
  let level = 'normal', label = 'Normal';
  if (netStorage != null && d.fsl_masl && baseLevel != null) {
    const headroom = d.fsl_masl - baseLevel;
    if (netStorage > 5_000_000 && headroom < 2)      { level = 'evacuate'; label = 'Evacuate — near FSL'; }
    else if (netStorage > 2_000_000 && headroom < 5) { level = 'warning';  label = 'Warning — rising'; }
    else if (netStorage > 1_000_000)                 { level = 'watch';    label = 'Watch — net filling'; }
  } else if (projInflow == null && projRelease == null) {
    label = 'No baseline data';
  }
  flagEl.className = `sf-${level}`;
  flagEl.textContent = label;
}

function fmtCms(v) { return (v == null || isNaN(v)) ? '—' : v.toFixed(1) + ' m³/s'; }
function fmtVol(v) {
  if (v == null || isNaN(v)) return '—';
  const mcm = v / 1_000_000;
  return (mcm >= 0 ? '+' : '') + mcm.toFixed(2) + ' MCM/day';
}

/* ========================================================
 * Freshness grid
 * ====================================================== */
function renderFreshnessGrid() {
  const counts = { current: 0, recent: 0, stale: 0, old: 0, no_readings: 0 };
  CASCADE.dams.forEach(d => { counts[d.reporting_status] = (counts[d.reporting_status]||0) + 1; });
  const order = [
    ['current', 'Today'], ['recent', 'This week'], ['stale', 'This month'],
    ['old', 'Older'], ['no_readings', 'No readings'],
  ];
  const grid = document.getElementById('freshGrid');
  grid.innerHTML = order.map(([k, label]) => `
    <div class="fresh-cell" style="border-left: 3px solid ${FRESH_COLOR[k]};padding:6px 10px;background:rgba(255,255,255,0.02);border-radius:6px">
      <strong style="display:block;font-size:18px;color:var(--text-hi);font-variant-numeric:tabular-nums">${counts[k] || 0}</strong>
      <span style="font-size:10px;color:var(--text-mid);letter-spacing:0.6px;text-transform:uppercase">${label}</span>
    </div>
  `).join('');
}

/* ========================================================
 * Submission form + Upload (unchanged from v1)
 * ====================================================== */
function populateDamSelect() {
  const sel = document.getElementById('f-dam');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select dam —</option>' +
    CASCADE.dams.slice().sort((a,b) => a.name_en.localeCompare(b.name_en))
      .map(d => `<option value="${d.code}">${d.name_en} (${d.code})</option>`).join('');
  const today = new Date().toISOString().slice(0, 10);
  const fd = document.getElementById('f-date');
  if (fd && !fd.value) fd.value = today;
}

function setupFormSubmit() {
  const form = document.getElementById('formObservation');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('formMsg');
    msg.className = 'form-msg'; msg.textContent = 'Validating…';
    const payload = {
      dam_code: document.getElementById('f-dam').value,
      date: document.getElementById('f-date').value,
      water_level_masl: numOrNull('f-level'),
      inflow_cms: numOrNull('f-inflow'),
      total_release_cms: numOrNull('f-release'),
      generation_mw: numOrNull('f-gen'),
      rainfall_mm: numOrNull('f-rain'),
      notes: document.getElementById('f-notes').value || '',
    };
    if (!payload.dam_code) { msg.textContent = 'Select a dam.'; return; }
    if (!payload.date)     { msg.textContent = 'Date required.'; return; }
    try {
      const res = await fetch('/api/observations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      msg.textContent = 'Submitted to clean dataset.'; form.reset(); populateDamSelect();
    } catch (err) {
      stageLocal(payload);
      msg.textContent = `Staged locally (${err.message}). Backend not yet deployed.`;
    }
  });
}
function numOrNull(id) { const v = document.getElementById(id).value; return v === '' ? null : Number(v); }
function stageLocal(payload) {
  const key = 'hp_staged_observations';
  const buf = JSON.parse(localStorage.getItem(key) || '[]');
  buf.push({ ...payload, staged_at_utc: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(buf));
}

function setupUpload() {
  const zone = document.getElementById('uploadZone');
  const input = document.getElementById('fileInput');
  const pick = document.getElementById('btnPick');
  const ingest = document.getElementById('btnIngest');
  const discard = document.getElementById('btnDiscard');
  function pickFile(e) { if (e) e.stopPropagation(); input.click(); }
  pick.addEventListener('click', pickFile);
  zone.addEventListener('click', pickFile);
  input.addEventListener('change', () => { if (input.files && input.files[0]) handleFile(input.files[0]); });
  ['dragenter','dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  ingest.addEventListener('click', async () => {
    const uMsg = document.getElementById('uploadMsg');
    if (!PENDING_UPLOAD || !PENDING_UPLOAD.rows.length) { uMsg.textContent = 'Nothing to ingest.'; return; }
    uMsg.textContent = `Sending ${PENDING_UPLOAD.rows.length} rows…`;
    try {
      const res = await fetch('/api/observations/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: PENDING_UPLOAD.rows }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      uMsg.textContent = `Ingested ${PENDING_UPLOAD.rows.length} rows.`; resetUpload();
    } catch (err) {
      const key = 'hp_staged_observations';
      const buf = JSON.parse(localStorage.getItem(key) || '[]');
      buf.push(...PENDING_UPLOAD.rows.map(r => ({ ...r, staged_at_utc: new Date().toISOString() })));
      localStorage.setItem(key, JSON.stringify(buf));
      uMsg.textContent = `Staged ${PENDING_UPLOAD.rows.length} rows locally (${err.message}).`; resetUpload();
    }
  });
  discard.addEventListener('click', resetUpload);
}
function resetUpload() {
  PENDING_UPLOAD = null;
  document.getElementById('uploadPreview').hidden = true;
  document.getElementById('fileInput').value = '';
}
async function handleFile(file) {
  const uMsg = document.getElementById('uploadMsg');
  uMsg.textContent = `Parsing ${file.name}…`;
  let rows = [];
  try {
    if (/\.csv$/i.test(file.name)) {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      rows = parsed.data;
    } else if (/\.xlsx?$/i.test(file.name)) {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } else { throw new Error('Unsupported file type. Use .csv or .xlsx.'); }
  } catch (err) { uMsg.textContent = `Parse failed: ${err.message}`; return; }
  const mapped = rows.map(mapRow).filter(r => r.dam_code && r.date);
  if (!mapped.length) { uMsg.textContent = `Parsed ${rows.length} rows but none had a recognisable dam_code + date.`; return; }
  PENDING_UPLOAD = { rows: mapped, original_count: rows.length };
  uMsg.textContent = ''; showPreview(mapped, rows.length);
}
const FIELD_ALIASES = {
  dam_code: ['dam_code','dam','code','damcode','project','dam_id'],
  date:     ['date','observation_date','reading_date','day','timestamp'],
  water_level_masl: ['water_level_masl','water_level','level','reservoir_level','headwater','headwater_level','wl_masl'],
  storage_mcm:      ['storage_mcm','storage','reservoir_volume'],
  inflow_cms:       ['inflow_cms','inflow','q_in','inflow_m3s'],
  generation_mw:    ['generation_mw','generation','power_mw','mw'],
  spillway_discharge_cms: ['spillway_discharge_cms','spillway','spillway_cms','q_spill'],
  turbine_discharge_cms:  ['turbine_discharge_cms','turbine','turbine_cms','q_turb'],
  total_release_cms:      ['total_release_cms','release','total_release','q_out','outflow'],
  downstream_level_masl:  ['downstream_level_masl','downstream_level','tailwater','tailwater_level'],
  rainfall_mm:            ['rainfall_mm','rainfall','rain','precipitation_mm','precip'],
};
function mapRow(raw) {
  const norm = {};
  for (const k of Object.keys(raw)) norm[k.toLowerCase().trim().replace(/[\s\-]+/g,'_')] = raw[k];
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const a of aliases) {
      if (norm[a] !== undefined && norm[a] !== '') {
        out[field] = (field === 'dam_code' || field === 'date') ? String(norm[a]).trim() : Number(norm[a]);
        break;
      }
    }
  }
  if (out.date) { const d = parseAnyDate(out.date); if (d) out.date = d; }
  return out;
}
function parseAnyDate(s) {
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) { const [dd, mm, yyyy] = s.split('/').map(Number); return `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  const n = Number(s);
  if (!isNaN(n) && n > 30000 && n < 60000) { const epoch = new Date(Date.UTC(1899, 11, 30)); const d = new Date(epoch.getTime() + n * 86400 * 1000); return d.toISOString().slice(0,10); }
  return null;
}
function showPreview(rows, originalCount) {
  const wrap = document.getElementById('uploadPreview');
  wrap.hidden = false;
  document.getElementById('previewCount').textContent = `· ${rows.length} valid of ${originalCount} parsed`;
  const cols = ['dam_code','date','water_level_masl','inflow_cms','total_release_cms','generation_mw','rainfall_mm'];
  const head = `<thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
  const body = '<tbody>' + rows.slice(0, 30).map(r => `<tr>${cols.map(c => `<td>${fmtCell(r[c])}</td>`).join('')}</tr>`).join('') + '</tbody>';
  document.getElementById('previewTable').innerHTML = head + body;
}
function fmtCell(v) {
  if (v == null || v === '') return '<span style="color:#6b7a93">—</span>';
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(v);
}

/* ============================================================
   FLASH FLOOD FORECAST — MRC FFGS (added Phase 6)
   API: http://ffp.mrcmekong.org:8000  (CORS: *)
   ============================================================ */
const FFGS = {
  // Use the Vercel proxy because the upstream is HTTP-only (mixed-content blocked over HTTPS)
  proxy: '/api/ffgs',
  endpoints: {
    '1h':  '/get-alert-stat-1hrs/',
    '3h':  '/get-alert-stat-3hrs/',
    '6h':  '/get-alert-stat-6hrs/',
    '12h': '/get-risk-stat-12hrs/',
    '24h': '/get-risk-stat-24hrs/',
  },
  horizons: ['1h', '3h', '6h', '12h', '24h'],
  levelRank: { 'Low': 0, 'Moderate': 1, 'High': 2, 'Extreme': 3 },
  rankLevel: ['Low', 'Moderate', 'High', 'Extreme'],
  colors: {
    'Low':      'rgba(110, 230, 180, 0)',
    'Moderate': 'rgba(245, 180,  60, 0.65)',
    'High':     'rgba(239,  68,  68, 0.80)',
    'Extreme':  'rgba(217,  70, 239, 0.90)'
  },
  cacheMs: 30 * 60 * 1000,
  state: { data: null, ts: 0, geo: null, horizon: '24h', visible: true, country: 'ALL', timer: null, joinedCount: 0 },
};

async function ffgsFetchLatest() {
  // FFGS returns date list as e.g. [["2026-06-02"],["2026-06-01"],...] (newest first, sometimes double-encoded).
  let dates = await fetch(`${FFGS.proxy}?path=${encodeURIComponent('/get-datelist/')}`).then(r => r.json());
  if (typeof dates === 'string') dates = JSON.parse(dates);
  // Flatten + normalize to array of strings
  const flat = (Array.isArray(dates) ? dates : []).map(x => Array.isArray(x) ? x[0] : x).filter(Boolean);
  // Newest is the lexically-largest date (works because format is YYYY-MM-DD)
  flat.sort();
  const date = flat[flat.length - 1];

  let hours = await fetch(`${FFGS.proxy}?path=${encodeURIComponent('/get-hourlist')}&date=${date}`).then(r => r.json());
  if (typeof hours === 'string') hours = JSON.parse(hours);
  const hflat = (Array.isArray(hours) ? hours : []).map(x => Array.isArray(x) ? x[0] : x).filter(v => v !== undefined && v !== null);
  // Numeric sort
  hflat.sort((a, b) => Number(a) - Number(b));
  const hrs = String(hflat[hflat.length - 1]).padStart(2, '0');
  return { date, hrs };
}
async function ffgsFetchHorizon(url, date, hrs) {
  const res = await fetch(`${FFGS.proxy}?path=${encodeURIComponent(url)}&date=${date}&hrs=${hrs}`);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  let d = await res.json();
  if (typeof d === 'string') d = JSON.parse(d);
  return Array.isArray(d) ? d : [];
}
function ffgsKey(iso, n1, n2) {
  return `${iso}|${String(n1).trim().toLowerCase()}|${String(n2).trim().toLowerCase()}`;
}
function ffgsMerge(byHorizon) {
  const merged = {};
  for (const h of FFGS.horizons) {
    for (const r of byHorizon[h] || []) {
      const k = ffgsKey(r.ISO, r.NAME_1, r.NAME_2);
      if (!merged[k]) merged[k] = { iso: r.ISO, province: r.NAME_1, district: r.NAME_2, horizons: {} };
      merged[k].horizons[h] = {
        level: r.Level || 'Low',
        ffg: r.FFG01 ?? r.FFG03 ?? r.FFG06 ?? null,
        ffft: r.FFFT06 ?? null,
        ffr: r.FFR12 ?? r.FFR24 ?? null,
      };
    }
  }
  for (const k in merged) {
    let maxR = 0;
    for (const h of FFGS.horizons) {
      const lv = merged[k].horizons[h]?.level;
      if (lv && FFGS.levelRank[lv] > maxR) maxR = FFGS.levelRank[lv];
    }
    merged[k].maxLevel = FFGS.rankLevel[maxR];
  }
  return merged;
}
async function ffgsLoad(force) {
  const now = Date.now();
  if (!force && FFGS.state.data && (now - FFGS.state.ts) < FFGS.cacheMs) return FFGS.state.data;
  try {
    const { date, hrs } = await ffgsFetchLatest();
    const byHorizon = {};
    await Promise.all(FFGS.horizons.map(async h => {
      try { byHorizon[h] = await ffgsFetchHorizon(FFGS.endpoints[h], date, hrs); }
      catch (e) { console.warn('[ffgs]', h, e.message); byHorizon[h] = []; }
    }));
    FFGS.state.data = { meta: { date, hrs }, byHorizon, merged: ffgsMerge(byHorizon) };
    FFGS.state.ts = now;
    return FFGS.state.data;
  } catch (e) { console.error('[ffgs] load failed', e); return null; }
}
function ffgsMatchFeature(feature, merged) {
  const p = feature.properties || {};
  const iso = p.ISO, prov = String(p.Province || '').trim().toLowerCase(), dist = String(p.District || '').trim().toLowerCase();
  if (!iso || !prov || !dist) return null;
  const exact = merged[`${iso}|${prov}|${dist}`];
  if (exact) return exact;
  // Truncated bulletin names — try prefix + substring
  const provPrefix = `${iso}|${prov}|`;
  for (const k in merged) {
    if (!k.startsWith(provPrefix)) continue;
    const fd = k.split('|')[2];
    if (dist.startsWith(fd) || fd.startsWith(dist.slice(0, 9))) return merged[k];
  }
  for (const k in merged) {
    if (!k.startsWith(provPrefix)) continue;
    const fd = k.split('|')[2];
    if (dist.includes(fd) || fd.includes(dist.slice(0, 6))) return merged[k];
  }
  return null;
}

async function ffgsAddLayer() {
  if (!MAP) return;
  // Fetch geo + bulletin in parallel
  const [geo, data] = await Promise.all([
    FFGS.state.geo ? Promise.resolve(FFGS.state.geo) :
      fetch('../data/geo/adm2_mekong.geojson').then(r => r.json()),
    ffgsLoad()
  ]);
  FFGS.state.geo = geo;
  if (!data) return;

  // Join: attach FFGS level per horizon to each feature
  let joined = 0;
  for (const f of geo.features) {
    const m = ffgsMatchFeature(f, data.merged);
    if (m) {
      joined++;
      f.properties._ffgs = {};
      for (const h of FFGS.horizons) {
        const lv = m.horizons[h]?.level || 'Low';
        f.properties._ffgs[h] = lv;
        // Also flatten as scalar so it survives MapLibre's queryRenderedFeatures
        // (nested objects get stripped on the rendered side).
        f.properties[`_ffgs_${h}`] = lv;
      }
      f.properties._ffgs_max = m.maxLevel;
      f.properties._ffgs_iso = m.iso;
      f.properties._ffgs_prov = m.province;
      f.properties._ffgs_dist = m.district;
    } else {
      f.properties._ffgs = null;
      f.properties._ffgs_max = 'Low';
      for (const h of FFGS.horizons) f.properties[`_ffgs_${h}`] = 'Low';
    }
  }
  FFGS.state.joinedCount = joined;
  console.log(`[ffgs] joined ${joined}/${geo.features.length} districts to bulletin (date ${data.meta.date} hr ${data.meta.hrs})`);

  // Remove old layers if present
  if (MAP.getLayer('ffgs-fill')) MAP.removeLayer('ffgs-fill');
  if (MAP.getLayer('ffgs-outline')) MAP.removeLayer('ffgs-outline');
  if (MAP.getSource('ffgs-src')) MAP.removeSource('ffgs-src');

  MAP.addSource('ffgs-src', { type: 'geojson', data: geo });

  const horizonProp = `_ffgs_${FFGS.state.horizon}`;
  // Flatten level property for current horizon (data-driven fill needs scalar)
  for (const f of geo.features) {
    f.properties[horizonProp] = f.properties._ffgs ? f.properties._ffgs[FFGS.state.horizon] : 'Low';
  }
  MAP.getSource('ffgs-src').setData(geo);

  MAP.addLayer({
    id: 'ffgs-fill',
    type: 'fill',
    source: 'ffgs-src',
    paint: {
      'fill-color': [
        'match', ['get', horizonProp],
        'Extreme',  FFGS.colors.Extreme,
        'High',     FFGS.colors.High,
        'Moderate', FFGS.colors.Moderate,
        'rgba(0,0,0,0)'
      ],
      'fill-opacity': FFGS.state.visible ? 1 : 0,
    }
  }, MAP.getLayer('river-mekong-glow') ? 'river-mekong-glow' : undefined);

  MAP.addLayer({
    id: 'ffgs-outline',
    type: 'line',
    source: 'ffgs-src',
    paint: {
      'line-color': [
        'match', ['get', horizonProp],
        'Extreme',  '#d946ef',
        'High',     '#ef4444',
        'Moderate', '#f59e0b',
        'rgba(0,0,0,0)'
      ],
      'line-width': 1.4,
      'line-opacity': FFGS.state.visible ? 1.0 : 0,
    }
  }, MAP.getLayer('river-mekong-glow') ? 'river-mekong-glow' : undefined);

  // Click → popup
  MAP.on('click', 'ffgs-fill', (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const p = f.properties;
    // Read flat horizon keys (nested _ffgs object is stripped by queryRenderedFeatures).
    // Fallback to nested if it survived (e.g. raw source feature).
    let ffgs = null;
    if (p._ffgs) {
      ffgs = typeof p._ffgs === 'string' ? (() => { try { return JSON.parse(p._ffgs); } catch { return null; } })() : p._ffgs;
    }
    if (!ffgs) {
      ffgs = {};
      for (const h of FFGS.horizons) ffgs[h] = p[`_ffgs_${h}`] || 'Low';
    }
    const maxLevel = p._ffgs_max || 'Low';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const lvColor = (lv) => lv === 'Extreme' ? '#d946ef' : lv === 'High' ? '#ef4444' : lv === 'Moderate' ? '#f59e0b' : '#3a4860';

    const rows = FFGS.horizons.map(h => {
      const lv = ffgs[h] || 'Low';
      return `<tr><td>${esc(h)}</td><td><span class="ffgs-dot" style="background:${lvColor(lv)}"></span>${esc(lv)}</td></tr>`;
    }).join('');

    // Impact guidance by severity
    const impactByLevel = {
      'Extreme':  'Severe flash-flood risk imminent. Evacuate low-lying areas, avoid stream crossings, monitor district alerts.',
      'High':     'Significant flash-flood risk. Prepare to move to higher ground, secure property, avoid travel on flood-prone roads.',
      'Moderate': 'Elevated flash-flood risk. Stay alert, monitor rainfall, prepare emergency kit, avoid unnecessary travel.',
      'Low':      'No significant flash-flood risk currently. Routine monitoring; conditions can change with new rainfall.',
    };
    const impactText = impactByLevel[maxLevel] || impactByLevel['Low'];

    const dist = esc(p._ffgs_dist || p.District || 'District');
    const prov = esc(p._ffgs_prov || p.Province || '');
    const country = esc(p.Country || '');

    new maplibregl.Popup({ closeButton: true, maxWidth: '320px', className: 'ffgs-popup' })
      .setLngLat(e.lngLat)
      .setHTML(`
        <div class="ffgs-pop">
          <div class="ffgs-pop-head" style="border-left:4px solid ${lvColor(maxLevel)};padding-left:8px">
            <strong>${dist}</strong>
            <span>${prov}${prov && country ? ', ' : ''}${country}</span>
            <div style="margin-top:4px;font-size:11px;color:${lvColor(maxLevel)};font-weight:600;text-transform:uppercase;letter-spacing:0.5px">
              Flash-flood max: ${esc(maxLevel)}
            </div>
          </div>
          <div class="ffgs-pop-impact" style="font-size:12px;line-height:1.4;color:#cbd5e1;margin:8px 0;padding:6px 8px;background:rgba(148,163,184,0.08);border-radius:4px">
            ${esc(impactText)}
          </div>
          <table class="ffgs-pop-tbl">
            <thead><tr><th>Horizon</th><th>Risk level</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="font-size:10px;color:#64748b;margin-top:6px;text-align:right">Source: FFGS / Mekong River Commission</div>
        </div>
      `)
      .addTo(MAP);
  });
  MAP.on('mouseenter', 'ffgs-fill', () => { MAP.getCanvas().style.cursor = 'pointer'; });
  MAP.on('mouseleave', 'ffgs-fill', () => { MAP.getCanvas().style.cursor = ''; });
}

function ffgsSetHorizon(h) {
  if (!FFGS.horizons.includes(h)) return;
  FFGS.state.horizon = h;
  if (!MAP || !FFGS.state.geo) return;
  const horizonProp = `_ffgs_${h}`;
  for (const f of FFGS.state.geo.features) {
    f.properties[horizonProp] = f.properties._ffgs ? f.properties._ffgs[h] : 'Low';
  }
  const src = MAP.getSource('ffgs-src');
  if (src) src.setData(FFGS.state.geo);
  if (MAP.getLayer('ffgs-fill')) {
    MAP.setPaintProperty('ffgs-fill', 'fill-color', [
      'match', ['get', horizonProp],
      'Extreme',  FFGS.colors.Extreme,
      'High',     FFGS.colors.High,
      'Moderate', FFGS.colors.Moderate,
      'rgba(0,0,0,0)'
    ]);
  }
  if (MAP.getLayer('ffgs-outline')) {
    MAP.setPaintProperty('ffgs-outline', 'line-color', [
      'match', ['get', horizonProp],
      'Extreme',  '#d946ef',
      'High',     '#ef4444',
      'Moderate', '#f59e0b',
      'rgba(0,0,0,0)'
    ]);
  }
  ffgsRenderPanel();
}

function ffgsSetVisible(on) {
  FFGS.state.visible = !!on;
  if (!MAP) return;
  if (MAP.getLayer('ffgs-fill'))    MAP.setPaintProperty('ffgs-fill', 'fill-opacity', on ? 1 : 0);
  if (MAP.getLayer('ffgs-outline')) MAP.setPaintProperty('ffgs-outline', 'line-opacity', on ? 1.0 : 0);
}

function ffgsRenderPanel() {
  const data = FFGS.state.data;
  if (!data) return;
  const horizon = FFGS.state.horizon;
  const country = FFGS.state.country;
  const stamp = document.getElementById('ffgsStamp');
  if (stamp) stamp.textContent = `${data.meta.date} · ${data.meta.hrs}h UTC`;

  // Build list of elevated districts for the selected horizon
  const rows = [];
  for (const k in data.merged) {
    const m = data.merged[k];
    const h = m.horizons[horizon];
    if (!h || h.level === 'Low') continue;
    if (country !== 'ALL' && m.iso !== country) continue;
    rows.push({ ...m, ...h });
  }
  rows.sort((a, b) => {
    const r = FFGS.levelRank[b.level] - FFGS.levelRank[a.level];
    if (r) return r;
    return (b.ffr ?? b.ffg ?? 0) - (a.ffr ?? a.ffg ?? 0);
  });

  const counts = { Moderate: 0, High: 0, Extreme: 0 };
  rows.forEach(r => { if (counts[r.level] != null) counts[r.level]++; });
  const summary = document.getElementById('ffgsSummary');
  if (summary) {
    summary.innerHTML = `
      <span class="ffgs-pill ffgs-pill-mod">${counts.Moderate} Mod</span>
      <span class="ffgs-pill ffgs-pill-high">${counts.High} High</span>
      <span class="ffgs-pill ffgs-pill-ext">${counts.Extreme} Extreme</span>
    `;
  }

  const tbody = document.getElementById('ffgsTbody');
  if (tbody) {
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="ffgs-empty">No elevated districts at this horizon.</td></tr>`;
    } else {
      tbody.innerHTML = rows.slice(0, 80).map(r => {
        const cls = `ffgs-lv ffgs-lv-${r.level.toLowerCase()}`;
        const val = (horizon === '12h' || horizon === '24h')
          ? (r.ffr != null ? `${(r.ffr * 100).toFixed(0)}%` : '—')
          : (r.ffg != null ? `${r.ffg.toFixed(0)}mm` : '—');
        return `<tr>
          <td><strong>${r.district}</strong><br><span class="ffgs-sub">${r.province}</span></td>
          <td>${r.iso}</td>
          <td><span class="${cls}">${r.level}</span></td>
          <td>${val}</td>
        </tr>`;
      }).join('');
    }
  }
}

function ffgsSetCountry(iso) {
  FFGS.state.country = iso;
  document.querySelectorAll('.ffgs-country-tab').forEach(b => {
    b.classList.toggle('on', b.dataset.iso === iso);
  });
  ffgsRenderPanel();
}

async function ffgsInit() {
  // Build the panel UI on first run
  const panel = document.getElementById('ffgsPanel');
  if (panel && !panel.dataset.ready) {
    panel.dataset.ready = '1';
    // Horizon buttons
    panel.querySelectorAll('.ffgs-horizon-btn').forEach(b => {
      b.addEventListener('click', () => {
        panel.querySelectorAll('.ffgs-horizon-btn').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        ffgsSetHorizon(b.dataset.h);
      });
    });
    // Country tabs
    panel.querySelectorAll('.ffgs-country-tab').forEach(b => {
      b.addEventListener('click', () => ffgsSetCountry(b.dataset.iso));
    });
    // Layer toggle
    const tog = document.getElementById('ffgsToggle');
    if (tog) tog.addEventListener('change', e => ffgsSetVisible(e.target.checked));
    // Refresh button
    const btn = document.getElementById('ffgsRefresh');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '...';
      FFGS.state.ts = 0;
      await ffgsAddLayer();
      ffgsRenderPanel();
      btn.disabled = false;
      btn.textContent = '↻';
    });
  }

  await ffgsAddLayer();
  ffgsRenderPanel();

  // Auto-refresh every 30 min
  if (FFGS.state.timer) clearInterval(FFGS.state.timer);
  FFGS.state.timer = setInterval(async () => {
    FFGS.state.ts = 0;
    await ffgsAddLayer();
    ffgsRenderPanel();
  }, FFGS.cacheMs);
}

/* ============================================================
   PHASE 3 — Province layer, master filters, time scrubber, export
   ============================================================ */
const P3 = {
  provincesGeo: null,
  damProvinces: {},      // code → { iso, country, province }
  stationProvinces: {},  // station_code → { iso, country, province }
  filters: { province: 'ALL', basin: 'ALL', hazard: 'ALL' },
  layerVisible: { provinces: false, ffgs: true, rivers: true, dams: true, stations: true },
  scrubber: { dates: [], selectedDate: null, selectedHour: null, isCustom: false },
  cache: {}, // (date|hrs) → ffgs data
};

// ---- Point-in-polygon ----------------------------------------------------
function pip(point, ring) {
  // point = [lon, lat], ring = [[lon,lat],...]
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}
function pipPolygon(point, polygon) {
  // polygon = [outer ring, ...holes]
  if (!polygon || !polygon.length || !pip(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pip(point, polygon[i])) return false; // inside a hole
  }
  return true;
}
function pipFeature(point, feature) {
  const g = feature.geometry;
  if (!g) return false;
  if (g.type === 'Polygon') return pipPolygon(point, g.coordinates);
  if (g.type === 'MultiPolygon') return g.coordinates.some(poly => pipPolygon(point, poly));
  return false;
}

async function loadProvinceGeo() {
  if (P3.provincesGeo) return P3.provincesGeo;
  try {
    P3.provincesGeo = await fetch('../data/geo/adm1_provinces.geojson').then(r => r.json());
    return P3.provincesGeo;
  } catch (e) {
    console.warn('[p3] province geo failed', e);
    return null;
  }
}

function bboxOf(feature) {
  // simple bbox cache to skip pip when point is clearly outside
  if (feature._bbox) return feature._bbox;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (ring) => ring.forEach(([x, y]) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  });
  const g = feature.geometry;
  if (g.type === 'Polygon') g.coordinates.forEach(visit);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(visit));
  feature._bbox = [minX, minY, maxX, maxY];
  return feature._bbox;
}

function locateProvince(lon, lat) {
  if (!P3.provincesGeo || lon == null || lat == null) return null;
  for (const f of P3.provincesGeo.features) {
    const [minX, minY, maxX, maxY] = bboxOf(f);
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    if (pipFeature([lon, lat], f)) {
      return { iso: f.properties.ISO, country: f.properties.Country, province: f.properties.Province };
    }
  }
  return null;
}

async function p3StampDams() {
  await loadProvinceGeo();
  if (!P3.provincesGeo || !CASCADE?.dams) return;
  for (const d of CASCADE.dams) {
    const lat = d.lat != null ? d.lat : (Array.isArray(d.subdams) && d.subdams[0] ? d.subdams[0].lat : null);
    const lon = d.lon != null ? d.lon : (Array.isArray(d.subdams) && d.subdams[0] ? d.subdams[0].lon : null);
    const loc = locateProvince(lon, lat);
    P3.damProvinces[d.code] = loc || { iso: '?', country: d.country || '?', province: '?' };
    d._province = P3.damProvinces[d.code].province;
    d._iso = P3.damProvinces[d.code].iso;
  }
  console.log(`[p3] stamped ${Object.keys(P3.damProvinces).length} dams with provinces`);
}

function p3StampStations() {
  if (!P3.provincesGeo || !MRC_STATIONS?.length) return;
  for (const s of MRC_STATIONS) {
    if (s._province) continue;
    const loc = locateProvince(s.lon, s.lat);
    s._province = loc?.province || '?';
    s._iso = loc?.iso || '?';
    P3.stationProvinces[s.station_code || s.code] = loc;
  }
}

// ---- Province layer ------------------------------------------------------
async function p3AddProvinceLayer() {
  if (!MAP || !P3.provincesGeo) return;
  if (MAP.getLayer('provinces-fill')) MAP.removeLayer('provinces-fill');
  if (MAP.getLayer('provinces-outline')) MAP.removeLayer('provinces-outline');
  if (MAP.getSource('provinces-src')) MAP.removeSource('provinces-src');
  MAP.addSource('provinces-src', { type: 'geojson', data: P3.provincesGeo });
  MAP.addLayer({
    id: 'provinces-fill',
    type: 'fill',
    source: 'provinces-src',
    paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0 }
  }, MAP.getLayer('ffgs-fill') ? 'ffgs-fill' : undefined);
  MAP.addLayer({
    id: 'provinces-outline',
    type: 'line',
    source: 'provinces-src',
    paint: {
      'line-color': '#60a5fa',
      'line-width': 0.6,
      'line-opacity': P3.layerVisible.provinces ? 0.45 : 0,
      'line-dasharray': [2, 2]
    }
  });
  MAP.on('click', 'provinces-fill', (e) => {
    if (!P3.layerVisible.provinces) return;
    const f = e.features?.[0];
    if (!f) return;
    p3SetProvince(f.properties.Province);
  });
}
function p3SetProvinceLayerVisible(on) {
  P3.layerVisible.provinces = !!on;
  if (!MAP) return;
  if (MAP.getLayer('provinces-outline')) MAP.setPaintProperty('provinces-outline', 'line-opacity', on ? 0.45 : 0);
}

// ---- Master filters ------------------------------------------------------
function p3GetBasins() {
  const set = new Set();
  (CASCADE?.dams || []).forEach(d => { if (d.river) set.add(d.river); });
  (MRC_STATIONS || []).forEach(s => { if (s.river_basin || s.river) set.add(s.river_basin || s.river); });
  return [...set].sort();
}
function p3GetProvinces() {
  const set = new Set();
  (CASCADE?.dams || []).forEach(d => { if (d._province && d._province !== '?') set.add(d._province); });
  if (P3.provincesGeo) P3.provincesGeo.features.forEach(f => set.add(f.properties.Province));
  return [...set].sort();
}

function p3PopulateFilters() {
  const provSel = document.getElementById('mfProvince');
  const basinSel = document.getElementById('mfBasin');
  if (provSel && !provSel.dataset.ready) {
    provSel.dataset.ready = '1';
    const opts = ['<option value="ALL">All provinces</option>']
      .concat(p3GetProvinces().map(p => `<option value="${p}">${p}</option>`));
    provSel.innerHTML = opts.join('');
    provSel.addEventListener('change', e => p3SetProvince(e.target.value));
  }
  if (basinSel && !basinSel.dataset.ready) {
    basinSel.dataset.ready = '1';
    const opts = ['<option value="ALL">All rivers / basins</option>']
      .concat(p3GetBasins().map(b => `<option value="${b}">${b}</option>`));
    basinSel.innerHTML = opts.join('');
    basinSel.addEventListener('change', e => p3SetBasin(e.target.value));
  }
  const hazSel = document.getElementById('mfHazard');
  if (hazSel && !hazSel.dataset.ready) {
    hazSel.dataset.ready = '1';
    hazSel.addEventListener('change', e => p3SetHazard(e.target.value));
  }
  const clearBtn = document.getElementById('mfClear');
  if (clearBtn && !clearBtn.dataset.ready) {
    clearBtn.dataset.ready = '1';
    clearBtn.addEventListener('click', () => p3ClearFilters());
  }
}
function p3SetProvince(prov) {
  P3.filters.province = prov;
  const sel = document.getElementById('mfProvince');
  if (sel) sel.value = prov;
  p3ApplyFilters();
}
function p3SetBasin(b) {
  P3.filters.basin = b;
  const sel = document.getElementById('mfBasin');
  if (sel) sel.value = b;
  p3ApplyFilters();
}
function p3SetHazard(h) {
  P3.filters.hazard = h;
  const sel = document.getElementById('mfHazard');
  if (sel) sel.value = h;
  p3ApplyFilters();
}
function p3ClearFilters() {
  P3.filters = { province: 'ALL', basin: 'ALL', hazard: 'ALL' };
  ['mfProvince','mfBasin','mfHazard'].forEach(id => { const el = document.getElementById(id); if (el) el.value = 'ALL'; });
  p3ApplyFilters();
}

function p3DamPassesMaster(d) {
  if (P3.filters.province !== 'ALL' && d._province !== P3.filters.province) return false;
  if (P3.filters.basin !== 'ALL' && d.river !== P3.filters.basin) return false;
  return true;
}
function p3StationPasses(s) {
  if (P3.filters.province !== 'ALL' && s._province !== P3.filters.province) return false;
  const basin = s.river_basin || s.river;
  if (P3.filters.basin !== 'ALL' && basin !== P3.filters.basin) return false;
  return true;
}

function p3ApplyFilters() {
  renderDamList();
  // Marker visibility
  for (const code in MARKERS) {
    const dam = CASCADE.dams.find(x => x.code === code);
    if (!dam) continue;
    const passes = p3DamPassesMaster(dam);
    const marker = MARKERS[code];
    if (marker && marker.getElement) {
      marker.getElement().style.display = passes ? '' : 'none';
    }
  }
  // MRC markers
  MRC_MARKERS.forEach((m, i) => {
    const s = MRC_STATIONS[i];
    if (!s || !m.getElement) return;
    m.getElement().style.display = p3StationPasses(s) ? '' : 'none';
  });
  // FFGS panel
  if (typeof ffgsRenderPanel === 'function') ffgsRenderPanel();
}

// ---- Patch ffgsRenderPanel to apply master filters ----------------------
const _origFfgsRender = typeof ffgsRenderPanel === 'function' ? ffgsRenderPanel : null;
window.ffgsRenderPanel = function() {
  const data = FFGS.state.data;
  if (!data) return;
  const horizon = FFGS.state.horizon;
  const country = FFGS.state.country;
  const stamp = document.getElementById('ffgsStamp');
  if (stamp) stamp.textContent = `${data.meta.date} · ${data.meta.hrs}h UTC`;

  const rows = [];
  for (const k in data.merged) {
    const m = data.merged[k];
    const h = m.horizons[horizon];
    if (!h || h.level === 'Low') continue;
    if (country !== 'ALL' && m.iso !== country) continue;
    if (P3.filters.province !== 'ALL' && m.province !== P3.filters.province) continue;
    if (P3.filters.hazard !== 'ALL' && h.level !== P3.filters.hazard) continue;
    rows.push({ ...m, ...h });
  }
  rows.sort((a, b) => {
    const r = FFGS.levelRank[b.level] - FFGS.levelRank[a.level];
    if (r) return r;
    return (b.ffr ?? b.ffg ?? 0) - (a.ffr ?? a.ffg ?? 0);
  });

  const counts = { Moderate: 0, High: 0, Extreme: 0 };
  rows.forEach(r => { if (counts[r.level] != null) counts[r.level]++; });
  const summary = document.getElementById('ffgsSummary');
  if (summary) {
    summary.innerHTML = `
      <span class="ffgs-pill ffgs-pill-mod">${counts.Moderate} Mod</span>
      <span class="ffgs-pill ffgs-pill-high">${counts.High} High</span>
      <span class="ffgs-pill ffgs-pill-ext">${counts.Extreme} Extreme</span>
    `;
  }
  const tbody = document.getElementById('ffgsTbody');
  if (tbody) {
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="ffgs-empty">No elevated districts match these filters.</td></tr>`;
    } else {
      tbody.innerHTML = rows.slice(0, 80).map(r => {
        const cls = `ffgs-lv ffgs-lv-${r.level.toLowerCase()}`;
        const val = (horizon === '12h' || horizon === '24h')
          ? (r.ffr != null ? `${(r.ffr * 100).toFixed(0)}%` : '—')
          : (r.ffg != null ? `${r.ffg.toFixed(0)}mm` : '—');
        return `<tr>
          <td><strong>${r.district}</strong><br><span class="ffgs-sub">${r.province}</span></td>
          <td>${r.iso}</td>
          <td><span class="${cls}">${r.level}</span></td>
          <td>${val}</td>
        </tr>`;
      }).join('');
    }
  }
};

// ---- Layer-toggle floating panel ----------------------------------------
function p3SetupLayerPanel() {
  const panel = document.getElementById('layerPanel');
  if (!panel || panel.dataset.ready) return;
  panel.dataset.ready = '1';
  panel.querySelectorAll('input[type=checkbox][data-layer]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const layer = e.target.dataset.layer;
      const on = e.target.checked;
      P3.layerVisible[layer] = on;
      if (layer === 'provinces') p3SetProvinceLayerVisible(on);
      else if (layer === 'ffgs') { if (typeof ffgsSetVisible === 'function') ffgsSetVisible(on); }
      else if (layer === 'rivers') {
        ['river-mekong-glow', 'river-mekong', 'river-tributaries'].forEach(id => {
          if (MAP.getLayer(id)) MAP.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
        });
      } else if (layer === 'dams') {
        for (const code in MARKERS) {
          const dam = CASCADE.dams.find(x => x.code === code);
          if (!dam) continue;
          const passes = p3DamPassesMaster(dam);
          MARKERS[code].getElement().style.display = (on && passes) ? '' : 'none';
        }
      } else if (layer === 'stations') {
        MRC_MARKERS.forEach((m, i) => {
          const s = MRC_STATIONS[i];
          if (!s) return;
          const passes = p3StationPasses(s);
          m.getElement().style.display = (on && passes) ? '' : 'none';
        });
      }
    });
  });
  const toggleBtn = document.getElementById('layerPanelToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      panel.classList.toggle('open');
    });
  }
}

// ---- Time scrubber ------------------------------------------------------
async function p3SetupScrubber() {
  const bar = document.getElementById('timeScrubber');
  if (!bar || bar.dataset.ready) return;
  bar.dataset.ready = '1';

  try {
    let dates = await fetch(`${FFGS.proxy}?path=${encodeURIComponent('/get-datelist/')}`).then(r => r.json());
    if (typeof dates === 'string') dates = JSON.parse(dates);
    const flat = (Array.isArray(dates) ? dates : []).map(x => Array.isArray(x) ? x[0] : x).filter(Boolean);
    flat.sort();
    P3.scrubber.dates = flat.slice(-14); // last 14 days
  } catch (e) {
    console.warn('[p3] scrubber dates failed', e);
    return;
  }
  if (!P3.scrubber.dates.length) return;

  const sel = document.getElementById('scrubDate');
  const hrSel = document.getElementById('scrubHour');
  const liveBtn = document.getElementById('scrubLive');
  if (!sel || !hrSel) return;

  sel.innerHTML = P3.scrubber.dates.slice().reverse()
    .map(d => `<option value="${d}">${d}</option>`).join('');
  hrSel.innerHTML = ['00','06','12','18'].map(h => `<option value="${h}">${h}:00 UTC</option>`).join('');

  // Default to current bulletin
  const curDate = FFGS.state.data?.meta?.date;
  const curHr = FFGS.state.data?.meta?.hrs;
  if (curDate) sel.value = curDate;
  if (curHr)   hrSel.value = curHr;

  async function rescrub() {
    const date = sel.value, hrs = hrSel.value;
    if (!date || !hrs) return;
    const cacheKey = `${date}|${hrs}`;
    let data = P3.cache[cacheKey];
    if (!data) {
      const byHorizon = {};
      await Promise.all(FFGS.horizons.map(async h => {
        try {
          const res = await fetch(`${FFGS.proxy}?path=${encodeURIComponent(FFGS.endpoints[h])}&date=${date}&hrs=${hrs}`);
          let d = await res.json();
          if (typeof d === 'string') d = JSON.parse(d);
          byHorizon[h] = Array.isArray(d) ? d : [];
        } catch (e) { byHorizon[h] = []; }
      }));
      data = { meta: { date, hrs }, byHorizon, merged: (function merge(){
        const merged = {};
        for (const h of FFGS.horizons) {
          for (const r of byHorizon[h] || []) {
            const k = `${r.ISO}|${String(r.NAME_1).trim().toLowerCase()}|${String(r.NAME_2).trim().toLowerCase()}`;
            if (!merged[k]) merged[k] = { iso: r.ISO, province: r.NAME_1, district: r.NAME_2, horizons: {} };
            merged[k].horizons[h] = { level: r.Level || 'Low', ffg: r.FFG01 ?? r.FFG03 ?? r.FFG06 ?? null, ffft: r.FFFT06 ?? null, ffr: r.FFR12 ?? r.FFR24 ?? null };
          }
        }
        for (const k in merged) {
          let mx = 0;
          for (const h of FFGS.horizons) {
            const lv = merged[k].horizons[h]?.level;
            if (lv && FFGS.levelRank[lv] > mx) mx = FFGS.levelRank[lv];
          }
          merged[k].maxLevel = FFGS.rankLevel[mx];
        }
        return merged;
      })()};
      P3.cache[cacheKey] = data;
    }
    FFGS.state.data = data;
    P3.scrubber.isCustom = true;
    if (liveBtn) liveBtn.classList.remove('hidden');
    // re-join geo features and repaint
    if (FFGS.state.geo) {
      for (const f of FFGS.state.geo.features) {
        const m = ffgsMatchFeature(f, data.merged);
        if (m) {
          f.properties._ffgs = {};
          for (const h of FFGS.horizons) f.properties._ffgs[h] = m.horizons[h]?.level || 'Low';
        } else {
          f.properties._ffgs = null;
        }
        f.properties[`_ffgs_${FFGS.state.horizon}`] = f.properties._ffgs ? f.properties._ffgs[FFGS.state.horizon] : 'Low';
      }
      const src = MAP?.getSource('ffgs-src');
      if (src) src.setData(FFGS.state.geo);
    }
    ffgsRenderPanel();
  }
  sel.addEventListener('change', rescrub);
  hrSel.addEventListener('change', rescrub);
  if (liveBtn) liveBtn.addEventListener('click', async () => {
    P3.scrubber.isCustom = false;
    FFGS.state.ts = 0;
    await ffgsAddLayer();
    ffgsRenderPanel();
    if (FFGS.state.data?.meta) {
      sel.value = FFGS.state.data.meta.date;
      hrSel.value = FFGS.state.data.meta.hrs;
    }
    liveBtn.classList.add('hidden');
  });
}

// ---- Export menu --------------------------------------------------------
function p3DownloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
}
function p3CsvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function p3ExportDamsCSV() {
  const dams = filterDams().filter(p3DamPassesMaster);
  const cols = ['code','name_en','river','country','province','capacity_mw','reporting_status','lat','lon','fsl_masl','mol_masl'];
  const lines = [cols.join(',')];
  dams.forEach(d => {
    const row = cols.map(c => p3CsvEscape(c === 'province' ? d._province : d[c]));
    lines.push(row.join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  p3DownloadBlob(`onemekong_dams_${new Date().toISOString().slice(0,10)}.csv`, blob);
}
function p3ExportFFGSCsv() {
  const data = FFGS.state.data;
  if (!data) return;
  const horizon = FFGS.state.horizon;
  const cols = ['ISO','Province','District','Horizon','Level','FFG_mm','FFR_pct'];
  const lines = [cols.join(',')];
  const country = FFGS.state.country;
  for (const k in data.merged) {
    const m = data.merged[k];
    const h = m.horizons[horizon];
    if (!h || h.level === 'Low') continue;
    if (country !== 'ALL' && m.iso !== country) continue;
    if (P3.filters.province !== 'ALL' && m.province !== P3.filters.province) continue;
    if (P3.filters.hazard !== 'ALL' && h.level !== P3.filters.hazard) continue;
    lines.push([m.iso, m.province, m.district, horizon, h.level,
      h.ffg != null ? h.ffg.toFixed(1) : '',
      h.ffr != null ? (h.ffr * 100).toFixed(1) : ''].map(p3CsvEscape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  p3DownloadBlob(`onemekong_flood_${data.meta.date}_${data.meta.hrs}h_${horizon}.csv`, blob);
}
function p3ExportFFGSGeoJSON() {
  if (!FFGS.state.geo) return;
  const horizon = FFGS.state.horizon;
  const out = { type: 'FeatureCollection', features: [] };
  FFGS.state.geo.features.forEach(f => {
    const lvl = f.properties._ffgs ? f.properties._ffgs[horizon] : 'Low';
    if (lvl === 'Low' || !lvl) return;
    if (P3.filters.province !== 'ALL' && f.properties.Province !== P3.filters.province) return;
    if (P3.filters.hazard !== 'ALL' && lvl !== P3.filters.hazard) return;
    out.features.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        ISO: f.properties.ISO, Country: f.properties.Country,
        Province: f.properties.Province, District: f.properties.District,
        horizon, level: lvl,
        all_horizons: f.properties._ffgs,
      }
    });
  });
  const blob = new Blob([JSON.stringify(out, null, 0)], { type: 'application/geo+json' });
  p3DownloadBlob(`onemekong_flood_${FFGS.state.data?.meta.date}_${horizon}.geojson`, blob);
}
function p3SetupExportMenu() {
  const btn = document.getElementById('exportBtn');
  const menu = document.getElementById('exportMenu');
  if (!btn || !menu || btn.dataset.ready) return;
  btn.dataset.ready = '1';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btn) menu.classList.remove('open');
  });
  document.getElementById('exDams')?.addEventListener('click', () => { p3ExportDamsCSV(); menu.classList.remove('open'); });
  document.getElementById('exFfgs')?.addEventListener('click', () => { p3ExportFFGSCsv(); menu.classList.remove('open'); });
  document.getElementById('exGeo')?.addEventListener('click', () => { p3ExportFFGSGeoJSON(); menu.classList.remove('open'); });
}

// ---- Patch filterDams to also apply master filters ---------------------
const _origFilterDams = filterDams;
filterDams = function() {
  return _origFilterDams().filter(p3DamPassesMaster);
};

// ---- Phase 3 init -------------------------------------------------------
async function p3Init() {
  await loadProvinceGeo();
  await p3StampDams();
  p3StampStations();
  await p3AddProvinceLayer();
  p3PopulateFilters();
  p3SetupLayerPanel();
  p3SetupExportMenu();
  // Scrubber must wait for FFGS to be loaded so it can sync defaults
  setTimeout(() => p3SetupScrubber(), 4000);
  renderDamList();
}
