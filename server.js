// GGT Sitzungsnotizen Backend v2
// Verbesserungen:
// - Obsidian-Struktur nach Vorlage (YAML, Sections mit Emojis, Horizontal Rules)
// - Filename: [Datum]-[Projekt]-Sitzung.md
// - emailHtml + emailMd getrennt (Outlook-kompatible HTML-Tags statt **Markdown**)
// - Neue Kategorie "Traktanden / Themen"
// - zeit-Feld im Frontmatter
// - Anwesende aus ergänzter Liste (vom Frontend in /themen und /bericht)

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const Replicate = require('replicate');

const app = express();
const SERVER_START = new Date();
const PORT = process.env.PORT || 3001;
const VAULT = process.env.VAULT_PATH;
const API_SECRET = process.env.API_SECRET;
const REPLICATE_TOKEN = process.env.REPLICATE_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

if (!VAULT || !API_SECRET || !REPLICATE_TOKEN || !ANTHROPIC_KEY) {
  console.error('FEHLER: VAULT_PATH, API_SECRET, REPLICATE_TOKEN, ANTHROPIC_KEY müssen gesetzt sein');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const replicate = new Replicate({ auth: REPLICATE_TOKEN });

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fsSync.existsSync(UPLOAD_DIR)) fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sitzungsDir = path.join(UPLOAD_DIR, req.sitzungsId || 'temp');
    fsSync.mkdirSync(sitzungsDir, { recursive: true });
    cb(null, sitzungsDir);
  },
  filename: (req, file, cb) => cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

const sessions = {};

app.use(express.json({ limit: '10mb' }));

app.get('/version', (req, res) => {
  const deployed = SERVER_START.toLocaleString('de-CH', {
    timeZone: 'Europe/Zurich',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  res.json({ version: '3.0', deployed });
});

app.use((req, res, next) => {
  const secret = req.headers['x-api-secret'];
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ======== Helpers ========
function gitPull() {
  try { execSync('git pull --rebase --autostash', { cwd: VAULT, stdio: 'pipe' }); } catch (e) { console.warn('Git pull:', e.message); }
}

function gitCommitPush(msg) {
  try {
    execSync('git add -A', { cwd: VAULT });
    execSync(`git commit -m "${msg}" || true`, { cwd: VAULT, shell: '/bin/bash' });
    execSync('git push', { cwd: VAULT });
  } catch (e) { console.warn('Git commit/push:', e.message); }
}

function listProjekte() {
  const projekteDir = path.join(VAULT, '01-Projekte');
  if (!fsSync.existsSync(projekteDir)) return [];
  return fsSync.readdirSync(projekteDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map(d => d.name).sort();
}

async function findOpenPendenzen(projektName) {
  const projektDir = path.join(VAULT, '01-Projekte', projektName);
  if (!fsSync.existsSync(projektDir)) return [];
  const pendenzen = [];
  
  // Rekursiv alle .md Dateien im Projektordner finden
  function walkDir(dir, relativeBase = '') {
    const entries = fsSync.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'Assets') {
        files.push(...walkDir(fullPath, relPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push({ fullPath, relPath, name: entry.name });
      }
    }
    return files;
  }
  
  const allFiles = walkDir(projektDir);
  // Sortieren: neueste zuerst (nach Datumsprefix falls vorhanden)
  allFiles.sort((a, b) => b.name.localeCompare(a.name));
  
  for (const fileInfo of allFiles) {
    const content = await fs.readFile(fileInfo.fullPath, 'utf8');
    const lines = content.split('\n');
    // Datum aus Dateinamen extrahieren oder Fallback
    const datumMatch = fileInfo.name.match(/^(\d{4}-\d{2}-\d{2})/);
    let datum = datumMatch ? datumMatch[1] : '';
    // Falls kein Datum im Namen, aus YAML-Frontmatter holen
    if (!datum) {
      const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (yamlMatch) {
        const dm = yamlMatch[1].match(/datum:\s*(\d{4}-\d{2}-\d{2})/);
        if (dm) datum = dm[1];
      }
    }
    lines.forEach((line, idx) => {
      // Match offene Checkboxen: "- [ ] Text" oder "* [ ] Text"
      const m = line.match(/^\s*[-*]\s*\[\s\]\s*(.+)$/);
      if (m) {
        let text = m[1].trim();
        // Entferne Reminder-Plugin-Syntax wie (@2026-04-20)
        text = text.replace(/\s*\(@[^)]+\)\s*/g, '').trim();
        // Entferne Tasks-Plugin Emojis wie 📅 2026-04-20, ⏫, 🔼 etc.
        text = text.replace(/[📅⏫🔼🔽🔺⏬⏳🛫✅❌🏁]\s*\d{4}-\d{2}-\d{2}/g, '').trim();
        text = text.replace(/[⏫🔼🔽🔺⏬]/g, '').trim();
        if (text && text.length > 2 && !pendenzen.find(p => p.text.toLowerCase() === text.toLowerCase())) {
          pendenzen.push({
            id: `${fileInfo.relPath}:${idx}`,
            text,
            datum,
            file: fileInfo.relPath
          });
        }
      }
    });
  }
  return pendenzen;
}

// ======== Projekt-Typ Erkennung ========
function detectProjektTyp(projektName) {
  const n = projektName.toLowerCase();
  if (/\bprivat\b/.test(n)) return 'privat';
  if (/\bvr\b|\bverwaltungsrat\b/.test(n)) return 'vr';
  return 'hlks';
}

// ======== Datei-Zusammenfassung für Kontext ========
function extractFileSummary(content, filename) {
  // Rohtranskript-Callout entfernen bevor Kontext extrahiert wird
  content = content.replace(/^>\s*\[!note\]-?\s*Rohtranskript[\s\S]*?(?=\n(?!>)|\n*$)/m, '').trim();
  const lines = content.split('\n');
  const parts = [];

  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) parts.push(dateMatch[1]);

  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (yamlMatch) {
    const m = yamlMatch[1].match(/(?:teilnehmer|anwesende|participants):\s*(.+)/i);
    if (m) parts.push('Teiln: ' + m[1].trim().substring(0, 80));
  }

  const headings = lines.filter(l => /^##\s+/.test(l)).map(l => l.replace(/^##\s+/, '').trim());
  if (headings.length) parts.push('Sek: ' + headings.join(', '));

  const todos = lines
    .filter(l => /^\s*[-*]\s*\[\s\]\s*.+/.test(l))
    .map(l => { const m = l.match(/\[\s\]\s*(.+)/); return m ? m[1].replace(/\s*\(@[^)]+\)/g, '').replace(/[📅⏫🔼🔽🔺⏬⏳🛫✅❌]\s*[\d-]*/g, '').trim() : ''; })
    .filter(Boolean)
    .slice(0, 5);
  if (todos.length) parts.push('Offen: ' + todos.join(' | '));

  return parts.join(' — ').substring(0, 350);
}

// ======== Projekt-Kontext laden ========
async function loadProjektKontext(projektName, maxFiles = 15) {
  const projektDir = path.join(VAULT, '01-Projekte', projektName);
  if (!fsSync.existsSync(projektDir)) return '';

  function walkSync(dir) {
    const result = [];
    try {
      for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'Assets') result.push(...walkSync(full));
        else if (e.isFile() && e.name.endsWith('.md')) result.push({ fullPath: full, name: e.name });
      }
    } catch (_) {}
    return result;
  }

  const files = walkSync(projektDir).sort((a, b) => b.name.localeCompare(a.name)).slice(0, maxFiles);
  if (!files.length) return '';

  const parts = [];
  let used = 0;
  for (const f of files) {
    if (used >= 5000) break;
    try {
      const content = await fs.readFile(f.fullPath, 'utf8');
      const s = extractFileSummary(content, f.name);
      if (s) { parts.push(s); used += s.length; }
    } catch (_) {}
  }

  return parts.length ? '\n\nPROJEKTKONTEXT – letzte Einträge:\n' + parts.join('\n') : '';
}

// ======== Dynamisches max_tokens ========
function calcMaxTokens(promptText, ceiling = 8192) {
  const estimated = Math.ceil(promptText.length / 3.5);
  return Math.min(ceiling, Math.max(6144, Math.ceil(estimated * 0.6)));
}

// ======== System-Prompt je Projekt-Typ ========
function buildSystemPrompt(projektTyp) {
  const kategorien = `Kategorien (exakt eine davon verwenden):
- "Traktanden / Themen": Besprochene Themen, Sachverhalte, Informationen
- "Mängel & Pendenzen": Offene Punkte, Mängel, Aufgaben, Probleme
- "Ausgeführte Arbeiten": Was bereits erledigt oder ausgeführt wurde
- "Nächste Schritte": Was als nächstes getan wird, geplante Massnahmen
- "Beschlüsse": Getroffene Entscheidungen, Vereinbarungen
- "Bemerkungen": Alles Übrige, Unklar-Formuliertes, Fragmente`;

  const regeln = `WICHTIGSTE REGEL: Im Zweifel immer extrahieren — lieber zu viel als zu wenig.

REGELN:
- Nur aus dem Transkript — nichts erfinden, nichts ableiten was nicht gesagt wurde.
- Auch Fragmente und unklare Aussagen aufnehmen: unter "Bemerkungen", wörtlich nah formuliert.
- Personen nur namentlich nennen wenn der Name im Transkript vorkommt.
- Schweizerdeutsch/Hochdeutsch → sauberes Schriftdeutsch.
- Antworte NUR mit einem gültigen JSON-Array, kein Markdown, keine Erklärung.`;

  const hlksKontext = projektTyp === 'hlks'
    ? `\nFachgebiet: Heizung, Lüftung, Klima, Sanitär (HLKS), Baustelle, Giovanoli Gebäudetechnik GmbH (Kanton Graubünden).`
    : projektTyp === 'vr' ? `\nKontext: Verwaltungsrats- oder Geschäftssitzung.`
    : `\nKontext: Private Besprechung.`;

  return `Du bist Protokollant und sammelst ALLE erkennbaren Inhalte aus einem Gesprächs-Transkript.${hlksKontext}

${kategorien}

${regeln}`;
}

// ======== Endpunkte ========
app.get('/projekte', (req, res) => { res.json({ projekte: listProjekte() }); });

app.get('/pendenzen', async (req, res) => {
  try {
    gitPull();
    const projekt = req.query.projekt;
    if (!projekt) return res.status(400).json({ error: 'projekt fehlt' });
    const pendenzen = await findOpenPendenzen(projekt);
    res.json({ pendenzen });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sitzung', (req, res, next) => {
  req.sitzungsId = 'sit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'fotos', maxCount: 20 }])(req, res, next);
}, (req, res) => {
  try {
    const sitzungsId = req.sitzungsId;
    const audio = req.files.audio?.[0];
    const fotos = req.files.fotos || [];
    if (!audio) return res.status(400).json({ error: 'audio fehlt' });
    const fotoZeiten = [].concat(req.body.foto_zeiten || []).map(z => parseInt(z) || 0);
    sessions[sitzungsId] = {
      id: sitzungsId,
      audioPath: audio.path,
      fotos: fotos.map((f, i) => ({ path: f.path, timestamp: fotoZeiten[i] || 0, name: f.filename })),
      projekt: req.body.projekt,
      anwesende: req.body.anwesende,
      transkript: null,
      transkriptBereinigt: null,
      fotoAnalysen: [],
      topics: [],
      createdAt: Date.now()
    };
    res.json({ sitzungsId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/transkribieren', async (req, res) => {
  try {
    const id = req.query.id;
    const s = sessions[id];
    if (!s) return res.status(404).json({ error: 'Sitzung nicht gefunden' });
    const audioBuffer = await fs.readFile(s.audioPath);
    const audioExt = path.extname(s.audioPath).slice(1).toLowerCase();
    const mimeMap = { m4a:'audio/mp4', mp4:'audio/mp4', webm:'audio/webm', wav:'audio/wav', aac:'audio/aac', ogg:'audio/ogg' };
    const audioMime = mimeMap[audioExt] || 'audio/webm';
    const audioBase64 = `data:${audioMime};base64,` + audioBuffer.toString('base64');
    const whisperPrompt = [
      'Giovanoli, Dario, Heizung, Sanitär, Lüftung, Haustechnik, HLKS, Baustelle, Pendenzen,',
      'Wärmepumpe, Heizkörper, Estrich, Rohrleitung, Armatur, Ventil, Pumpe, Schacht,',
      'Unterlagsboden, Abpressprotokoll, Fussbodenheizung, Verteiler, Speicher, Boiler,',
      'Luftauslass, Zuluft, Abluft, Kanalisation, Lüftungskanal, Heizkreis, Druckverlust.',
      'Grüezi mitenand. Mir fangid jetzt a mit de Bausitzung.',
      'I ha de Plan scho aglueget, das isch no nid gmacht worde.',
      'Mir müend no de Estrich abdrucke, de Anschluss isch no nid fertig.',
      'Wer isch derfür verantwortlich? Das chunnt nächste Wuche.',
      'Mir händ no e Pendenz offe, das mues no abgchlare werde.',
      'De Boiler isch scho installiert, mir warte no uf d Inbetriebnahme.',
      'Chönd mir das bis Mäntig erledige? Jo, das isch kei Problem.'
    ].join(' ');
    const output = await replicate.run(
      'thomasmol/whisper-diarization:1495a9cddc83b2203b0d8d3516e38b80fd1572ebc4bc5700ac1da56a9b3ed886',
      { input: { file_string: audioBase64, prompt: whisperPrompt } }
    );
    s.transkript = output;

    // Claude bereinigt Schweizerdeutsch → Hochdeutsch
    const rohText = (output.segments || [])
      .map(seg => `[${seg.speaker || 'SPEAKER'}] ${(seg.text || '').trim()}`)
      .filter(l => l.length > 12)
      .join('\n');
    if (rohText.trim()) {
      try {
        const bereinigtResp = await anthropic.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: calcMaxTokens(rohText),
          system: `Du bist ein Experte für Schweizerdeutsch-Transkriptionen im Bauwesen.
Der Text stammt aus einer automatischen Whisper-Transkription einer Schweizerdeutschen Bausitzung — er enthält Dialekt, Erkennungsfehler und Vermischungen.

AUFGABE: Forme den Text in korrektes, natürliches Schriftdeutsch um.

HÄUFIGE SCHWEIZERDEUTSCH → SCHRIFTDEUTSCH MUSTER:
- isch / isch gsi → ist / war
- hät / het / händ → hat / haben
- chund / chunnt / gah / gönd → kommt / gehen
- mues / müend → muss / müssen
- gid / git → gibt
- scho / no / no nid → schon / noch / noch nicht
- vo / uf / mit em / i de → von / auf / mit dem / in der
- Wuche / Mäntig / Zischtig → Woche / Montag / Dienstag
- abchlare / aluege / afange → klären / anschauen / anfangen
- Nächste Wuche → Nächste Woche
- Whisper schreibt oft hochdeutsche Wörter die klanglich ähnlich sind, aber falsch sind

REGELN:
- Alle Namen, Zahlen, Daten, Maße und Fachbegriffe exakt beibehalten.
- Sprecher-Labels [SPEAKER_XX] unverändert beibehalten.
- Sinn und Inhalt bleiben 100% identisch — nur Dialekt und Erkennungsfehler korrigieren.
- Füllwörter (äh, mhm, ähm) weglassen.
- Nur bereinigten Text zurückgeben, keine Erklärungen.`,
          messages: [{ role: 'user', content: rohText }]
        });
        s.transkriptBereinigt = bereinigtResp.content[0].text.trim();
        console.log(`[transkribieren] Bereinigung OK (${s.transkriptBereinigt.length}ch)`);
      } catch (e) {
        console.warn('[transkribieren] Bereinigung fehlgeschlagen, Fallback:', e.message);
        s.transkriptBereinigt = rohText;
      }
    }

    res.json({ ok: true, segments: output.segments?.length || 0 });
  } catch (e) { console.error('transkribieren:', e); res.status(500).json({ error: e.message }); }
});

app.post('/fotos-analyse', async (req, res) => {
  try {
    const id = req.query.id;
    const s = sessions[id];
    if (!s) return res.status(404).json({ error: 'Sitzung nicht gefunden' });
    s.fotoAnalysen = [];
    for (const foto of s.fotos) {
      const imgBuffer = await fs.readFile(foto.path);
      const imgBase64 = imgBuffer.toString('base64');
      const ext = path.extname(foto.path).slice(1).toLowerCase();
      const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const resp = await anthropic.messages.create({
        model: 'claude-opus-4-6', max_tokens: 500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imgBase64 } },
          { type: 'text', text: 'Kurze Beschreibung (1-2 Sätze) was auf diesem Baustellen-Foto zu sehen ist. Technisch und präzise.' }
        ]}]
      });
      s.fotoAnalysen.push({ timestamp: foto.timestamp, beschreibung: resp.content[0].text });
    }
    res.json({ ok: true, anzahl: s.fotoAnalysen.length });
  } catch (e) { console.error('fotos-analyse:', e); res.status(500).json({ error: e.message }); }
});

app.post('/themen', async (req, res) => {
  try {
    const id = req.query.id;
    const s = sessions[id];
    if (!s) return res.status(404).json({ error: 'Sitzung nicht gefunden' });
    const { erledigte = [], anwesende = '' } = req.body;
    if (anwesende) s.anwesende = anwesende;

    const segments = s.transkript?.segments || [];
    const transkriptText = s.transkriptBereinigt ||
      segments.map(seg => `[${seg.speaker || 'SPEAKER'}] ${seg.text}`).join('\n');
    console.log(`[themen] Transkript: ${s.transkriptBereinigt ? 'bereinigt' : 'roh'} (${transkriptText.length}ch)`);
    const fotoKontext = s.fotoAnalysen.map(f => `[Foto bei ${Math.floor(f.timestamp/60)}:${String(f.timestamp%60).padStart(2,'0')}] ${f.beschreibung}`).join('\n');

    const projektTyp = detectProjektTyp(s.projekt);
    const projektKontext = await loadProjektKontext(s.projekt);
    const systemPrompt = buildSystemPrompt(projektTyp);

    const userContent = `ANWESENDE: ${s.anwesende}

TRANSKRIPT:
${transkriptText}
${fotoKontext ? '\nFOTO-KONTEXT:\n' + fotoKontext : ''}
${erledigte.length ? '\nFOLGENDE PENDENZEN WURDEN IN DIESER SITZUNG ALS ERLEDIGT MARKIERT:\n' + erledigte.map(t => `- ${t}`).join('\n') : ''}
${projektKontext}

Extrahiere ALLE erkennbaren Inhalte als JSON-Array — auch Fragmente und unklare Aussagen. Felder: text (1-2 Sätze, konservativ formuliert), kategorie (eine der definierten), verantwortlich (Name oder ""), termin (Datum/Frist oder ""), prio ("hoch"/"mittel"/"niedrig"). Im Zweifel extrahieren.`;

    const maxTok = calcMaxTokens(systemPrompt + userContent);
    console.log(`[themen] Projekt="${s.projekt}" Typ=${projektTyp} Segmente=${segments.length} maxTok=${maxTok} Kontext=${projektKontext.length}ch`);

    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: maxTok,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    });

    let text = resp.content[0].text.trim();
    console.log(`[themen] API-Antwort (${text.length}ch): ${text.substring(0, 200)}`);
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let topics = [];
    try { topics = JSON.parse(text); } catch (e) {
      console.error('[themen] JSON.parse fehlgeschlagen:', e.message, '| Text:', text.substring(0, 300));
      const m = text.match(/\[[\s\S]*\]/);
      if (m) topics = JSON.parse(m[0]);
    }
    console.log(`[themen] Topics gefunden: ${topics.length}`);
    s.topics = topics;
    res.json({ topics });
  } catch (e) { console.error('[themen] Fehler:', e.message, e.status || ''); res.status(500).json({ error: e.message }); }
});

app.post('/bericht', async (req, res) => {
  try {
    const id = req.query.id;
    const s = sessions[id];
    if (!s) return res.status(404).json({ error: 'Sitzung nicht gefunden' });
    const { selectedIdx = [], erledigte = [], datum, datumFile, zeit, anwesende } = req.body;
    if (anwesende) s.anwesende = anwesende;

    const selected = selectedIdx.map(i => s.topics[i]).filter(Boolean);

    // Erledigte Pendenzen ermitteln
    const erledigteTexte = [];
    for (const pendId of erledigte) {
      const pendenzen = await findOpenPendenzen(s.projekt);
      const p = pendenzen.find(x => x.id === pendId);
      if (p) erledigteTexte.push(p.text);
    }

    // Gruppieren nach Kategorie
    const byKat = {};
    selected.forEach(t => {
      if (!byKat[t.kategorie]) byKat[t.kategorie] = [];
      byKat[t.kategorie].push(t);
    });

    // ===== Obsidian-Markdown nach Vorlage =====
    let md = `---\n`;
    md += `typ: besprechung\n`;
    md += `datum: ${datumFile}\n`;
    md += `projekt: ${s.projekt}\n`;
    md += `ort: Baustelle\n`;
    md += `tags: [besprechung, baustelle]\n`;
    md += `---\n\n`;

    md += `# Besprechung – ${s.projekt}\n`;
    md += `**Datum:** ${datum} um ${zeit} Uhr  \n`;
    md += `**Ort:** Baustelle  \n`;
    md += `**Teilnehmer:** ${s.anwesende}\n\n`;
    md += `---\n\n`;

    // Traktanden / Themen
    const traktanden = byKat['Traktanden / Themen'] || [];
    const andereThemen = selected.filter(t => t.kategorie !== 'Traktanden / Themen' && t.kategorie !== 'Bemerkungen');
    const traktandenInhalt = traktanden.length ? traktanden : andereThemen.slice(0, 5);
    if (traktandenInhalt.length) {
      md += `## 📋 Traktanden / Themen\n\n`;
      traktandenInhalt.forEach(t => md += `- ${t.text.split('.')[0].substring(0, 80)}\n`);
      md += `\n---\n\n`;
    }

    // Besprochenes & Entscheide
    const besprochenes = [...(byKat['Ausgeführte Arbeiten']||[]), ...(byKat['Beschlüsse']||[])];
    if (besprochenes.length) {
      md += `## 🔨 Besprochenes & Entscheide\n\n`;
      besprochenes.forEach(t => {
        const meta = [t.verantwortlich, t.termin].filter(Boolean).join(', ');
        md += `- ${t.text}${meta ? ` *(${meta})*` : ''}\n`;
      });
      md += `\n---\n\n`;
    }

    // Aufgaben / Pendenzen
    const neuePendenzen = [...(byKat['Mängel & Pendenzen']||[]), ...(byKat['Nächste Schritte']||[])];
    if (erledigteTexte.length || neuePendenzen.length) {
      md += `## ✅ Aufgaben / Pendenzen\n\n`;
      erledigteTexte.forEach(t => md += `- [x] ${t} ✅\n`);
      neuePendenzen.forEach(t => {
        const meta = [t.verantwortlich, t.termin].filter(Boolean).join(', ');
        md += `- [ ] ${t.text}${meta ? ` *(${meta})*` : ''}\n`;
      });
      md += `\n---\n\n`;
    }

    // Fotos / Anhänge
    if (s.fotoAnalysen.length) {
      md += `## 📸 Fotos / Anhänge\n\n`;
      s.fotoAnalysen.forEach((f, i) => {
        const zeit = `${Math.floor(f.timestamp/60)}:${String(f.timestamp%60).padStart(2,'0')}`;
        const ext = s.fotos[i] ? path.extname(s.fotos[i].path) : '.jpg';
        const filename = `${datumFile}-foto-${i+1}${ext}`;
        md += `![[${filename}]]\n`;
        md += `> [!note]- Bildbeschreibung (${zeit})\n`;
        md += `> ${f.beschreibung}\n\n`;
      });
      md += `---\n\n`;
    }

    // Sonstiges / Bemerkungen
    const bemerkungen = byKat['Bemerkungen'] || [];
    if (bemerkungen.length) {
      md += `## 📝 Sonstiges / Bemerkungen\n\n`;
      bemerkungen.forEach(t => md += `- ${t.text}\n`);
      md += `\n---\n\n`;
    }

    md += `*Erstellt: ${datum} um ${zeit} Uhr*\n`;

    // ===== Rohtranskript (eingeklappt) =====
    const segments = s.transkript?.segments || [];
    if (segments.length) {
      md += `\n> [!note]- Rohtranskript (Whisper)\n`;
      segments.forEach(seg => {
        const speaker = seg.speaker || 'SPEAKER';
        const text = (seg.text || '').trim();
        if (text) md += `> [${speaker}] ${text}\n`;
      });
      md += '\n';
    }

    // ===== Datei speichern =====
    const sitzungenDir = path.join(VAULT, '01-Projekte', s.projekt, 'Sitzungen');
    fsSync.mkdirSync(sitzungenDir, { recursive: true });
    const mdFile = path.join(sitzungenDir, `${datumFile}-${s.projekt}-Sitzung.md`);
    await fs.writeFile(mdFile, md, 'utf8');

    // Fotos kopieren
    const assetsDir = path.join(VAULT, '01-Projekte', s.projekt, 'Assets');
    if (s.fotoAnalysen.length) {
      fsSync.mkdirSync(assetsDir, { recursive: true });
      for (let i = 0; i < s.fotos.length; i++) {
        const src = s.fotos[i].path;
        const dst = path.join(assetsDir, `${datumFile}-foto-${i+1}${path.extname(src)}`);
        await fs.copyFile(src, dst);
      }
    }

    // Erledigte Pendenzen in Quelldateien markieren
    for (const pendId of erledigte) {
      // pendId = "relativer/pfad/file.md:lineIdx"
      const lastColon = pendId.lastIndexOf(':');
      const relFile = pendId.substring(0, lastColon);
      const idxStr = pendId.substring(lastColon + 1);
      const filePath = path.join(VAULT, '01-Projekte', s.projekt, relFile);
      if (fsSync.existsSync(filePath)) {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const lineIdx = parseInt(idxStr);
        if (lines[lineIdx] && lines[lineIdx].match(/^\s*[-*]\s*\[\s\]/)) {
          lines[lineIdx] = lines[lineIdx].replace(/^(\s*[-*]\s*)\[\s\]/, '$1[x]') + ' ✅ ' + datumFile;
          await fs.writeFile(filePath, lines.join('\n'), 'utf8');
        }
      }
    }

    gitCommitPush(`Sitzung ${datumFile}: ${s.projekt}`);

    // ===== E-Mail: HTML (Outlook-kompatibel) + Markdown =====
    const { emailHtml, emailMd } = buildEmail(s, selected, erledigteTexte, datum, zeit);

    res.json({ ok: true, markdown: md, emailHtml, emailMd, dateiname: `${datumFile}-${s.projekt}-Sitzung.md` });
  } catch (e) {
    console.error('bericht:', e);
    res.status(500).json({ error: e.message });
  }
});

function escapeHtml(s){
  if(!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function buildEmail(s, selected, erledigteTexte, datum, zeit) {
  // Gruppieren
  const byKat = {};
  selected.forEach(t => {
    if (!byKat[t.kategorie]) byKat[t.kategorie] = [];
    byKat[t.kategorie].push(t);
  });

  // ===== HTML-Version (für Outlook) =====
  let html = '';
  html += `<p>Guten Tag,</p>`;
  html += `<p>anbei die Zusammenfassung der Besprechung vom <strong>${escapeHtml(datum)}</strong> (${escapeHtml(zeit)}) zum Projekt <strong>${escapeHtml(s.projekt)}</strong>.</p>`;
  html += `<p><strong>Teilnehmer:</strong> ${escapeHtml(s.anwesende)}</p>`;

  const traktanden = byKat['Traktanden / Themen'] || [];
  if (traktanden.length) {
    html += `<h3 style="margin-top:16px;margin-bottom:6px">Traktanden / Themen</h3><ul style="margin-top:0">`;
    traktanden.forEach(t => html += `<li>${escapeHtml(t.text)}</li>`);
    html += `</ul>`;
  }

  const besprochenes = [...(byKat['Ausgeführte Arbeiten']||[]), ...(byKat['Beschlüsse']||[])];
  if (besprochenes.length) {
    html += `<h3 style="margin-top:16px;margin-bottom:6px">Besprochenes &amp; Entscheide</h3><ul style="margin-top:0">`;
    besprochenes.forEach(t => {
      const meta = [t.verantwortlich, t.termin].filter(Boolean).join(', ');
      html += `<li>${escapeHtml(t.text)}${meta ? ` <em style="color:#666">(${escapeHtml(meta)})</em>` : ''}</li>`;
    });
    html += `</ul>`;
  }

  const neuePendenzen = [...(byKat['Mängel & Pendenzen']||[]), ...(byKat['Nächste Schritte']||[])];
  if (neuePendenzen.length || erledigteTexte.length) {
    html += `<h3 style="margin-top:16px;margin-bottom:6px">Aufgaben / Pendenzen</h3><ul style="margin-top:0">`;
    erledigteTexte.forEach(t => html += `<li style="color:#888"><s>${escapeHtml(t)}</s> ✅ erledigt</li>`);
    neuePendenzen.forEach(t => {
      const verant = t.verantwortlich ? ` <strong>${escapeHtml(t.verantwortlich)}</strong>` : '';
      const termin = t.termin ? ` <em>bis ${escapeHtml(t.termin)}</em>` : '';
      html += `<li>${escapeHtml(t.text)}${verant}${termin}</li>`;
    });
    html += `</ul>`;
  }

  const bemerkungen = byKat['Bemerkungen'] || [];
  if (bemerkungen.length) {
    html += `<h3 style="margin-top:16px;margin-bottom:6px">Bemerkungen</h3><ul style="margin-top:0">`;
    bemerkungen.forEach(t => html += `<li>${escapeHtml(t.text)}</li>`);
    html += `</ul>`;
  }

  html += `<p style="margin-top:20px">Bei Fragen oder Ergänzungen gerne zurückmelden.</p>`;
  html += `<p>Freundliche Grüsse<br>Giovanoli Gebäudetechnik GmbH</p>`;

  // ===== Plain-Text/Markdown Fallback =====
  let md = `Guten Tag\n\nanbei die Zusammenfassung der Besprechung vom ${datum} (${zeit}) zum Projekt ${s.projekt}.\n\n`;
  md += `Teilnehmer: ${s.anwesende}\n\n`;
  if (traktanden.length) { md += `TRAKTANDEN / THEMEN\n`; traktanden.forEach(t => md += `• ${t.text}\n`); md += `\n`; }
  if (besprochenes.length) {
    md += `BESPROCHENES & ENTSCHEIDE\n`;
    besprochenes.forEach(t => { const meta=[t.verantwortlich,t.termin].filter(Boolean).join(', '); md += `• ${t.text}${meta?` (${meta})`:''}\n`; });
    md += `\n`;
  }
  if (neuePendenzen.length || erledigteTexte.length) {
    md += `AUFGABEN / PENDENZEN\n`;
    erledigteTexte.forEach(t => md += `• [erledigt] ${t}\n`);
    neuePendenzen.forEach(t => { const meta=[t.verantwortlich,t.termin].filter(Boolean).join(', '); md += `• ${t.text}${meta?` (${meta})`:''}\n`; });
    md += `\n`;
  }
  if (bemerkungen.length) { md += `BEMERKUNGEN\n`; bemerkungen.forEach(t => md += `• ${t.text}\n`); md += `\n`; }
  md += `Bei Fragen oder Ergänzungen gerne zurückmelden.\n\nFreundliche Grüsse\nGiovanoli Gebäudetechnik GmbH`;

  return { emailHtml: html, emailMd: md };
}

// Cleanup alter Sessions
setInterval(() => {
  const now = Date.now();
  for (const id in sessions) {
    if (now - sessions[id].createdAt > 2 * 60 * 60 * 1000) delete sessions[id];
  }
}, 30 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`GGT Backend v2 läuft auf Port ${PORT}`);
  console.log(`Vault: ${VAULT}`);
});
