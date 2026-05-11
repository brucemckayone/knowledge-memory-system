// DashboardCards: home tab. Cards rendered in a responsive grid.
// Props:
//   data: DashboardResponse | null   — null while loading
//   loading: boolean
//   error: string | null
//   onReload: () => void
//   onRegenerateFlashcards: () => void
//   onNavigateSection: (sectionId, opts?) => void   — opts.quiz: jump straight to quiz view
//   onNavigateChat: (sessionId) => void
//   onNavigateCourse: (courseId) => void   — used by CrossCourseCard linkInsights
//   regenerating: boolean
(function(){
  const { h } = window;
  const { useEffect, useRef, useState } = window.preactHooks;

  const DISMISSED_KEY = 'learn:dashboard:insights:dismissed';

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

  function loadDismissed() {
    try {
      const raw = localStorage.getItem(DISMISSED_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  }

  function saveDismissed(set) {
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set])); }
    catch { /* noop */ }
  }

  // ── Card frame ────────────────────────────────────────────────────────────
  function Card(props) {
    const { title, badge, action, children, span, feature } = props;
    const cls = 'dash-card'
      + (span === 2 ? ' span-2' : '')
      + (feature ? ' is-feature' : '');
    return h`
      <div class=${cls}>
        <div class="dash-card-head">
          <span class="dash-card-title">
            ${title}
            ${badge != null ? h`<span class="dash-card-badge">${badge}</span>` : null}
          </span>
          ${action || null}
        </div>
        <div class="dash-card-body">${children}</div>
      </div>
    `;
  }

  function ActionLink(props) {
    return h`<button type="button" class="dash-action-link" onClick=${props.onClick} disabled=${props.disabled}>${props.children}</button>`;
  }

  function Empty(props) {
    return h`<div class="dash-empty">${props.children}</div>`;
  }

  // ── Card 1: Top gap (feature card, span 2) ───────────────────────────────
  function SecondaryGapsModal(props) {
    const { onClose, onFixGap } = props;
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [gaps, setGaps] = useState([]);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const r = await fetch('/api/learner/gaps/top?n=3');
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = await r.json();
          if (!cancelled) setGaps(Array.isArray(j.gaps) ? j.gaps : []);
        } catch (err) {
          if (!cancelled) setError(err && err.message ? err.message : String(err));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }, []);

    const onBackdropClick = (e) => {
      if (e.target === e.currentTarget) onClose();
    };

    return h`<div class="promote-modal-backdrop" onClick=${onBackdropClick}>
      <div class="promote-modal" style=${{minWidth: '420px', maxWidth: '560px'}}>
        <h3>Other gaps</h3>
        ${loading ? h`<div style=${{padding:'12px',color:'var(--muted)',fontSize:'13px'}}>Loading…</div>` : null}
        ${error ? h`<div style=${{padding:'12px',color:'var(--red)',fontSize:'13px'}}>${error}</div>` : null}
        ${(!loading && !error && gaps.length === 0)
          ? h`<div style=${{padding:'12px',color:'var(--muted)',fontSize:'13px'}}>No other visible gaps right now.</div>`
          : null}
        ${(!loading && !error && gaps.length > 0) ? h`
          <div style=${{display:'flex',flexDirection:'column',gap:'10px',marginBottom:'12px'}}>
            ${gaps.map(g => h`
              <div key=${g.id} style=${{
                padding:'10px',
                border:'1px solid var(--border)',
                borderRadius:'6px',
                background:'var(--surface2)',
              }}>
                <div style=${{fontSize:'13px',fontWeight:'600',marginBottom:'4px'}}>${g.rootCauseConceptName || g.title}</div>
                ${g.rootCauseReason ? h`<div style=${{fontSize:'12px',color:'var(--muted)',marginBottom:'4px',lineHeight:'1.4'}}>${g.rootCauseReason}</div>` : null}
                ${g.whyItMatters ? h`<div style=${{fontSize:'12px',color:'var(--text)',marginBottom:'8px',lineHeight:'1.4'}}><strong>Why it matters:</strong> ${g.whyItMatters}</div>` : null}
                <div style=${{display:'flex',justifyContent:'flex-end'}}>
                  <button class="btn btn-secondary" style=${{fontSize:'12px',padding:'4px 10px'}}
                    onClick=${() => { if (typeof onFixGap === 'function') onFixGap(g); }}>
                    Fix this gap
                  </button>
                </div>
              </div>
            `)}
          </div>
        ` : null}
        <div class="actions">
          <button onClick=${onClose}>Close</button>
        </div>
      </div>
    </div>`;
  }

  function TopGapCard(props) {
    const { tg, onFixGap, onNavigateSection } = props;
    const [fixing, setFixing] = useState(false);
    const [fixError, setFixError] = useState(null);
    const [showSecondary, setShowSecondary] = useState(false);

    if (!tg) return null;

    if (tg.coldStart) {
      return h`<${Card} title="Top gap" span=${2} feature=${true}>
        <${Empty}>Complete a quiz to surface gaps. (${tg.factCount}/${tg.threshold} learner facts so far.)<//>
      <//>`;
    }

    if (!tg.gap) {
      return h`<${Card} title="Top gap" span=${2} feature=${true}>
        <${Empty}>${tg.refreshing ? 'Analysing your knowledge for gaps…' : 'No active gaps. Keep going.'}<//>
      <//>`;
    }

    const gap = tg.gap;
    const fixWithSection = async (gapEntityId) => {
      if (!tg.candidateSectionId) {
        setFixError('No section currently teaches this concept.');
        return;
      }
      setFixing(true); setFixError(null);
      try {
        const res = await fetch('/api/learner/fix-gap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gapEntityId: gapEntityId || '',
            sectionId: tg.candidateSectionId,
          }),
        });
        if (!res.ok && res.status !== 202) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        if (typeof onFixGap === 'function') onFixGap(tg.candidateSectionId);
        else if (typeof onNavigateSection === 'function') onNavigateSection(tg.candidateSectionId);
      } catch (err) {
        setFixError(err && err.message ? err.message : String(err));
      } finally {
        setFixing(false);
      }
    };

    const handleFix = () => fixWithSection(gap.rootCauseEntityId);
    const handleFixSecondary = (secondaryGap) => {
      setShowSecondary(false);
      fixWithSection(secondaryGap && secondaryGap.rootCauseEntityId);
    };

    return h`<${Card} title="Top gap" span=${2} feature=${true}>
      <div class="dash-gap-headline">${gap.rootCauseConceptName || gap.title}</div>
      ${gap.rootCauseReason ? h`<div class="dash-gap-reason">${gap.rootCauseReason}</div>` : null}
      ${gap.whyItMatters ? h`<div class="dash-gap-why"><strong>Why it matters:</strong> ${gap.whyItMatters}</div>` : null}
      ${tg.refreshing ? h`<div class="dash-gap-cta-hint" style=${{marginBottom:'8px'}}>Refreshing analysis…</div>` : null}
      <div class="dash-gap-cta">
        ${tg.candidateSectionId
          ? h`<button class="btn btn-primary" onClick=${handleFix} disabled=${fixing}>
              ${fixing ? 'Regenerating lesson…' : 'Fix this gap'}
            </button>`
          : h`<span class="dash-gap-cta-hint">No section teaches this concept yet.</span>`}
        ${tg.candidateSectionTitle
          ? h`<span class="dash-gap-cta-hint">→ ${truncate(tg.candidateSectionTitle, 40)}</span>`
          : null}
      </div>
      ${fixError ? h`<div class="dash-gap-error">${fixError}</div>` : null}
      <div class="dash-gap-secondary">
        <button class="btn btn-secondary" style=${{fontSize:'11px',padding:'4px 10px'}}
          onClick=${() => setShowSecondary(true)}>
          See other gaps
        </button>
      </div>
      ${showSecondary ? h`<${SecondaryGapsModal}
        onClose=${() => setShowSecondary(false)}
        onFixGap=${handleFixSecondary} />` : null}
    <//>`;
  }

  // ── Card 2: Jump back in ─────────────────────────────────────────────────
  function JumpBackInCard(props) {
    const { jbi, onNavigateSection } = props;
    if (!jbi || (!jbi.quizAttempt && !jbi.chatMessage)) {
      return h`<${Card} title="Jump back in"><${Empty}>No recent activity yet. Start a course to begin.<//><//>`;
    }
    const items = [];
    if (jbi.quizAttempt) {
      const a = jbi.quizAttempt;
      const score = a.score == null ? null : Math.round(a.score * 100);
      const cls = score == null ? '' : score >= 70 ? 'high' : score >= 40 ? 'mid' : 'low';
      items.push(h`
        <button key="qa" type="button" class="dash-row" onClick=${() => onNavigateSection(a.sectionId)}>
          <div class="dash-row-kicker">Continue quiz</div>
          <div class="dash-row-head">
            <span class="dash-row-title">${a.courseTitle} · ${a.sectionTitle}</span>
            ${score != null ? h`<span class=${'score-pill ' + cls}>${score}%</span>` : null}
          </div>
          <div class="dash-row-time">${timeAgo(a.completedAt)}</div>
        </button>
      `);
    }
    if (jbi.chatMessage) {
      const m = jbi.chatMessage;
      items.push(h`
        <button key="cm" type="button" class="dash-row" disabled=${!m.sectionId}
                onClick=${() => m.sectionId ? onNavigateSection(m.sectionId) : null}>
          <div class="dash-row-kicker">Resume chat</div>
          <div class="dash-row-title" style=${{whiteSpace:'nowrap',marginBottom:'4px'}}>${m.courseTitle ?? 'General chat'}</div>
          <div class="dash-row-snippet">${truncate(m.snippet, 140)}</div>
          <div class="dash-row-time">${timeAgo(m.createdAt)}</div>
        </button>
      `);
    }
    return h`<${Card} title="Jump back in">${items}<//>`;
  }

  // ── Card 3: Daily quiz ───────────────────────────────────────────────────
  function DailyQuizCard(props) {
    const { dq, onNavigateSection } = props;
    const q = dq && dq.question;
    const rationale = dq && dq.rationale;
    if (!q) {
      const reason = rationale && rationale.reason ? rationale.reason : "No question to surface today. You're up to date — explore Courses?";
      return h`<${Card} title="Daily quiz"><${Empty}>${reason}<//><//>`;
    }
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
      <button type="button" class="dash-row"
              onClick=${() => onNavigateSection(q.sectionId, { quiz: true })}>
        <div class="dash-row-kicker" style=${{marginBottom:'6px'}}>${q.courseTitle} · ${q.sectionTitle}</div>
        <div style=${{fontSize:'14px',fontWeight:'500',lineHeight:'1.5',marginBottom:'10px',whiteSpace:'normal'}}>
          ${truncate(q.questionText, 220)}
        </div>
        ${rationaleText ? h`<div style=${{color:'var(--muted)',fontSize:'11px',lineHeight:'1.5'}}>${rationaleText}</div>` : null}
      </button>
    <//>`;
  }

  // ── Card 4: Daily flashcards ─────────────────────────────────────────────
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

  function FlashcardDeckWithVerdicts(props) {
    const FlashcardDeck = window.LearnComponents.FlashcardDeck;
    const ref = useRef(null);
    const idxRef = useRef(0);
    const cards = props.cards;

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
        const header = node.querySelector('.flashcard-deck > div');
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

    useEffect(() => { idxRef.current = 0; }, [cards]);

    return h`<div ref=${ref} class="dash-flashcards-wrap">
      <${FlashcardDeck} cards=${cards} onComplete=${() => {}} />
    </div>`;
  }

  // ── Card 5: Insights feed ────────────────────────────────────────────────
  function InsightsCard(props) {
    const { ins, patrolMinutes } = props;
    const items = ins && Array.isArray(ins.items) ? ins.items : [];
    const [dismissed, setDismissed] = useState(loadDismissed);
    const viewedRef = useRef(new Set());

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
        saveDismissed(next);
        return next;
      });
      postSilent(`/api/insights/${id}/dismiss`);
    };

    const unreadCount = visible.filter(it => !it.viewedAt).length;

    return h`<${Card} title="Insights" badge=${unreadCount > 0 ? unreadCount : null}>
      <div>
        ${visible.map(it => {
          const v = typeof it.importance === 'number' ? it.importance : 0;
          const dotCls = v >= 0.7 ? 'high' : v >= 0.4 ? 'mid' : 'low';
          return h`
            <div key=${it.id} class="dash-insight">
              <span class=${'dash-insight-dot ' + dotCls} title=${`importance ${v.toFixed(2)}`}></span>
              <div class="dash-insight-body">
                <div class="dash-insight-title">${truncate(it.title, 80)}</div>
                <div class="dash-insight-snippet" title=${it.contentMd}>${truncate(it.contentMd, 140)}</div>
                <div class="dash-insight-time">${timeAgo(it.createdAt)}</div>
              </div>
              <button type="button" class="dash-dismiss-btn" title="Dismiss" aria-label="Dismiss insight" onClick=${() => dismiss(it.id)}>×</button>
            </div>
          `;
        })}
      </div>
    <//>`;
  }

  // ── Card 6: Cross-course connections ─────────────────────────────────────
  function CrossCourseCard(props) {
    const { ccc, onNavigateCourse } = props;
    const concepts = ccc && Array.isArray(ccc.concepts) ? ccc.concepts : [];
    const linkInsights = ccc && Array.isArray(ccc.linkInsights) ? ccc.linkInsights : [];

    if (concepts.length === 0 && linkInsights.length === 0) {
      return h`<${Card} title="Cross-course connections">
        <${Empty}>No cross-course connections yet. They'll appear as your learning expands.<//>
      <//>`;
    }

    const idToTitle = new Map();
    for (const c of concepts) {
      for (const co of (c.courses || [])) {
        if (co && co.courseId && co.courseTitle) idToTitle.set(co.courseId, co.courseTitle);
      }
    }
    try {
      const cached = (window.state && Array.isArray(window.state.courses)) ? window.state.courses : [];
      for (const c of cached) {
        if (c && c.id && c.title && !idToTitle.has(c.id)) idToTitle.set(c.id, c.title);
      }
    } catch { /* noop */ }
    const courseTitleFor = (cid) => idToTitle.get(cid) || (typeof cid === 'string' ? cid.slice(0, 8) : '');

    const handleInsightClick = (it) => {
      const ids = Array.isArray(it.relatedCourseIds) ? it.relatedCourseIds : [];
      if (ids.length === 0) return;
      if (typeof onNavigateCourse === 'function') onNavigateCourse(ids[0]);
    };

    const renderLinkInsights = () => h`
      <div>
        ${linkInsights.length > 0 && concepts.length > 0
          ? h`<div class="dash-section-head">From the patrol</div>`
          : null}
        ${linkInsights.map(it => {
          const courseIds = Array.isArray(it.relatedCourseIds) ? it.relatedCourseIds : [];
          const hasCourses = courseIds.length > 0;
          const activate = hasCourses ? () => handleInsightClick(it) : null;
          const cls = 'dash-insight' + (hasCourses ? ' is-clickable' : '');
          return h`
            <div key=${it.id}
                 class=${cls}
                 role=${hasCourses ? 'button' : null}
                 tabIndex=${hasCourses ? 0 : null}
                 onClick=${activate}
                 onKeyDown=${hasCourses ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } } : null}
                 style=${hasCourses ? {cursor:'pointer'} : null}>
              <div class="dash-insight-body">
                <div style=${{display:'flex',alignItems:'center',marginBottom:'4px'}}>
                  <span class="dash-insight-title" style=${{flex:'1',minWidth:'0',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>${truncate(it.title, 80)}</span>
                  ${hasCourses ? h`<span class="dash-explore">explore →</span>` : null}
                </div>
                <div class="dash-insight-snippet" title=${it.contentMd}>${truncate(it.contentMd, 200)}</div>
                ${hasCourses ? h`<div style=${{marginTop:'4px'}}>${courseIds.map(cid => h`<span key=${cid} class="dash-chip">${truncate(courseTitleFor(cid), 32)}</span>`)}</div>` : null}
              </div>
            </div>
          `;
        })}
      </div>
    `;

    const renderConcepts = () => h`
      <div>
        ${linkInsights.length > 0 && concepts.length > 0
          ? h`<div class="dash-divider-head">Detected overlaps</div>`
          : null}
        ${concepts.map(c => h`
          <div key=${c.conceptEntityId} class="dash-insight">
            <div class="dash-insight-body">
              <div style=${{display:'flex',alignItems:'center',marginBottom:'4px'}}>
                <span class="dash-insight-title">${c.conceptName}</span>
                <span class="dash-tag">${c.kind === 'same_as' ? 'same-as' : 'direct'}</span>
              </div>
              <div>${(c.courses || []).map(co => h`<span key=${co.courseId} class="dash-chip">${truncate(co.courseTitle, 32)}</span>`)}</div>
            </div>
          </div>
        `)}
      </div>
    `;

    return h`<${Card} title="Cross-course connections">
      ${linkInsights.length > 0 ? renderLinkInsights() : null}
      ${concepts.length > 0 ? renderConcepts() : null}
    <//>`;
  }

  // ── Card 7: Graph snapshot ───────────────────────────────────────────────
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
        <div class="dash-stat-num">${concepts}</div>
        <div class="dash-stat-label">concepts</div>
        ${growth > 0 ? h`<div class="dash-stat-delta-pos">+${growth} this week</div>` : null}
        ${facts > 0 ? h`<div class="dash-stat-label" style=${{marginTop:'4px'}}>${facts} fact${facts === 1 ? '' : 's'}</div>` : null}
      </div>
    <//>`;
  }

  // ── Top-level grid ───────────────────────────────────────────────────────
  function DashboardCards(props) {
    const { data, loading, error, onReload, onRegenerateFlashcards, onNavigateSection, onNavigateCourse, onFixGap, regenerating } = props;
    const [lastUpdated, setLastUpdated] = useState(null);

    useEffect(() => {
      if (data) setLastUpdated(new Date());
    }, [data]);

    // Tick once a minute so "updated 2m ago" stays fresh without refetching.
    const [, setTick] = useState(0);
    useEffect(() => {
      const id = setInterval(() => setTick(t => t + 1), 60000);
      return () => clearInterval(id);
    }, []);

    if (loading && !data) {
      return h`
        <div>
          <div class="dash-header">
            <h1>Dashboard</h1>
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
          <div class="dash-header">
            <h1>Dashboard</h1>
            <button class="btn btn-secondary" onClick=${onReload}>Retry</button>
          </div>
          <div style=${{color:'var(--red)',padding:'24px',textAlign:'center'}}>${error}</div>
        </div>
      `;
    }

    const d = data || {};
    const stamp = lastUpdated ? `updated ${timeAgo(lastUpdated.toISOString())}` : '';
    const gridCls = 'dash-grid' + (loading ? ' is-updating' : '');
    return h`
      <div>
        <div class="dash-header">
          <h1>Dashboard</h1>
          <div class="dash-header-meta">
            ${stamp ? h`<span class="dash-header-stamp">${stamp}</span>` : null}
            <button class="btn btn-secondary" onClick=${onReload} disabled=${loading}>${loading ? 'Reloading…' : 'Reload'}</button>
          </div>
        </div>
        <div class=${gridCls}>
          <${TopGapCard} tg=${d.topGap} onFixGap=${onFixGap} onNavigateSection=${onNavigateSection} />
          <${JumpBackInCard} jbi=${d.jumpBackIn} onNavigateSection=${onNavigateSection} />
          <${DailyQuizCard} dq=${d.dailyQuiz} onNavigateSection=${onNavigateSection} />
          <${DailyFlashcardsCard} df=${d.dailyFlashcards} onRegenerate=${onRegenerateFlashcards} regenerating=${regenerating} />
          <${InsightsCard} ins=${d.insights} patrolMinutes=${(d.timing && d.timing.patrolMinutes) || null} />
          <${CrossCourseCard} ccc=${d.crossCourseConnections} onNavigateCourse=${onNavigateCourse} />
          <${GraphSnapshotCard} gs=${d.graphSnapshot} />
        </div>
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.DashboardCards = DashboardCards;
})();
