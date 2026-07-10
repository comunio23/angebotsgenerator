// KI-Angebotsgenerator — Netlify Function (Claude-Proxy)
// Lädt historische Angebote + Stammdaten aus Supabase und baut daraus den Prompt.
// ANTHROPIC_API_KEY liegt ausschließlich hier (Netlify-Env-Var), nie im Frontend.

const SB_URL = process.env.SUPABASE_URL || 'https://xuuitgtnnphcwjzkaihc.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dWl0Z3RubnBoY3dqemthaWhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3Njk5MDYsImV4cCI6MjA5NzM0NTkwNn0.4MPIuF73kmZ9ZXfedNEcxXiSPQf4V-O6SxHLlksX6Qs';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// Historische Angebote (Deckel: 20, chronologisch neueste zuerst geladen, aber
// aufsteigend in den Prompt gegeben) + Stammdaten-Singleton parallel laden.
// Deckel bewusst niedrig gehalten (vorher 40): ein zu großer Prompt verlangsamt
// die Claude-Antwort und riskiert, dass Netlifys Function-Zeitlimit greift —
// dann liefert Netlify eine HTML-Fehlerseite statt JSON zurück (siehe
// rufeAngebotApiAuf() im Frontend für die Fehlerbehandlung dieses Falls).
async function ladeKontext() {
  const [angRes, stammRes] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/angebot_angebote?select=nummer,datum,angebotstext&order=datum.desc.nullslast,created_at.desc&limit=20`, { headers: sbHeaders }),
    fetch(`${SB_URL}/rest/v1/angebot_stammdaten?id=eq.1&select=daten`, { headers: sbHeaders }),
  ]);
  if (!angRes.ok)  throw new Error(`Supabase Angebote HTTP ${angRes.status}: ${await angRes.text()}`);
  if (!stammRes.ok) throw new Error(`Supabase Stammdaten HTTP ${stammRes.status}: ${await stammRes.text()}`);

  const angebote = await angRes.json();
  const stammArr = await stammRes.json();
  const daten = (stammArr[0] && stammArr[0].daten) || {};
  return { angebote, daten };
}

function preisliste(titel, arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  const zeilen = arr.map(p => `  ${p.name} — ${Number(p.preis).toFixed(2).replace('.', ',')} €/${p.einheit}`).join('\n');
  return `${titel}:\n${zeilen}\n`;
}

function baueStammblock(d) {
  const s = d.stundensaetze || {};
  const teile = [];
  teile.push('AKTUELLE STAMMDATEN DES BETRIEBS (haben Vorrang vor abweichenden Preisen in älteren Musterangeboten):');
  if (s.meister != null || s.geselle != null || s.azubi != null) {
    teile.push(`  Stundenverrechnungssätze: Meister ${s.meister ?? '—'} €/h, Geselle ${s.geselle ?? '—'} €/h, Azubi ${s.azubi ?? '—'} €/h`);
  }
  if (d.anfahrtspauschale != null)  teile.push(`  Anfahrtspauschale: ${d.anfahrtspauschale} € pro Einsatz`);
  if (d.mwst != null)               teile.push(`  Mehrwertsteuer: ${d.mwst} %`);
  if (d.zahlungsbedingungen)        teile.push(`  Übliche Zahlungsbedingungen: ${d.zahlungsbedingungen}`);
  if (d.gueltigkeit_tage != null)   teile.push(`  Angebotsgültigkeit: ${d.gueltigkeit_tage} Tage`);
  return teile.join('\n');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Nur POST erlaubt.' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY nicht konfiguriert.' }) };
  }

  let anfrage;
  try {
    const body = JSON.parse(event.body);
    anfrage = body.anfrage && body.anfrage.trim();
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Ungültige Anfrage.' }) };
  }
  if (!anfrage) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Bitte eine Kundenanfrage eingeben.' }) };
  }

  // Kontext aus Supabase laden — bei Fehler klare Meldung (kein stiller Fallback).
  let angebote, daten;
  try {
    ({ angebote, daten } = await ladeKontext());
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Kontext konnte nicht geladen werden: ${err.message}` }) };
  }
  if (!angebote.length) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Keine historischen Angebote im Speicher gefunden.' }) };
  }

  const heute = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const betriebHeader = daten.betrieb_header || 'Fliesen Metzger GmbH';

  // Angebote chronologisch aufsteigend (ältestes zuerst) in den Prompt.
  const referenzAngebote = [...angebote].reverse().map(a => a.angebotstext).join('\n\n');

  const preise =
    preisliste('MATERIALPREISE (Verkauf, netto)', daten.materialpreise) +
    preisliste('LEISTUNGSPREISE (Lohn, netto)', daten.leistungspreise);

  const system = `Du bist Klaus Metzger, Fliesenlegermeister und Inhaber der Fliesen Metzger GmbH.
Du erstellst professionelle Angebote auf Deutsch.
Halte dich exakt an die Preise, das Format und die Struktur aus den Musterangeboten.
Verwende immer diesen Briefkopf:

${betriebHeader}

${baueStammblock(daten)}

Heutiges Datum: ${heute}`;

  const userMsg = `Hier sind ${angebote.length} historische Angebote unseres Betriebs als Referenz für Preise, Format und Materialien:

${referenzAngebote}

---

${preise ? `AKTUELLE PREISLISTE:\n${preise}\n---\n\n` : ''}Erstelle jetzt ein neues, vollständiges Angebot für diese Kundenanfrage.
Nutze exakt das gleiche Format wie die Musterangebote (Positionsliste mit Menge × EP = GP,
Netto / MwSt. / Brutto, Ausführungszeit, Zahlungsbedingungen).
Wähle passende Materialien aus der Preisliste und rechne mit den aktuellen Stammdaten.
Vergib eine neue Angebotsnummer im Format FM-2026-XXX (fortlaufend nach den bestehenden Nummern).

KUNDENANFRAGE:
${anfrage}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Claude API Fehler ${response.status}: ${errText}` }) };
  }

  const data = await response.json();
  const angebot = data.content[0].text;

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ angebot }) };
};
