// Highlight: wraps content; on text selection within, shows a floating action menu.
// Actions: Explain / Example / Why / Note. Phase-5 will wire these to agents.
// Props:
//   children: any
//   onAction?: (action: 'explain'|'example'|'why'|'note', selectedText: string) => void
(function(){
  const { h } = window;
  const { useState, useEffect, useRef, useCallback } = window.preactHooks;

  // Two groups: text actions (run the explainer agent → save annotation on
  // the highlight) and artifact actions (run artifact-generator → insert a
  // new component block into the lesson body at this highlight position).
  const TEXT_ACTIONS = [
    { key: 'explain', label: 'Explain' },
    { key: 'example', label: 'Example' },
    { key: 'why',     label: 'Why' },
    { key: 'note',    label: 'Note' },
  ];
  const ARTIFACT_ACTIONS = [
    { key: 'diagram',     label: 'Diagram' },
    { key: 'animate',     label: 'Animate' },
    { key: 'plot',        label: 'Plot' },
    { key: 'walkthrough', label: 'Walk through' },
  ];

  function Highlight(props) {
    const onAction = props && typeof props.onAction === 'function' ? props.onAction : null;
    const wrapRef = useRef(null);
    const [menu, setMenu] = useState(null); // { x, y, text } | null

    // Walk up from `node` until we find a direct child of `.lesson-renderer`.
    // Returns that child element + its index, or null if the selection isn't
    // inside a recognised lesson block. This is what handlers use to insert
    // new content (artifacts, callouts) at the correct position — strictly
    // more reliable than text-content matching across formatting.
    const findBlockAncestor = (node) => {
      if (!node) return null;
      const renderer = (wrapRef.current && wrapRef.current.querySelector(':scope > .lesson-renderer'))
        || (wrapRef.current && wrapRef.current.querySelector('.lesson-renderer'));
      if (!renderer) return null;
      let cur = node.nodeType === 3 /* TEXT_NODE */ ? node.parentNode : node;
      while (cur && cur !== renderer && cur !== document.body) {
        if (cur.parentNode === renderer) {
          const idx = Array.prototype.indexOf.call(renderer.children, cur);
          if (idx >= 0) return { el: cur, index: idx };
        }
        cur = cur.parentNode;
      }
      return null;
    };

    // Compute menu position from current window selection. Returns null if selection
    // is empty or not contained inside our wrapper. The returned object also
    // carries the lesson-block index so handlers can insert new content next
    // to the highlight without doing fragile textContent matches afterwards.
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
      const block = findBlockAncestor(range.commonAncestorContainer);
      return { x, y, text, blockIndex: block ? block.index : -1 };
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
      const blockIndex = menu ? menu.blockIndex : -1;
      if (onAction) onAction(key, text, blockIndex);
      else console.log('[Highlight] action:', key, '· selected:', text, '· blockIndex:', blockIndex);
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
      display: 'flex', flexDirection: 'column', gap: '4px',
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '4px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
      zIndex: '50',
      whiteSpace: 'nowrap',
    } : null;
    const groupStyle = {
      display: 'flex', gap: '4px',
    };
    const dividerStyle = {
      height: '1px', background: 'var(--border)', margin: '2px 0',
    };
    const labelStyle = {
      fontSize: '10px', color: 'var(--muted)', textTransform: 'uppercase',
      letterSpacing: '0.05em', padding: '2px 8px 0',
    };
    const btnStyle = {
      background: 'transparent', color: 'var(--text)',
      border: '1px solid transparent', borderRadius: '4px',
      padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
      fontFamily: 'inherit',
    };

    const renderBtn = (a) => h`
      <button
        key=${a.key}
        class="highlight-action"
        style=${btnStyle}
        onMouseEnter=${(e) => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
        onMouseLeave=${(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}
        onClick=${() => handleAction(a.key)}
      >${a.label}</button>
    `;

    return h`
      <div class="highlight-wrap" ref=${wrapRef} style=${wrapStyle}>
        ${props && props.children}
        ${menu ? h`
          <div class="highlight-menu" style=${menuStyle} onMouseDown=${(e) => e.preventDefault()}>
            <div style=${labelStyle}>Explain</div>
            <div style=${groupStyle}>
              ${TEXT_ACTIONS.map(renderBtn)}
            </div>
            <div style=${dividerStyle}></div>
            <div style=${labelStyle}>Show me</div>
            <div style=${groupStyle}>
              ${ARTIFACT_ACTIONS.map(renderBtn)}
            </div>
          </div>
        ` : null}
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.Highlight = Highlight;
})();
