// ExplainerPopover: floating popover that shows the explainer-agent response
// (or a "Take a note" editor stub) anchored near the learner's text selection.
//
// Used by the lesson view: when the Highlight component fires onAction, the
// page constructs one of these and mounts it into a fixed overlay container.
// The popover handles its own click-outside / Esc dismiss and auto-flips
// vertically when it would render off-screen.
//
// Two modes:
//   { mode: 'agent', state: 'loading' | 'error' | 'ok', contentMd, action, selectedText, errorText }
//     — read-only; renders markdown content. "Loading…" while fetching.
//   { mode: 'note', selectedText, onSave, onCancel }
//     — quick note editor stub. Save calls onSave({ selectedText, draft });
//     persistence lands later, so onSave should just toast / log for now.
//
// Props:
//   anchorRect: DOMRect-like { left, top, right, bottom } in viewport coords
//   mode: 'agent' | 'note'
//   action?: 'explain' | 'example' | 'why'   (agent mode only — controls header label)
//   state?: 'loading' | 'error' | 'ok'        (agent mode only)
//   contentMd?: string                         (agent mode only)
//   errorText?: string                         (agent mode optional)
//   selectedText?: string
//   onSave?: ({ selectedText, draft }) => void (note mode)
//   onCancel?: () => void                      (note mode — also called on Esc / outside click in either mode)
(function () {
  const { h } = window;
  const { useEffect, useRef, useState, useLayoutEffect } = window.preactHooks;

  const ACTION_LABELS = {
    explain: 'Explain',
    example: 'Example',
    why: 'Why',
  };

  function renderMd(src) {
    if (typeof src !== 'string' || !src) return '';
    if (typeof window.renderMarkdown === 'function') return window.renderMarkdown(src);
    if (typeof window.marked !== 'undefined' && window.marked.parse) {
      try { return window.marked.parse(src, { breaks: false, gfm: true }); } catch { /* fall through */ }
    }
    const esc = src
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<p>' + esc + '</p>';
  }

  // Position the popover relative to the anchor rect, flipping above/below
  // and clamping horizontally to stay on-screen.
  function computePosition(anchorRect, popEl) {
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const popW = popEl ? popEl.offsetWidth : 360;
    const popH = popEl ? popEl.offsetHeight : 200;

    // Centre horizontally on the anchor, then clamp.
    const anchorMidX = (anchorRect.left + anchorRect.right) / 2;
    let x = anchorMidX - popW / 2;
    if (x + popW + margin > vw) x = vw - popW - margin;
    if (x < margin) x = margin;

    // Prefer below the selection. Flip above if it would clip.
    const spaceBelow = vh - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    let y;
    if (spaceBelow >= popH + margin || spaceBelow >= spaceAbove) {
      y = anchorRect.bottom + margin;
      if (y + popH + margin > vh) y = Math.max(margin, vh - popH - margin);
    } else {
      y = anchorRect.top - popH - margin;
      if (y < margin) y = margin;
    }
    return { x, y };
  }

  function ExplainerPopover(props) {
    const popRef = useRef(null);
    const bodyRef = useRef(null);
    const taRef = useRef(null);
    const [pos, setPos] = useState({ x: 0, y: 0 });
    const [draft, setDraft] = useState(props && props.mode === 'note'
      ? (props.selectedText ? props.selectedText : '')
      : '');

    // Position once after layout, then again whenever content size changes
    // (e.g. agent response replaces the loading spinner).
    useLayoutEffect(() => {
      if (!popRef.current || !props.anchorRect) return;
      setPos(computePosition(props.anchorRect, popRef.current));
    }, [props.anchorRect, props.contentMd, props.state, props.mode]);

    // Render markdown content into bodyRef (agent mode only).
    useEffect(() => {
      if (props.mode !== 'agent') return;
      if (!bodyRef.current) return;
      if (props.state === 'ok' && props.contentMd) {
        bodyRef.current.innerHTML = renderMd(props.contentMd);
      } else if (props.state === 'error') {
        const err = props.errorText ? String(props.errorText) : 'Unknown error';
        bodyRef.current.innerHTML = renderMd(props.contentMd || `_Failed: ${err}_`);
      } else {
        bodyRef.current.innerHTML = '';
      }
    }, [props.mode, props.state, props.contentMd, props.errorText]);

    // Auto-focus textarea in note mode.
    useEffect(() => {
      if (props.mode !== 'note') return;
      if (!taRef.current) return;
      taRef.current.focus();
      // Move caret to end.
      const len = taRef.current.value.length;
      try { taRef.current.setSelectionRange(len, len); } catch { /* ignore */ }
    }, [props.mode]);

    // Click-outside + Escape dismiss.
    useEffect(() => {
      const onDocClick = (e) => {
        if (!popRef.current) return;
        if (popRef.current.contains(e.target)) return;
        if (typeof props.onCancel === 'function') props.onCancel();
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          if (typeof props.onCancel === 'function') props.onCancel();
        }
      };
      // mousedown so we beat any click handlers on lesson body.
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mousedown', onDocClick);
        document.removeEventListener('keydown', onKey);
      };
    }, [props.onCancel]);

    const wrapStyle = {
      position: 'fixed',
      left: pos.x + 'px',
      top: pos.y + 'px',
      width: '360px',
      maxWidth: '90vw',
      maxHeight: '60vh',
      overflow: 'auto',
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      zIndex: '100',
      color: 'var(--text)',
      padding: '12px 14px',
      fontSize: '13px',
      lineHeight: '1.55',
    };
    const headerStyle = {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '8px',
      paddingBottom: '6px',
      borderBottom: '1px solid var(--border)',
    };
    const titleStyle = {
      fontSize: '12px',
      color: 'var(--muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      fontWeight: '600',
    };
    const closeBtnStyle = {
      background: 'transparent',
      border: 'none',
      color: 'var(--muted)',
      cursor: 'pointer',
      fontSize: '16px',
      lineHeight: '1',
      padding: '0 4px',
      fontFamily: 'inherit',
    };
    const quoteStyle = {
      fontSize: '11px',
      color: 'var(--muted)',
      fontStyle: 'italic',
      marginBottom: '8px',
      maxHeight: '3em',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      borderLeft: '2px solid var(--accent)',
      paddingLeft: '8px',
    };

    if (props.mode === 'agent') {
      const label = ACTION_LABELS[props.action] || 'Explain';
      const trimmedSel = props.selectedText
        ? (props.selectedText.length > 80
            ? props.selectedText.slice(0, 77) + '…'
            : props.selectedText)
        : '';
      return h`
        <div ref=${popRef} class="explainer-popover" style=${wrapStyle}
             onMouseDown=${(e) => e.stopPropagation()}>
          <div style=${headerStyle}>
            <span style=${titleStyle}>${label}</span>
            <button type="button" style=${closeBtnStyle} onClick=${props.onCancel} aria-label="Close">×</button>
          </div>
          ${trimmedSel ? h`<div style=${quoteStyle}>"${trimmedSel}"</div>` : null}
          ${props.state === 'loading'
            ? h`<div style=${{display:'flex',alignItems:'center',gap:'8px',color:'var(--muted)'}}>
                  <div class="spinner" style=${{width:'12px',height:'12px',borderWidth:'2px'}}></div>
                  <span>Thinking…</span>
                </div>`
            : h`<div ref=${bodyRef} class="md explainer-body"></div>`}
        </div>
      `;
    }

    // note mode
    const taStyle = {
      width: '100%',
      minHeight: '120px',
      resize: 'vertical',
      background: 'var(--surface)',
      color: 'var(--text)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      padding: '8px 10px',
      fontSize: '13px',
      fontFamily: 'inherit',
      lineHeight: '1.5',
    };
    const btnRowStyle = {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '8px',
      marginTop: '10px',
    };
    const btnPrimaryStyle = {
      background: 'var(--accent)',
      color: '#fff',
      border: '1px solid var(--accent)',
      borderRadius: '6px',
      padding: '6px 14px',
      fontSize: '12px',
      cursor: 'pointer',
      fontFamily: 'inherit',
    };
    const btnSecondaryStyle = {
      background: 'transparent',
      color: 'var(--text)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      padding: '6px 14px',
      fontSize: '12px',
      cursor: 'pointer',
      fontFamily: 'inherit',
    };

    const handleSave = () => {
      if (typeof props.onSave === 'function') {
        props.onSave({ selectedText: props.selectedText || '', draft });
      }
    };

    return h`
      <div ref=${popRef} class="explainer-popover" style=${wrapStyle}
           onMouseDown=${(e) => e.stopPropagation()}>
        <div style=${headerStyle}>
          <span style=${titleStyle}>Take a note</span>
          <button type="button" style=${closeBtnStyle} onClick=${props.onCancel} aria-label="Close">×</button>
        </div>
        <textarea
          ref=${taRef}
          style=${taStyle}
          value=${draft}
          onInput=${(e) => setDraft(e.currentTarget.value)}
          placeholder="Your note…"
        ></textarea>
        <div style=${btnRowStyle}>
          <button type="button" style=${btnSecondaryStyle} onClick=${props.onCancel}>Cancel</button>
          <button type="button" style=${btnPrimaryStyle} onClick=${handleSave}>Save</button>
        </div>
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.ExplainerPopover = ExplainerPopover;
})();
