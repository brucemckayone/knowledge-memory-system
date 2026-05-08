// Artifact: agent-generated interactive widget rendered inside a sandboxed
// iframe. The agent emits HTML+JS targeting a small set of allowlisted CDN
// libraries; the runtime mounts the iframe, loads the libraries, inserts the
// HTML into a #root div, and surfaces uncaught errors to the parent via
// postMessage.
//
// Props:
//   html: string         — body HTML+JS the agent produced (REQUIRED)
//   libraries?: string[] — subset of LIBRARY_ALLOWLIST keys
//   height?: number      — pixel height (default 360, clamped 120..900)
//   title?: string       — short label shown in the artifact's header
//   bg?: 'dark' | 'light' — colour scheme inside the iframe (default 'dark')
//
// Sandbox: `allow-scripts` only. No `allow-same-origin`, no `allow-forms`,
// no `allow-popups`. The iframe gets its own opaque origin: it can run JS
// and load whitelisted CDNs (cross-origin), but cannot reach our DOM,
// cookies, fetch our APIs, or navigate the parent.
(function () {
  const { h } = window;
  const { useState, useRef, useEffect, useMemo } = window.preactHooks;

  // Pinned CDN URLs. Adding a library requires an explicit entry here — the
  // agent cannot smuggle in a new library by naming it. Each entry can have
  // a JS bundle, a CSS bundle, or both. Order in the iframe matches the
  // order requested by the agent (so deps that need to load before scripts
  // can be ordered explicitly).
  const LIBRARY_ALLOWLIST = {
    d3:      { js: 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js' },
    mermaid: { js: 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js' },
    mathjax: { js: 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js' },
    katex:   {
      js:  'https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js',
      css: 'https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css',
      auto: 'https://cdn.jsdelivr.net/npm/katex@0.16/dist/contrib/auto-render.min.js',
    },
    plotly:  { js: 'https://cdn.jsdelivr.net/npm/plotly.js-dist@2.35.2/plotly.min.js' },
    p5:      { js: 'https://cdn.jsdelivr.net/npm/p5@1/lib/p5.min.js' },
    three:   { js: 'https://cdn.jsdelivr.net/npm/three@0.160/build/three.min.js' },
  };

  function clampHeight(h) {
    const n = typeof h === 'number' ? h : parseInt(h, 10);
    if (!Number.isFinite(n)) return 360;
    return Math.max(120, Math.min(900, n));
  }

  function pickLibraries(requested) {
    if (!Array.isArray(requested)) return [];
    const seen = new Set();
    const out = [];
    for (const name of requested) {
      if (typeof name !== 'string') continue;
      const key = name.trim().toLowerCase();
      if (!LIBRARY_ALLOWLIST[key]) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  // Build the srcdoc. Loads CSS in <head>, then JS scripts sequentially (so
  // dependent libraries finish before the agent's body runs), then injects
  // the body HTML, then surfaces errors.
  function buildSrcdoc({ html, libraries, bg }) {
    const css = [];
    const js = [];
    for (const lib of libraries) {
      const entry = LIBRARY_ALLOWLIST[lib];
      if (entry.css) css.push(entry.css);
      if (entry.js) js.push(entry.js);
      if (entry.auto) js.push(entry.auto); // katex auto-render bundles a second script
    }

    const isDark = bg !== 'light';
    const baseStyle = isDark
      ? 'background:#0f1117;color:#e2e8f0;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;padding:16px;margin:0;'
      : 'background:#fafafa;color:#1a1a1a;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;padding:16px;margin:0;';

    const cssTags = css.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n');

    // Sequential script loading: each <script src> is appended only after the
    // previous one fires onload. The agent's body HTML is written to #root after
    // all libraries finish loading so its inline <script>s can rely on globals.
    const libList = JSON.stringify(js);
    // Why escape </script> in the JSON output (not in the HTML before stringify):
    // the resulting JSON literal is embedded as a JS string inside the bootstrap's
    // <script> tag. The OUTER iframe HTML parser must not see </script> inside
    // that JS string or it terminates the bootstrap early — so we replace it with
    // <\/script> in the JSON. `\/` is a JS-string escape for `/`, so the parser
    // produces an in-memory string with the original </script> intact, and
    // innerHTML at runtime sees clean HTML and parses the inner scripts properly.
    // (Doing the replace on the raw HTML before JSON.stringify is the bug we
    // had: it produced LITERAL backslashes at runtime, breaking inner script
    // parsing with "Unexpected token '<'".)
    const safeBodyJson = JSON.stringify(String(html || '')).replace(/<\/script>/gi, '<\\/script>');

    const bootstrapJs = `
      (function(){
        const send = (msg) => { try { parent.postMessage(msg, '*'); } catch(_){} };
        window.addEventListener('error', (e) => {
          send({ type: 'artifact:error', message: (e.message || 'unknown error') + (e.filename ? ' @ ' + (e.lineno || '?') : '') });
        });
        window.addEventListener('unhandledrejection', (e) => {
          const r = e.reason; const m = (r && r.message) ? r.message : String(r);
          send({ type: 'artifact:error', message: 'Unhandled: ' + m });
        });
        const libs = ${libList};
        const root = document.getElementById('root');
        function loadNext(i) {
          if (i >= libs.length) { mountBody(); return; }
          const s = document.createElement('script');
          s.src = libs[i];
          s.onload = () => loadNext(i + 1);
          s.onerror = () => {
            send({ type: 'artifact:error', message: 'Library failed to load: ' + libs[i] });
            // Continue anyway so the agent's body still runs (degraded).
            loadNext(i + 1);
          };
          document.head.appendChild(s);
        }
        // Re-execute one of the agent's inline scripts. We DO NOT use
        // replaceChild(newScript, old) because if newScript's text contains
        // a syntax error, the resulting parse failure propagates as an
        // "Uncaught SyntaxError" out of the DOM mutation in some browsers,
        // bypassing our try/catch. Instead: parse-check via new Function,
        // and if it parses, execute via new Function() inside try/catch so
        // both parse AND runtime errors surface as postMessage events.
        function runInlineScript(old, idx) {
          const code = old.textContent || '';
          // Skip non-JS scripts (e.g. type="x-template"). Treat empty/missing
          // type and "text/javascript" / "application/javascript" as JS.
          const t = (old.getAttribute('type') || '').trim().toLowerCase();
          const isJs = t === '' || t === 'text/javascript' || t === 'application/javascript' || t === 'module';
          if (!isJs) return;
          let fn;
          try {
            // Compile-only check. For type="module" we can't really new-Function
            // a module, but we attempt it anyway — if it fails, the error is
            // surfaced cleanly instead of crashing the iframe.
            fn = new Function(code);
          } catch (err) {
            send({ type: 'artifact:error', message: 'Script #' + (idx + 1) + ' parse error: ' + (err && err.message ? err.message : String(err)) });
            return;
          }
          try {
            fn();
          } catch (err) {
            send({ type: 'artifact:error', message: 'Script #' + (idx + 1) + ' runtime error: ' + (err && err.message ? err.message : String(err)) });
          }
        }
        function mountBody() {
          try {
            root.innerHTML = ${safeBodyJson};
          } catch (err) {
            send({ type: 'artifact:error', message: 'innerHTML parse error: ' + (err && err.message ? err.message : String(err)) });
            send({ type: 'artifact:ready' });
            return;
          }
          // Re-execute every inline <script>. innerHTML doesn't run them on
          // its own; we evaluate via new Function so parse/runtime errors are
          // catchable rather than uncaught.
          const inlineScripts = root.querySelectorAll('script');
          inlineScripts.forEach(runInlineScript);
          // Send ready even when individual scripts errored — partial render
          // is still useful, and the error footer surfaces what went wrong.
          send({ type: 'artifact:ready' });
        }
        loadNext(0);
      })();
    `;

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{${baseStyle}}#root{width:100%;}*{box-sizing:border-box;}</style>
${cssTags}
</head><body><div id="root"></div><script>${bootstrapJs}<\/script></body></html>`;
  }

  function Artifact(props) {
    const html = (props && typeof props.html === 'string') ? props.html : '';
    const libraries = useMemo(() => pickLibraries(props && props.libraries), [props && props.libraries]);
    const height = clampHeight(props && props.height);
    const title = (props && typeof props.title === 'string') ? props.title : '';
    const bg = (props && props.bg) || 'dark';

    const iframeRef = useRef(null);
    const wrapRef = useRef(null);
    const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
    const [errors, setErrors] = useState([]);
    const [repairState, setRepairState] = useState({ pending: false, elapsedMs: 0, error: null });
    const repairStartRef = useRef(0);

    // Build the srcdoc once per (html, libs) tuple. Re-mount on change.
    const srcdoc = useMemo(
      () => buildSrcdoc({ html, libraries, bg }),
      [html, libraries.join('|'), bg],
    );

    // Listen for postMessage from this iframe specifically.
    useEffect(() => {
      const onMessage = (e) => {
        if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
        const d = e.data || {};
        if (d.type === 'artifact:ready') {
          setStatus('ready');
        } else if (d.type === 'artifact:error') {
          setErrors((prev) => prev.concat([d.message || 'unknown error']));
          // First error keeps loading-state false but we don't flip to 'error' —
          // many artifacts log non-fatal errors after ready. Only flip if the
          // ready message never arrives (handled by the load-watchdog below).
        }
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, []);

    // Watchdog: if no ready message after 8s, surface a soft error but keep
    // the iframe visible (the artifact may still be alive — just slow).
    useEffect(() => {
      setStatus('loading');
      setErrors([]);
      const t = setTimeout(() => {
        setStatus((s) => (s === 'loading' ? 'slow' : s));
      }, 8000);
      return () => clearTimeout(t);
    }, [srcdoc]);

    const wrapStyle = {
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      margin: '12px 0',
      overflow: 'hidden',
    };
    const headerStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
      padding: '6px 12px',
      background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      fontSize: '12px',
      color: 'var(--muted)',
    };
    const statusDot = {
      display: 'inline-block',
      width: '8px', height: '8px', borderRadius: '50%',
      background: status === 'ready' ? 'var(--green)' : status === 'slow' ? 'var(--yellow)' : 'var(--muted)',
      marginRight: '6px',
    };
    const iframeStyle = {
      width: '100%',
      height: height + 'px',
      border: 'none',
      display: 'block',
      background: bg === 'light' ? '#fafafa' : '#0f1117',
    };
    const errorStyle = {
      padding: '8px 12px',
      borderTop: '1px solid var(--border)',
      background: 'rgba(239,68,68,0.06)',
      color: 'var(--red)',
      fontFamily: 'ui-monospace, monospace',
      fontSize: '11px',
      whiteSpace: 'pre-wrap',
      maxHeight: '120px',
      overflow: 'auto',
    };
    const errorFooterStyle = {
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px',
    };
    const fixBtnStyle = {
      flexShrink: 0,
      padding: '4px 10px',
      fontSize: '11px',
      fontFamily: 'inherit',
      background: 'transparent',
      color: 'var(--text)',
      border: '1px solid var(--border)',
      borderRadius: '4px',
      cursor: repairState.pending ? 'progress' : 'pointer',
      opacity: repairState.pending ? 0.7 : 1,
    };

    // Pull the repair callback at render time from props OR a window-scoped
    // registry keyed by section. The registry exists because LessonRenderer
    // dispatches component blocks generically — threading a section-specific
    // onFix through every component would mean changing the renderer's
    // contract. The registry keeps the renderer pristine.
    const onFix = (props && typeof props.onFix === 'function')
      ? props.onFix
      : (window.LearnArtifactRepair && typeof window.LearnArtifactRepair.onFix === 'function'
          ? window.LearnArtifactRepair.onFix
          : null);

    // Tick elapsed-time counter while repair is pending. Cheap setInterval —
    // mounted only when pending flips true.
    useEffect(() => {
      if (!repairState.pending) return undefined;
      const tick = () => {
        setRepairState((s) => s.pending
          ? { ...s, elapsedMs: Date.now() - repairStartRef.current }
          : s);
      };
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }, [repairState.pending]);

    const handleFix = async () => {
      if (!onFix || repairState.pending) return;
      repairStartRef.current = Date.now();
      setRepairState({ pending: true, elapsedMs: 0, error: null });
      try {
        // The parent handler will remount the lesson on success (this component
        // unmounts entirely). On failure, it returns { errorText } so we can
        // surface it inline.
        const res = await onFix({ html, libraries, height, title, errors: errors.slice(), element: wrapRef.current });
        if (res && res.errorText) {
          setRepairState({ pending: false, elapsedMs: 0, error: res.errorText });
        } else {
          setRepairState({ pending: false, elapsedMs: 0, error: null });
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        setRepairState({ pending: false, elapsedMs: 0, error: msg });
      }
    };

    function formatElapsed(ms) {
      const s = Math.floor(ms / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return mm + ':' + ss;
    }

    const showFixButton = errors.length > 0 && typeof onFix === 'function';

    return h`
      <div class="artifact" ref=${wrapRef} style=${wrapStyle}>
        <div class="artifact-header" style=${headerStyle}>
          <span><span style=${statusDot}></span>${title || 'Artifact'}${libraries.length ? ' · ' + libraries.join(', ') : ''}</span>
          <span>${status === 'loading' ? 'loading…' : status === 'slow' ? 'still loading…' : 'ready'}</span>
        </div>
        <iframe
          ref=${iframeRef}
          class="artifact-frame"
          sandbox="allow-scripts"
          srcdoc=${srcdoc}
          style=${iframeStyle}
          title=${title || 'Artifact'}
          loading="lazy"
        ></iframe>
        ${errors.length > 0 ? h`
          <div class="artifact-errors" style=${errorStyle}>
            <div style=${errorFooterStyle}>
              <div style=${{flex: '1 1 auto', minWidth: 0}}>
                ${errors.map((m, i) => h`<div key=${i}>${m}</div>`)}
                ${repairState.error ? h`<div style=${{marginTop:'6px',fontWeight:600}}>Repair failed: ${repairState.error}</div>` : null}
              </div>
              ${showFixButton ? h`
                <button
                  type="button"
                  style=${fixBtnStyle}
                  disabled=${repairState.pending}
                  onClick=${handleFix}
                >${repairState.pending ? 'Fixing… ' + formatElapsed(repairState.elapsedMs) : 'Fix this'}</button>
              ` : null}
            </div>
          </div>
        ` : null}
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.Artifact = Artifact;
  // Expose the allowlist so other parts of the UI can render a "supported libraries" hint.
  window.LearnComponents.ARTIFACT_LIBRARY_ALLOWLIST = Object.keys(LIBRARY_ALLOWLIST);
})();
