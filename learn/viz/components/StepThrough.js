// StepThrough: stepwise reveal with Next/Prev. Animates content swap via fade.
// Props:
//   steps: Array<{ title?: string, content: string|VNode }>  required
//   currentStep?: number    (controlled mode — when provided, parent owns the index)
//   onStepChange?: (idx) => void
(function(){
  const { h } = window;
  const { useState, useEffect, useRef } = window.preactHooks;

  function StepThrough(props) {
    const steps = (props && Array.isArray(props.steps)) ? props.steps : [];
    const controlled = props && typeof props.currentStep === 'number';
    const onStepChange = props && typeof props.onStepChange === 'function' ? props.onStepChange : null;

    const [internalIdx, setInternalIdx] = useState(controlled ? props.currentStep : 0);
    const idx = controlled ? Math.max(0, Math.min(props.currentStep, steps.length - 1)) : internalIdx;

    // Fade key — bumped when idx changes so the content div re-mounts and re-animates.
    const [animKey, setAnimKey] = useState(0);
    const prevIdxRef = useRef(idx);
    useEffect(() => {
      if (prevIdxRef.current !== idx) {
        setAnimKey(k => k + 1);
        prevIdxRef.current = idx;
      }
    }, [idx]);

    const setIdx = (next) => {
      const clamped = Math.max(0, Math.min(next, steps.length - 1));
      if (clamped === idx) return;
      if (!controlled) setInternalIdx(clamped);
      if (onStepChange) onStepChange(clamped);
    };

    const wrapStyle = {
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '20px', margin: '12px 0',
    };
    const headStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: '14px', paddingBottom: '12px', borderBottom: '1px solid var(--border)',
    };
    const titleStyle = { fontWeight: '600', fontSize: '15px', color: 'var(--text)' };
    const counterStyle = {
      color: 'var(--muted)', fontSize: '12px', textTransform: 'uppercase',
      letterSpacing: '0.5px', fontVariantNumeric: 'tabular-nums',
    };
    const contentStyle = {
      minHeight: '60px', lineHeight: '1.6', color: 'var(--text)',
      animation: 'stepFade 220ms ease',
    };
    const navStyle = {
      display: 'flex', gap: '8px', marginTop: '16px',
      paddingTop: '14px', borderTop: '1px solid var(--border)',
    };

    if (steps.length === 0) {
      return h`<div class="step-through" style=${wrapStyle}>
        <div style=${{color:'var(--muted)',fontSize:'13px'}}>No steps provided.</div>
      </div>`;
    }

    const cur = steps[idx] || {};

    // Inject keyframes once
    useEffect(() => {
      if (document.getElementById('stepthrough-anim')) return;
      const s = document.createElement('style');
      s.id = 'stepthrough-anim';
      s.textContent = '@keyframes stepFade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }';
      document.head.appendChild(s);
    }, []);

    return h`
      <div class="step-through" style=${wrapStyle}>
        <div style=${headStyle}>
          <div style=${titleStyle}>${cur.title || ('Step ' + (idx + 1))}</div>
          <div style=${counterStyle}>${idx + 1} of ${steps.length}</div>
        </div>
        <div key=${animKey} class="step-content" style=${contentStyle}>
          ${cur.content != null ? cur.content : ''}
        </div>
        <div style=${navStyle}>
          <button class="btn btn-secondary" onClick=${() => setIdx(idx - 1)} disabled=${idx === 0}>← Prev</button>
          <button class="btn btn-primary" onClick=${() => setIdx(idx + 1)} disabled=${idx === steps.length - 1}>Next →</button>
        </div>
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.StepThrough = StepThrough;
})();
