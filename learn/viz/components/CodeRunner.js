// CodeRunner: shows code in a <pre><code> block + Run button that executes in a
// sandboxed iframe (sandbox="allow-scripts"). Captures console.log via postMessage.
// v1: JS only (other langs render but Run is disabled).
(function(){
  const { h } = window;
  const { useState, useRef, useEffect, useCallback } = window.preactHooks;

  // HTML scaffold for the sandboxed runner. Posts {type:'log', args} for every console.* call,
  // {type:'error', message} for thrown errors, {type:'done'} when execution finishes.
  function buildIframeSrcdoc(code) {
    // Escape closing script tags inside the code so the inline <script> isn't terminated early.
    const safeCode = String(code).replace(/<\/script>/gi, '<\\/script>');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
(function(){
  const send = (msg) => { try { parent.postMessage(msg, '*'); } catch(_){} };
  const fmt = (a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch(_){ return String(a); } }
    return String(a);
  };
  ['log','info','warn','error','debug'].forEach(level => {
    const orig = console[level];
    console[level] = function(){
      const args = Array.from(arguments).map(fmt);
      send({type:'log', level, args});
      try { orig.apply(console, arguments); } catch(_){}
    };
  });
  window.addEventListener('error', (e) => send({type:'error', message: e.message + ' @ ' + (e.lineno||'?')}));
  window.addEventListener('unhandledrejection', (e) => send({type:'error', message: 'Unhandled: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))}));
  try {
    (function(){ ${safeCode} })();
    send({type:'done'});
  } catch (err) {
    send({type:'error', message: err && err.message ? err.message : String(err)});
    send({type:'done'});
  }
})();
<\/script></body></html>`;
  }

  function CodeRunner(props) {
    const lang = (props && props.lang) || 'js';
    const code = (props && props.code) != null ? props.code : '';
    const [output, setOutput] = useState([]);
    const [running, setRunning] = useState(false);
    const iframeRef = useRef(null);
    const runIdRef = useRef(0);

    const runnable = lang === 'js' || lang === 'javascript';

    const onMessage = useCallback((e) => {
      // Only accept messages from our iframe
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const data = e.data || {};
      if (data.type === 'log') {
        setOutput(prev => prev.concat([{ kind: data.level || 'log', text: (data.args || []).join(' ') }]));
      } else if (data.type === 'error') {
        setOutput(prev => prev.concat([{ kind: 'error', text: data.message || 'error' }]));
      } else if (data.type === 'done') {
        setRunning(false);
      }
    }, []);

    useEffect(() => {
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, [onMessage]);

    const handleRun = () => {
      if (!runnable) return;
      runIdRef.current += 1;
      setOutput([]);
      setRunning(true);
      const iframe = iframeRef.current;
      if (!iframe) { setRunning(false); return; }
      iframe.srcdoc = buildIframeSrcdoc(code);
    };

    const handleReset = () => {
      setOutput([]);
      setRunning(false);
      if (iframeRef.current) iframeRef.current.srcdoc = '';
    };

    const wrapStyle = {
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', margin: '12px 0', overflow: 'hidden',
    };
    const headStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 12px', background: 'var(--surface2)', borderBottom: '1px solid var(--border)',
      fontSize: '11px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px',
    };
    const preStyle = {
      margin: '0', padding: '14px 16px', background: 'var(--surface2)',
      fontFamily: 'ui-monospace, monospace', fontSize: '12.5px', lineHeight: '1.55',
      color: 'var(--text)', overflowX: 'auto', whiteSpace: 'pre',
    };
    const btnRowStyle = {
      display: 'flex', gap: '8px', padding: '10px 12px',
      borderTop: '1px solid var(--border)', background: 'var(--surface)',
    };
    const outStyle = {
      borderTop: '1px solid var(--border)', padding: '10px 14px', background: '#0b0d12',
      fontFamily: 'ui-monospace, monospace', fontSize: '12px', lineHeight: '1.5',
      maxHeight: '220px', overflowY: 'auto',
    };

    return h`
      <div class="code-runner" style=${wrapStyle}>
        <div style=${headStyle}>
          <span>Code · ${lang}</span>
          ${running ? h`<span style=${{color:'var(--accent)'}}>Running…</span>` : null}
        </div>
        <pre style=${preStyle}><code class="language-${lang}">${code}</code></pre>
        <div style=${btnRowStyle}>
          <button class="btn btn-primary" onClick=${handleRun} disabled=${!runnable || running}>
            ${running ? 'Running…' : 'Run'}
          </button>
          <button class="btn btn-secondary" onClick=${handleReset} disabled=${running}>Reset</button>
          ${!runnable ? h`<span style=${{color:'var(--muted)',fontSize:'12px',alignSelf:'center'}}>Run only supports JavaScript in v1</span>` : null}
        </div>
        ${output.length > 0 ? h`
          <div style=${outStyle}>
            ${output.map((line, idx) => h`
              <div key=${idx} style=${{color: line.kind === 'error' ? 'var(--red)' : line.kind === 'warn' ? 'var(--yellow)' : 'var(--text)', whiteSpace: 'pre-wrap'}}>
                ${line.kind !== 'log' ? '[' + line.kind + '] ' : ''}${line.text}
              </div>
            `)}
          </div>
        ` : null}
        <iframe ref=${iframeRef} sandbox="allow-scripts" style=${{display:'none'}} title="code-runner-sandbox"></iframe>
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.CodeRunner = CodeRunner;
})();
