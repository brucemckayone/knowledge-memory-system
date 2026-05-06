// DashboardCards: home tab. Six cards rendered in a responsive grid.
// Props:
//   data: DashboardResponse | null   — null while loading
//   loading: boolean
//   error: string | null
//   onReload: () => void
//   onRegenerateFlashcards: () => void
//   onNavigateSection: (sectionId, opts?) => void   — opts.quiz: jump straight to quiz view
//   onNavigateChat: (sessionId) => void
//   regenerating: boolean
(function(){
  const { h } = window;
  const { useEffect, useRef, useState } = window.preactHooks;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    const wk = Math.floor(day / 7);
    if (wk < 5) return `${wk}w ago`;
    return d.toLocaleDateString();
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n).trim() + '…' : s;
  }

  function postSilent(path, body) {
    try {
      fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }).catch(() => {});
    } catch { /* noop */ }
  }

  // ── Card frame ────────────────────────────────────────────────────────────
  function Card(props) {
    const { title, action, children, span } = props;
    const style = {
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '18px 20px',
      display: 'flex',
      flexDirection: 'column',
      minHeight: '180px',
      gridColumn: span === 2 ? 'span 2' : 'span 1',
    };
    const headStyle = {
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      marginBottom: '12px', gap: '12px',
    };
    const titleStyle = {
      fontSize: '13px', fontWeight: '600', color: 'var(--muted)',
      textTransform: 'uppercase', letterSpacing: '0.5px',
    };
    return h`
      <div class="dash-card" style=${style}>
        <div style=${headStyle}>
          <span style=${titleStyle}>${title}</span>
          ${action || null}
        </div>
        <div style=${{flex:'1',display:'flex',flexDirection:'column'}}>${children}</div>
      </div>
    `;
  }

  function ActionLink(props) {
    const style = {
      color: 'var(--accent)', cursor: 'pointer', fontSize: '12px',
      userSelect: 'none', background: 'none', border: 'none', padding: '0',
      fontFamily: 'inherit',
    };
    return h`<button type="button" style=${style} onClick=${props.onClick} disabled=${props.disabled}>${props.children}</button>`;
  }

  function Empty(props) {
    const style = {
      flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--muted)', fontSize: '13px', textAlign: 'center', padding: '20px 8px',
      lineHeight: '1.6',
    };
    return h`<div style=${style}>${props.children}</div>`;
  }

  // ── Card 1: Jump back in ─────────────────────────────────────────────────
  function JumpBackInCard(props) {
    const { jbi, onNavigateSection } = props;
    if (!jbi || (!jbi.quizAttempt && !jbi.chatMessage)) {
      return h`<${Card} title="Jump back in"><${Empty}>No recent activity yet. Start a course to begin.<//><//>`;
    }
    const rowStyle = {
      padding: '12px 14px', background: 'var(--surface2)', borderRadius: 'var(--radius)',
      cursor: 'pointer', border: '1px solid transparent', transition: 'border-color 0.15s',
    };
    const items = [];
    if (jbi.quizAttempt) {
      const a = jbi.quizAttempt;
      const score = a.score == null ? null : Math.round(a.score * 100);
      const cls = score == null ? '' : score >= 70 ? 'high' : score >= 40 ? 'mid' : 'low';
      items.push(h`
        <div key="qa" class="jump-row" style=${rowStyle}
             onClick=${() => onNavigateSection(a.sectionId)}
             onMouseEnter=${(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
             onMouseLeave=${(e) => e.currentTarget.style.borderColor = 'transparent'}>
          <div style=${{fontSize:'11px',color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:'4px'}}>Continue quiz</div>
          <div style=${{display:'flex',alignItems:'center',gap:'8px',marginBottom:'4px'}}>
            <span style=${{fontWeight:'600',flex:'1',minWidth:'0',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
              ${a.courseTitle} · ${a.sectionTitle}
            </span>
            ${score != null ? h`<span class=${'score-pill ' + cls}>${score}%</span>` : null}
          </div>
          <div style=${{color:'var(--muted)',fontSize:'11px'}}>${timeAgo(a.completedAt)}</div>
        </div>
      `);
    }
    if (jbi.chatMessage) {
      const m = jbi.chatMessage;
      items.push(h`
        <div key="cm" class="jump-row" style=${rowStyle}
             onClick=${() => m.sectionId ? onNavigateSection(m.sectionId) : null}
             onMouseEnter=${(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
             onMouseLeave=${(e) => e.currentTarget.style.borderColor = 'transparent'}>
          <div style=${{fontSize:'11px',color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:'4px'}}>Resume chat</div>
          <div style=${{fontWeight:'600',marginBottom:'4px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
            ${m.courseTitle ?? 'General chat'}
          </div>
          <div style=${{color:'var(--muted)',fontSize:'12px',lineHeight:'1.5',display:'-webkit-box',WebkitLineClamp:'2',WebkitBoxOrient:'vertical',overflow:'hidden'}}>${truncate(m.snippet, 140)}</div>
          <div style=${{color:'var(--muted)',fontSize:'11px',marginTop:'4px'}}>${timeAgo(m.createdAt)}</div>
        </div>
      `);
    }
    return h`<${Card} title="Jump back in">
      <div style=${{display:'flex',flexDirection:'column',gap:'10px'}}>${items}</div>
    <//>`;
  }

  // ── Card 2: Daily quiz ───────────────────────────────────────────────────
  function DailyQuizCard(props) {
    const { dq, onNavigateSection } = props;
    const q = dq && dq.question;
    const rationale = dq && dq.rationale;
    if (!q) {
      const reason = rationale && rationale.reason ? rationale.reason : "No question to surface today. You're up to date — explore Courses?";
      return h`<${Card} title="Daily quiz"><${Empty}>${reason}<//><//>`;
    }
    const cardStyle = {
      padding: '14px 16px', background: 'var(--surface2)', borderRadius: 'var(--radius)',
      cursor: 'pointer', border: '1px solid transparent', transition: 'border-color 0.15s',
    };
    let rationaleText = '';
    if (rationale) {
      const parts = [];
      if (rationale.reason) parts.push(rationale.reason);
      if (typeof rationale.priorBestScore === 'number') {
        parts.push(`confidence ${rationale.priorBestScore.toFixed(2)}`);
      }
      if (typeof rationale.blastRadius === 'number') {
        parts.push(`blocks ${rationale.blastRadius} downstream concept${rationale.blastRadius === 1 ? '' : 's'}`);
      }
      if (typeof rationale.decayDays === 'number') {
        parts.push(`${rationale.decayDays}d since touch`);
      }
      rationaleText = parts.join(' · ');
    }
    return h`<${Card} title="Daily quiz">
      <div class="dash-quiz" style=${cardStyle}
           onClick=${() => onNavigateSection(q.sectionId, { quiz: true })}
           onMouseEnter=${(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
           onMouseLeave=${(e) => e.currentTarget.style.borderColor = 'transparent'}>
        <div style=${{fontSize:'11px',color:'var(--muted)',marginBottom:'6px'}}>
          ${q.courseTitle} · ${q.sectionTitle}
        </div>
        <div style=${{fontSize:'14px',fontWeight:'500',lineHeight:'1.5',marginBottom:'10px'}}>
          ${truncate(q.questionText, 220)}
        </div>
        ${rationaleText ? h`<div style=${{color:'var(--muted)',fontSize:'11px',lineHeight:'1.5'}}>${rationaleText}</div>` : null}
      </div>
    <//>`;
  }

  // ── Card 3: Daily flashcards ─────────────────────────────────────────────
  function DailyFlashcardsCard(props) {
    const { df, onRegenerate, regenerating } = props;
    const cards = df && Array.isArray(df.cards) ? df.cards : [];
    const refreshAction = h`<${ActionLink} onClick=${onRegenerate} disabled=${regenerating}>${regenerating ? 'Refreshing…' : 'Refresh'}<//>`;

    if (cards.length === 0) {
      const empty = regenerating
        ? 'Generating flashcards — this takes ~20s…'
        : 'No flashcards to review. Concepts will appear here as they fade.';
      return h`<${Card} title="Daily flashcards" action=${refreshAction}>
        <${Empty}>${empty}<//>
      <//>`;
    }

    const lib = window.LearnComponents || {};
    const FlashcardDeck = lib.FlashcardDeck;

    // Map dashboard cards -> deck cards. Track flashcard.id alongside so we can
    // POST per-verdict to /api/flashcards/:id/review without blocking the UI.
    const deckCards = cards.map(c => ({
      front: c.frontText,
      back: c.backText,
      hint: c.hintText,
      _flashcardId: c.id,
    }));

    if (typeof FlashcardDeck !== 'function') {
      return h`<${Card} title="Daily flashcards" action=${refreshAction}>
        <${Empty}>FlashcardDeck component unavailable.<//>
      <//>`;
    }

    return h`<${Card} title="Daily flashcards" action=${refreshAction}>
      <${FlashcardDeckWithVerdicts} cards=${deckCards} />
    <//>`;
  }

  // Wraps FlashcardDeck so we can fire per-verdict POSTs without modifying the
  // upstream component. We monkey-patch the click handlers via a small interception
  // on the wrapper buttons using event delegation on the rendered subtree.
  function FlashcardDeckWithVerdicts(props) {
    const FlashcardDeck = window.LearnComponents.FlashcardDeck;
    const ref = useRef(null);
    const idxRef = useRef(0);
    const cards = props.cards;

    // Click-capture handler: we listen for clicks on the action row buttons within the deck.
    // FlashcardDeck doesn't expose per-card callbacks, so we trap "Knew it"/"Didn't know" clicks
    // via text-content match. The card index advances within the component's own state — we
    // mirror it via a ref by reading the "Card N of M" header on each click.
    useEffect(() => {
      const node = ref.current;
      if (!node) return;
      const onClick = (e) => {
        const btn = e.target && e.target.closest && e.target.closest('button');
        if (!btn || !node.contains(btn)) return;
        const txt = (btn.textContent || '').trim().toLowerCase();
        let knew = null;
        if (txt.startsWith('knew')) knew = true;
        else if (txt.startsWith("didn't") || txt.startsWith('didn’t') || txt.startsWith('didnt')) knew = false;
        if (knew === null) return;
        // Read current card index from header before component advances.
        const header = node.querySelector('.flashcard-deck > div'); // first child is header
        let idx = idxRef.current;
        if (header) {
          const m = header.textContent && header.textContent.match(/Card\s+(\d+)\s+of\s+\d+/i);
          if (m) idx = parseInt(m[1], 10) - 1;
        }
        const card = cards[idx];
        if (card && card._flashcardId) {
          postSilent(`/api/flashcards/${card._flashcardId}/review`, { knew });
        }
        idxRef.current = idx + 1;
      };
      node.addEventListener('click', onClick, true);
      return () => node.removeEventListener('click', onClick, true);
    }, [cards]);

    // Reset index when cards change
    useEffect(() => { idxRef.current = 0; }, [cards]);

    const onComplete = (r) => {
      // Show the small "X / Y" message inside the card via the deck's own done state.
      // No backend call here — per-verdict POSTs already covered each card.
      void r;
    };

    return h`<div ref=${ref} class="dash-flashcards-wrap">
      <${FlashcardDeck} cards=${cards} onComplete=${onComplete} />
    </div>`;
  }

  // ── Card 4: Insights feed ────────────────────────────────────────────────
  function ImportanceDot(props) {
    // Importance is a 0..1ish float — render a small badge.
    const v = typeof props.importance === 'number' ? props.importance : 0;
    const cls = v >= 0.7 ? 'high' : v >= 0.4 ? 'mid' : 'low';
    const colors = { high: 'var(--green)', mid: 'var(--yellow)', low: 'var(--muted)' };
    const style = {
      width: '8px', height: '8px', borderRadius: '50%',
      background: colors[cls], display: 'inline-block', flexShrink: '0',
    };
    return h`<span style=${style} title=${`importance ${v.toFixed(2)}`}></span>`;
  }

  function InsightsCard(props) {
    const { ins, patrolMinutes } = props;
    const items = ins && Array.isArray(ins.items) ? ins.items : [];
    const [dismissed, setDismissed] = useState(() => new Set());
    const viewedRef = useRef(new Set());

    // Auto-fire viewed POST once per insight (debounced by ref-set membership).
    useEffect(() => {
      for (const it of items) {
        if (!it.viewedAt && !viewedRef.current.has(it.id)) {
          viewedRef.current.add(it.id);
          postSilent(`/api/insights/${it.id}/viewed`);
        }
      }
    }, [items]);

    const visible = items.filter(it => !dismissed.has(it.id));
    if (visible.length === 0) {
      const empty = patrolMinutes
        ? `Nothing to surface yet. The patrol checks every ${patrolMinutes} minutes.`
        : 'Nothing to surface yet.';
      return h`<${Card} title="Insights">
        <${Empty}>${empty}<//>
      <//>`;
    }

    const dismiss = (id) => {
      setDismissed(prev => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      postSilent(`/api/insights/${id}/dismiss`);
    };

    const rowStyle = {
      padding: '10px 0', borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'flex-start', gap: '10px',
    };
    const dismissBtnStyle = {
      background: 'none', border: 'none', color: 'var(--muted)',
      cursor: 'pointer', fontSize: '14px', padding: '0 4px', lineHeight: '1',
      flexShrink: '0',
    };

    return h`<${Card} title="Insights">
      <div style=${{display:'flex',flexDirection:'column'}}>
        ${visible.map(it => h`
          <div key=${it.id} style=${rowStyle}>
            <${ImportanceDot} importance=${it.importance} />
            <div style=${{flex:'1',minWidth:'0'}}>
              <div style=${{fontWeight:'600',fontSize:'13px',marginBottom:'2px'}}>${truncate(it.title, 80)}</div>
              <div style=${{color:'var(--muted)',fontSize:'12px',lineHeight:'1.5'}} title=${it.contentMd}>${truncate(it.contentMd, 140)}</div>
              <div style=${{color:'var(--muted)',fontSize:'11px',marginTop:'2px'}}>${timeAgo(it.createdAt)}</div>
            </div>
            <button type="button" style=${dismissBtnStyle} title="Dismiss" onClick=${() => dismiss(it.id)}>×</button>
          </div>
        `)}
      </div>
    <//>`;
  }

  // ── Card 5: Cross-course connections ─────────────────────────────────────
  function CrossCourseCard(props) {
    const { ccc } = props;
    const concepts = ccc && Array.isArray(ccc.concepts) ? ccc.concepts : [];
    if (concepts.length === 0) {
      return h`<${Card} title="Cross-course connections">
        <${Empty}>No cross-course connections yet. They'll appear as your learning expands.<//>
      <//>`;
    }
    const chipStyle = {
      display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
      background: 'rgba(99,102,241,0.15)', color: 'var(--accent)',
      fontSize: '11px', fontWeight: '500', marginRight: '4px', marginBottom: '4px',
    };
    const labelStyle = {
      display: 'inline-block', fontSize: '10px', padding: '1px 6px',
      borderRadius: '8px', background: 'var(--surface2)', color: 'var(--muted)',
      textTransform: 'uppercase', letterSpacing: '0.5px', marginLeft: '8px',
    };
    const rowStyle = { padding: '10px 0', borderBottom: '1px solid var(--border)' };
    return h`<${Card} title="Cross-course connections">
      <div>
        ${concepts.map(c => h`
          <div key=${c.conceptEntityId} style=${rowStyle}>
            <div style=${{display:'flex',alignItems:'center',marginBottom:'4px'}}>
              <span style=${{fontWeight:'600',fontSize:'13px'}}>${c.conceptName}</span>
              <span style=${labelStyle}>${c.kind === 'same_as' ? 'same-as' : 'direct'}</span>
            </div>
            <div>${(c.courses || []).map(co => h`<span key=${co.courseId} style=${chipStyle}>${truncate(co.courseTitle, 32)}</span>`)}</div>
          </div>
        `)}
      </div>
    <//>`;
  }

  // ── Card 6: Graph snapshot ───────────────────────────────────────────────
  function GraphSnapshotCard(props) {
    const { gs } = props;
    const concepts = gs && typeof gs.conceptCount === 'number' ? gs.conceptCount : 0;
    const growth = gs && typeof gs.growthThisWeek === 'number' ? gs.growthThisWeek : 0;
    const facts = gs && typeof gs.factCount === 'number' ? gs.factCount : 0;
    if (concepts === 0 && growth === 0 && facts === 0) {
      return h`<${Card} title="Graph snapshot">
        <${Empty}>No graph data yet. The picture fills in as you learn.<//>
      <//>`;
    }
    return h`<${Card} title="Graph snapshot">
      <div style=${{display:'flex',flexDirection:'column',alignItems:'flex-start',gap:'8px',padding:'12px 0'}}>
        <div style=${{fontSize:'42px',fontWeight:'700',lineHeight:'1'}}>${concepts}</div>
        <div style=${{color:'var(--muted)',fontSize:'12px'}}>concepts</div>
        ${growth > 0 ? h`<div style=${{color:'var(--green)',fontSize:'13px',fontWeight:'600'}}>+${growth} this week</div>` : null}
        ${facts > 0 ? h`<div style=${{color:'var(--muted)',fontSize:'12px',marginTop:'4px'}}>${facts} fact${facts === 1 ? '' : 's'}</div>` : null}
      </div>
    <//>`;
  }

  // ── Top-level grid ───────────────────────────────────────────────────────
  function DashboardCards(props) {
    const { data, loading, error, onReload, onRegenerateFlashcards, onNavigateSection, regenerating } = props;
    const headerStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: '4px',
    };
    const gridStyle = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: 'var(--gap)',
    };

    if (loading && !data) {
      return h`
        <div>
          <div style=${headerStyle}>
            <h1 style=${{fontSize:'20px',fontWeight:'700'}}>Dashboard</h1>
          </div>
          <div class="loading-row" style=${{padding:'40px',justifyContent:'center'}}>
            <div class="spinner"></div> Loading dashboard…
          </div>
        </div>
      `;
    }

    if (error) {
      return h`
        <div>
          <div style=${headerStyle}>
            <h1 style=${{fontSize:'20px',fontWeight:'700'}}>Dashboard</h1>
            <button class="btn btn-secondary" onClick=${onReload}>Retry</button>
          </div>
          <div style=${{color:'var(--red)',padding:'24px',textAlign:'center'}}>${error}</div>
        </div>
      `;
    }

    const d = data || {};
    return h`
      <div>
        <div style=${headerStyle}>
          <h1 style=${{fontSize:'20px',fontWeight:'700'}}>Dashboard</h1>
          <button class="btn btn-secondary" onClick=${onReload} disabled=${loading}>${loading ? 'Reloading…' : 'Reload'}</button>
        </div>
        <div class="dashboard-grid" style=${gridStyle}>
          <${JumpBackInCard} jbi=${d.jumpBackIn} onNavigateSection=${onNavigateSection} />
          <${DailyQuizCard} dq=${d.dailyQuiz} onNavigateSection=${onNavigateSection} />
          <${DailyFlashcardsCard} df=${d.dailyFlashcards} onRegenerate=${onRegenerateFlashcards} regenerating=${regenerating} />
          <${InsightsCard} ins=${d.insights} patrolMinutes=${(d.timing && d.timing.patrolMinutes) || null} />
          <${CrossCourseCard} ccc=${d.crossCourseConnections} />
          <${GraphSnapshotCard} gs=${d.graphSnapshot} />
        </div>
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.DashboardCards = DashboardCards;
})();
