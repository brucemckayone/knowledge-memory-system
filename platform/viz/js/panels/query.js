import { triggerReasonQuery } from '../api.js';

export function showAnswer(text) {
  const panel = document.getElementById('answerPanel');
  document.getElementById('answerContent').textContent = text;
  panel.classList.add('open');
}

async function doQuery() {
  const input = document.getElementById('queryInput');
  const statusEl = document.getElementById('queryStatus');
  const btn = document.getElementById('btnQuery');
  const question = input.value.trim();

  if (!question) {
    statusEl.className = 'query-status error';
    statusEl.textContent = 'Enter a question';
    return;
  }

  btn.textContent = 'Thinking…';
  btn.disabled = true;
  statusEl.className = 'query-status';
  statusEl.textContent = '';

  try {
    const data = await triggerReasonQuery(question);
    showAnswer(`Q: ${question}\n\n${data.result}`);
    input.value = '';
  } catch (err) {
    statusEl.className = 'query-status error';
    statusEl.textContent = err.message;
  } finally {
    btn.textContent = 'Ask';
    btn.disabled = false;
  }
}

export function bindQueryPanel() {
  document.getElementById('btnQueryToggle').addEventListener('click', () => {
    const panel = document.getElementById('queryPanel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) document.getElementById('queryInput').focus();
  });
  document.getElementById('btnQuery').addEventListener('click', doQuery);
  document.getElementById('queryInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doQuery();
  });
  document.getElementById('answerClose').addEventListener('click', () => {
    document.getElementById('answerPanel').classList.remove('open');
  });
}
