// Highlight: wraps content; on text selection within, shows a floating action menu.
// Actions: Explain / Example / Why / Note. Phase-5 will wire these to agents.
// Props:
//   children: any
//   onAction?: (action: 'explain'|'example'|'why'|'note', selectedText: string) => void
(function(){
  const { h } = window;
  const { useState, useEffect, useRef, useCallback } = window.preactHooks;

  const ACTIONS = [
    { key: 'explain', label: 'Explain' },
    { key: 'example', label: 'Example' },
    { key: 'why',     label: 'Why' },
    { key: 'note',    label: 'Note' },
  ];

  function Highlight(props) {
    const onAction = props && typeof props.onAction === 'function' ? props.onAction : null;
    const wrapRef = useRef(null);
    const [menu, setMenu] = useState(null); // { x, y, text } | null

    // Compute menu position from current window selection. Returns null if selection
    // is empty or not contained inside our wrapper.
    const computeMenu = useCallback(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const text = sel.toString().trim();
      if (!text) return null;
      const range = sel.getRangeAt(0);
      // Selection must be inside our wrapper.
      if (!wrapRef.current || !wrapRef.current.contains(range.commonAncestorContainer)) return null;
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return null;
      const wrapRect = wrapRef.current.getBoundingClientRect();
      // Position above the selection, relative to the wrapper.
      const x = rect.left - wrapRect.left + (rect.width / 2);
      const y = rect.top - wrapRect.top - 8;
      return { x, y, text };
    }, []);

    // Listen for selection-end (mouseup / touchend / keyup with shift).
    useEffect(() => {
      const onMouseUp = () => {
        // Defer one frame so the selection has settled.
        setTimeout(() => {
          const m = computeMenu();
          setMenu(m);
        }, 0);
      };
      const onSelectionChange = () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) setMenu(null);
      };
      const onDocClick = (e) => {
        if (!wrapRef.current) return;
        // If clicking outside the wrapper, dismiss.
        if (!wrapRef.current.contains(e.target)) setMenu(null);
      };
      const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
      document.addEventListener('mouseup', onMouseUp);
      document.addEventListener('touchend', onMouseUp);
      document.addEventListener('selectionchange', onSelectionChange);
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('touchend', onMouseUp);
        document.removeEventListener('selectionchange', onSelectionChange);
        document.removeEventListener('mousedown', onDocClick);
        document.removeEventListener('keydown', onKey);
      };
    }, [computeMenu]);

    const handleAction = (key) => {
      const text = menu ? menu.text : '';
      if (onAction) onAction(key, text);
      else console.log('[Highlight] action:', key, '· selected:', text);
      // Clear native selection + dismiss menu.
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      setMenu(null);
    };

    const wrapStyle = { position: 'relative', display: 'block' };
    const menuStyle = menu ? {
      position: 'absolute',
      left: menu.x + 'px', top: menu.y + 'px',
      transform: 'translate(-50%, -100%)',
      display: 'flex', gap: '4px',
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '4px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
      zIndex: '50',
      whiteSpace: 'nowrap',
    } : null;
    const btnStyle = {
      background: 'transparent', color: 'var(--text)',
      border: '1px solid transparent', borderRadius: '4px',
      padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
      fontFamily: 'inherit',
    };

    return h`
      <div class="highlight-wrap" ref=${wrapRef} style=${wrapStyle}>
        ${props && props.children}
        ${menu ? h`
          <div class="highlight-menu" style=${menuStyle} onMouseDown=${(e) => e.preventDefault()}>
            ${ACTIONS.map(a => h`
              <button
                key=${a.key}
                class="highlight-action"
                style=${btnStyle}
                onMouseEnter=${(e) => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onMouseLeave=${(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}
                onClick=${() => handleAction(a.key)}
              >${a.label}</button>
            `)}
          </div>
        ` : null}
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.Highlight = Highlight;
})();
