# Velora-Server (NAS)

Gemeinsame Bibliothek für Workouts und Strecken, Nutzerprofile mit FTP, Favoriten pro Nutzer und Fahrtenspeicher.
Die Weboberfläche läuft im Browser, die Tablet-App synchronisiert sich mit diesem Server.

**Kein Passwortschutz.** Nur im Heimnetz betreiben, keinen Port ins Internet freigeben.

## Starten (Docker auf der ThinkStation)
```bash
git clone https://github.com/<DEIN-NAME>/velora-server.git
cd velora-server
docker compose up -d --build
```
Dann im Browser `http://<IP-der-ThinkStation>:18420` öffnen. Die Daten liegen im Ordner `data/` neben der Compose-Datei. Dieser Ordner ist dein Backup.

Ohne Docker (Node.js 18 oder neuer): `node server.js` (Port per `PORT` (Standard 8080, im Container auf 18420 veröffentlicht, änderbar mit `RT_PORT`), Datenordner per `DATA_DIR`).

## Tests
`npm test`.

## Hinweise
- **Workouts aus FIT-Dateien:** Im Reiter Workouts mit „FIT importieren“ lassen sich mehrere Garmin-Workout-Dateien auf einmal wählen. Prozent-Ziele werden übernommen, Watt-Ziele mit der FTP des gewählten Nutzers umgerechnet, Wiederholungen aufgelöst. Aufgezeichnete Fahrten (Aktivitäten) werden abgelehnt.
- Zwei Nutzer sind vorab angelegt („Fahrer 1“, „Fahrer 2“). Umbenennen unter **Profil**.
- Die Routenberechnung ruft vom Server aus brouter.de auf. Der Server braucht dafür Internet.
- Die Karte der Weboberfläche lädt Kacheln und das MapLibre-Skript aus dem Internet.
- Update: `git pull` und `docker compose up -d --build`. Die Daten im Ordner `data/` bleiben erhalten.

## Workout-Kategorien

Die Weboberfläche zeigt Workouts als Kategorie-Kacheln (Favoriten, Dauer, Art des Trainings). Eigene Kategorien lassen sich anlegen, umbenennen, löschen und Workouts manuell zuordnen. API: `GET/POST /api/categories`, `PUT/DELETE /api/categories/:id` (Körper `{name, workoutIds}`), gespeichert in `data/categories.json`.

Workouts und Kategorien lassen sich einzeln oder per Mehrfachauswahl löschen (`POST /api/workouts/bulk-delete`, `POST /api/categories/bulk-delete`, Körper `{ids:[…]}`); eingebaute Workouts bleiben geschützt. Der FIT-Import erkennt Duplikate am Inhalt (gleiche Abschnitte, unabhängig vom Namen) und akzeptiert `?category=<id>`, um importierte Workouts direkt einer Kategorie zuzuordnen.

## Einordnung der Workouts

Die Regeln stehen allein in `classify.js`; Weboberfläche und App zeigen nur an. `GET /api/workout-categories` liefert Titel und Farben, `GET /api/workouts` je Workout `type` (wirksame Trainingsart), `autoType` (Regel), `pinned` (manuell festgelegt) und `durationCat`. Trainingsarten: Regeneration, Ausdauer, Tempo & Sweet Spot, Schwelle, VO2max & Sprint, jedes Workout hat genau eine. Sweet Spot und Schwelle brauchen zusammenhängende Blöcke (Sweet Spot 76 bis 97 % FTP, mindestens 6 Minuten am Stück, zusammen 12 Minuten; Schwelle 95 bis 106 % FTP, 5 Minuten am Stück, zusammen 10 Minuten). `PUT /api/workouts/:id/type` legt die Art manuell fest (`{type: null}` = automatisch). Ein FIT-Import mit `?category=<Trainingsart>` legt sie ebenfalls fest.
