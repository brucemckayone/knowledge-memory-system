import { enqueueIngest } from '../api.js';

const MAX_CHUNK = 2000;

function chunkText(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_CHUNK) {
    let cut = -1;
    const slice = remaining.slice(0, MAX_CHUNK);
    cut = slice.lastIndexOf('\n\n');
    if (cut < 200) cut = slice.lastIndexOf('\n');
    if (cut < 200) cut = slice.lastIndexOf('. ');
    if (cut < 200) cut = slice.lastIndexOf(' ');
    if (cut < 200) cut = MAX_CHUNK;
    else cut += 1;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function doIngest() {
  const textEl = document.getElementById('ingestText');
  const sourceEl = document.getElementById('ingestSource');
  const statusEl = document.getElementById('ingestStatus');
  const btn = document.getElementById('btnIngest');
  const text = textEl.value.trim();

  if (!text) {
    statusEl.className = 'ingest-status error';
    statusEl.textContent = 'No text to ingest';
    return;
  }

  const chunks = chunkText(text);
  const source = sourceEl.value.trim() || undefined;

  btn.textContent = `Queuing ${chunks.length} chunk${chunks.length > 1 ? 's' : ''}…`;
  btn.disabled = true;
  statusEl.className = 'ingest-status';
  statusEl.textContent = '';

  try {
    for (const chunk of chunks) {
      await enqueueIngest(chunk, source);
    }
    statusEl.className = 'ingest-status success';
    statusEl.textContent = chunks.length === 1
      ? 'Queued (1 chunk) — graph updates automatically'
      : `Queued (${chunks.length} chunks) — graph updates automatically`;
    textEl.value = '';
    sourceEl.value = '';
  } catch (err) {
    statusEl.className = 'ingest-status error';
    statusEl.textContent = err.message;
  } finally {
    btn.textContent = 'Ingest';
    btn.disabled = false;
  }
}

export function bindIngestPanel() {
  document.getElementById('btnIngestToggle').addEventListener('click', () => {
    const panel = document.getElementById('ingestPanel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) document.getElementById('ingestText').focus();
  });
  document.getElementById('btnIngest').addEventListener('click', doIngest);
}
