// KI-Angebotsgenerator — Netlify Function (Archiv-Chat)
// Lädt das komplette Angebotsarchiv (Kurzdaten) aus Supabase und lässt Claude
// Fragen dazu beantworten (Statistik, Verlauf, Vergleiche). Kein Angebotstext-
// Volltext im Prompt, um Kosten und Kontextgröße gering zu halten — analog zum
// Telegram-Bot-Archiv-Chat (handleAngebotsChat).

const SB_URL = process.env.SUPABASE_URL || 'https://xuuitgtnnphcwjzkaihc.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dWl0Z3RubnBoY3dqemthaWhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3Njk5MDYsImV4cCI6MjA5NzM0NTkwNn0.4MPIuF73kmZ9ZXfedNEcxXiSPQf4V-O6SxHLlksX6Qs';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function ladeArchiv() {
  const res = await fetch(
    `${SB_URL}/rest/v1/angebot_angebote?select=nummer,datum,kunde,projekt,brutto,quelle&order=datum.desc.nullslast,created_at.desc`,
    { headers: sbHeaders }
  );
  if (!res.ok) throw new Error(`Supabase Archiv HTTP ${res.status}: ${await res.text()}`);
  return res.json();
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

  let frage, verlauf;
  try {
    const body = JSON.parse(event.body);
    frage = body.frage && body.frage.trim();
    verlauf = Array.isArray(body.verlauf) ? body.verlauf : [];
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Ungültige Anfrage.' }) };
  }
  if (!frage) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Bitte eine Frage eingeben.' }) };
  }

  let archiv;
  try {
    archiv = await ladeArchiv();
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Archiv konnte nicht geladen werden: ${err.message}` }) };
  }

  const heute = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const archivText = archiv.map(a =>
    `${a.nummer} | ${a.datum || '—'} | ${a.kunde || '—'} | ${a.projekt || '—'} | ${a.brutto != null ? Number(a.brutto).toFixed(2).replace('.', ',') + ' €' : '—'} | ${a.quelle}`
  ).join('\n');

  const system = `Du bist ein hilfreicher Assistent für die Fliesen Metzger GmbH und beantwortest Fragen zum
Angebotsarchiv des Betriebs. Dir liegt das komplette Archiv als Tabelle vor
(Nummer | Datum | Kunde | Projekt | Bruttobetrag | Quelle).
Beantworte Fragen präzise auf Deutsch — bei Zahlen/Statistiken rechne selbst nach, gib konkrete
Nummern/Beträge an. Wenn eine Frage mit den vorliegenden Daten nicht beantwortbar ist, sag das
ehrlich statt zu raten. Halte Antworten kurz und auf den Punkt.

Heutiges Datum: ${heute}

ARCHIV (${archiv.length} Angebote):
Nummer | Datum | Kunde | Projekt | Brutto | Quelle
${archivText}`;

  const messages = [
    ...verlauf
      .filter(m => m && (m.rolle === 'user' || m.rolle === 'assistant') && typeof m.text === 'string')
      .slice(-10)
      .map(m => ({ role: m.rolle, content: m.text })),
    { role: 'user', content: frage },
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Claude API Fehler ${response.status}: ${errText}` }) };
  }

  const data = await response.json();
  const antwort = data.content[0].text;

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ antwort }) };
};
