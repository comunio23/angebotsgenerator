# Angebotsgenerator (Musterfirma Fliesen Metzger GmbH)

KI-gestützter Angebotsgenerator für einen Handwerks-Workshop. Erzeugt aus einer Kundenanfrage
(Text, Screenshot/PDF per OCR, Sprache) ein kalkuliertes Angebot auf Basis eines historischen
Angebotsarchivs und pflegbarer Stammdaten. **Alle Daten sind Musterdaten der fiktiven Firma
„Fliesen Metzger GmbH" — es ist bewusst keine Passwortsperre eingebaut.**

## Architektur (drei Teile, unterschiedliche Hosts)

| Teil | Wo | Zweck |
|---|---|---|
| `index.html` | Netlify (statisch) | Internes Tool, 1 Datei, Vanilla JS, keine Build-Pipeline |
| `formular.html` | Netlify (statisch) | Öffentliche Kunden-Formularseite (siehe unten), eigenständig, kein Login/Demo-Banner |
| `netlify/functions/angebot.js` | Netlify Function | Claude-Proxy, lädt Archiv+Stammdaten aus Supabase |
| `netlify/functions/angebot-chat.js` | Netlify Function | Claude-Proxy für den Archiv-Chat (Tab „Angebotsarchiv") |
| `telegram-bot` Edge Function | **Supabase-Projekt `xuuitgtnnphcwjzkaihc`** | Telegram-Anbindung (siehe unten) |

**Wichtig:** Die Supabase-Ressourcen dieses Projekts (Tabellen `angebot_angebote`,
`angebot_stammdaten`, Edge Function `ocr`) leben im **gemeinsam genutzten DMS-Supabase-Projekt**,
nicht in einem eigenen Projekt — bewusste Entscheidung, um kein drittes Supabase-Projekt
anzulegen. Tabellen sind mit Präfix `angebot_` benannt, um Kollisionen mit anderen Projekten im
selben DB zu vermeiden. Bei Schemaänderungen immer `list_tables` vorher prüfen, ob andere Projekte
(Mallorca, Partien-Verwaltung, Fuhrpark, Dokumente) im selben Schema betroffen sein könnten.

- Live-URL: https://angebotsgenerator-hwk.netlify.app
- GitHub: `comunio23/angebotsgenerator`, Auto-Deploy bei Push auf `master`
- Supabase-Projekt: `xuuitgtnnphcwjzkaihc` (MCP `mcp__supabase__*`-Tools zeigen automatisch auf
  dieses Projekt — **immer per `list_tables`/Präfix prüfen, dass man in der richtigen Tabelle
  landet**, da im selben Projekt auch DMS/Fuhrpark/Chess/Mallorca-Daten liegen)

## Datenmodell

- `angebot_angebote`: `nummer`, `datum`, `kunde`, `kunde_email` (nullable, für mailto-Vorbefüllung),
  `projekt`, `angebotstext` (kompletter Block im Musterformat), `brutto`,
  `quelle` (`muster` | `generiert` | `manuell` | `akzeptiert` | `formular`).
  30 Musterangebote (FM-2025-001…030) sind der Startbestand.
- `angebot_stammdaten`: **eine** JSONB-Singleton-Zeile (`id=1`) mit Briefkopf, Stundensätzen
  (Meister/Geselle/Azubi), Anfahrtspauschale, MwSt., Zahlungsbedingungen, Material-/Leistungspreisen.
  Upsert immer mit `Prefer: resolution=merge-duplicates`, nie neue Zeile anlegen.
- `angebot_formular_anfragen`: Rohdaten aus `formular.html` (`kunde_name`, `kunde_email`,
  `formular_antworten` JSONB, `status` `eingegangen`→`angebot_erstellt`/`fehler`, `angebot_id`
  als FK auf `angebot_angebote`). Dient als Sicherheitsnetz — Formular-Antworten bleiben auch
  erhalten, wenn die anschließende Angebotserstellung fehlschlägt.
- RLS ist aktiv, aber **bewusst offen** (`using (true)`) für `anon`/`authenticated` — kein Login,
  reine Demo. Nicht versehentlich "fixen", ohne vorher zu fragen — das ist Absicht, kein Bug.

## Der Angebotstext ist ein festes Parse-Format, kein freies LLM-Format

Claude wird angewiesen, exakt dieses Format zu erzeugen (Trennlinien `====`, `ANGEBOT FM-JJJJ-XXX |
Datum`, Positionen `N.N Text  Menge Einheit × EP € = GP €`, `NETTO/MwSt/BRUTTO`-Zeile,
`Ausführung: … | Zahlung: …`). **Mehrere Stellen im Code verlassen sich per Regex exakt auf dieses
Format** — wenn der Prompt in `angebot.js` geändert wird, müssen mitgezogen werden:
- `parseAngebot()` und `parseAngebotVoll()` in `index.html` (Frontend, Archiv, Kopfbogen)
- `parseAngebotFelder()` in der `telegram-bot` Edge Function
- `entwurfZuText()` in `index.html` (Rückbau des editierten Entwurfs ins gleiche Format)
- `parseAngebot()` in `formular.html` (dupliziert, da eigenständige Datei ohne Build-Pipeline —
  nur die schlanke Variante nötig, kein Kopfbogen-Rendering auf der Kundenseite)

Wird das Ausgabeformat je geändert, alle fünf Stellen konsistent halten, sonst brechen Archiv-Insert,
Kopfbogen-Rendering, Telegram-Auswertung und das Formular-Insert.

## Kopfbogen-Rendering (Corporate Identity)

`belegHTMLFromData(d, editable)` in `index.html` ist der **einzige** Renderer für Bildschirm,
PDF-Druck und Word-Export — bewusst tabellenbasiert mit Inline-Styles/`bgcolor` statt
Flexbox/Grid/SVG, weil Word (`.doc`-Blob-Export) modernes CSS unzuverlässig darstellt. Neue visuelle
Elemente im Kopfbogen immer nach diesem Muster bauen, sonst sieht der Word-Export anders aus als
die App. Firmendaten (Name, Adresse, Bank, Farben) stehen zentral in der `BRAND`-Konstante.

Der Entwurf ist über den Button „✏️ Bearbeiten" umschaltbar (Menge/Einzelpreis/Rabatt editierbar,
Live-Neuberechnung via `recompute()`). Standardansicht ist immer die nicht-editierbare, saubere
Darstellung — das war schon einmal falsch (dauerhaft editierbare Felder überall) und wurde bewusst
zurückgebaut.

## Telegram-Bot-Anbindung (Edge Function `telegram-bot`)

Der Bot ist multifunktional (Schach-Coach, Hörbuch, Verkehrsansage `/heimweg` — nicht Teil dieses
Projekts) und wurde um zwei Angebotsgenerator-Funktionen erweitert:
- **Sprachnachricht/`/angebot <Text>`** mit dem Schlüsselwort „angebot" → ruft die Netlify-Function
  `angebot.js` auf, speichert das Ergebnis direkt (Service-Role-Key, kein RLS-Umweg) in
  `angebot_angebote` mit `quelle='generiert'`.
- **Frageformen** ("wie viele", "verlauf", "historie", "teuerste" …) oder `/historie <Frage>` →
  `handleAngebotsChat()` lädt das **komplette** Archiv (Nummer/Datum/Kunde/Projekt/Betrag) und lässt
  OpenAI GPT Fragen dazu beantworten.
- Routing-Reihenfolge in `handleVoice()`/`Deno.serve()` ist bewusst: `heimweg` → Fragemuster →
  `angebot` → sonst normaler Chat. Reihenfolge beim Erweitern nicht vertauschen, sonst überschneiden
  sich die Trigger (z. B. „Wie viele Angebote…" enthält auch das Wort „Angebot").
- Deploy erfolgt als **komplette Datei** über `mcp__supabase__deploy_edge_function` (keine partiellen
  Patches möglich) — immer den kompletten aktuellen Funktionsinhalt neu einreichen, sonst gehen die
  anderen Bot-Features (Schach, Hörbuch, Heimweg) verloren.

## Öffentliches Angebots-Formular (`formular.html`)

Bewusst **getrennte Datei** vom internen Tool `index.html` (kein Demo-Banner, keine Tabs, keine
Archiv-/Stammdaten-Ansicht — nur der Fragenkatalog für Kunden). Ist eine feste, dauerhaft
erreichbare URL ohne Vorbedingung (kein `?id=`-Parameter nötig), die von der echten Firmenwebsite
oder in einer manuellen Antwort-Mail verlinkt werden kann. **Bewusst kein IMAP-Postfach-Polling und
kein automatischer E-Mail-Versand** — der Betrieb verschickt den Link selbst manuell, wenn eine
Anfrage klassisch per E-Mail hereinkommt (Entscheidung vom 2026-07-09: einfacher/robuster als eine
automatisierte E-Mail-Erkennungs-Pipeline, siehe Plan-Historie).

Ablauf: Formular ausfüllen → `POST angebot_formular_anfragen` (Rohdaten sichern) → Antworten zu
einem Anfrage-Text zusammenbauen → `POST /api/angebot` (dieselbe Function wie im „Erstellen"-Tab,
unverändert) → Ergebnis in `angebot_angebote` mit `quelle='formular'` + `kunde_email` → Formular-
Datensatz auf `status='angebot_erstellt'` verknüpfen. Bei Fehlern bleiben die Rohdaten erhalten
(`status='fehler'`), kein Datenverlust für den Kunden.

Unterstützt optionale `?name=&email=`-URL-Parameter zum Vorbefüllen (z. B. für personalisierte
Links in Antwort-Mails) — rein optional, kein funktionaler Pflichtbestandteil.

## DSGVO-Besonderheit dieses Projekts

Das Standard-Setup (Mistral OCR, Claude, EU-Supabase) ist unkritisch. Die Telegram-Bot-Erweiterung
nutzt zusätzlich **OpenAI** (Whisper-Transkription, GPT-Chat) — das ist ein zusätzlicher
Drittanbieter außerhalb des sonst genutzten Stacks. Für die Demo mit Musterdaten unkritisch,
bei echten Kundendaten aber vor produktivem Einsatz zu prüfen (AVV mit OpenAI, Datenminimierung im
Archiv-Chat, RLS/Login). Details siehe Chat-Verlauf vom 2026-07-07 (DSGVO-Abgleich).

`angebot_formular_anfragen` speichert echte Kontaktdaten (Name, E-Mail, Telefon, Adresse) von
Formular-Ausfüllern — auch mit Testdaten personenbezogen. Für den Workshop nur eigene
Testpersonen verwenden, Tabelle danach bereinigen; kein Produktivbetrieb mit echten Kundendaten
ohne AVV/Login/RLS-Härtung.

## Muster-Testdateien

`Beispiel-Anfrage.txt`/`.pdf` im Projektroot sind bewusst zum Ausprobieren der OCR-Drag&Drop-Funktion
angelegt (kein Kundendaten-Leak, rein fiktiv). Beim Aufräumen nicht versehentlich löschen, ohne
nachzufragen — sie sind Teil der Vorführung.
