// LessonRenderer: walks a LessonBlock[] and dispatches each block.
// Block types:
//   { type: 'markdown', content: string }
//   { type: 'component', kind: string, props: object, children?: string }
// Markdown blocks render via window.renderMarkdown (or marked.parse fallback) into
// a div whose innerHTML is set in a useEffect — matches the SvgFigure pattern.
// Component blocks dispatch to window.LearnComponents[kind] with props (+ children
// rendered as markdown if provided). Unknown kinds render an inline error block.
(function(){
  const { h } = window;
  const { useEffect, useRef, useMemo } = window.preactHooks;

  const KNOWN_KINDS = {
    Callout: true, Mermaid: true, SvgFigure: true, CodeRunner: true,
    StepThrough: true, FlashcardDeck: true, ConceptMap: true, Highlight: true,
  };

  function renderMd(src) {
    if (typeof src !== 'string' || !src) return '';
    if (typeof window.renderMarkdown === 'function') return window.renderMarkdown(src);
    if (typeof window.marked !== 'undefined' && window.marked.parse) {
      try { return window.marked.parse(src, { breaks: false, gfm: true }); } catch { /* fall through */ }
    }
    // Last-ditch: escape + wrap.
    const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<p>' + esc + '</p>';
  }

  function MarkdownBlock(props) {
    const html = useMemo(() => renderMd(props.content), [props.content]);
    const ref = useRef(null);
    useEffect(() => {
      if (ref.current) ref.current.innerHTML = html;
    }, [html]);
    return h`<div class="lesson-md" ref=${ref}></div>`;
  }

  function UnknownBlock(props) {
    const style = {
      background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.4)',
      borderRadius: 'var(--radius)', padding: '12px 16px', margin: '12px 0',
      color: 'var(--red)', fontSize: '13px',
    };
    return h`<div class="lesson-unknown" style=${style}>Unknown component: ${props.kind}</div>`;
  }

  function ComponentBlock(props) {
    const kind = props.kind;
    if (!KNOWN_KINDS[kind]) return h`<${UnknownBlock} kind=${kind} />`;
    const lib = window.LearnComponents || {};
    const Comp = lib[kind];
    if (typeof Comp !== 'function') return h`<${UnknownBlock} kind=${kind} />`;

    const compProps = (props.props && typeof props.props === 'object') ? props.props : {};
    const childMd = typeof props.children === 'string' ? props.children : null;

    if (childMd) {
      // Pass rendered markdown as children via a small inner block.
      return h`<${Comp} ...${compProps}><${MarkdownBlock} content=${childMd} /><//>`;
    }
    return h`<${Comp} ...${compProps} />`;
  }

  function LessonRenderer(props) {
    const blocks = (props && Array.isArray(props.blocks)) ? props.blocks : [];
    if (blocks.length === 0) {
      return h`<div class="lesson-empty" style=${{color:'var(--muted)',fontSize:'13px'}}>No lesson content.</div>`;
    }
    const wrapStyle = { display: 'flex', flexDirection: 'column', gap: '8px' };
    return h`
      <div class="lesson-renderer" style=${wrapStyle}>
        ${blocks.map((b, i) => {
          if (!b || typeof b !== 'object') return null;
          if (b.type === 'markdown') return h`<${MarkdownBlock} key=${i} content=${b.content || ''} />`;
          if (b.type === 'component') return h`<${ComponentBlock} key=${i} kind=${b.kind} props=${b.props} children=${b.children} />`;
          return h`<${UnknownBlock} key=${i} kind=${'<malformed block>'} />`;
        })}
      </div>
    `;
  }

  // Backwards-compat: section.lessonBlocks (JSON string) preferred; else lessonContent (markdown string).
  function lessonToBlocks(section) {
    if (!section || typeof section !== 'object') return [];
    const raw = section.lessonBlocks;
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        if (parsed && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) return parsed.blocks;
      } catch { /* fall through to lessonContent */ }
    } else if (Array.isArray(raw) && raw.length > 0) {
      return raw;
    }
    if (typeof section.lessonContent === 'string' && section.lessonContent.trim()) {
      return [{ type: 'markdown', content: section.lessonContent }];
    }
    return [];
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.LessonRenderer = LessonRenderer;
  window.LearnComponents.lessonToBlocks = lessonToBlocks;
})();
