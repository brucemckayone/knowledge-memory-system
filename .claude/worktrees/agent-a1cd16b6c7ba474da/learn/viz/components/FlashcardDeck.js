// FlashcardDeck: stack of flip cards. Click/tap or "Flip" to reveal back.
// Tracks per-card state (knew / didnt) locally; emits end-of-deck summary.
// Props:
//   cards: Array<{ front: string|VNode, back: string|VNode, hint?: string }>  required
//   onComplete?: (results: { correct: number, total: number, perCard: Array<'knew'|'didnt'|null> }) => void
(function(){
  const { h } = window;
  const { useState, useEffect } = window.preactHooks;

  function FlashcardDeck(props) {
    const cards = (props && Array.isArray(props.cards)) ? props.cards : [];
    const onComplete = props && typeof props.onComplete === 'function' ? props.onComplete : null;

    const [idx, setIdx] = useState(0);
    const [flipped, setFlipped] = useState(false);
    const [results, setResults] = useState(() => cards.map(() => null)); // 'knew' | 'didnt' | null
    const [done, setDone] = useState(false);

    // Reset results when card list changes (new deck)
    useEffect(() => {
      setIdx(0); setFlipped(false); setDone(false);
      setResults(cards.map(() => null));
    }, [cards]);

    const reset = () => {
      setIdx(0); setFlipped(false); setDone(false);
      setResults(cards.map(() => null));
    };

    const mark = (verdict) => {
      // Record verdict for current card, advance.
      setResults(prev => {
        const next = prev.slice();
        next[idx] = verdict;
        return next;
      });
      if (idx + 1 >= cards.length) {
        // Deck complete — compute results in next tick using the updated array.
        const finalResults = results.slice();
        finalResults[idx] = verdict;
        const correct = finalResults.filter(r => r === 'knew').length;
        setDone(true);
        if (onComplete) onComplete({ correct, total: cards.length, perCard: finalResults });
      } else {
        setIdx(idx + 1);
        setFlipped(false);
      }
    };

    const wrapStyle = {
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '20px', margin: '12px 0',
    };
    const headerStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: '12px', color: 'var(--muted)', fontSize: '12px',
      textTransform: 'uppercase', letterSpacing: '0.5px', fontVariantNumeric: 'tabular-nums',
    };
    const cardStyle = {
      background: 'var(--surface2)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '32px 24px',
      minHeight: '180px', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', userSelect: 'none', textAlign: 'center',
      transition: 'border-color 0.15s, background 0.2s',
      lineHeight: '1.6',
    };
    const sideLabelStyle = {
      position: 'absolute', top: '8px', left: '12px',
      fontSize: '10px', color: 'var(--muted)',
      textTransform: 'uppercase', letterSpacing: '0.5px',
    };
    const hintStyle = { marginTop: '12px', color: 'var(--muted)', fontSize: '12px', fontStyle: 'italic' };
    const btnRowStyle = { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' };

    if (cards.length === 0) {
      return h`<div class="flashcard-deck" style=${wrapStyle}>
        <div style=${{color:'var(--muted)',fontSize:'13px'}}>No cards in this deck.</div>
      </div>`;
    }

    if (done) {
      const correct = results.filter(r => r === 'knew').length;
      const pct = Math.round((correct / cards.length) * 100);
      const cls = pct >= 70 ? 'high' : pct >= 40 ? 'mid' : 'low';
      return h`
        <div class="flashcard-deck flashcard-summary" style=${wrapStyle}>
          <div style=${{textAlign:'center',padding:'24px 0'}}>
            <div style=${{fontSize:'13px',color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:'10px'}}>Deck complete</div>
            <div style=${{fontSize:'36px',fontWeight:'700',color:'var(--text)',marginBottom:'4px'}}>${correct} / ${cards.length}</div>
            <div>
              <span class=${'score-pill ' + cls}>${pct}% known</span>
            </div>
          </div>
          <div style=${{display:'flex',justifyContent:'center'}}>
            <button class="btn btn-primary" onClick=${reset}>Restart Deck</button>
          </div>
        </div>
      `;
    }

    const cur = cards[idx];
    const sideText = flipped ? (cur.back != null ? cur.back : '') : (cur.front != null ? cur.front : '');

    return h`
      <div class="flashcard-deck" style=${wrapStyle}>
        <div style=${headerStyle}>
          <span>Card ${idx + 1} of ${cards.length}</span>
          <span>${flipped ? 'Back' : 'Front'}</span>
        </div>
        <div
          class="flashcard"
          style=${{...cardStyle, position:'relative'}}
          onClick=${() => setFlipped(f => !f)}
          title="Click to flip"
        >
          <span style=${sideLabelStyle}>${flipped ? 'BACK' : 'FRONT'}</span>
          <div style=${{fontSize:'15px',color:'var(--text)'}}>${sideText}</div>
          ${!flipped && cur.hint ? h`<div style=${hintStyle}>Hint: ${cur.hint}</div>` : null}
        </div>
        <div style=${btnRowStyle}>
          <button class="btn btn-secondary" onClick=${() => setFlipped(f => !f)}>
            ${flipped ? 'Show Front' : 'Flip'}
          </button>
          ${flipped ? h`
            <button class="btn btn-secondary" style=${{borderColor:'var(--green)',color:'var(--green)'}} onClick=${() => mark('knew')}>Knew it</button>
            <button class="btn btn-secondary" style=${{borderColor:'var(--red)',color:'var(--red)'}} onClick=${() => mark('didnt')}>Didn't know</button>
          ` : null}
          <button class="btn btn-secondary" style=${{marginLeft:'auto'}} onClick=${reset}>Reset</button>
        </div>
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.FlashcardDeck = FlashcardDeck;
})();
