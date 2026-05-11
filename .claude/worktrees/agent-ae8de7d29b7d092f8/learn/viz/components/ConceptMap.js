// ConceptMap: small force-directed graph using d3 (loaded lazily via window.loadD3()).
// Props:
//   nodes: Array<{ id, label, type? }>     required
//   edges: Array<{ source, target, label? }>  required
//   width?: number  (default 600)
//   height?: number (default 360)
//   onNodeClick?: (node) => void
(function(){
  const { h } = window;
  const { useEffect, useRef, useState } = window.preactHooks;

  // Lazy d3 loader. Idempotent. Returns Promise<typeof d3>.
  if (typeof window.loadD3 !== 'function') {
    window.loadD3 = (() => {
      let pending = null;
      return () => {
        if (typeof window.d3 !== 'undefined') return Promise.resolve(window.d3);
        if (pending) return pending;
        pending = new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
          s.onload = () => {
            if (typeof window.d3 !== 'undefined') resolve(window.d3);
            else reject(new Error('d3 script loaded but global is undefined'));
          };
          s.onerror = () => reject(new Error('d3 script failed to load'));
          document.head.appendChild(s);
        });
        return pending;
      };
    })();
  }

  // Type → colour palette (uses CSS vars where applicable).
  const TYPE_COLORS = {
    concept:  '#6366f1',   // accent
    fact:     '#22c55e',   // green
    question: '#eab308',   // yellow
    error:    '#ef4444',   // red
    default:  '#8892a4',   // muted
  };

  function ConceptMap(props) {
    const nodes = (props && Array.isArray(props.nodes)) ? props.nodes : [];
    const edges = (props && Array.isArray(props.edges)) ? props.edges : [];
    const width = (props && props.width) || 600;
    const height = (props && props.height) || 360;
    const onNodeClick = props && typeof props.onNodeClick === 'function' ? props.onNodeClick : null;

    const ref = useRef(null);
    const [status, setStatus] = useState('loading'); // loading | ready | error
    const [error, setError] = useState('');
    const [selectedId, setSelectedId] = useState(null);

    useEffect(() => {
      let cancelled = false;
      let simulation = null;
      window.loadD3()
        .then(d3 => {
          if (cancelled || !ref.current) return;

          // Wipe any prior render
          ref.current.innerHTML = '';

          // d3-force mutates node objects; clone so caller's data is untouched.
          const simNodes = nodes.map(n => ({ ...n }));
          const idSet = new Set(simNodes.map(n => n.id));
          const simEdges = edges
            .filter(e => idSet.has(e.source) && idSet.has(e.target))
            .map(e => ({ ...e }));

          const svg = d3.select(ref.current)
            .append('svg')
            .attr('width', width)
            .attr('height', height)
            .attr('viewBox', `0 0 ${width} ${height}`)
            .style('display', 'block')
            .style('max-width', '100%');

          // Arrow marker for directed edges
          const defs = svg.append('defs');
          defs.append('marker')
            .attr('id', 'cm-arrow')
            .attr('viewBox', '0 -5 10 10')
            .attr('refX', 18)
            .attr('refY', 0)
            .attr('markerWidth', 6)
            .attr('markerHeight', 6)
            .attr('orient', 'auto')
            .append('path')
            .attr('d', 'M0,-5L10,0L0,5')
            .attr('fill', '#8892a4');

          const link = svg.append('g')
            .attr('stroke', '#2e3248')
            .attr('stroke-width', 1.5)
            .selectAll('line')
            .data(simEdges)
            .join('line')
            .attr('marker-end', 'url(#cm-arrow)');

          const linkLabel = svg.append('g')
            .selectAll('text')
            .data(simEdges)
            .join('text')
            .text(e => e.label || '')
            .attr('font-size', 10)
            .attr('fill', '#8892a4')
            .attr('text-anchor', 'middle')
            .style('pointer-events', 'none');

          const node = svg.append('g')
            .attr('stroke', '#0f1117')
            .attr('stroke-width', 1.5)
            .selectAll('circle')
            .data(simNodes)
            .join('circle')
            .attr('r', 14)
            .attr('fill', n => TYPE_COLORS[n.type] || TYPE_COLORS.default)
            .style('cursor', 'pointer')
            .on('click', (_, n) => {
              setSelectedId(n.id);
              if (onNodeClick) onNodeClick(n);
            });

          const label = svg.append('g')
            .selectAll('text')
            .data(simNodes)
            .join('text')
            .text(n => n.label || n.id)
            .attr('font-size', 11)
            .attr('font-family', 'system-ui, sans-serif')
            .attr('fill', '#e2e8f0')
            .attr('text-anchor', 'middle')
            .attr('dy', 28)
            .style('pointer-events', 'none');

          // Drag behaviour
          const drag = d3.drag()
            .on('start', (event, d) => {
              if (!event.active) simulation.alphaTarget(0.3).restart();
              d.fx = d.x; d.fy = d.y;
            })
            .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
            .on('end', (event, d) => {
              if (!event.active) simulation.alphaTarget(0);
              d.fx = null; d.fy = null;
            });
          node.call(drag);

          simulation = d3.forceSimulation(simNodes)
            .force('link', d3.forceLink(simEdges).id(d => d.id).distance(90))
            .force('charge', d3.forceManyBody().strength(-220))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('collide', d3.forceCollide().radius(28))
            .on('tick', () => {
              link
                .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
              linkLabel
                .attr('x', d => (d.source.x + d.target.x) / 2)
                .attr('y', d => (d.source.y + d.target.y) / 2);
              node.attr('cx', d => d.x).attr('cy', d => d.y);
              label.attr('x', d => d.x).attr('y', d => d.y);
            });

          // Update selection ring on subsequent renders by storing references on the host
          ref.current.__cmNode = node;

          setStatus('ready');
        })
        .catch(err => {
          if (cancelled) return;
          setStatus('error');
          setError((err && err.message) ? err.message : String(err));
        });

      return () => {
        cancelled = true;
        if (simulation) simulation.stop();
      };
    }, [nodes, edges, width, height]);

    // Apply selection ring whenever selectedId changes (without re-running the sim).
    useEffect(() => {
      if (!ref.current || !ref.current.__cmNode) return;
      ref.current.__cmNode
        .attr('stroke', n => n.id === selectedId ? '#e2e8f0' : '#0f1117')
        .attr('stroke-width', n => n.id === selectedId ? 3 : 1.5);
    }, [selectedId, status]);

    const wrapStyle = {
      background: 'var(--surface2)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '12px', margin: '12px 0',
      overflow: 'hidden',
    };

    if (status === 'loading') {
      return h`<div class="concept-map" style=${wrapStyle}>
        <div style=${{color:'var(--muted)',fontSize:'13px'}}>Loading graph…</div>
      </div>`;
    }
    if (status === 'error') {
      return h`<div class="concept-map" style=${wrapStyle}>
        <div style=${{color:'var(--red)',fontSize:'12px',fontFamily:'ui-monospace,monospace'}}>
          <div style=${{fontWeight:'600',marginBottom:'4px'}}>Concept map failed to load</div>
          <div style=${{color:'var(--muted)'}}>${error}</div>
        </div>
      </div>`;
    }
    return h`<div class="concept-map" ref=${ref} style=${wrapStyle}></div>`;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.ConceptMap = ConceptMap;
})();
