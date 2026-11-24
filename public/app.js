'use strict';
/* Weltblick – Live-Weltkarte. Daten kommen gepuffert vom eigenen Server (/api/…). */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const zahl = (v, n = 0) => v == null || isNaN(v) ? '–' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: n, minimumFractionDigits: n });
const RAD = Math.PI / 180;

/* ------------------------------------------------------------ Einstellungen */
const SPEICHER = 'weltblick-2';
const st = {
  ebenen: { flug: true, schiff: true, sat: true, zug: true, beben: true, ereignis: true, radar: false, nacht: true },
  grund: 'dunkel', proj: 'globe', satGruppe: 'visual', nurMil: false, amBoden: false,
  mitte: [10, 30], zoom: 1.6,
};
try { const g = JSON.parse(localStorage.getItem(SPEICHER) || '{}'); Object.assign(st, g, { ebenen: { ...st.ebenen, ...(g.ebenen || {}) } }); } catch {}
let speichernT = 0;
function speichern() {
  clearTimeout(speichernT);
  speichernT = setTimeout(() => { try { localStorage.setItem(SPEICHER, JSON.stringify(st)); } catch {} }, 400);
}

/* ------------------------------------------------------------------- Karte */
const STILE = {
  dunkel: 'https://tiles.openfreemap.org/styles/dark',
  hell: 'https://tiles.openfreemap.org/styles/positron',
  satellit: {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      esri: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Bilder © Esri, Maxar, Earthstar Geographics',
      },
    },
    layers: [{ id: 'hg', type: 'background', paint: { 'background-color': '#05070c' } }, { id: 'esri', type: 'raster', source: 'esri' }],
  },
};

const karte = new maplibregl.Map({
  container: 'karte', style: STILE[st.grund] || STILE.dunkel,
  center: st.mitte, zoom: st.zoom, maxPitch: 70,
  attributionControl: { compact: true, customAttribution: 'Flugdaten: OpenSky, adsb.lol, adsb.fi · Züge: <a href="https://transitous.org/sources/" target="_blank">Transitous</a> · Schiffe: Digitraffic, aisstream.io · Satelliten: CelesTrak · USGS · NASA EONET · RainViewer' },
});
karte.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
karte.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false }, trackUserLocation: false, showUserLocation: true }), 'top-right');
karte.on('error', e => { if (e && e.error && !/tile|Failed to fetch|AbortError/i.test(e.error.message || '')) console.warn(e.error); });

let zeitVersatz = 0; // Server-Uhr minus Gerät
const nun = () => Date.now() / 1000 + zeitVersatz;
async function api(pfad) {
  const r = await fetch('api/' + pfad, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status);
  const ct = r.headers.get('content-type') || '';
  const d = ct.includes('json') ? await r.json() : await r.text();
  if (d && d.jetzt) zeitVersatz = d.jetzt - Date.now() / 1000;
  return d;
}

/* ------------------------------------------------------------------ Bilder */
// Signed-Distance-Field, damit die Symbole sich frei einfärben lassen
function sdfBild(zeichnen, g = 64, R = 8) {
  const c = document.createElement('canvas'); c.width = c.height = g;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; zeichnen(x, g);
  const d = x.getImageData(0, 0, g, g).data;
  const innen = new Uint8Array(g * g);
  for (let i = 0; i < g * g; i++) innen[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  const out = new ImageData(g, g);
  for (let y = 0; y < g; y++) for (let xx = 0; xx < g; xx++) {
    const i = y * g + xx, ich = innen[i];
    let best = (R + 1) * (R + 1);
    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= g) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x2 = xx + dx; if (x2 < 0 || x2 >= g) continue;
        if (innen[yy * g + x2] !== ich) { const q = dx * dx + dy * dy; if (q < best) best = q; }
      }
    }
    const dist = Math.min(R, Math.sqrt(best) - 0.5);
    const sd = ich ? -dist : dist;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = 255;
    out.data[i * 4 + 3] = Math.max(0, Math.min(255, 255 - 255 * (sd / R + 0.25)));
  }
  return out;
}
function emojiBild(e, g = 48) {
  const c = document.createElement('canvas'); c.width = c.height = g;
  const x = c.getContext('2d');
  x.font = `${Math.round(g * 0.78)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(e, g / 2, g / 2 + g * 0.04);
  return x.getImageData(0, 0, g, g);
}
const FLUGZEUG = new Path2D('M32 5C34 5 35 8 35 12L35 22L58 34L58 38L35 32L35 47L43 53L43 56L32 53.5L21 56L21 53L29 47L29 32L6 38L6 34L29 22L29 12C29 8 30 5 32 5Z');
const BILDER = {};
function bilderVorbereiten() {
  if (BILDER.flug) return;
  BILDER.flug = sdfBild(x => { x.translate(32, 32); x.scale(0.8, 0.8); x.translate(-32, -31.5); x.fill(FLUGZEUG); });
  BILDER.heli = sdfBild(x => {
    x.beginPath(); x.ellipse(32, 30, 7, 10, 0, 0, Math.PI * 2); x.fill();
    x.fillRect(30.5, 36, 3, 18); x.fillRect(25, 51, 14, 3);
    x.save(); x.translate(32, 29); x.rotate(Math.PI / 4);
    x.fillRect(-23, -1.6, 46, 3.2); x.fillRect(-1.6, -23, 3.2, 46); x.restore();
  });
  BILDER.schiff = sdfBild(x => { x.beginPath(); x.moveTo(32, 9); x.lineTo(42, 25); x.lineTo(42, 55); x.lineTo(22, 55); x.lineTo(22, 25); x.closePath(); x.fill(); });
  BILDER.anker = sdfBild(x => { x.beginPath(); x.moveTo(32, 20); x.lineTo(43, 32); x.lineTo(32, 44); x.lineTo(21, 32); x.closePath(); x.fill(); });
  for (const [k, e] of Object.entries(EREIGNIS_SYM)) BILDER['ev-' + k] = emojiBild(e);
  BILDER.station = emojiBild('🛰️');
}
function bilderEinfuegen() {
  bilderVorbereiten();
  for (const [k, img] of Object.entries(BILDER)) {
    if (karte.hasImage(k)) continue;
    const sdf = k === 'flug' || k === 'heli' || k === 'schiff' || k === 'anker';
    karte.addImage(k, img, { sdf, pixelRatio: 2 });
  }
}

/* ----------------------------------------------------------------- Farben */
const SCHIFF_ARTEN = {
  c: ['Frachtschiff', '#22c55e'], t: ['Tanker', '#ef4444'], p: ['Passagierschiff / Fähre', '#3b82f6'], fi: ['Fischereifahrzeug', '#f97316'],
  s: ['Segel- / Sportboot', '#e879f9'], d: ['Schlepper / Lotse / Dienst', '#22d3ee'], h: ['Schnellfahrzeug', '#facc15'],
  m: ['Militär / Behörde', '#94a3b8'], r: ['Such- und Rettung', '#f43f5e'], x: ['Sonstiges', '#cbd5e1'],
};
const EREIGNIS_SYM = { wildfires: '🔥', severeStorms: '🌀', volcanoes: '🌋', seaLakeIce: '🧊', floods: '🌊', drought: '☀️', dustHaze: '🌫️', landslides: '⛰️', snow: '❄️', tempExtremes: '🌡️', earthquakes: '💥', manmade: '⚠️', waterColor: '💧', sonst: '📍' };
const EREIGNIS_NAME = { wildfires: 'Waldbrand', severeStorms: 'Sturm', volcanoes: 'Vulkan', seaLakeIce: 'Eis / Eisberg', floods: 'Hochwasser', drought: 'Dürre', dustHaze: 'Staub / Dunst', landslides: 'Erdrutsch', snow: 'Schnee', tempExtremes: 'Extremtemperatur', earthquakes: 'Erdbeben', manmade: 'Menschengemacht', waterColor: 'Wasserfärbung' };
const NAV_STATUS = ['In Fahrt (Motor)', 'Vor Anker', 'Manövrierunfähig', 'Eingeschränkt manövrierfähig', 'Tiefgangbehindert', 'Festgemacht', 'Auf Grund gelaufen', 'Beim Fischen', 'Unter Segeln', '', '', 'Schleppverband', 'Schubverband', '', 'Notsignal (AIS-SART)', ''];
const NOTFALL = { '7500': 'Entführung', '7600': 'Funkausfall', '7700': 'Notfall' };
const HOEHE_FARBE = ['interpolate', ['linear'], ['get', 'a'], 0, '#f59e0b', 5000, '#facc15', 15000, '#a3e635', 25000, '#22d3ee', 35000, '#60a5fa', 45000, '#c084fc'];

/* --------------------------------------------------------------- Zustand */
let flieger = new Map(); // hex -> Array (Format siehe server.js)
const milSet = new Set();
let flugWeltZeit = 0;
let schiffListe = [], schiffInfo = { gesamt: 0, ais: 'aus' };
let sats = [], satPos = [];
let zugListe = [], nvListe = [], bebenListe = [], ereignisListe = [];
let bahnListe = [], bahnStand = 0;
// Bahn-Arten (Transitous/MOTIS) -> [Gruppe, Name, Farbe]
const BAHN_ART = {
  HIGHSPEED_RAIL: ['f', 'Hochgeschwindigkeitszug'], LONG_DISTANCE: ['f', 'Fernzug'], NIGHT_RAIL: ['n', 'Nachtzug'],
  REGIONAL_FAST_RAIL: ['r', 'Regional-Express'], REGIONAL_RAIL: ['r', 'Regionalzug'], RAIL: ['r', 'Zug'],
  METRO: ['s', 'S-Bahn'], SUBURBAN: ['s', 'S-Bahn'], SUBWAY: ['u', 'U-Bahn'], TRAM: ['t', 'Straßenbahn'],
  FERRY: ['w', 'Fähre'], FUNICULAR: ['l', 'Standseilbahn'], CABLE_CAR: ['l', 'Seilbahn'], AERIAL_LIFT: ['l', 'Seilbahn'], AREAL_LIFT: ['l', 'Seilbahn'],
};
const BAHN_FARBE = { f: '#ef4444', n: '#8b5cf6', r: '#22c55e', s: '#14b8a6', u: '#3b82f6', t: '#eab308', w: '#06b6d4', l: '#a855f7' };
const BETREIBER = { GVB: 'GVB Amsterdam', RET: 'RET Rotterdam', HTM: 'HTM Den Haag', ARR: 'Arriva', CXX: 'Connexxion', QBUZZ: 'Qbuzz', EBS: 'EBS', KEOLIS: 'Keolis', SYNTUS: 'Syntus', TESO: 'TESO (Fähre Texel)', DOEKSEN: 'Rederij Doeksen (Fähre)', WPD: 'Wagenborg (Fähre)', UOV: 'U-OV Utrecht', GVU: 'U-OV Utrecht', RIG: 'R-net', OPENOV: 'OpenOV', BRAVO: 'Bravo', ALLGO: 'allGo', BLAUWNET: 'Blauwnet', DELIJN: 'De Lijn' };
let radarDaten = null;
let auswahl = null; // {art, id}
let folgen = false;
let spur = [];

/* ----------------------------------------------------------------- Ebenen */
const leer = () => ({ type: 'FeatureCollection', features: [] });
const QUELLEN = ['nacht', 'beben', 'ereignis', 'zuglinie', 'zug', 'nv', 'bahn', 'schiff', 'flug', 'sat', 'route', 'orbit', 'spur', 'auswahl'];
const EBENEN_ZU = {
  flug: ['flug', 'flug-notfall'], schiff: ['schiff'], sat: ['sat', 'sat-station'], zug: ['zug', 'nv', 'bahn', 'bahn-text', 'zuglinie'],
  beben: ['beben', 'beben-puls'], ereignis: ['ereignis'], nacht: ['nacht'], radar: ['radar'],
};

function ebenenAufbauen() {
  bilderEinfuegen();
  for (const q of QUELLEN) if (!karte.getSource(q)) karte.addSource(q, { type: 'geojson', data: leer() });
  if (st.ebenen.radar && radarDaten) radarEinfuegen();
  const neu = (def) => { if (!karte.getLayer(def.id)) karte.addLayer(def); };
  neu({ id: 'nacht', type: 'fill', source: 'nacht', paint: { 'fill-color': '#000814', 'fill-opacity': st.grund === 'hell' ? 0.18 : 0.32 } });
  neu({ id: 'beben-puls', type: 'circle', source: 'beben', filter: ['<', ['get', 'alter'], 3 * 3600], paint: { 'circle-radius': 10, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ef4444', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.8, 'circle-pitch-alignment': 'map' } });
  neu({ id: 'beben', type: 'circle', source: 'beben', paint: {
    'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 0, 2, 3, 4, 5, 9, 7, 18],
    'circle-color': ['interpolate', ['linear'], ['get', 'alter'], 0, '#ef4444', 6 * 3600, '#f97316', 24 * 3600, '#facc15'],
    'circle-opacity': 0.75, 'circle-stroke-color': '#fff', 'circle-stroke-width': 0.6, 'circle-stroke-opacity': 0.5, 'circle-pitch-alignment': 'map',
  } });
  neu({ id: 'ereignis', type: 'symbol', source: 'ereignis', layout: { 'icon-image': ['concat', 'ev-', ['get', 'k']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.55, 6, 0.9], 'icon-allow-overlap': true } });
  neu({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#e2e8f0', 'line-width': 1.4, 'line-opacity': 0.55, 'line-dasharray': [2, 2] } });
  neu({ id: 'orbit', type: 'line', source: 'orbit', paint: { 'line-color': '#fbbf24', 'line-width': 1.5, 'line-opacity': 0.7 } });
  neu({ id: 'spur', type: 'line', source: 'spur', paint: { 'line-color': '#38bdf8', 'line-width': 2.5, 'line-opacity': 0.85 } });
  neu({ id: 'zuglinie', type: 'line', source: 'zuglinie', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['to-color', ['coalesce', ['get', 'farbe'], '#22c55e']], 'line-width': 3, 'line-opacity': 0.75 } });
  neu({ id: 'bahn', type: 'circle', source: 'bahn', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['==', ['get', 'g'], 'f'], 3.2, 2.2], 9, 4.5, 13, 7],
    'circle-color': ['match', ['get', 'g'], ...Object.entries(BAHN_FARBE).flat(), '#22c55e'],
    'circle-stroke-color': ['case', ['==', ['get', 'fa'], 1], '#ffffff', '#64748b'], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.5],
    'circle-pitch-alignment': 'map',
  } });
  neu({ id: 'bahn-text', type: 'symbol', source: 'bahn', minzoom: 9, layout: {
    'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-offset': [0, 1.1], 'text-anchor': 'top',
    'text-allow-overlap': false, 'text-optional': true,
  }, paint: { 'text-color': '#e2e8f0', 'text-halo-color': 'rgba(11,15,23,.9)', 'text-halo-width': 1.4 } });
  neu({ id: 'nv', type: 'circle', source: 'nv', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 8, 3.5, 12, 6], 'circle-color': '#fb923c', 'circle-stroke-color': '#431407', 'circle-stroke-width': 0.8 } });
  neu({ id: 'zug', type: 'circle', source: 'zug', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 8, 5, 12, 7], 'circle-color': '#4ade80', 'circle-stroke-color': '#052e16', 'circle-stroke-width': 1 } });
  neu({ id: 'schiff', type: 'symbol', source: 'schiff', layout: {
    'icon-image': ['case', ['>', ['get', 'v'], 0.7], 'schiff', 'anker'],
    'icon-rotate': ['get', 'r'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
    'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.22, 5, 0.34, 9, 0.5, 13, 0.75],
    'icon-allow-overlap': true, 'icon-ignore-placement': true,
  }, paint: { 'icon-color': ['match', ['get', 'g'], ...Object.entries(SCHIFF_ARTEN).flatMap(([k, v]) => [k, v[1]]), '#cbd5e1'], 'icon-opacity': ['case', ['==', ['get', 'alt'], 1], 0.45, 1], 'icon-halo-color': 'rgba(0,0,0,.6)', 'icon-halo-width': 1 } });
  neu({ id: 'auswahl', type: 'circle', source: 'auswahl', paint: { 'circle-radius': 17, 'circle-color': 'rgba(56,189,248,.12)', 'circle-stroke-color': '#38bdf8', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } });
  neu({ id: 'flug', type: 'symbol', source: 'flug', layout: {
    'icon-image': ['case', ['==', ['get', 'k'], 'h'], 'heli', 'flug'], 'icon-rotate': ['get', 'r'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
    'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.3, 4, 0.42, 8, 0.6, 12, 0.85],
    'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'a'],
  }, paint: {
    'icon-color': ['case', ['==', ['get', 'e'], 1], '#ef4444', ['==', ['get', 'm'], 1], '#f472b6', ['<', ['get', 'a'], 0], '#64748b', HOEHE_FARBE],
    'icon-halo-color': 'rgba(0,0,0,.55)', 'icon-halo-width': 1,
  } });
  neu({ id: 'flug-notfall', type: 'circle', source: 'flug', filter: ['==', ['get', 'e'], 1], paint: { 'circle-radius': 14, 'circle-color': 'rgba(239,68,68,.15)', 'circle-stroke-color': '#ef4444', 'circle-stroke-width': 1.5 } });
  neu({ id: 'sat', type: 'circle', source: 'sat', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['case', ['==', ['get', 's'], 1], 4, 1.6], 6, ['case', ['==', ['get', 's'], 1], 6, 3]],
    'circle-color': ['case', ['==', ['get', 's'], 1], '#fbbf24', '#f8fafc'], 'circle-opacity': 0.9,
    'circle-stroke-color': '#0b0f17', 'circle-stroke-width': 0.5,
  } });
  neu({ id: 'sat-station', type: 'symbol', source: 'sat', filter: ['==', ['get', 's'], 1], layout: { 'icon-image': 'station', 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 6, 0.9], 'icon-allow-overlap': true, 'icon-offset': [0, -16] } });
  sichtbarkeitSetzen();
  allesZeichnen();
}

function sichtbarkeitSetzen() {
  for (const [e, ids] of Object.entries(EBENEN_ZU)) for (const id of ids) {
    if (karte.getLayer(id)) karte.setLayoutProperty(id, 'visibility', st.ebenen[e] ? 'visible' : 'none');
  }
}
function quelleSetzen(id, daten) { const q = karte.getSource(id); if (q) q.setData(daten); }

/* --------------------------------------------------------------- Flugzeuge */
function flugPos(a, t) {
  const dt = t - a[9];
  if (a[8] || !a[5] || a[6] == null || dt <= 0) return [a[2], a[3]];
  const s = a[5] * 0.514444 * Math.min(dt, a[13] === 'o' ? 900 : 150);
  const lat = Math.max(-89, Math.min(89, a[2] + s * Math.cos(a[6] * RAD) / 111320));
  let lon = a[3] + s * Math.sin(a[6] * RAD) / (111320 * Math.max(0.05, Math.cos(a[2] * RAD)));
  if (lon > 180) lon -= 360; else if (lon < -180) lon += 360;
  return [lat, lon];
}
const istMil = a => a[14] === 1 || milSet.has(a[0]);
function flugZeichnen() {
  const t = nun(), feats = [];
  const boden = st.amBoden, nurMil = st.nurMil;
  for (const a of flieger.values()) {
    if (t - a[9] > (a[13] === 'o' ? 1500 : 600)) continue;
    if (a[8] && !boden) continue;
    const mil = istMil(a);
    if (nurMil && !mil) continue;
    const p = flugPos(a, t);
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p[1], p[0]] }, properties: { h: a[0], r: a[6] || 0, a: a[8] ? -1 : (a[4] == null ? 20000 : a[4]), m: mil ? 1 : 0, e: NOTFALL[a[12]] ? 1 : 0, k: a[15] === 'A7' ? 'h' : 'f' } });
  }
  quelleSetzen('flug', { type: 'FeatureCollection', features: feats });
  $('#n-flug').textContent = zahl(feats.length);
}

function flugEinmischen(liste) {
  for (const a of liste) {
    const alt = flieger.get(a[0]);
    if (!alt || alt[9] <= a[9]) {
      if (alt && !a[1] && alt[1]) a[1] = alt[1];
      if (alt && !a[10] && alt[10]) a[10] = alt[10];
      if (alt && !a[11] && alt[11]) a[11] = alt[11];
      if (alt && alt[18] && !a[18]) a[18] = alt[18];
      flieger.set(a[0], a);
    }
  }
}
async function flugWeltLaden() {
  if (!st.ebenen.flug) return;
  try {
    const d = await api('flug/welt');
    const t = nun(), neu = new Map();
    for (const a of d.liste) neu.set(a[0], a);
    for (const a of flieger.values()) {
      if (a[13] === 'o' || t - a[9] > 150) continue;
      const w = neu.get(a[0]);
      if (!w || w[9] < a[9]) neu.set(a[0], a);
    }
    flieger = neu; flugWeltZeit = d.zeit;
    flugZeichnen(); statusAktualisieren();
  } catch (e) { console.warn('flug/welt', e); }
}

// Zellen-Raster wie auf dem Server
function zellenImBild() {
  const z = karte.getZoom(), ids = new Map();
  const c = karte.getCenter();
  const zelle = (lat, lon) => {
    const i = Math.min(35, Math.max(0, Math.floor((lat + 90) / 5)));
    const lm = -90 + 5 * (i + 0.5), polnah = Math.min(89, Math.abs(lm) + 2.5);
    const n = Math.max(1, Math.ceil(360 / (5 / Math.cos(polnah * RAD))));
    let k = Math.floor((((lon + 180) % 360) + 360) % 360 / (360 / n));
    return { i, k: Math.min(n - 1, k), n, lm };
  };
  if (z >= 4.5) {
    const b = karte.getBounds();
    const s = Math.max(-89.9, b.getSouth()), nn = Math.min(89.9, b.getNorth());
    let w = b.getWest(), o = b.getEast();
    if (o - w > 360) { w = -180; o = 180; }
    for (let lat = s; lat <= nn + 2.5; lat += 2.5) {
      const z0 = zelle(Math.min(lat, nn), 0);
      const breite = 360 / z0.n;
      for (let lon = w; lon <= o + breite / 2; lon += breite / 2) {
        const q = zelle(Math.min(lat, nn), Math.min(lon, o));
        const lonM = -180 + (360 / q.n) * (q.k + 0.5);
        const d = (q.lm - c.lat) ** 2 + (((lonM - c.lng + 540) % 360 - 180) * Math.cos(c.lat * RAD)) ** 2;
        ids.set(q.i + '_' + q.k, d);
      }
    }
  }
  // Ausgewähltes Flugzeug immer live halten
  if (auswahl && auswahl.art === 'flug') {
    const a = flieger.get(auswahl.id);
    if (a) { const p = flugPos(a, nun()); const q = zelle(p[0], p[1]); ids.set(q.i + '_' + q.k, -1); }
  }
  return [...ids.entries()].sort((x, y) => x[1] - y[1]).slice(0, 20).map(x => x[0]);
}
async function zellenLaden() {
  if (!st.ebenen.flug) return;
  const ids = zellenImBild();
  if (!ids.length) return;
  try {
    const d = await api('flug/zellen?ids=' + ids.join(','));
    for (const z of Object.values(d.zellen)) flugEinmischen(z.liste);
    flugZeichnen();
  } catch (e) { console.warn('zellen', e); }
}
async function militaerLaden() {
  if (!st.ebenen.flug) return;
  try {
    const d = await api('flug/militaer');
    for (const a of d.liste) milSet.add(a[0]);
    flugEinmischen(d.liste);
    flugZeichnen();
  } catch {}
}

/* ----------------------------------------------------------------- Schiffe */
async function schiffeLaden() {
  if (!st.ebenen.schiff) return;
  let b = '-180,-85,180,85';
  const z = karte.getZoom();
  if (z >= 3) {
    const g = karte.getBounds();
    let w = g.getWest(), o = g.getEast();
    if (o - w >= 360) { w = -180; o = 180; }
    const norm = x => x > 180 ? x - 360 : x < -180 ? x + 360 : x;
    b = [norm(w), Math.max(-85, g.getSouth()), norm(o), Math.min(85, g.getNorth())].map(x => x.toFixed(3)).join(',');
  }
  try {
    const d = await api('schiffe?b=' + b + '&z=' + z.toFixed(1));
    schiffListe = d.liste; schiffInfo = d;
    schiffeZeichnen();
    $('#aisHinweis').innerHTML = d.ais === 'live'
      ? 'Von freiwilligen Empfängern an Land. Weit draußen auf See und in manchen Meeren (z. B. Schwarzes und Rotes Meer) gibt es kaum Empfänger. Blasse Schiffe: letzte Meldung vor über 1 Stunde.'
      : 'Zurzeit nur Ostsee/Finnland (Digitraffic), die weltweite Quelle verbindet sich gerade.';
  } catch (e) { console.warn('schiffe', e); }
}
function schiffeZeichnen() {
  const t = nun();
  const feats = schiffListe.map(s => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s[2], s[1]] }, properties: { id: s[0], v: s[3] || 0, r: s[5] != null ? s[5] : (s[4] || 0), g: s[6], alt: t - s[8] > 3600 ? 1 : 0 } }));
  quelleSetzen('schiff', { type: 'FeatureCollection', features: feats });
  $('#n-schiff').textContent = zahl(schiffInfo.imBild != null ? schiffInfo.imBild : feats.length);
}

/* -------------------------------------------------------------- Satelliten */
let satLaedt = null;
async function satsLaden() {
  if (!st.ebenen.sat) return;
  const g = st.satGruppe;
  if (satLaedt === g) return;
  satLaedt = g;
  zeigeStatus('Satelliten werden geladen …', 4000);
  try {
    const text = await api('sat?g=' + g);
    if (st.satGruppe !== g) return;
    const z = text.split(/\r?\n/), neu = [];
    for (let i = 0; i + 2 < z.length; i++) {
      if (z[i + 1].startsWith('1 ') && z[i + 2].startsWith('2 ')) {
        const rec = satellite.twoline2satrec(z[i + 1].trim(), z[i + 2].trim());
        if (!rec.error) {
          const name = z[i].trim(), nr = z[i + 1].slice(2, 7).trim();
          neu.push({ name, nr, rec, station: /^(ISS|CSS|TIANHE|TIANGONG)/i.test(name) && !/DEB|R\/B/.test(name) ? 1 : 0 });
        }
        i += 2;
      }
    }
    sats = neu;
    satsRechnen(); zeigeStatus('', 0);
  } catch (e) {
    console.warn('sat', e); zeigeStatus('Satelliten gerade nicht erreichbar – neuer Versuch gleich', 3000);
    setTimeout(() => { if (!sats.length) satsLaden(); }, 45000);
  }
  finally { if (satLaedt === g) satLaedt = null; }
}
function satPosition(s, d) {
  const pv = satellite.propagate(s.rec, d);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const g = satellite.eciToGeodetic(pv.position, satellite.gstime(d));
  const v = pv.velocity;
  return { lat: satellite.degreesLat(g.latitude), lon: satellite.degreesLong(g.longitude), h: g.height, v: v ? Math.hypot(v.x, v.y, v.z) : null };
}
function satsRechnen() {
  if (!st.ebenen.sat) return;
  const d = new Date(nun() * 1000), feats = [];
  satPos = new Array(sats.length);
  for (let i = 0; i < sats.length; i++) {
    const p = satPosition(sats[i], d);
    satPos[i] = p;
    if (!p || isNaN(p.lat)) continue;
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { i, s: sats[i].station } });
  }
  quelleSetzen('sat', { type: 'FeatureCollection', features: feats });
  $('#n-sat').textContent = zahl(feats.length);
}
function orbitLinie(s) {
  const t0 = nun() * 1000, pkt = [];
  let vorher = null;
  for (let m = -40; m <= 100; m += 0.75) {
    const p = satPosition(s, new Date(t0 + m * 60000));
    if (!p) continue;
    let lon = p.lon;
    if (vorher != null) { while (lon - vorher > 180) lon -= 360; while (lon - vorher < -180) lon += 360; }
    vorher = lon; pkt.push([lon, p.lat]);
  }
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: pkt }, properties: {} };
}

/* ---------------------------------------------- Züge, Beben, Ereignisse, Radar */
async function zuegeLaden() {
  if (!st.ebenen.zug) return;
  await Promise.all([
    api('zuege').then(d => { zugListe = d.liste; }).catch(() => {}),
    api('nahverkehr').then(d => { nvListe = d.liste; }).catch(() => {}),
  ]);
  bahnZeichnen();
}
function bahnZeichnen() {
  quelleSetzen('zug', { type: 'FeatureCollection', features: zugListe.map(z => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [z[2], z[1]] }, properties: { id: z[0] } })) });
  quelleSetzen('nv', { type: 'FeatureCollection', features: nvListe.map(v => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v[2], v[1]] }, properties: { id: v[0] } })) });
  $('#n-zug').textContent = zahl(zugListe.length + nvListe.length + bahnListe.length);
}
// Züge in Europa und weiteren Ländern (Transitous): Kacheln im Ausschnitt, ab Zoom 5
function kachelnImBild(tz) {
  const b = karte.getBounds(), n = 2 ** tz;
  const lon2x = lon => Math.floor((lon + 180) / 360 * n);
  const lat2y = lat => { const r = Math.max(-85, Math.min(85, lat)) * RAD; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
  let w = b.getWest(), o = b.getEast();
  if (o - w >= 360) { w = -180; o = 179.999; }
  const c = karte.getCenter(), cx = (c.lng + 180) / 360 * n, cy = lat2y(c.lat) + 0.5;
  const out = new Map();
  for (let x = lon2x(w); x <= lon2x(o); x++) {
    for (let y = Math.max(0, lat2y(b.getNorth())); y <= Math.min(n - 1, lat2y(b.getSouth())); y++) {
      const xx = ((x % n) + n) % n;
      out.set(`${tz}/${xx}/${y}`, (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
    }
  }
  return [...out.entries()].sort((a, b2) => a[1] - b2[1]).slice(0, 9).map(e => e[0]);
}
async function zuegeEuropaLaden() {
  if (!st.ebenen.zug) return;
  const z = karte.getZoom();
  if (z < 5) { if (bahnListe.length) { bahnListe = []; zuegeEuropaZeichnen(); } return; }
  const stufe = Math.max(5, Math.min(12, Math.round(z)));
  const k = kachelnImBild(stufe - 2);
  if (!k.length) return;
  try {
    const d = await api(`bahn?q=${stufe}&k=${k.join(',')}`);
    bahnListe = d.liste; bahnStand = d.jetzt;
    zuegeEuropaZeichnen();
    if (d.offen) zeigeStatus('Züge werden geladen …', 4000);
  } catch (e) { console.warn('bahn', e); }
}
function bahnPos(b, t) {
  if (!b[10] || !b[6]) return [b[3], b[4]];
  const dt = Math.min(30, Math.max(0, t - bahnStand)), s = b[6] * dt;
  return [b[3] + s * Math.cos(b[5] * RAD) / 111320, b[4] + s * Math.sin(b[5] * RAD) / (111320 * Math.cos(b[3] * RAD))];
}
function zuegeEuropaZeichnen() {
  const t = nun();
  quelleSetzen('bahn', { type: 'FeatureCollection', features: bahnListe.map(b => {
    const p = bahnPos(b, t);
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [p[1], p[0]] }, properties: { id: b[0], n: b[1], g: (BAHN_ART[b[2]] || ['r'])[0], fa: b[10] } };
  }) });
  $('#n-zug').textContent = zahl(zugListe.length + nvListe.length + bahnListe.length);
}

async function bebenLaden() {
  if (!st.ebenen.beben) return;
  try {
    const d = await api('beben'); bebenListe = d.liste;
    bebenZeichnen();
  } catch {}
}
function bebenZeichnen() {
  const t = nun();
  quelleSetzen('beben', { type: 'FeatureCollection', features: bebenListe.map(b => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [b[2], b[1]] }, properties: { id: b[0], mag: b[4] || 0, alter: Math.max(0, t - b[6]) } })) });
  $('#n-beben').textContent = zahl(bebenListe.length);
}
async function ereignisseLaden() {
  if (!st.ebenen.ereignis) return;
  try {
    const d = await api('ereignisse'); ereignisListe = d.liste;
    quelleSetzen('ereignis', { type: 'FeatureCollection', features: ereignisListe.map(e => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e[4], e[3]] }, properties: { id: e[0], k: EREIGNIS_SYM[e[2]] ? e[2] : 'sonst' } })) });
    $('#n-ereignis').textContent = zahl(ereignisListe.length);
  } catch {}
}
async function radarLaden() {
  if (!st.ebenen.radar) return;
  try {
    radarDaten = await api('radar');
    radarEinfuegen();
  } catch {}
}
function radarEinfuegen() {
  const bilder = radarDaten && radarDaten.radar && radarDaten.radar.past;
  if (!bilder || !bilder.length) return;
  const f = bilder[bilder.length - 1];
  const url = `${radarDaten.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;
  const q = karte.getSource('radar');
  if (q && q._weltblickUrl === url) return;
  if (karte.getLayer('radar')) karte.removeLayer('radar');
  if (q) karte.removeSource('radar');
  karte.addSource('radar', { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 7, attribution: 'Radar: RainViewer' });
  karte.getSource('radar')._weltblickUrl = url;
  karte.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.65 }, layout: { visibility: st.ebenen.radar ? 'visible' : 'none' } }, karte.getLayer('nacht') ? 'nacht' : undefined);
  $('#n-radar').textContent = new Date(f.time * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/* -------------------------------------------------------------- Tag/Nacht */
function sonne(d) {
  const n = d.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const dek = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / RAD;
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra - gmst;
  lon = ((lon % 360) + 540) % 360 - 180;
  return { dek, lon };
}
function nachtZeichnen() {
  if (!st.ebenen.nacht) return;
  const s = sonne(new Date(nun() * 1000));
  const dek = Math.abs(s.dek) < 0.001 ? 0.001 : s.dek;
  const pkt = [];
  for (let lon = -180; lon <= 180; lon += 2) pkt.push([lon, Math.atan(-Math.cos((lon - s.lon) * RAD) / Math.tan(dek)) / RAD]);
  const pol = dek > 0 ? -90 : 90;
  pkt.push([180, pol], [-180, pol], pkt[0]);
  quelleSetzen('nacht', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [pkt] }, properties: {} }] });
}

/* ------------------------------------------------------------- Auswahl/Info */
function infoOeffnen(html) {
  $('#infoInhalt').innerHTML = html;
  $('#info').hidden = false;
  document.body.classList.add('mit-info');
}
function auswahlAufheben() {
  auswahl = null; folgen = false; spur = [];
  $('#info').hidden = true;
  document.body.classList.remove('mit-info');
  for (const q of ['auswahl', 'route', 'orbit', 'spur', 'zuglinie']) quelleSetzen(q, leer());
}
function wert(t, v, extra = '') { return `<div class="i-wert ${extra}"><span>${esc(t)}</span><b>${v}</b></div>`; }
function vorZeit(sekunden) {
  if (sekunden < 60) return `vor ${Math.max(0, Math.round(sekunden))} s`;
  if (sekunden < 3600) return `vor ${Math.round(sekunden / 60)} min`;
  return `vor ${zahl(sekunden / 3600, 1)} h`;
}
function knopfe(extraLink) {
  return `<div class="i-knopfe"><button class="primaer ${folgen ? 'an' : ''}" id="folgenKnopf">${folgen ? 'Verfolgen an' : 'Verfolgen'}</button>${extraLink || ''}</div>`;
}
function auswaehlen(art, id, fliegen) {
  auswahl = { art, id }; spur = []; folgen = false;
  for (const q of ['route', 'orbit', 'spur', 'zuglinie']) quelleSetzen(q, leer());
  if (art === 'flug') flugInfo(id);
  else if (art === 'schiff') schiffInfoZeigen(id);
  else if (art === 'sat') satInfo(id);
  else if (art === 'zug') zugInfo(id);
  else if (art === 'nv') nvInfo(id);
  else if (art === 'bahn') bahnInfo(id);
  else if (art === 'beben') bebenInfo(id);
  else if (art === 'ereignis') ereignisInfo(id);
  auswahlAktualisieren();
  if (fliegen) { const p = auswahlPosition(); if (p) karte.flyTo({ center: p, zoom: Math.max(karte.getZoom(), art === 'sat' ? 3 : 6), speed: 1.6 }); }
}
function auswahlPosition() {
  if (!auswahl) return null;
  const { art, id } = auswahl;
  if (art === 'flug') { const a = flieger.get(id); if (!a) return null; const p = flugPos(a, nun()); return [p[1], p[0]]; }
  if (art === 'schiff') { const s = schiffListe.find(x => x[0] === id) || (auswahl.zusatz && [0, auswahl.zusatz.la, auswahl.zusatz.lo]); return s ? [s[2], s[1]] : null; }
  if (art === 'sat') { const p = satPos[id]; return p ? [p.lon, p.lat] : null; }
  if (art === 'zug') { const z = zugListe.find(x => x[0] === id); return z ? [z[2], z[1]] : null; }
  if (art === 'nv') { const v = nvListe.find(x => x[0] === id); return v ? [v[2], v[1]] : null; }
  if (art === 'bahn') { const b = bahnListe.find(x => x[0] === id); if (!b) return null; const p = bahnPos(b, nun()); return [p[1], p[0]]; }
  if (art === 'beben') { const b = bebenListe.find(x => x[0] === id); return b ? [b[2], b[1]] : null; }
  if (art === 'ereignis') { const e = ereignisListe.find(x => x[0] === id); return e ? [e[4], e[3]] : null; }
  return null;
}
function auswahlAktualisieren() {
  if (!auswahl) return;
  const p = auswahlPosition();
  quelleSetzen('auswahl', p ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }] } : leer());
  if (!p) return;
  if (auswahl.art === 'flug' || auswahl.art === 'schiff') {
    const l = spur[spur.length - 1];
    if (!l || Math.abs(l[0] - p[0]) + Math.abs(l[1] - p[1]) > 0.002) spur.push(p);
    if (spur.length > 1500) spur.shift();
    if (spur.length > 1) quelleSetzen('spur', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: spur }, properties: {} }] });
  }
  if (auswahl.art === 'flug') flugWerte();
  if (auswahl.art === 'sat') satWerte();
  if (auswahl.art === 'bahn') bahnWerte();
  if (folgen) karte.easeTo({ center: p, duration: 900, easing: t => t });
}
document.addEventListener('click', e => {
  if (e.target.id === 'folgenKnopf') {
    folgen = !folgen;
    e.target.classList.toggle('an', folgen); e.target.textContent = folgen ? 'Verfolgen an' : 'Verfolgen';
    if (folgen) { const p = auswahlPosition(); if (p) karte.easeTo({ center: p, zoom: Math.max(karte.getZoom(), auswahl.art === 'sat' ? 3 : 7) }); }
  }
});

// Großkreis zwischen zwei Punkten (für die Route)
function grosskreis(a, b, n = 64) {
  const [l1, p1] = [a[0] * RAD, a[1] * RAD], [l2, p2] = [b[0] * RAD, b[1] * RAD];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!d) return [a, b];
  const pkt = []; let vorher = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    let lon = Math.atan2(y, x) / RAD; const lat = Math.atan2(z, Math.hypot(x, y)) / RAD;
    if (vorher != null) { while (lon - vorher > 180) lon -= 360; while (lon - vorher < -180) lon += 360; }
    vorher = lon; pkt.push([lon, lat]);
  }
  return pkt;
}
const entfernungKm = (a, b) => {
  const p1 = a[1] * RAD, p2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
};

let flugZusatz = null;
async function flugInfo(hex) {
  const a = flieger.get(hex); if (!a) return;
  flugZusatz = null;
  const titel = a[1] || a[10] || hex.toUpperCase();
  infoOeffnen(`<div class="i-art">Flugzeug${istMil(a) ? ' · Militär' : ''}</div>
    <div class="i-titel">${esc(titel)}</div><div class="i-unter" id="iUnter">${esc([a[16], a[17]].filter(Boolean).join(' · ') || a[18] || '')}</div>
    <div id="iFoto"></div><div id="iRoute"></div>
    <div class="i-raster" id="iWerte"></div>
    ${knopfe(`<a href="https://globe.adsb.lol/?icao=${encodeURIComponent(hex)}" target="_blank" rel="noopener">Verlauf ↗</a>`)}
    <div class="i-hinweis" id="iHinweis"></div>`);
  flugWerte();
  try {
    const info = await (await fetch(`api/flug/info?hex=${encodeURIComponent(hex)}&cs=${encodeURIComponent(a[1] || '')}`)).json();
    if (!auswahl || auswahl.id !== hex) return;
    flugZusatz = info;
    const f = info.flieger, r = info.route;
    const unter = [r && r.airline, f && f.typ ? [f.hersteller, f.typ].filter(Boolean).join(' ') : a[16]].filter(Boolean).join(' · ');
    if (unter) $('#iUnter').textContent = unter;
    if (r && r.von && r.nach) {
      $('#iRoute').innerHTML = `<div class="i-route"><div><div class="code">${esc(r.von.iata || r.von.icao)}</div><div class="ort">${esc(r.von.ort || r.von.name)}</div></div><div class="pfeil">→</div><div class="rechts"><div class="code">${esc(r.nach.iata || r.nach.icao)}</div><div class="ort">${esc(r.nach.ort || r.nach.name)}</div></div></div>`;
      const p = auswahlPosition();
      if (p) quelleSetzen('route', { type: 'FeatureCollection', features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: grosskreis([r.von.lon, r.von.lat], p) }, properties: {} },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: grosskreis(p, [r.nach.lon, r.nach.lat]) }, properties: {} },
      ] });
      $('#iHinweis').textContent = 'Route laut Flugplan-Datenbank (adsbdb) – kann bei Charter- und Sonderflügen abweichen.';
    }
    fotoZeigen(f && f.foto, hex);
    flugWerte();
  } catch {}
}
async function fotoZeigen(url, hex) {
  if (url) { $('#iFoto').innerHTML = `<img class="i-foto" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`; return; }
  try {
    const r = await fetch(`https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(hex)}`);
    const j = await r.json();
    const ph = j.photos && j.photos[0];
    if (!ph || !auswahl || auswahl.id !== hex) return;
    $('#iFoto').innerHTML = `<a href="${esc(ph.link)}" target="_blank" rel="noopener"><img class="i-foto" src="${esc(ph.thumbnail_large ? ph.thumbnail_large.src : ph.thumbnail.src)}" alt="" referrerpolicy="no-referrer"></a><div class="i-hinweis" style="margin:-8px 0 10px">Foto: ${esc(ph.photographer)} · planespotters.net</div>`;
  } catch {}
}
function flugWerte() {
  const el = $('#iWerte'); if (!el || !auswahl || auswahl.art !== 'flug') return;
  const a = flieger.get(auswahl.id);
  if (!a) { el.innerHTML = wert('Status', 'Signal verloren', 'breit'); return; }
  const t = nun(), alter = t - a[9];
  const quelle = { o: 'OpenSky', l: 'adsb.lol', f: 'adsb.fi' }[a[13]] || a[13];
  const geschaetzt = !a[8] && alter > 20;
  const f = flugZusatz && flugZusatz.flieger, r = flugZusatz && flugZusatz.route;
  let rest = '';
  const p = auswahlPosition();
  if (r && r.nach && p && a[5] > 50) {
    const km = entfernungKm(p, [r.nach.lon, r.nach.lat]);
    const min = km / (a[5] * 1.852) * 60;
    rest = wert('Bis zum Ziel', `${zahl(km)} km · ca. ${min > 90 ? zahl(min / 60, 1) + ' h' : zahl(min) + ' min'}`, 'breit');
  }
  const sq = a[12] ? (NOTFALL[a[12]] ? `${a[12]} – ${NOTFALL[a[12]]}` : a[12]) : '–';
  el.innerHTML = [
    wert('Höhe', a[8] ? 'am Boden' : a[4] == null ? '–' : `${zahl(a[4])} ft · ${zahl(a[4] * 0.3048)} m`, 'breit'),
    wert('Tempo', a[5] == null ? '–' : `${zahl(a[5] * 1.852)} km/h`),
    wert('Kurs', a[6] == null ? '–' : `${zahl(a[6])}°`),
    wert('Steigen/Sinken', a[7] == null ? '–' : `${a[7] > 0 ? '+' : ''}${zahl(a[7])} ft/min`),
    wert('Squawk', esc(sq), NOTFALL[a[12]] ? 'warn' : ''),
    rest,
    wert('Kennzeichen', esc((f && f.kennz) || a[10] || '–')),
    wert('Typ', esc((f && f.icaoTyp) || a[11] || '–')),
    wert('Halter', esc((f && f.halter) || a[17] || '–'), 'breit'),
    wert('ICAO-Adresse', esc(a[0].toUpperCase())),
    wert('Land', esc((f && f.land) || a[18] || '–')),
    wert('Daten', `${esc(quelle)} · ${vorZeit(alter)}${geschaetzt ? ' · Position geschätzt' : ''}`, 'breit'),
  ].join('');
}

const MID = { 201: 'Albanien', 203: 'Österreich', 205: 'Belgien', 207: 'Bulgarien', 209: 'Zypern', 210: 'Zypern', 211: 'Deutschland', 212: 'Zypern', 213: 'Georgien', 215: 'Malta', 218: 'Deutschland', 219: 'Dänemark', 220: 'Dänemark', 224: 'Spanien', 225: 'Spanien', 226: 'Frankreich', 227: 'Frankreich', 228: 'Frankreich', 229: 'Malta', 230: 'Finnland', 231: 'Färöer', 232: 'Großbritannien', 233: 'Großbritannien', 234: 'Großbritannien', 235: 'Großbritannien', 236: 'Gibraltar', 237: 'Griechenland', 238: 'Kroatien', 239: 'Griechenland', 240: 'Griechenland', 241: 'Griechenland', 242: 'Marokko', 244: 'Niederlande', 245: 'Niederlande', 246: 'Niederlande', 247: 'Italien', 248: 'Malta', 249: 'Malta', 250: 'Irland', 251: 'Island', 253: 'Luxemburg', 254: 'Monaco', 255: 'Portugal (Madeira)', 256: 'Malta', 257: 'Norwegen', 258: 'Norwegen', 259: 'Norwegen', 261: 'Polen', 263: 'Portugal', 264: 'Rumänien', 265: 'Schweden', 266: 'Schweden', 269: 'Schweiz', 271: 'Türkei', 272: 'Ukraine', 273: 'Russland', 275: 'Lettland', 276: 'Estland', 277: 'Litauen', 278: 'Slowenien', 304: 'Antigua und Barbuda', 305: 'Antigua und Barbuda', 308: 'Bahamas', 309: 'Bahamas', 311: 'Bahamas', 316: 'Kanada', 319: 'Kaimaninseln', 338: 'USA', 345: 'Mexiko', 351: 'Panama', 352: 'Panama', 353: 'Panama', 354: 'Panama', 355: 'Panama', 356: 'Panama', 357: 'Panama', 366: 'USA', 367: 'USA', 368: 'USA', 369: 'USA', 370: 'Panama', 371: 'Panama', 372: 'Panama', 373: 'Panama', 374: 'Panama', 375: 'St. Vincent', 376: 'St. Vincent', 377: 'St. Vincent', 403: 'Saudi-Arabien', 412: 'China', 413: 'China', 414: 'China', 416: 'Taiwan', 419: 'Indien', 422: 'Iran', 431: 'Japan', 432: 'Japan', 440: 'Südkorea', 441: 'Südkorea', 470: 'VAE', 471: 'VAE', 477: 'Hongkong', 503: 'Australien', 512: 'Neuseeland', 525: 'Indonesien', 533: 'Malaysia', 538: 'Marshallinseln', 548: 'Philippinen', 563: 'Singapur', 564: 'Singapur', 565: 'Singapur', 566: 'Singapur', 567: 'Thailand', 574: 'Vietnam', 636: 'Liberia', 637: 'Liberia', 710: 'Brasilien', 725: 'Chile' };
async function schiffInfoZeigen(mmsi) {
  const s = schiffListe.find(x => x[0] === mmsi);
  infoOeffnen(`<div class="i-art" id="iArt">Schiff</div><div class="i-titel">${esc((s && s[7]) || 'MMSI ' + mmsi)}</div><div class="i-unter" id="iUnter"></div>
    <div class="i-raster" id="iWerte">${wert('Status', 'lädt …', 'breit')}</div>
    ${knopfe(`<a href="https://www.marinetraffic.com/de/ais/details/ships/mmsi:${mmsi}" target="_blank" rel="noopener">MarineTraffic ↗</a>`)}`);
  try {
    const d = await (await fetch('api/schiff?mmsi=' + mmsi)).json();
    if (!auswahl || auswahl.id !== mmsi) return;
    auswahl.zusatz = d;
    const g = schiffGruppe(d.typ);
    const land = MID[String(mmsi).slice(0, 3)];
    $('#iArt').textContent = 'Schiff · ' + SCHIFF_ARTEN[g][0];
    $('#iUnter').textContent = [land && 'Flagge: ' + land, d.ziel && 'Ziel: ' + d.ziel].filter(Boolean).join(' · ');
    $('#iWerte').innerHTML = [
      wert('Tempo', d.sog == null ? '–' : `${zahl(d.sog, 1)} kn · ${zahl(d.sog * 1.852, 1)} km/h`, 'breit'),
      wert('Kurs', d.cog == null ? '–' : `${zahl(d.cog)}°`),
      wert('Status', esc(NAV_STATUS[d.nav] || '–')),
      wert('Länge', d.len ? `${zahl(d.len)} m` : '–'),
      wert('Rufzeichen', esc(d.cs || '–')),
      wert('IMO', esc(d.imo || '–')),
      wert('MMSI', esc(mmsi)),
      wert('Ziel', esc(d.ziel || '–'), 'breit'),
      wert('Daten', `${d.q === 'a' ? 'aisstream.io' : 'Digitraffic'} · ${vorZeit(nun() - d.ts)}`, 'breit'),
    ].join('');
  } catch {}
}
function schiffGruppe(t) {
  if (t == null) return 'x';
  if (t === 30) return 'fi';
  if ([31, 32, 33, 34, 50, 52, 53].includes(t)) return 'd';
  if (t === 35) return 'm'; if (t === 51) return 'r';
  if (t === 36 || t === 37) return 's';
  if (t >= 40 && t < 50) return 'h'; if (t >= 60 && t < 70) return 'p';
  if (t >= 70 && t < 80) return 'c'; if (t >= 80 && t < 90) return 't';
  return 'x';
}

function satInfo(i) {
  const s = sats[i]; if (!s) return;
  const neigung = s.rec.inclo / RAD, umlauf = 2 * Math.PI / s.rec.no;
  infoOeffnen(`<div class="i-art">Satellit${s.station ? ' · Raumstation' : ''}</div><div class="i-titel">${esc(s.name)}</div>
    <div class="i-unter">NORAD ${esc(s.nr)} · Umlauf ${zahl(umlauf)} min · Bahnneigung ${zahl(neigung, 1)}°</div>
    <div class="i-raster" id="iWerte"></div>
    ${knopfe(`<a href="https://www.n2yo.com/satellite/?s=${encodeURIComponent(+s.nr)}" target="_blank" rel="noopener">Überflüge ↗</a>`)}
    <div class="i-hinweis">Position aus Bahndaten von CelesTrak berechnet. Gelbe Linie: Bahn der letzten 40 und nächsten 100 Minuten.</div>`);
  quelleSetzen('orbit', { type: 'FeatureCollection', features: [orbitLinie(s)] });
  satWerte();
}
function satWerte() {
  const el = $('#iWerte'); if (!el || !auswahl || auswahl.art !== 'sat') return;
  const p = satPos[auswahl.id]; if (!p) return;
  el.innerHTML = [
    wert('Höhe', `${zahl(p.h)} km`), wert('Tempo', p.v ? `${zahl(p.v * 3600)} km/h` : '–'),
    wert('Breite', `${zahl(p.lat, 2)}°`), wert('Länge', `${zahl(p.lon, 2)}°`),
  ].join('');
}
async function zugInfo(nr) {
  const z = zugListe.find(x => x[0] === nr); if (!z) return;
  infoOeffnen(`<div class="i-art">Zug · Finnland</div><div class="i-titel" id="iTitel">Zug ${esc(nr)}</div><div class="i-unter" id="iUnter"></div>
    <div class="i-raster">${wert('Tempo', `${zahl(z[3])} km/h`)}${wert('Daten', vorZeit(nun() - z[4]))}</div>
    <div class="i-hinweis">Live-Positionen aller Züge in Finnland (Fintraffic). Für Deutschland gibt es leider keine offenen Live-Positionen.</div>`);
  try {
    const d = await (await fetch(`api/zug?nr=${nr}&d=${z[5]}`)).json();
    if (d.art) { $('#iTitel').textContent = `${d.linie ? d.linie + '-Zug' : d.art} ${nr}`; $('#iUnter').textContent = `${d.von} → ${d.nach} · ${d.kat || ''}`; }
  } catch {}
}
const uhr = t => new Date(typeof t === 'string' ? Date.parse(t) : t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
async function bahnInfo(id) {
  const b = bahnListe.find(x => x[0] === id); if (!b) return;
  const art = BAHN_ART[b[2]] || ['r', 'Zug'];
  infoOeffnen(`<div class="i-art">${esc(art[1])}</div><div class="i-titel">${esc(b[1] || art[1])}</div>
    <div class="i-unter" id="iUnter">${b[10] ? 'nächster Halt: ' : 'hält in '}${esc(b[9])}</div>
    <div class="i-raster" id="iWerte"></div><div id="iHalte"></div>
    ${knopfe('')}
    <div class="i-hinweis">Position aus Fahrplan und Echtzeitdaten berechnet – über Transitous (<a href="https://transitous.org/sources/" target="_blank" rel="noopener">Datenquellen</a>).</div>`);
  bahnWerte();
  try {
    const d = await (await fetch('api/bahn/fahrt?id=' + encodeURIComponent(id))).json();
    if (!auswahl || auswahl.id !== id || !d.name) return;
    $('#iUnter').textContent = [d.richtung && 'nach ' + d.richtung, d.betreiber, d.nr && 'Zug ' + d.nr].filter(Boolean).join(' · ');
    const jetztMs = nun() * 1000;
    let naechster = -1;
    const zeilen = d.halte.map((h, i) => {
      const zeit = h.an || h.ab, plan = h.sAn || h.sAb;
      const vs = zeit && plan ? Math.round((Date.parse(zeit) - Date.parse(plan)) / 60000) : 0;
      const vorbei = zeit && Date.parse(h.ab || zeit) < jetztMs;
      if (!vorbei && naechster < 0) naechster = i;
      return `<div class="halt${vorbei ? ' vorbei' : ''}${h.aus ? ' aus' : ''}" data-i="${i}"><span class="zeit">${zeit ? uhr(zeit) : ''}</span><span class="vs">${vs > 0 ? '+' + vs : ''}</span><span class="hname">${esc(h.name)}</span><span class="gleis">${h.gleis ? 'Gl. ' + esc(h.gleis) : ''}</span></div>`;
    });
    $('#iHalte').innerHTML = `<div class="halte-titel">Halte</div><div class="halte">${zeilen.join('')}</div>`;
    const nz = $(`#iHalte .halt[data-i="${Math.max(0, naechster - 1)}"]`);
    if (nz) nz.parentNode.scrollTop = nz.offsetTop - nz.parentNode.offsetTop;
    if (d.linie && d.linie.length > 3) {
      const coords = [];
      for (let i = 0; i < d.linie.length; i += 2) coords.push([d.linie[i + 1], d.linie[i]]);
      quelleSetzen('zuglinie', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { farbe: BAHN_FARBE[art[0]] } }] });
    }
  } catch {}
}
function bahnWerte() {
  const el = $('#iWerte'); if (!el || !auswahl || auswahl.art !== 'bahn') return;
  const b = bahnListe.find(x => x[0] === auswahl.id);
  if (!b) { el.innerHTML = wert('Status', 'gerade nicht im Kartenausschnitt', 'breit'); return; }
  el.innerHTML = [
    wert('Ø Tempo', b[10] ? `${zahl(b[6] * 3.6)} km/h` : 'steht'),
    wert('Verspätung', b[8] ? (b[7] > 0 ? `+${b[7]} min` : 'pünktlich') : 'nur Fahrplan', b[7] >= 5 ? 'warn' : ''),
    wert(b[10] ? 'Nächster Halt' : 'Abfahrt', `${esc(b[9])} · ${uhr(b[11] * 1000)}`, 'breit'),
  ].join('');
}
function nvInfo(id) {
  const v = nvListe.find(x => x[0] === id); if (!v) return;
  const faehre = /TESO|DOEKSEN|WPD/.test(v[3]);
  infoOeffnen(`<div class="i-art">${faehre ? 'Fähre' : 'Bus / Tram / Metro'} · Niederlande</div><div class="i-titel">Linie ${esc(v[4])}</div><div class="i-unter">${esc(BETREIBER[v[3]] || v[3])}</div>
    <div class="i-raster">${wert('Tempo', v[6] == null ? '–' : `${zahl(v[6])} km/h`)}${wert('Fahrzeug', esc(v[8] || '–'))}${wert('Daten', vorZeit(nun() - v[7]), 'breit')}</div>
    <div class="i-hinweis">Alle Busse, Trams, Metros und Fähren in den Niederlanden (OVapi). Die Liniennummer ist teils die interne Nummer des Betreibers.</div>`);
}
function bebenInfo(id) {
  const b = bebenListe.find(x => x[0] === id); if (!b) return;
  infoOeffnen(`<div class="i-art">Erdbeben</div><div class="i-titel">Stärke ${zahl(b[4], 1)}</div><div class="i-unter">${esc(b[5])}</div>
    <div class="i-raster">${wert('Zeit', new Date(b[6] * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }))}${wert('Vor', vorZeit(nun() - b[6]))}${wert('Tiefe', `${zahl(b[3])} km`)}${wert('Tsunami-Hinweis', b[7] ? 'ja' : 'nein', b[7] ? 'warn' : '')}</div>
    <div class="i-knopfe"><a href="${esc(b[8])}" target="_blank" rel="noopener">Bei USGS ansehen ↗</a></div>`);
}
function ereignisInfo(id) {
  const e = ereignisListe.find(x => x[0] === id); if (!e) return;
  infoOeffnen(`<div class="i-art">${esc(EREIGNIS_NAME[e[2]] || 'Naturereignis')}</div><div class="i-titel">${esc(e[1])}</div>
    <div class="i-raster">${wert('Letzte Meldung', new Date(e[5] * 1000).toLocaleDateString('de-DE'))}${wert('Stärke', esc(e[7] || '–'))}</div>
    ${e[6] ? `<div class="i-knopfe"><a href="${esc(e[6])}" target="_blank" rel="noopener">Quelle ↗</a></div>` : ''}
    <div class="i-hinweis">Offene Ereignisse der letzten 60 Tage aus NASA EONET.</div>`);
}

/* -------------------------------------------------------- Klicks & Hover */
const KLICK_EBENEN = ['flug', 'sat', 'sat-station', 'schiff', 'bahn', 'zug', 'nv', 'beben', 'ereignis'];
function treffer(punkt) {
  const da = KLICK_EBENEN.filter(id => karte.getLayer(id));
  const r = 8;
  const fs = karte.queryRenderedFeatures([[punkt.x - r, punkt.y - r], [punkt.x + r, punkt.y + r]], { layers: da });
  if (!fs.length) return null;
  // nächstes Objekt zum Klickpunkt
  let best = null, bd = Infinity;
  for (const f of fs) {
    const c = f.geometry.coordinates, px = karte.project(c);
    const d = (px.x - punkt.x) ** 2 + (px.y - punkt.y) ** 2;
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
function featureZuAuswahl(f) {
  const l = f.layer.id, p = f.properties;
  if (l === 'flug') return ['flug', p.h];
  if (l === 'sat' || l === 'sat-station') return ['sat', p.i];
  if (l === 'schiff') return ['schiff', p.id];
  if (l === 'zug') return ['zug', p.id];
  if (l === 'nv') return ['nv', p.id];
  if (l === 'bahn') return ['bahn', p.id];
  if (l === 'beben') return ['beben', p.id];
  if (l === 'ereignis') return ['ereignis', p.id];
  return null;
}
karte.on('click', e => {
  const f = treffer(e.point);
  if (!f) return;
  const a = featureZuAuswahl(f);
  if (a) auswaehlen(a[0], a[1], false);
});
const tipp = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, maxWidth: '260px' });
const hover = matchMedia('(hover: hover)').matches;
let hoverT = 0;
karte.on('mousemove', e => {
  if (!hover) return;
  if (hoverT) return;
  hoverT = requestAnimationFrame(() => {
    hoverT = 0;
    const f = treffer(e.point);
    karte.getCanvas().style.cursor = f ? 'pointer' : '';
    if (!f) { tipp.remove(); return; }
    const a = featureZuAuswahl(f); let text = '';
    if (!a) { tipp.remove(); return; }
    if (a[0] === 'flug') { const x = flieger.get(a[1]); if (x) text = `<b>${esc(x[1] || x[10] || x[0].toUpperCase())}</b> · ${x[8] ? 'am Boden' : zahl(x[4]) + ' ft'}${x[11] ? ' · ' + esc(x[11]) : ''}`; }
    else if (a[0] === 'sat') text = `<b>${esc(sats[a[1]] && sats[a[1]].name)}</b> · ${zahl(satPos[a[1]] && satPos[a[1]].h)} km`;
    else if (a[0] === 'schiff') { const s = schiffListe.find(x => x[0] === a[1]); if (s) text = `<b>${esc(s[7] || 'MMSI ' + s[0])}</b> · ${zahl(s[3], 1)} kn`; }
    else if (a[0] === 'zug') text = `<b>Zug ${esc(a[1])}</b>`;
    else if (a[0] === 'bahn') { const b = bahnListe.find(x => x[0] === a[1]); if (b) text = `<b>${esc(b[1] || 'Zug')}</b> · ${esc((BAHN_ART[b[2]] || ['', 'Zug'])[1])}${b[8] && b[7] > 0 ? ` · <span style="color:#f87171">+${b[7]} min</span>` : ''}<br>${b[10] ? 'nächster Halt' : 'hält in'} ${esc(b[9])}`; }
    else if (a[0] === 'nv') { const v = nvListe.find(x => x[0] === a[1]); if (v) text = `<b>Linie ${esc(v[4])}</b> · ${esc(BETREIBER[v[3]] || v[3])}`; }
    else if (a[0] === 'beben') { const b = bebenListe.find(x => x[0] === a[1]); if (b) text = `<b>M ${zahl(b[4], 1)}</b> · ${esc(b[5])}`; }
    else if (a[0] === 'ereignis') { const x = ereignisListe.find(y => y[0] === a[1]); if (x) text = esc(x[1]); }
    if (text) tipp.setLngLat(f.geometry.coordinates).setHTML(text).addTo(karte); else tipp.remove();
  });
});
karte.on('mouseout', () => tipp.remove());

/* ----------------------------------------------------------------- Suche */
let sucheT = 0, sucheTreffer = [], sucheIndex = -1;
$('#suche').addEventListener('input', () => { clearTimeout(sucheT); sucheT = setTimeout(suchen, 160); });
$('#suche').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sucheIndex = Math.max(0, Math.min(sucheTreffer.length - 1, sucheIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    $$('#treffer button').forEach((b, i) => b.classList.toggle('aktiv', i === sucheIndex));
  } else if (e.key === 'Enter') { const t = sucheTreffer[Math.max(0, sucheIndex)]; if (t) trefferWaehlen(t); }
  else if (e.key === 'Escape') { $('#treffer').hidden = true; e.target.blur(); }
});
document.addEventListener('click', e => { if (!e.target.closest('.suche')) $('#treffer').hidden = true; });
async function suchen() {
  const q = $('#suche').value.trim().toUpperCase();
  const box = $('#treffer');
  if (q.length < 2) { box.hidden = true; return; }
  const out = [];
  for (const a of flieger.values()) {
    if ((a[1] && a[1].toUpperCase().includes(q)) || (a[10] && a[10].toUpperCase().replace('-', '').includes(q.replace('-', ''))) || a[0].toUpperCase() === q) {
      out.push({ art: 'flug', id: a[0], sym: '✈', name: a[1] || a[10] || a[0].toUpperCase(), klein: [a[10], a[11]].filter(Boolean).join(' · ') || (a[8] ? 'am Boden' : zahl(a[4]) + ' ft') });
      if (out.length >= 8) break;
    }
  }
  for (const b of bahnListe) { if (out.length >= 12) break; if (b[1] && b[1].toUpperCase().replace(/s/g, '').includes(q.replace(/s/g, ''))) out.push({ art: 'bahn', id: b[0], sym: '🚆', name: b[1], klein: (b[10] ? '→ ' : 'in ') + b[9] }); }
  sats.forEach((s, i) => { if (out.length < 14 && s.name.toUpperCase().includes(q)) out.push({ art: 'sat', id: i, sym: '🛰', name: s.name, klein: 'NORAD ' + s.nr }); });
  try {
    const d = await (await fetch('api/schiffe/suche?q=' + encodeURIComponent(q))).json();
    for (const s of d.liste.slice(0, 8)) out.push({ art: 'schiff', id: s[0], sym: '⛴', name: s[1] || 'MMSI ' + s[0], klein: SCHIFF_ARTEN[s[4]][0], la: s[2], lo: s[3] });
  } catch {}
  if ($('#suche').value.trim().toUpperCase() !== q) return;
  sucheTreffer = out; sucheIndex = -1;
  box.innerHTML = out.length ? out.map((t, i) => `<button data-i="${i}"><span class="art">${t.sym}</span><span>${esc(t.name)}</span><span class="klein">${esc(t.klein)}</span></button>`).join('')
    : `<div style="padding:10px;color:var(--leise);font-size:13px">Nichts gefunden. Flüge findet man über Rufzeichen (z. B. DLH400) oder Kennzeichen (D-AIMA).</div>`;
  box.hidden = false;
}
$('#treffer').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) trefferWaehlen(sucheTreffer[+b.dataset.i]); });
function trefferWaehlen(t) {
  $('#treffer').hidden = true; $('#suche').blur();
  if (t.art === 'schiff') {
    if (!st.ebenen.schiff) ebeneSchalten('schiff', true);
    if (!schiffListe.find(x => x[0] === t.id)) schiffListe.push([t.id, t.la, t.lo, 0, 0, null, 'x', t.name, nun(), 0]);
    karte.flyTo({ center: [t.lo, t.la], zoom: Math.max(karte.getZoom(), 9), speed: 1.6 });
    auswaehlen('schiff', t.id, false);
    karte.once('moveend', schiffeLaden);
    return;
  }
  if (t.art === 'flug' && !st.ebenen.flug) ebeneSchalten('flug', true);
  if (t.art === 'sat' && !st.ebenen.sat) ebeneSchalten('sat', true);
  auswaehlen(t.art, t.id, true);
}

/* ---------------------------------------------------------- Bedienelemente */
function ebeneSchalten(e, an) {
  st.ebenen[e] = an; speichern();
  const cb = document.querySelector(`[data-ebene="${e}"]`); if (cb) cb.checked = an;
  document.querySelectorAll(`[data-zu="${e}"]`).forEach(u => u.style.display = an ? '' : 'none');
  sichtbarkeitSetzen();
  if (an) ({ flug: () => { flugWeltLaden(); zellenLaden(); }, schiff: schiffeLaden, sat: satsLaden, zug: () => { zuegeLaden(); zuegeEuropaLaden(); }, beben: bebenLaden, ereignis: ereignisseLaden, radar: radarLaden, nacht: nachtZeichnen }[e] || (() => {}))();
  if (!an && auswahl && auswahl.art === e) auswahlAufheben();
  statusAktualisieren();
}
$$('[data-ebene]').forEach(cb => {
  cb.checked = !!st.ebenen[cb.dataset.ebene];
  document.querySelectorAll(`[data-zu="${cb.dataset.ebene}"]`).forEach(u => u.style.display = cb.checked ? '' : 'none');
  cb.addEventListener('change', () => ebeneSchalten(cb.dataset.ebene, cb.checked));
});
$('#nurMil').checked = st.nurMil; $('#amBoden').checked = st.amBoden;
$('#nurMil').addEventListener('change', e => { st.nurMil = e.target.checked; speichern(); if (st.nurMil) militaerLaden(); flugZeichnen(); });
$('#amBoden').addEventListener('change', e => { st.amBoden = e.target.checked; speichern(); flugZeichnen(); });
$('#satGruppe').value = st.satGruppe;
$('#satGruppe').addEventListener('change', e => {
  st.satGruppe = e.target.value; speichern();
  if (auswahl && auswahl.art === 'sat') auswahlAufheben();
  sats = []; satsRechnen(); satsLaden();
});
$$('#grundkarte button').forEach(b => {
  b.classList.toggle('an', b.dataset.k === st.grund);
  b.addEventListener('click', () => {
    if (st.grund === b.dataset.k) return;
    st.grund = b.dataset.k; speichern();
    $$('#grundkarte button').forEach(x => x.classList.toggle('an', x === b));
    karte.setStyle(STILE[st.grund], { diff: false });
  });
});
$$('#projektion button').forEach(b => {
  b.classList.toggle('an', b.dataset.p === st.proj);
  b.addEventListener('click', () => {
    st.proj = b.dataset.p; speichern();
    $$('#projektion button').forEach(x => x.classList.toggle('an', x === b));
    projektionSetzen();
  });
});
function projektionSetzen() {
  try { karte.setProjection({ type: st.proj === 'mercator' ? 'mercator' : 'globe' }); } catch (e) { console.warn(e); }
}
$('#ebenenKnopf').addEventListener('click', () => $('#ebenen').classList.toggle('offen'));
$('#infoZu').addEventListener('click', auswahlAufheben);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#info').hidden && document.activeElement !== $('#suche')) auswahlAufheben(); });
karte.on('dragstart', () => {
  if (folgen) { folgen = false; const k = $('#folgenKnopf'); if (k) { k.classList.remove('an'); k.textContent = 'Verfolgen'; } }
  if (innerWidth <= 760) $('#ebenen').classList.remove('offen');
});

/* ------------------------------------------------------------------ Status */
let statusT = 0, statusFest = '';
function zeigeStatus(text, ms) {
  clearTimeout(statusT); statusT = 0;
  const el = $('#status');
  if (!text) { el.textContent = statusFest; el.classList.toggle('an', !!statusFest); return; }
  el.textContent = text; el.classList.add('an');
  if (ms) statusT = setTimeout(() => { statusT = 0; zeigeStatus('', 0); }, ms);
}
function statusAktualisieren() {
  if (!st.ebenen.flug) statusFest = '';
  else if (karte.getZoom() >= 4.5) statusFest = 'Live · Flugzeuge im Ausschnitt werden laufend aktualisiert';
  else statusFest = `Weltweit: Flugdaten ${flugWeltZeit ? vorZeit(Date.now() / 1000 - flugWeltZeit / 1000) : '…'} – zum Live-Verfolgen hineinzoomen`;
  if (!statusT) zeigeStatus('', 0);
}

/* ---------------------------------------------------------------- Abläufe */
function allesZeichnen() {
  flugZeichnen(); schiffeZeichnen(); satsRechnen(); nachtZeichnen(); bebenZeichnen();
  bahnZeichnen(); zuegeEuropaZeichnen();
  if (ereignisListe.length) quelleSetzen('ereignis', { type: 'FeatureCollection', features: ereignisListe.map(e => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e[4], e[3]] }, properties: { id: e[0], k: EREIGNIS_SYM[e[2]] ? e[2] : 'sonst' } })) });
  if (auswahl) { const a = auswahl; auswahl = null; auswaehlen(a.art, a.id, false); }
}
function wiederholen(fn, ms) {
  const lauf = async () => {
    try { if (!document.hidden) await fn(); } catch (e) { console.warn(e); }
    setTimeout(lauf, typeof ms === 'function' ? ms() : ms);
  };
  lauf();
}

let gestartet = false;
karte.on('style.load', () => {
  projektionSetzen();
  ebenenAufbauen();
  if (gestartet) return;
  gestartet = true;
  wiederholen(flugWeltLaden, 60e3);
  wiederholen(zellenLaden, 4000);
  wiederholen(militaerLaden, 60e3);
  wiederholen(schiffeLaden, () => karte.getZoom() >= 6 ? 10e3 : 30e3);
  wiederholen(zuegeLaden, 15e3);
  wiederholen(zuegeEuropaLaden, 5000);
  wiederholen(bebenLaden, 60e3);
  wiederholen(ereignisseLaden, 15 * 60e3);
  wiederholen(radarLaden, 5 * 60e3);
  satsLaden();
  // Bewegung: Flugzeuge weiterrechnen, Satelliten, Nachtgrenze
  wiederholen(() => {
    if (st.ebenen.flug) flugZeichnen();
    if (st.ebenen.zug && bahnListe.length) zuegeEuropaZeichnen();
    auswahlAktualisieren();
  }, () => karte.getZoom() < 3 ? 3000 : 1000);
  wiederholen(() => { if (st.ebenen.sat && sats.length) satsRechnen(); }, () => sats.length > 2000 ? 3000 : 1000);
  wiederholen(() => { nachtZeichnen(); bebenZeichnen(); statusAktualisieren(); }, 60e3);
  // Puls für frische Erdbeben
  let phase = 0;
  setInterval(() => {
    if (!st.ebenen.beben || document.hidden || !karte.getLayer('beben-puls')) return;
    phase = (phase + 0.05) % 1;
    karte.setPaintProperty('beben-puls', 'circle-radius', 6 + phase * 22);
    karte.setPaintProperty('beben-puls', 'circle-stroke-opacity', 0.9 * (1 - phase));
  }, 110);
});
let ladenT = 0;
karte.on('moveend', () => {
  const c = karte.getCenter();
  st.mitte = [+c.lng.toFixed(3), +c.lat.toFixed(3)]; st.zoom = +karte.getZoom().toFixed(2); speichern();
  clearTimeout(ladenT);
  ladenT = setTimeout(() => { schiffeLaden(); zellenLaden(); zuegeEuropaLaden(); statusAktualisieren(); }, 500);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { flugWeltLaden(); zellenLaden(); schiffeLaden(); } });
