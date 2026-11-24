# Weltblick – Live-Weltkarte

Flugzeuge, Schiffe, Züge, Satelliten, Busse und Trams, Erdbeben, Naturereignisse, Regenradar und die Tag-Nacht-Grenze – live auf einem Globus.

**Ansehen:** https://welt.2-28-114-139.sslip.io

*English: Weltblick is a live world map (planes, ships, trains, satellites, public transport, earthquakes, natural events, rain radar) built only on free and open data sources. Node.js server without dependencies, MapLibre GL front end. MIT licensed.*

## Was man sieht

| Ebene | Quelle | Hinweis |
|---|---|---|
| ✈ Flugzeuge weltweit | [OpenSky Network](https://opensky-network.org) | anonym alle 15 min, mit Konto alle 90 s |
| ✈ Flugzeuge im Ausschnitt | [adsb.lol](https://adsb.lol) (ODbL), [adsb.fi](https://adsb.fi) | ab Zoom 4,5 laufend |
| Route, Typ, Halter | [adsbdb](https://www.adsbdb.com), Fotos [planespotters.net](https://www.planespotters.net) | beim Anklicken |
| ⛴ Schiffe weltweit | [aisstream.io](https://aisstream.io) (kostenloser Schlüssel), [Fintraffic Digitraffic](https://www.digitraffic.fi) (CC BY 4.0) | |
| 🚆 Züge in Europa und weiteren Ländern | [Transitous](https://transitous.org) ([Datenquellen](https://transitous.org/sources/)) | Position aus Fahrplan + Echtzeit, ab Zoom 5 |
| 🚆 Züge Finnland (GPS) | Fintraffic Digitraffic | |
| 🚌 Busse, Trams, Metros Niederlande | [OVapi](https://gtfs.ovapi.nl) (GTFS-Realtime) | |
| 🛰 Satelliten | [CelesTrak](https://celestrak.org), Bahnberechnung mit [satellite.js](https://github.com/shashwatak/satellite-js) | |
| ◉ Erdbeben | [USGS](https://earthquake.usgs.gov) | letzte 24 h |
| 🔥 Feuer, Stürme, Vulkane | [NASA EONET](https://eonet.gsfc.nasa.gov) | |
| 🌧 Regenradar | [RainViewer](https://www.rainviewer.com) | |
| Karte | [OpenFreeMap](https://openfreemap.org), © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende, Satellitenbild © Esri | |

Die Daten gehören den jeweiligen Anbietern; deren Bedingungen gelten (einige nur für nicht-kommerzielle Nutzung).

## Starten

Node.js ab Version 22, keine Pakete nötig:

```
node server.js
```

Dann http://127.0.0.1:4210 öffnen.

Einstellungen über Umgebungsvariablen:

| Variable | Bedeutung |
|---|---|
| `WK_PORT`, `WK_HOST` | Port (4210) und Adresse (127.0.0.1) |
| `WK_DATEN` | Ordner für Zwischenspeicher (Standard: Temp-Ordner) |
| `WK_KONTAKT` | Kontakt-URL im User-Agent (für Transitous) |
| `AISSTREAM_KEY` | Schlüssel von aisstream.io für Schiffe weltweit |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | OpenSky-API-Zugang für häufigere Flugdaten |

`server/` enthält eine systemd-Unit und ein Caddy-Beispiel.

## Lizenz

Code: MIT (siehe `LICENSE`).
