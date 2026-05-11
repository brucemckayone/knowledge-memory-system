// Mermaid: lazy-loads mermaid via window.loadMermaid(), renders SVG into the component.
// Props: src (mermaid syntax), id? (auto-generated if absent).
(function(){
  const { h } = window;
  const { useState, useEffect, useRef } = window.preactHooks;

  let counter = 0;
  function genId() { counter += 1; return 'mermaid-' + Date.now().toString(36) + '-' + counter; }

  function Mermaid(props) {
    const src = (props && props.src) || '';
    const id = (props && props.id) || genId();
    const [state, setState] = useState({ status: 'loading', svg: '', error: '' });
    const ref = useRef(null);

    useEffect(() => {
      let cancelled = false;
      if (typeof window.loadMermaid !== 'function') {
        setState({ status: 'error', svg: '', error: 'window.loadMermaid not available' });
        return;
      }
      window.loadMermaid()
        .then(m => m.render(id, src))
        .then(out => {
          if (cancelled) return;
          // mermaid v10: returns { svg, bindFunctions? }
          const svg = (out && typeof out === 'object' && 'svg' in out) ? out.svg : out;
          setState({ status: 'ready', svg: svg, error: '' });
        })
        .catch(err => {
          if (cancelled) return;
          setState({ status: 'error', svg: '', error: (err && err.message) ? err.message : String(err) });
        });
      return () => { cancelled = true; };
    }, [src, id]);

    // Inject SVG once render resolves. Mermaid sometimes leaves orphan <div id> nodes; clean them up.
    useEffect(() => {
      if (state.status === 'ready' && ref.current) {
        ref.current.innerHTML = state.svg;
      }
      // Remove any orphan diagram nodes mermaid may have created on document.body during render.
      document.querySelectorAll('div#' + CSS.escape(id) + ':not(.mermaid-host)').forEach(n => {
        if (n !== ref.current) n.remove();
      });
    }, [state.status, state.svg]);

    const wrapStyle = {
      background: 'var(--surface2)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '16px', margin: '12px 0',
      overflowX: 'auto', textAlign: 'center',
    };

    if (state.status === 'loading') {
      return h`<div class="mermaid-loading" style=${wrapStyle}><span style=${{color:'var(--muted)',fontSize:'13px'}}>Loading diagram…</span></div>`;
    }
    if (state.status === 'error') {
      return h`
        <div class="mermaid-error" style=${{...wrapStyle, color:'var(--red)', textAlign:'left', fontFamily:'ui-monospace,monospace', fontSize:'12px'}}>
          <div style=${{fontWeight:'600',marginBottom:'4px'}}>Mermaid render failed</div>
          <div style=${{color:'var(--muted)',whiteSpace:'pre-wrap'}}>${state.error}</div>
        </div>
      `;
    }
    return h`<div class="mermaid-host" id="${id}-host" ref=${ref} style=${wrapStyle}></div>`;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.Mermaid = Mermaid;
})();
