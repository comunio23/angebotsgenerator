# Angebotsgenerator (Musterfirma Fliesen Metzger GmbH)

KI-gestützter Angebotsgenerator für einen Handwerks-Workshop. Erzeugt aus einer Kundenanfrage
(Text, Screenshot/PDF per OCR, Sprache) ein kalkuliertes Angebot auf Basis eines historischen
Angebotsarchivs und pflegbarer Stammdaten. **Alle Daten sind Musterdaten der fiktiven Firma
„Fliesen Metzger GmbH" — es ist bewusst keine Passwortsperre eingebaut.**

## Architektur (drei Teile, unterschiedliche Hosts)

| Teil | Wo | Zweck |
|---|---|---|
| `index.html` | Netlify (statisch) | Frontend, 1 Datei, Vanilla JS, keine Build-Pipeline |
| `netlify/functions/angebot.js` | Netlify Function | Claude-Proxy, lädt Archiv+Stammdaten aus Supabase |
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

- `angebot_angebote`: `nummer`, `datum`, `kunde`, `projekt`, `angebotstext` (kompletter Block im
  Musterformat), `brutto`, `quelle` (`muster` | `generiert` | `manuell` | `akzeptiert`).
  30 Musterangebote (FM-2025-001…030) sind der Startbestand.
- `angebot_stammdaten`: **eine** JSONB-Singleton-Zeile (`id=1`) mit Briefkopf, Stundensätzen
  (Meister/Geselle/Azubi), Anfahrtspauschale, MwSt., Zahlungsbedingungen, Material-/Leistungspreisen.
  Upsert immer mit `Prefer: resolution=merge-duplicates`, nie neue Zeile anlegen.
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

Wird das Ausgabeformat je geändert, alle vier Stellen konsistent halten, sonst brechen Archiv-Insert,
Kopfbogen-Rendering und Telegram-Auswertung.

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

## DSGVO-Besonderheit dieses Projekts

Das Standard-Setup (Mistral OCR, Claude, EU-Supabase) ist unkritisch. Die Telegram-Bot-Erweiterung
nutzt zusätzlich **OpenAI** (Whisper-Transkription, GPT-Chat) — das ist ein zusätzlicher
Drittanbieter außerhalb des sonst genutzten Stacks. Für die Demo mit Musterdaten unkritisch,
bei echten Kundendaten aber vor produktivem Einsatz zu prüfen (AVV mit OpenAI, Datenminimierung im
Archiv-Chat, RLS/Login). Details siehe Chat-Verlauf vom 2026-07-07 (DSGVO-Abgleich).

## Muster-Testdateien

`Beispiel-Anfrage.txt`/`.pdf` im Projektroot sind bewusst zum Ausprobieren der OCR-Drag&Drop-Funktion
angelegt (kein Kundendaten-Leak, rein fiktiv). Beim Aufräumen nicht versehentlich löschen, ohne
nachzufragen — sie sind Teil der Vorführung.
