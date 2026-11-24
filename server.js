'use strict';
// Weltblick – Live-Weltkarte (Flugzeuge, Schiffe, Satelliten, Züge, Erdbeben, Radar, Naturereignisse).
// Ohne Fremdpakete. Holt freie Live-Daten, puffert sie und liefert sie kompakt an die Karte.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = +(process.env.WK_PORT || 4210);
const HOST = process.env.WK_HOST || '127.0.0.1';
const DATEN = process.env.WK_DATEN || path.join(require('os').tmpdir(), 'weltkarte-daten');
const OEFFENTLICH = path.join(__dirname, 'public');
const UA = 'Weltblick/1.0';
const AIS_KEY = (process.env.AISSTREAM_KEY || '').trim();
const OS_ID = (process.env.OPENSKY_CLIENT_ID || '').trim();
const OS_GEHEIM = (process.env.OPENSKY_CLIENT_SECRET || '').trim();
const ATTRAPPE = process.env.WK_ATTRAPPE === '1'; // nur für Tests: keine echten Abrufe

fs.mkdirSync(DATEN, { recursive: true });

const jetzt = () => Date.now();
const sek = () => Math.floor(Date.now() / 1000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const runde = (x, n) => (x == null || isNaN(x) ? null : Math.round(x * 10 ** n) / 10 ** n);

async function holen(url, opt = {}) {
  if (ATTRAPPE) throw new Error('Attrappe');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opt.timeout || 20000);
  try {
    const r = await fetch(url, {
      method: opt.method || 'GET',
      headers: { 'User-Agent': UA, Accept: opt.accept || 'application/json', ...(opt.headers || {}) },
      body: opt.body,
      signal: ctl.signal,
    });
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status + ' ' + url.split('?')[0]);
      e.status = r.status; e.headers = r.headers;
      throw e;
    }
    return opt.roh ? r : (opt.text ? r.text() : r.json());
  } finally { clearTimeout(t); }
}

// Einfacher Puffer: liefert sofort den letzten Stand und frischt im Hintergrund auf.
function puffer(ttl, fn) {
  let wert = null, zeit = 0, laeuft = null;
  const frischen = () => {
    if (laeuft) return laeuft;
    laeuft = fn().then(v => { wert = v; zeit = jetzt(); return v; })
      .catch(e => { log('Fehler:', e.message); return wert; })
      .finally(() => { laeuft = null; });
    return laeuft;
  };
  return async () => {
    if (wert && jetzt() - zeit < ttl) return wert;
    if (wert) { frischen(); return wert; }
    return frischen();
  };
}

/* ------------------------------------------------------------------ Flugzeuge */
// Kompaktes Format je Flugzeug:
// [hex, rufzeichen, lat, lon, hoeheFt|null, speedKt, kurs, steigFpm, amBoden 0/1, zeitSek, kennz, typ, squawk,
//  quelle (o=OpenSky, l=adsb.lol, f=adsb.fi), militaer 0/1, kategorie, beschreibung, betreiber, land]
const flugWelt = { liste: [], zeit: 0, quelle: 'opensky' };
const zellen = new Map(); // id -> { zeit, liste }
let osToken = null, osTokenBis = 0, osNaechster = 0;

function osIntervall() { return OS_ID ? 90e3 : 15 * 60e3; }

async function osTokenHolen() {
  if (osToken && jetzt() < osTokenBis - 60e3) return osToken;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: OS_ID, client_secret: OS_GEHEIM });
  const j = await holen('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  osToken = j.access_token; osTokenBis = jetzt() + (j.expires_in || 1800) * 1000;
  return osToken;
}

async function openskyHolen() {
  const headers = {};
  if (OS_ID) headers.Authorization = 'Bearer ' + await osTokenHolen();
  let r;
  try {
    r = await holen('https://opensky-network.org/api/states/all', { headers, roh: true, timeout: 40000 });
  } catch (e) {
    if (e.status === 429) {
      const warte = +(e.headers && e.headers.get('x-rate-limit-retry-after-seconds')) || 3600;
      osNaechster = jetzt() + Math.min(warte, 6 * 3600) * 1000;
      log('OpenSky-Limit erreicht, nächster Versuch in', Math.round(warte / 60), 'min');
    }
    throw e;
  }
  const rest = r.headers.get('x-rate-limit-remaining');
  const j = await r.json();
  const liste = [];
  for (const s of j.states || []) {
    if (s[6] == null || s[5] == null) continue;
    const hoeheM = s[7] != null ? s[7] : s[13];
    liste.push([
      s[0], (s[1] || '').trim(), runde(s[6], 4), runde(s[5], 4),
      s[8] ? 0 : (hoeheM == null ? null : Math.round(hoeheM * 3.28084)),
      s[9] == null ? null : runde(s[9] * 1.94384, 0), s[10] == null ? null : runde(s[10], 0),
      s[11] == null ? null : Math.round(s[11] * 196.85), s[8] ? 1 : 0, s[3] || j.time,
      '', '', s[14] || '', 'o', 0, '', '', '', s[2] || '',
    ]);
  }
  flugWelt.liste = liste; flugWelt.zeit = (j.time || sek()) * 1000;
  try { fs.writeFileSync(path.join(DATEN, 'opensky.json'), JSON.stringify(flugWelt)); } catch {}
  log('OpenSky:', liste.length, 'Flugzeuge, Rest-Kontingent', rest);
  if (rest != null && +rest < 8) osNaechster = Math.max(osNaechster, jetzt() + 3 * 3600e3);
}

function openskyTakt() {
  const faellig = jetzt() >= osNaechster && jetzt() - flugWelt.zeit >= osIntervall() - 5000;
  if (faellig) {
    osNaechster = jetzt() + 60e3; // Doppelabrufe vermeiden
    openskyHolen().catch(e => log('OpenSky:', e.message));
  }
}

try {
  const alt = JSON.parse(fs.readFileSync(path.join(DATEN, 'opensky.json'), 'utf8'));
  if (alt && Array.isArray(alt.liste)) Object.assign(flugWelt, alt);
} catch {}

// readsb-Format (adsb.lol / adsb.fi) in das kompakte Format umwandeln
function readsbUmwandeln(j, quelle) {
  const t = j.now ? j.now / 1000 : sek();
  const out = [];
  for (const a of j.ac || j.aircraft || []) {
    if (a.lat == null || a.lon == null) continue;
    const boden = a.alt_baro === 'ground';
    const hoehe = boden ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : (a.alt_geom != null ? a.alt_geom : null));
    out.push([
      a.hex, (a.flight || '').trim(), runde(a.lat, 4), runde(a.lon, 4), hoehe,
      a.gs == null ? null : runde(a.gs, 0), runde(a.track != null ? a.track : (a.true_heading != null ? a.true_heading : a.mag_heading), 0),
      a.baro_rate != null ? a.baro_rate : (a.geom_rate != null ? a.geom_rate : null), boden ? 1 : 0,
      Math.round(t - (a.seen_pos || 0)), a.r || '', a.t || '', a.squawk || '', quelle,
      (a.dbFlags & 1) ? 1 : 0, a.category || '', a.desc || '', a.ownOp || '',
    ]);
  }
  return out;
}

// Zellen-Raster: Breiten-Bänder à 5°, Längen-Schritt je Band so, dass ein Kreis mit 250 NM die Zelle deckt.
const ZELL_LAT = 5;
function zellMitte(id) {
  const [i, k] = id.split('_').map(Number);
  if (!Number.isInteger(i) || !Number.isInteger(k) || i < 0 || i >= 36) return null;
  const lat = -90 + ZELL_LAT * (i + 0.5);
  const polnah = Math.min(89, Math.abs(lat) + ZELL_LAT / 2);
  const n = Math.max(1, Math.ceil(360 / (ZELL_LAT / Math.cos(polnah * Math.PI / 180))));
  if (k < 0 || k >= n) return null;
  return { lat, lon: -180 + (360 / n) * (k + 0.5) };
}

const warteschlange = [];
let schlangeTakt = 0;
function zelleAnfordern(id) {
  const z = zellen.get(id);
  if (z && (z.laedt || jetzt() - z.zeit < 8000)) return;
  if (warteschlange.includes(id)) return;
  if (warteschlange.length > 60) warteschlange.shift();
  warteschlange.push(id);
}
async function zelleLaden(id, quelle) {
  const m = zellMitte(id); if (!m) return;
  const z = zellen.get(id) || { zeit: 0, liste: [] };
  z.laedt = true; zellen.set(id, z);
  try {
    const url = quelle === 'f'
      ? `https://opendata.adsb.fi/api/v2/lat/${m.lat.toFixed(2)}/lon/${m.lon.toFixed(2)}/dist/250`
      : `https://api.adsb.lol/v2/point/${m.lat.toFixed(2)}/${m.lon.toFixed(2)}/250`;
    const j = await holen(url, { timeout: 12000 });
    z.liste = readsbUmwandeln(j, quelle === 'f' ? 'f' : 'l');
    z.zeit = jetzt();
  } catch (e) {
    z.zeit = jetzt() - 2000; // kurz warten, dann erneut
    if (e.status === 429) pause[quelle] = jetzt() + 60e3;
    if (!/Attrappe/.test(e.message)) log('Zelle', id, e.message);
  } finally { z.laedt = false; }
}
// Takt alle 550 ms, abwechselnd adsb.lol und adsb.fi (je höchstens etwa 1 Abruf pro Sekunde).
// Meldet eine Quelle „zu viele Anfragen“, pausiert sie eine Minute.
const pause = { l: 0, f: 0 };
setInterval(() => {
  if (!warteschlange.length) return;
  schlangeTakt++;
  let quelle = schlangeTakt % 2 ? 'l' : 'f';
  if (pause[quelle] > jetzt()) quelle = quelle === 'l' ? 'f' : 'l';
  if (pause[quelle] > jetzt()) return;
  zelleLaden(warteschlange.shift(), quelle);
}, 550);
// Alte Zellen aufräumen
setInterval(() => { for (const [id, z] of zellen) if (jetzt() - z.zeit > 10 * 60e3 && !z.laedt) zellen.delete(id); }, 60e3);

const militaer = puffer(20000, async () => readsbUmwandeln(await holen('https://api.adsb.lol/v2/mil'), 'l').map(a => (a[14] = 1, a)));

let weltCache = { zeit: 0, json: null };
function flugWeltAusgabe() {
  if (weltCache.json && jetzt() - weltCache.zeit < 5000) return weltCache.json;
  const nach = new Map();
  for (const a of flugWelt.liste) nach.set(a[0], a);
  for (const z of zellen.values()) {
    if (jetzt() - z.zeit > 120e3) continue;
    for (const a of z.liste) {
      const alt = nach.get(a[0]);
      if (!alt || alt[9] <= a[9]) nach.set(a[0], a);
    }
  }
  weltCache = { zeit: jetzt(), json: JSON.stringify({ zeit: flugWelt.zeit, jetzt: sek(), liste: [...nach.values()] }) };
  return weltCache.json;
}

const infoPuffer = new Map();
async function flugInfo(hex, cs) {
  const schluessel = hex + '|' + cs;
  const p = infoPuffer.get(schluessel);
  if (p && jetzt() - p.zeit < 6 * 3600e3) return p.wert;
  const [route, flieger] = await Promise.all([
    cs ? holen('https://api.adsbdb.com/v0/callsign/' + encodeURIComponent(cs), { timeout: 8000 }).then(j => j.response && j.response.flightroute).catch(() => null) : null,
    hex ? holen('https://api.adsbdb.com/v0/aircraft/' + encodeURIComponent(hex), { timeout: 8000 }).then(j => j.response && j.response.aircraft).catch(() => null) : null,
  ]);
  const flughafen = f => f && { iata: f.iata_code, icao: f.icao_code, name: f.name, ort: f.municipality, land: f.country_name, lat: f.latitude, lon: f.longitude };
  const wert = {
    route: route ? { airline: route.airline && route.airline.name, von: flughafen(route.origin), nach: flughafen(route.destination) } : null,
    flieger: flieger ? { typ: flieger.type, hersteller: flieger.manufacturer, icaoTyp: flieger.icao_type, kennz: flieger.registration, halter: flieger.registered_owner, land: flieger.registered_owner_country_name, foto: flieger.url_photo_thumbnail || flieger.url_photo } : null,
  };
  infoPuffer.set(schluessel, { zeit: jetzt(), wert });
  if (infoPuffer.size > 5000) infoPuffer.delete(infoPuffer.keys().next().value);
  return wert;
}

/* -------------------------------------------------------------------- Schiffe */
const schiffe = new Map(); // mmsi -> {la, lo, sog, cog, hdg, nav, ts, name, typ, ziel, cs, imo, len, q}
let aisStatus = AIS_KEY ? 'verbinde' : 'aus';

function schiffSetzen(mmsi, w) {
  if (!mmsi) return;
  const s = schiffe.get(mmsi) || { mmsi };
  for (const k in w) if (w[k] != null && w[k] !== '') s[k] = w[k];
  schiffe.set(mmsi, s);
}

async function digitrafficOrte() {
  const j = await holen('https://meri.digitraffic.fi/api/ais/v1/locations', { headers: { 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'Weltblick' } });
  for (const f of j.features || []) {
    const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
    if (!c) continue;
    schiffSetzen(f.mmsi, { la: c[1], lo: c[0], sog: p.sog, cog: p.cog, hdg: p.heading === 511 ? null : p.heading, nav: p.navStat, ts: Math.round((p.timestampExternal || jetzt()) / 1000), q: 'd' });
  }
}
async function digitrafficSchiffe() {
  const j = await holen('https://meri.digitraffic.fi/api/ais/v1/vessels', { headers: { 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'Weltblick' } });
  for (const v of j || []) {
    schiffSetzen(v.mmsi, { name: (v.name || '').trim(), typ: v.shipType, ziel: (v.destination || '').trim(), cs: (v.callSign || '').trim(), imo: v.imo || null, len: (v.referencePointA || 0) + (v.referencePointB || 0) || null });
  }
}
function digitrafficTakt() { digitrafficOrte().catch(e => log('Digitraffic:', e.message)); }
setInterval(digitrafficTakt, 60e3);
setInterval(() => digitrafficSchiffe().catch(e => log('Digitraffic-Schiffe:', e.message)), 30 * 60e3);

function aisstreamStarten() {
  if (!AIS_KEY || typeof WebSocket === 'undefined') return;
  let verzoegerung = 5000;
  const verbinden = () => {
    aisStatus = 'verbinde';
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.binaryType = 'arraybuffer';
    let zaehler = 0;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        APIKey: AIS_KEY, BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'],
      }));
    };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.error) { log('aisstream:', m.error); aisStatus = 'fehler: ' + m.error; return; }
      aisStatus = 'live'; verzoegerung = 5000;
      if (++zaehler % 50000 === 0) log('aisstream:', zaehler, 'Meldungen,', schiffe.size, 'Schiffe');
      const md = m.MetaData || {}, mm = m.Message || {};
      const mmsi = md.MMSI;
      const name = (md.ShipName || '').trim();
      const pos = mm.PositionReport || mm.StandardClassBPositionReport || mm.ExtendedClassBPositionReport;
      if (pos) {
        if (Math.abs(pos.Latitude) > 90 || Math.abs(pos.Longitude) > 180) return;
        schiffSetzen(mmsi, {
          la: runde(pos.Latitude, 5), lo: runde(pos.Longitude, 5), sog: pos.Sog > 102 ? null : pos.Sog, cog: pos.Cog >= 360 ? null : pos.Cog,
          hdg: pos.TrueHeading === 511 ? null : pos.TrueHeading, nav: pos.NavigationalStatus, ts: sek(), q: 'a', name: name || undefined,
          typ: mm.ExtendedClassBPositionReport ? mm.ExtendedClassBPositionReport.Type : undefined,
        });
      }
      const st = mm.ShipStaticData;
      if (st) {
        const d = st.Dimension || {};
        schiffSetzen(mmsi, { name: (st.Name || name || '').trim(), typ: st.Type, ziel: (st.Destination || '').trim(), cs: (st.CallSign || '').trim(), imo: st.ImoNumber || null, len: (d.A || 0) + (d.B || 0) || null, tief: st.MaximumStaticDraught || null });
      }
      const sd = mm.StaticDataReport;
      if (sd) {
        const a = sd.ReportA, b = sd.ReportB;
        if (a && a.Valid) schiffSetzen(mmsi, { name: (a.Name || '').trim() });
        if (b && b.Valid) schiffSetzen(mmsi, { typ: b.ShipType, cs: (b.CallSign || '').trim() });
      }
    };
    const neu = () => {
      if (aisStatus === 'live') aisStatus = 'getrennt';
      setTimeout(verbinden, verzoegerung);
      verzoegerung = Math.min(verzoegerung * 2, 5 * 60e3);
    };
    ws.onclose = neu;
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  verbinden();
}

// Alte Schiffs-Positionen entfernen (über 2 h ohne Meldung) und den Stand sichern,
// damit nach einem Neustart nicht alle Schiffe fehlen
const SCHIFF_DATEI = path.join(DATEN, 'schiffe.json');
try {
  const alt = JSON.parse(fs.readFileSync(SCHIFF_DATEI, 'utf8'));
  const grenze = sek() - 2 * 3600;
  for (const s of alt) if (s.ts >= grenze) schiffe.set(s.mmsi, s);
  log('Schiffe aus Sicherung:', schiffe.size);
} catch {}
setInterval(() => {
  const grenze = sek() - 2 * 3600;
  for (const [k, s] of schiffe) if (!s.ts || s.ts < grenze) schiffe.delete(k);
  if (ATTRAPPE) return;
  fs.writeFile(SCHIFF_DATEI + '.tmp', JSON.stringify([...schiffe.values()]), e => {
    if (!e) fs.rename(SCHIFF_DATEI + '.tmp', SCHIFF_DATEI, () => {});
  });
}, 5 * 60e3);

function typGruppe(t) {
  if (t == null) return 'x';
  if (t === 30) return 'fi';
  if (t === 31 || t === 32 || t === 52 || t === 53 || t === 50 || t === 33 || t === 34) return 'd';
  if (t === 35) return 'm';
  if (t === 51) return 'r';
  if (t === 36 || t === 37) return 's';
  if (t >= 40 && t < 50) return 'h';
  if (t >= 60 && t < 70) return 'p';
  if (t >= 70 && t < 80) return 'c';
  if (t >= 80 && t < 90) return 't';
  return 'x';
}

function schiffeAusgabe(b, z) {
  const [w, s, o, n] = b;
  const quer = w > o; // über die Datumsgrenze
  const treffer = [];
  for (const sc of schiffe.values()) {
    if (sc.la == null) continue;
    if (sc.la < s || sc.la > n) continue;
    if (quer ? (sc.lo < w && sc.lo > o) : (sc.lo < w || sc.lo > o)) continue;
    treffer.push(sc);
  }
  const grenze = z < 4 ? 20000 : 30000;
  let liste = treffer;
  if (treffer.length > grenze) {
    // Fahrende Schiffe zuerst, dann gleichmäßig ausdünnen
    treffer.sort((a, b2) => (b2.sog || 0) - (a.sog || 0));
    const schritt = treffer.length / grenze;
    liste = [];
    for (let i = 0; i < grenze; i++) liste.push(treffer[Math.floor(i * schritt)]);
  }
  return {
    jetzt: sek(), gesamt: schiffe.size, imBild: treffer.length, ais: aisStatus,
    liste: liste.map(sc => [sc.mmsi, sc.la, sc.lo, sc.sog == null ? null : runde(sc.sog, 1), sc.cog == null ? null : Math.round(sc.cog), sc.hdg == null ? null : sc.hdg, typGruppe(sc.typ), sc.name || '', sc.ts, sc.len || 0]),
  };
}

/* ----------------------------------------------------------------- Satelliten */
const SAT_GRUPPEN = { stations: 'stations', visual: 'visual', starlink: 'starlink', active: 'active', gnss: 'gnss', weather: 'weather', geo: 'geo', science: 'science', oneweb: 'oneweb', amateur: 'amateur', neu: 'last-30-days' };
const satLaeuft = new Map();
async function satGruppe(g) {
  const datei = path.join(DATEN, 'sat-' + g + '.txt');
  let st = null;
  try { st = fs.statSync(datei); } catch {}
  if (st && jetzt() - st.mtimeMs < 6 * 3600e3) return fs.readFileSync(datei, 'utf8');
  if (!satLaeuft.has(g)) {
    satLaeuft.set(g, holen(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${SAT_GRUPPEN[g]}&FORMAT=tle`, { text: true, accept: 'text/plain', timeout: 60000 })
      .then(t => { if (/\n1 [0-9A-Z ]{5}/.test(t)) fs.writeFileSync(datei, t); return t; })
      .finally(() => satLaeuft.delete(g)));
  }
  try { return await satLaeuft.get(g); } catch (e) {
    if (st) return fs.readFileSync(datei, 'utf8');
    throw e;
  }
}

/* ------------------------------------------------- Züge, Erdbeben, Radar, Ereignisse */
const zuege = puffer(10000, async () => {
  const j = await holen('https://rata.digitraffic.fi/api/v1/train-locations/latest', { headers: { 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'Weltblick' } });
  return j.map(t => [t.trainNumber, runde(t.location.coordinates[1], 5), runde(t.location.coordinates[0], 5), t.speed, Math.round(Date.parse(t.timestamp) / 1000), t.departureDate]);
});
const zugInfo = new Map();
async function zugDetails(nr, datum) {
  const k = nr + '|' + datum;
  if (zugInfo.has(k)) return zugInfo.get(k);
  const j = await holen(`https://rata.digitraffic.fi/api/v1/trains/${encodeURIComponent(datum)}/${encodeURIComponent(nr)}`, { headers: { 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'Weltblick' } });
  const t = j && j[0];
  const w = t ? { art: t.trainType, kat: t.trainCategory, linie: t.commuterLineID || '', von: t.timeTableRows[0] && t.timeTableRows[0].stationShortCode, nach: t.timeTableRows.length && t.timeTableRows[t.timeTableRows.length - 1].stationShortCode } : null;
  zugInfo.set(k, w);
  if (zugInfo.size > 3000) zugInfo.delete(zugInfo.keys().next().value);
  return w;
}

// Busse, Trams, Metros und Fähren in den Niederlanden (OVapi, GTFS-Realtime als Protobuf)
function pbVarint(b, i) { let r = 0, m = 1, x; do { x = b[i++]; r += (x & 0x7f) * m; m *= 128; } while (x & 0x80); return [r, i]; }
function pbFelder(b, s, e) {
  const out = []; let i = s;
  while (i < e) {
    let t; [t, i] = pbVarint(b, i);
    const f = Math.floor(t / 8), w = t & 7;
    if (w === 0) { let v; [v, i] = pbVarint(b, i); out.push([f, w, v]); }
    else if (w === 2) { let l; [l, i] = pbVarint(b, i); out.push([f, w, i, i + l]); i += l; }
    else if (w === 5) { out.push([f, w, i]); i += 4; }
    else if (w === 1) { out.push([f, w, i]); i += 8; }
    else throw new Error('Protobuf: Drahttyp ' + w);
  }
  return out;
}
const nahverkehr = puffer(20000, async () => {
  const r = await holen('https://gtfs.ovapi.nl/nl/vehiclePositions.pb', { roh: true, accept: 'application/x-protobuf', timeout: 30000 });
  const b = Buffer.from(await r.arrayBuffer());
  const out = [], grenze = sek() - 600;
  for (const f of pbFelder(b, 0, b.length)) {
    if (f[0] !== 2 || f[1] !== 2) continue;
    let id = '', lat = null, lon = null, kurs = null, tempo = null, ts = 0, nr = '';
    try {
      for (const g of pbFelder(b, f[2], f[3])) {
        if (g[0] === 1 && g[1] === 2) id = b.toString('utf8', g[2], g[3]);
        if (g[0] !== 4 || g[1] !== 2) continue;
        for (const h of pbFelder(b, g[2], g[3])) {
          if (h[0] === 2 && h[1] === 2) for (const k of pbFelder(b, h[2], h[3])) {
            if (k[1] !== 5) continue;
            const v = b.readFloatLE(k[2]);
            if (k[0] === 1) lat = v; else if (k[0] === 2) lon = v; else if (k[0] === 3) kurs = v; else if (k[0] === 5) tempo = v;
          }
          if (h[0] === 5 && h[1] === 0) ts = h[2];
          if (h[0] === 8 && h[1] === 2) for (const k of pbFelder(b, h[2], h[3])) if (k[0] === 2 && k[1] === 2) nr = b.toString('utf8', k[2], k[3]);
        }
      }
    } catch { continue; }
    if (!lat || !lon || ts < grenze) continue;
    const teile = id.split(':'); // Datum:BETREIBER:LINIE:FAHRT
    out.push([id, runde(lat, 5), runde(lon, 5), teile[1] || '', teile[2] || '', kurs == null ? null : Math.round(kurs), tempo == null ? null : Math.round(tempo * 3.6), ts, nr]);
  }
  return out;
});

/* ------------------------------------------------------- Bahnen (Transitous / MOTIS) */
// Transitous (transitous.org) rechnet aus Fahrplänen + Echtzeitdaten ganz Europas (und weiterer Länder)
// die Fahrten im Kartenausschnitt. Wir holen sie je Kachel höchstens alle 2,5 min, eine Anfrage nach der anderen.
const TR_UA = 'Weltblick/1.0 (+' + (process.env.WK_KONTAKT || 'https://github.com/oerguen/weltblick') + ')';
const BAHN_MODI = new Set(['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL', 'REGIONAL_FAST_RAIL', 'REGIONAL_RAIL', 'RAIL', 'METRO', 'SUBURBAN', 'SUBWAY', 'TRAM', 'FERRY', 'FUNICULAR', 'CABLE_CAR', 'AERIAL_LIFT', 'AREAL_LIFT']);
const STADT_MODI = new Set(['TRAM', 'SUBWAY', 'METRO', 'FERRY']);
const bahnKacheln = new Map(); // "q:z/x/y" -> { zeit, benutzt, laedt, segs }
const bahnSchlange = [];
let bahnPause = 0;

function polyDekodieren(s, p, minAbst) {
  const f = 10 ** p, out = [];
  let i = 0, la = 0, lo = 0, lla = 1e9, llo = 1e9;
  while (i < s.length) {
    let b, sh = 0, r = 0;
    do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
    la += (r & 1) ? ~(r >> 1) : (r >> 1);
    sh = 0; r = 0;
    do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
    lo += (r & 1) ? ~(r >> 1) : (r >> 1);
    const a = la / f, o = lo / f;
    if (i >= s.length || Math.abs(a - lla) + Math.abs(o - llo) >= minAbst) { out.push(a, o); lla = a; llo = o; }
  }
  return out;
}
function abstandM(a1, o1, a2, o2) {
  const x = (o2 - o1) * Math.cos((a1 + a2) / 2 * Math.PI / 180), y = a2 - a1;
  return Math.sqrt(x * x + y * y) * 111320;
}
function kachelBox(z, x, y) {
  const n = 2 ** z, lat = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI;
  return { s: lat(y + 1), n: lat(y), w: x / n * 360 - 180, o: (x + 1) / n * 360 - 180 };
}
async function bahnKachelLaden(schluessel) {
  const k = bahnKacheln.get(schluessel); if (!k) return;
  const [q, rest] = schluessel.split(':');
  const [z, x, y] = rest.split('/').map(Number);
  const b = kachelBox(z, x, y), t = jetzt();
  k.laedt = true;
  try {
    const url = `https://api.transitous.org/api/v1/map/trips?min=${b.s.toFixed(4)},${b.w.toFixed(4)}&max=${b.n.toFixed(4)},${b.o.toFixed(4)}`
      + `&startTime=${new Date(t - 60e3).toISOString()}&endTime=${new Date(t + 6 * 60e3).toISOString()}&zoom=${q}`;
    const liste = await holen(url, { headers: { 'User-Agent': TR_UA }, timeout: 40000 });
    const minAbst = +q <= 6 ? 0.004 : +q <= 8 ? 0.0015 : 0.0004;
    const segs = [];
    for (const s of Array.isArray(liste) ? liste : []) {
      if (!BAHN_MODI.has(s.mode) || !s.polyline) continue;
      const tr = (s.trips && s.trips[0]) || {};
      const quelle = String(tr.tripId || '').split('_')[2] || '';
      if (quelle.startsWith('fi-') && !STADT_MODI.has(s.mode)) continue; // Finnland kommt per GPS
      if (quelle.startsWith('nl-') && STADT_MODI.has(s.mode)) continue;  // NL-Nahverkehr kommt per GPS
      const pts = polyDekodieren(s.polyline, 5, minAbst);
      if (pts.length < 4) continue;
      const cum = new Float64Array(pts.length / 2);
      for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + abstandM(pts[2 * i - 2], pts[2 * i - 1], pts[2 * i], pts[2 * i + 1]);
      segs.push({
        id: tr.tripId, name: tr.routeShortName || '', mode: s.mode,
        von: s.from && s.from.name, nach: s.to && s.to.name,
        dep: Date.parse(s.departure), arr: Date.parse(s.arrival),
        sdep: Date.parse(s.scheduledDeparture || s.departure), sarr: Date.parse(s.scheduledArrival || s.arrival),
        rt: s.realTime ? 1 : 0, pts: Float32Array.from(pts), cum,
      });
    }
    k.segs = segs; k.zeit = jetzt();
  } catch (e) {
    k.zeit = jetzt() - 120e3; // in etwa 30 s erneut
    if (e.status === 429) bahnPause = jetzt() + 5 * 60e3;
    if (!/Attrappe/.test(e.message)) log('Transitous', schluessel, e.message);
  } finally { k.laedt = false; }
}
setInterval(() => {
  if (!bahnSchlange.length || bahnPause > jetzt()) return;
  if ([...bahnKacheln.values()].some(k => k.laedt)) return; // nur eine Anfrage zur Zeit
  bahnKachelLaden(bahnSchlange.shift());
}, 1500);
setInterval(() => { for (const [s, k] of bahnKacheln) if (jetzt() - k.benutzt > 10 * 60e3 && !k.laedt) bahnKacheln.delete(s); }, 60e3);

function bahnPosition(seg, t) {
  const f = Math.min(1, Math.max(0, (t - seg.dep) / Math.max(1, seg.arr - seg.dep)));
  const ziel = f * seg.cum[seg.cum.length - 1];
  let lo = 0, hi = seg.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (seg.cum[m] <= ziel) lo = m; else hi = m; }
  const d = seg.cum[hi] - seg.cum[lo], g = d > 0 ? (ziel - seg.cum[lo]) / d : 0;
  const a1 = seg.pts[2 * lo], o1 = seg.pts[2 * lo + 1], a2 = seg.pts[2 * hi], o2 = seg.pts[2 * hi + 1];
  const kurs = (Math.atan2((o2 - o1) * Math.cos(a1 * Math.PI / 180), a2 - a1) * 180 / Math.PI + 360) % 360;
  return [a1 + (a2 - a1) * g, o1 + (o2 - o1) * g, Math.round(kurs)];
}
function bahnAusgabe(schluesselListe) {
  const t = jetzt(), proZug = new Map();
  for (const s of schluesselListe) {
    const k = bahnKacheln.get(s); if (!k) continue;
    for (const seg of k.segs) {
      const alt = proZug.get(seg.id);
      if (seg.dep <= t && t < seg.arr) { if (!alt || !alt.faehrt) proZug.set(seg.id, { seg, faehrt: true }); }
      else if (!alt && seg.dep > t && seg.dep - t < 3 * 60e3) proZug.set(seg.id, { seg, faehrt: false });
      else if (alt && !alt.faehrt && seg.dep > t && seg.dep < alt.seg.dep) proZug.set(seg.id, { seg, faehrt: false });
    }
  }
  const out = [];
  for (const [id, { seg, faehrt }] of proZug) {
    const p = faehrt ? bahnPosition(seg, t) : [seg.pts[0], seg.pts[1], 0];
    const v = faehrt ? seg.cum[seg.cum.length - 1] / Math.max(1, (seg.arr - seg.dep) / 1000) : 0;
    out.push([id, seg.name, seg.mode, runde(p[0], 5), runde(p[1], 5), p[2], runde(v, 1), Math.round((seg.dep - seg.sdep) / 60e3), seg.rt, faehrt ? (seg.nach || '') : (seg.von || ''), faehrt ? 1 : 0, Math.round(faehrt ? seg.arr / 1000 : seg.dep / 1000)]);
  }
  return out;
}

const fahrtPuffer = new Map();
async function fahrtDetails(id) {
  const p = fahrtPuffer.get(id);
  if (p && jetzt() - p.zeit < 90e3) return p.wert;
  const j = await holen('https://api.transitous.org/api/v1/trip?tripId=' + encodeURIComponent(id), { headers: { 'User-Agent': TR_UA }, timeout: 20000 });
  const l = (j.legs || [])[0];
  if (!l) return null;
  const halt = h => ({ name: h.name, an: h.arrival || null, sAn: h.scheduledArrival || null, ab: h.departure || null, sAb: h.scheduledDeparture || null, gleis: h.track || h.scheduledTrack || '', aus: h.cancelled ? 1 : 0 });
  const geo = l.legGeometry || {};
  const wert = {
    name: l.displayName || l.routeShortName, nr: l.tripShortName || '', richtung: l.headsign || (l.tripTo && l.tripTo.name) || '',
    betreiber: l.agencyName || '', modus: l.mode, echtzeit: l.realTime ? 1 : 0, farbe: l.routeColor || '',
    halte: [halt(l.from), ...(l.intermediateStops || []).map(halt), halt(l.to)],
    linie: geo.points ? polyDekodieren(geo.points, geo.precision || 6, 0.0003) : [],
  };
  fahrtPuffer.set(id, { zeit: jetzt(), wert });
  if (fahrtPuffer.size > 500) fahrtPuffer.delete(fahrtPuffer.keys().next().value);
  return wert;
}

const beben = puffer(60000, async () => {
  const j = await holen('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
  return j.features.map(f => [f.id, runde(f.geometry.coordinates[1], 3), runde(f.geometry.coordinates[0], 3), runde(f.geometry.coordinates[2], 1), f.properties.mag, f.properties.place || '', Math.round(f.properties.time / 1000), f.properties.tsunami || 0, f.properties.url || '']);
});
const radar = puffer(60000, () => holen('https://api.rainviewer.com/public/weather-maps.json'));
const ereignisse = puffer(15 * 60e3, async () => {
  const j = await holen('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=60', { timeout: 40000 });
  const out = [];
  for (const e of j.events || []) {
    const g = (e.geometry || []).filter(x => x.type === 'Point').pop();
    if (!g) continue;
    out.push([e.id, e.title, (e.categories[0] || {}).id || '', runde(g.coordinates[1], 3), runde(g.coordinates[0], 3), Math.round(Date.parse(g.date) / 1000), (e.sources[0] || {}).url || '', g.magnitudeValue != null ? g.magnitudeValue + ' ' + (g.magnitudeUnit || '') : '']);
  }
  return out;
});

/* --------------------------------------------------------------------- HTTP */
const TYPEN = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
let letzterBesuch = 0;

function senden(req, res, code, inhalt, typ = 'application/json; charset=utf-8', extra = {}) {
  let body = Buffer.isBuffer(inhalt) ? inhalt : Buffer.from(typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt));
  const kopf = { 'Content-Type': typ, 'X-Content-Type-Options': 'nosniff', ...extra };
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !/image\/png/.test(typ)) {
    body = zlib.gzipSync(body, { level: 5 }); kopf['Content-Encoding'] = 'gzip'; kopf.Vary = 'Accept-Encoding';
  }
  kopf['Content-Length'] = body.length;
  res.writeHead(code, kopf); res.end(body);
}
const zahl = (v, min, max) => { const x = parseFloat(v); return isNaN(x) ? null : Math.max(min, Math.min(max, x)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = u.searchParams;
  try {
    if (p.startsWith('/api/')) {
      letzterBesuch = jetzt();
      const kurz = { 'Cache-Control': 'no-store' };
      if (p === '/api/gesund') return senden(req, res, 200, { ok: true, flugzeuge: flugWelt.liste.length, flugZeit: flugWelt.zeit, zellen: zellen.size, schiffe: schiffe.size, ais: aisStatus, schlange: warteschlange.length });
      if (p === '/api/flug/welt') return senden(req, res, 200, flugWeltAusgabe(), undefined, kurz);
      if (p === '/api/flug/zellen') {
        const ids = (q.get('ids') || '').split(',').filter(id => /^\d{1,2}_\d{1,3}$/.test(id) && zellMitte(id)).slice(0, 24);
        const out = {};
        for (const id of ids) {
          zelleAnfordern(id);
          const z = zellen.get(id);
          if (z && z.zeit) out[id] = { alter: Math.round((jetzt() - z.zeit) / 1000), liste: z.liste };
        }
        return senden(req, res, 200, { jetzt: sek(), zellen: out }, undefined, kurz);
      }
      if (p === '/api/flug/militaer') return senden(req, res, 200, { jetzt: sek(), liste: (await militaer()) || [] }, undefined, kurz);
      if (p === '/api/flug/info') {
        const hex = (q.get('hex') || '').replace(/[^0-9a-f~]/gi, '').slice(0, 8);
        const cs = (q.get('cs') || '').replace(/[^0-9A-Z]/gi, '').slice(0, 8);
        return senden(req, res, 200, await flugInfo(hex, cs));
      }
      if (p === '/api/schiffe') {
        const b = (q.get('b') || '-180,-85,180,85').split(',').map(Number);
        if (b.length !== 4 || b.some(isNaN)) return senden(req, res, 400, { fehler: 'b=w,s,o,n' });
        return senden(req, res, 200, schiffeAusgabe(b, zahl(q.get('z'), 0, 22) || 0), undefined, kurz);
      }
      if (p === '/api/schiffe/suche') {
        const such = (q.get('q') || '').trim().toUpperCase().slice(0, 40);
        const out = [];
        if (such.length >= 2) {
          for (const s of schiffe.values()) {
            if (s.la == null) continue;
            if ((s.name && s.name.toUpperCase().includes(such)) || String(s.mmsi).startsWith(such) || (s.imo && String(s.imo) === such)) {
              out.push([s.mmsi, s.name || '', s.la, s.lo, typGruppe(s.typ)]);
              if (out.length >= 12) break;
            }
          }
        }
        return senden(req, res, 200, { liste: out }, undefined, kurz);
      }
      if (p === '/api/schiff') {
        const s = schiffe.get(+q.get('mmsi'));
        return senden(req, res, s ? 200 : 404, s || { fehler: 'unbekannt' }, undefined, kurz);
      }
      if (p === '/api/sat') {
        const g = q.get('g') || 'stations';
        if (!SAT_GRUPPEN[g]) return senden(req, res, 400, { fehler: 'Gruppe unbekannt' });
        return senden(req, res, 200, await satGruppe(g), 'text/plain; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
      }
      if (p === '/api/zuege') return senden(req, res, 200, { jetzt: sek(), liste: (await zuege()) || [] }, undefined, kurz);
      if (p === '/api/bahn') {
        const stufe = Math.round(zahl(q.get('q'), 5, 12) || 5), tz = stufe - 2;
        const schluessel = [];
        for (const k of (q.get('k') || '').split(',').slice(0, 9)) {
          const m = /^(\d{1,2})\/(\d{1,5})\/(\d{1,5})$/.exec(k);
          if (!m || +m[1] !== tz || +m[2] >= 2 ** tz || +m[3] >= 2 ** tz) continue;
          const s = stufe + ':' + k;
          let e = bahnKacheln.get(s);
          if (!e) { e = { zeit: 0, benutzt: 0, laedt: false, segs: [] }; bahnKacheln.set(s, e); }
          e.benutzt = jetzt();
          if (!e.laedt && jetzt() - e.zeit > 150e3 && !bahnSchlange.includes(s)) {
            if (bahnSchlange.length > 40) bahnSchlange.shift();
            bahnSchlange.push(s);
          }
          schluessel.push(s);
        }
        const offen = schluessel.filter(s => !bahnKacheln.get(s).zeit).length;
        return senden(req, res, 200, { jetzt: sek(), offen, liste: bahnAusgabe(schluessel) }, undefined, kurz);
      }
      if (p === '/api/bahn/fahrt') {
        const id = (q.get('id') || '').slice(0, 200);
        return senden(req, res, 200, (await fahrtDetails(id).catch(() => null)) || {}, undefined, kurz);
      }
      if (p === '/api/nahverkehr') return senden(req, res, 200, { jetzt: sek(), liste: (await nahverkehr()) || [] }, undefined, kurz);
      if (p === '/api/zug') return senden(req, res, 200, (await zugDetails(+q.get('nr'), (q.get('d') || '').replace(/[^0-9-]/g, '').slice(0, 10)).catch(() => null)) || {});
      if (p === '/api/beben') return senden(req, res, 200, { jetzt: sek(), liste: (await beben()) || [] }, undefined, kurz);
      if (p === '/api/radar') return senden(req, res, 200, (await radar()) || {}, undefined, kurz);
      if (p === '/api/ereignisse') return senden(req, res, 200, { jetzt: sek(), liste: (await ereignisse()) || [] }, undefined, kurz);
      return senden(req, res, 404, { fehler: 'unbekannt' });
    }
    // Statische Dateien
    let datei = p === '/' ? '/index.html' : decodeURIComponent(p);
    datei = path.normalize(path.join(OEFFENTLICH, datei));
    if (!datei.startsWith(OEFFENTLICH + path.sep)) return senden(req, res, 403, 'verboten', 'text/plain');
    fs.readFile(datei, (err, inhalt) => {
      if (err) return senden(req, res, 404, 'nicht gefunden', 'text/plain; charset=utf-8');
      const ext = path.extname(datei);
      senden(req, res, 200, inhalt, TYPEN[ext] || 'application/octet-stream', { 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    });
  } catch (e) {
    log('Fehler', p, e.message);
    senden(req, res, 502, { fehler: 'Quelle nicht erreichbar' });
  }
});

server.listen(PORT, HOST, () => {
  log(`Weltblick läuft auf http://${HOST}:${PORT}` + (AIS_KEY ? ' (aisstream an)' : ' (aisstream aus)') + (OS_ID ? ' (OpenSky-Konto)' : ' (OpenSky anonym)'));
  if (ATTRAPPE) return;
  openskyTakt();
  setInterval(openskyTakt, 30e3);
  digitrafficSchiffe().catch(e => log('Digitraffic-Schiffe:', e.message)).finally(digitrafficTakt);
  aisstreamStarten();
});
