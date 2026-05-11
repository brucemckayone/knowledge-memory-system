// SvgFigure: renders an agent-supplied raw SVG string after sanitisation with DOMPurify.
// USE_PROFILES enables svg + svgFilters; <script> and event handlers are stripped.
(function(){
  const { h } = window;
  const { useMemo, useEffect, useRef } = window.preactHooks;

  function sanitise(src) {
    if (!src) return '';
    if (typeof window.DOMPurify === 'undefined') {
      console.warn('[SvgFigure] DOMPurify not loaded — refusing to inject raw SVG');
      return '';
    }
    return window.DOMPurify.sanitize(src, { USE_PROFILES: { svg: true, svgFilters: true } });
  }

  function SvgFigure(props) {
    const src = (props && props.src) || '';
    const caption = props && props.caption;
    const ref = useRef(null);
    const safe = useMemo(() => sanitise(src), [src]);

    useEffect(() => {
      if (ref.current) ref.current.innerHTML = safe;
    }, [safe]);

    const wrapStyle = {
      background: 'var(--surface2)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '16px', margin: '12px 0', textAlign: 'center',
    };
    const svgHostStyle = { display: 'block', maxWidth: '100%' };
    const captionStyle = {
      marginTop: '10px', color: 'var(--muted)', fontSize: '12px',
      fontStyle: 'italic', lineHeight: '1.5',
    };

    return h`
      <figure class="svg-figure" style=${wrapStyle}>
        <div class="svg-host" ref=${ref} style=${svgHostStyle}></div>
        ${caption ? h`<figcaption style=${captionStyle}>${caption}</figcaption>` : null}
      </figure>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.SvgFigure = SvgFigure;
})();
