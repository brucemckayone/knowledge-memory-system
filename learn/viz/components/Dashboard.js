// DashboardCards: home tab. "Today's Brief" layout — a header stats strip,
// a full-width Top-Gap hero, then two clusters: "Do next" (quiz / resume /
// flashcards) and "What we noticed" (insights / cross-course).
//
// Props:
//   data: DashboardResponse | null   — null while loading
//   loading: boolean
//   error: string | null
//   onReload: () => void
//   onRegenerateFlashcards: () => void
//   onNavigateSection: (sectionId, opts?) => void   — opts.quiz: jump straight to quiz view
//   onNavigateChat: (sessionId) => void
//   onNavigateCourse: (courseId) => void
//   onFixGap: (sectionId) => void
//   regenerating: boolean
(function(){
  const { h } = window;
  const { useEffect, useMemo, useRef, useState } = window.preactHooks;

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

  // Light inline markdown renderer — bold, italic, inline code, paragraphs.
  // The page already includes `marked` but using it would also render lists/
  // headings which doesn't match the hero/insight typography. Cheap, safe.
  function inlineMd(s) {
    if (!s) return null;
    // Normalise: insert a paragraph break before each `**Heading:**` marker so
    // that gap insights (which pack Root cause / Why / Next on one line) split.
    const normalised = String(s).replace(/\s*(\*\*[A-Z][^*]{0,40}:\*\*)/g, (_, m, i) => (i === 0 ? m : '\n\n' + m));
    // Escape, then re-introduce a handful of inline tokens.
    const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
    const tokens = esc(normalised)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    // Paragraph split on blank lines.
    const paragraphs = tokens.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    return paragraphs.map((p, i) => h`<p key=${i} dangerouslySetInnerHTML=${{ __html: p.replace(/\n/g, '<br>') }} />`);
  }

  // Split gap.contentMd into Root cause / Why it matters / Next steps sections,
  // falling back to the structured fields when the markdown is absent.
  function parseGapSections(gap) {
    const result = {
      rootCause: gap?.rootCauseReason || '',
      whyItMatters: gap?.whyItMatters || '',
      nextSteps: '',
    };
    const md = gap?.contentMd || '';
    if (!md) return result;
    // Pattern: **Heading:** body...   captured until the next **Heading:** or EOF.
    const re = /\*\*([^*]+):\*\*\s*([\s\S]*?)(?=\n\s*\*\*[^*]+:\*\*|$)/g;
    let m;
    while ((m = re.exec(md)) !== null) {
      const key = m[1].trim().toLowerCase();
      const body = m[2].trim();
      if (/^root cause/.test(key)) result.rootCause = body || result.rootCause;
      else if (/^why/.test(key)) result.whyItMatters = body || result.whyItMatters;
      else if (/^next/.test(key)) result.nextSteps = body;
    }
    return result;
  }

  function importanceDots(v) {
    // 0..1 → 4 dots filled proportionally
    const filled = Math.max(0, Math.min(4, Math.round((Number(v) || 0) * 4)));
    return h`<span class="db-imp" aria-label=${`importance ${(v || 0).toFixed(2)}`}>
      ${[0,1,2,3].map(i => h`<i key=${i} class=${i < filled ? 'on' : ''}></i>`)}
    </span>`;
  }

  function confidenceMeter(num) {
    const v = Math.max(0, Math.min(1, Number(num) || 0));
    return h`<span class="db-conf">
      <span class="db-conf-track"><span class="db-conf-fill" style=${{ width: `${Math.max(4, v * 100)}%` }}></span></span>
      <span class="db-conf-num">${v.toFixed(2)}</span>
    </span>`;
  }

  // ── Hero: Top gap ────────────────────────────────────────────────────────
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
    const [tab, setTab] = useState('why');  // 'why' | 'cause' | 'next'

    if (!tg) return null;

    // Cold-start state — invite the learner in, don't apologise.
    if (tg.coldStart) {
      return h`<section class="db-hero">
        <div class="db-hero-kicker"><span class="pulse"></span>Today's focus</div>
        <h1 class="db-hero-headline">Take a quiz to surface your first gap</h1>
        <div class="db-hero-body">
          We need a little signal before we can call out what to drill on next.
          You're at <strong>${tg.factCount}</strong> of <strong>${tg.threshold}</strong> learner facts.
        </div>
      </section>`;
    }

    if (!tg.gap) {
      return h`<section class="db-hero">
        <div class="db-hero-kicker"><span class="pulse"></span>Today's focus</div>
        <h1 class="db-hero-headline">${tg.refreshing ? 'Looking for what to drill on next…' : 'You’re up to date.'}</h1>
        <div class="db-hero-body">
          ${tg.refreshing
            ? 'The gap analyser is scanning your latest quiz results.'
            : 'No open gaps. Keep going — try a fresh quiz or explore a connected concept.'}
        </div>
      </section>`;
    }

    const gap = tg.gap;
    const sections = parseGapSections(gap);
    const importance = typeof gap.importance === 'number' ? gap.importance : 0.5;
    // No structured confidence on the gap payload; reuse the rootCauseReason text
    // signal if present: the gap analyser writes 'confidence 0.0' in there for now.
    const confMatch = (gap.rootCauseReason || '').match(/confidence\s*([0-9.]+)/i);
    const confidence = confMatch ? parseFloat(confMatch[1]) : null;

    const tabs = [
      { id: 'why', label: 'Why it matters', body: sections.whyItMatters },
      { id: 'cause', label: 'Root cause', body: sections.rootCause },
      { id: 'next', label: 'Next steps', body: sections.nextSteps },
    ].filter(t => t.body);

    // Default to 'why' if available, otherwise first.
    const activeTab = tabs.find(t => t.id === tab) || tabs[0];

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

    return h`<section class="db-hero">
      <div class="db-hero-kicker">
        <span class="pulse"></span>Today's focus
        ${tg.refreshing ? h`<span class="db-hero-pending" style=${{marginLeft:'10px'}}>Refreshing</span>` : null}
      </div>
      <h1 class="db-hero-headline">${gap.rootCauseConceptName || gap.title}</h1>

      <div class="db-hero-meta">
        <div class="db-meta-item">
          <span class="db-meta-label">Importance</span>
          ${importanceDots(importance)}
        </div>
        ${confidence !== null ? h`
          <div class="db-meta-item">
            <span class="db-meta-label">Confidence</span>
            ${confidenceMeter(confidence)}
          </div>
        ` : null}
        ${gap.createdAt ? h`
          <div class="db-meta-item">
            <span class="db-meta-label">Spotted</span>
            <span class="db-meta-val">${timeAgo(gap.createdAt)}</span>
          </div>
        ` : null}
      </div>

      ${tabs.length > 1 ? h`
        <div class="db-segmented" role="tablist">
          ${tabs.map(t => h`
            <button
              key=${t.id}
              role="tab"
              aria-selected=${activeTab && activeTab.id === t.id}
              class=${activeTab && activeTab.id === t.id ? 'active' : ''}
              onClick=${() => setTab(t.id)}>
              ${t.label}
            </button>
          `)}
        </div>
      ` : null}

      <div class="db-hero-body">${activeTab ? inlineMd(activeTab.body) : null}</div>

      <div class="db-hero-cta-row">
        ${tg.candidateSectionId
          ? h`<button class="db-cta" onClick=${handleFix} disabled=${fixing}>
              ${fixing ? 'Regenerating lesson…' : h`<>Fix this gap <span class="db-cta-arrow">→</span></>`}
            </button>`
          : h`<span class="db-cta-unavailable">No section currently teaches this — queued for content.</span>`}
        ${tg.candidateSectionTitle ? h`
          <span class="db-cta-target">routes to <b>${truncate(tg.candidateSectionTitle, 60)}</b></span>
        ` : null}
        <button class="db-cta-secondary" onClick=${() => setShowSecondary(true)}>See other gaps</button>
      </div>
      ${fixError ? h`<div style=${{color:'var(--db-rose)', fontSize:'12px', marginTop:'10px'}}>${fixError}</div>` : null}

      ${showSecondary ? h`<${SecondaryGapsModal}
        onClose=${() => setShowSecondary(false)}
        onFixGap=${handleFixSecondary} />` : null}
    </section>`;
  }

  // ── Cluster card frame ───────────────────────────────────────────────────
  function ClusterCard(props) {
    const { title, glyph, tone, action, children } = props;
    return h`
      <div class="db-card">
        <div class="db-card-head">
          <span class=${'db-card-title' + (tone ? ' is-' + tone : '')}>
            ${glyph ? h`<span class="glyph">${glyph}</span>` : null}
            ${title}
          </span>
          ${action || null}
        </div>
        ${children}
      </div>
    `;
  }

  function Empty(props) {
    return h`
      <div class="db-empty">
        ${props.icon ? h`<div class="db-empty-icon">${props.icon}</div>` : null}
        ${props.headline ? h`<div class="db-empty-line">${props.headline}</div>` : null}
        ${props.children ? h`<div class="db-empty-sub">${props.children}</div>` : null}
      </div>
    `;
  }

  // ── Jump back in ─────────────────────────────────────────────────────────
  function JumpBackInCard(props) {
    const { jbi, onNavigateSection } = props;
    const hasContent = jbi && (jbi.quizAttempt || jbi.chatMessage);

    return h`<${ClusterCard} title="Jump back in" glyph="↺" tone="sky">
      ${hasContent ? null : h`<${Empty} icon="✶" headline="Nothing in progress.">Open a course to start a session.<//>`}
      ${jbi && jbi.quizAttempt ? (() => {
        const a = jbi.quizAttempt;
        const score = a.score == null ? null : Math.round(a.score * 100);
        const cls = score == null ? '' : score >= 70 ? 'high' : score >= 40 ? 'mid' : 'low';
        return h`
          <button type="button" class="db-action" onClick=${() => onNavigateSection(a.sectionId)}>
            <span class="db-action-icon kind-quiz">Q</span>
            <span class="db-action-body">
              <div class="db-action-kicker">Continue quiz · ${truncate(a.courseTitle, 38)}</div>
              <div class="db-action-title">${truncate(a.sectionTitle, 64)}</div>
              <div class="db-action-meta"><span>${timeAgo(a.completedAt)}</span></div>
            </span>
            ${score != null ? h`<span class=${'db-action-score ' + cls}>${score}%</span>` : null}
          </button>
        `;
      })() : null}
      ${jbi && jbi.chatMessage ? (() => {
        const m = jbi.chatMessage;
        return h`
          <button type="button" class="db-action" disabled=${!m.sectionId}
                  onClick=${() => m.sectionId ? onNavigateSection(m.sectionId) : null}>
            <span class="db-action-icon kind-chat">✻</span>
            <span class="db-action-body">
              <div class="db-action-kicker">Resume chat · ${truncate(m.courseTitle ?? 'General', 38)}</div>
              <div class="db-action-snippet">${truncate(m.snippet, 180)}</div>
              <div class="db-action-meta"><span>${timeAgo(m.createdAt)}</span></div>
            </span>
          </button>
        `;
      })() : null}
    <//>`;
  }

  // ── Daily quiz ───────────────────────────────────────────────────────────
  function DailyQuizCard(props) {
    const { dq, onNavigateSection } = props;
    const q = dq && dq.question;
    const rationale = dq && dq.rationale;

    if (!q) {
      return h`<${ClusterCard} title="Daily quiz" glyph="?" tone="violet">
        <${Empty} icon="✓" headline="You're up to date.">
          ${rationale && rationale.reason ? rationale.reason : 'No struggle area to surface today — explore Courses.'}
        <//>
      <//>`;
    }

    // Build clean rationale tags from the structured fields. We deliberately
    // skip rationale.reason here because it duplicates the structured numerics
    // — the old card joined both, producing visible duplication.
    const tags = [];
    if (rationale) {
      if (typeof rationale.priorBestScore === 'number') {
        tags.push({ kind: rationale.priorBestScore < 0.4 ? 'attn' : 'info', label: 'confidence', value: rationale.priorBestScore.toFixed(2) });
      }
      if (typeof rationale.blastRadius === 'number' && rationale.blastRadius > 0) {
        tags.push({ kind: 'attn', label: 'blocks', value: `${rationale.blastRadius} downstream` });
      }
      if (typeof rationale.decayDays === 'number' && rationale.decayDays > 0) {
        tags.push({ kind: 'info', label: 'untouched', value: `${rationale.decayDays}d` });
      }
    }

    // Short, single-line "why this one" lead. Falls back to a benign default.
    const whyLine = (() => {
      if (!rationale) return 'Surfaced for today’s drill';
      const r = rationale.reason || '';
      if (/struggle/i.test(r)) return 'Surfaced because you’re struggling here';
      if (/decay/i.test(r) || /untouched/i.test(r)) return 'Surfaced because this concept is fading';
      if (/blast/i.test(r) || /downstream/i.test(r)) return 'Surfaced because this unlocks downstream concepts';
      return 'Today’s drill';
    })();

    return h`<${ClusterCard} title="Daily quiz" glyph="?" tone="violet">
      <button type="button" class="db-action" style=${{flexDirection:'column', alignItems:'stretch'}}
              onClick=${() => onNavigateSection(q.sectionId, { quiz: true })}>
        <div class="db-quiz-why">${whyLine}</div>
        <div class="db-quiz-q">${truncate(q.questionText, 240)}</div>
        <div class="db-action-kicker" style=${{marginBottom:'8px'}}>${truncate(q.courseTitle, 42)} · ${truncate(q.sectionTitle, 54)}</div>
        ${tags.length > 0 ? h`
          <div class="db-quiz-tags">
            ${tags.map((t,i) => h`<span key=${i} class=${'db-tag is-' + t.kind}>${t.label} <b>${t.value}</b></span>`)}
          </div>
        ` : null}
      </button>
    <//>`;
  }

  // ── Flashcards ───────────────────────────────────────────────────────────
  function DailyFlashcardsCard(props) {
    const { df, onRegenerate, regenerating } = props;
    const cards = df && Array.isArray(df.cards) ? df.cards : [];
    const refreshAction = h`<button class="db-pill-btn" onClick=${onRegenerate} disabled=${regenerating}>
      ${regenerating ? h`<><span class="spinner-dot"></span>Generating…</>` : 'Refresh'}
    </button>`;

    if (cards.length === 0) {
      return h`<${ClusterCard} title="Flashcards" glyph="◫" tone="amber" action=${refreshAction}>
        <${Empty} icon="◫" headline=${regenerating ? 'Spinning up new cards…' : 'No cards waiting for review.'}>
          ${regenerating
            ? 'Takes about 20s — the model is drafting fresh prompts from your weakest concepts.'
            : 'Cards will appear as concepts fade. Hit Refresh to draft a fresh set now.'}
        <//>
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
      return h`<${ClusterCard} title="Flashcards" glyph="◫" tone="amber" action=${refreshAction}>
        <${Empty} icon="!">FlashcardDeck component unavailable.<//>
      <//>`;
    }

    return h`<${ClusterCard} title="Flashcards" glyph="◫" tone="amber" action=${refreshAction}>
      <div class="db-flashcards">
        <${FlashcardDeckWithVerdicts} cards=${deckCards} />
      </div>
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

  // ── Insights — expandable rows ───────────────────────────────────────────
  function InsightsCard(props) {
    const { ins, patrolMinutes } = props;
    const items = ins && Array.isArray(ins.items) ? ins.items : [];
    const [dismissed, setDismissed] = useState(loadDismissed);
    const [openIds, setOpenIds] = useState({});
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
      return h`<${ClusterCard} title="Insights" glyph="✦" tone="mint">
        <${Empty} icon="✦" headline="Nothing new to surface.">
          ${patrolMinutes ? `The patrol checks every ${patrolMinutes} minutes for emerging patterns.` : 'The patrol will surface patterns as your graph grows.'}
        <//>
      <//>`;
    }

    const dismiss = (id, e) => {
      if (e) e.stopPropagation();
      setDismissed(prev => {
        const next = new Set(prev);
        next.add(id);
        saveDismissed(next);
        return next;
      });
      postSilent(`/api/insights/${id}/dismiss`);
    };

    const toggle = (id) => setOpenIds(prev => ({ ...prev, [id]: !prev[id] }));

    const unreadCount = visible.filter(it => !it.viewedAt).length;

    const typeLabel = (t) => {
      if (!t) return '';
      if (t === 'synthesis_candidate') return 'synth';
      if (t === 'cross_course_link') return 'link';
      if (t === 'gap_analysis' || t === 'gap') return 'gap';
      if (t.endsWith('_drift')) return 'drift';
      return t.replace(/_/g, ' ');
    };
    const typeClass = (t) => {
      if (!t) return '';
      if (t === 'synthesis_candidate') return 't-synth';
      if (t === 'cross_course_link') return 't-link';
      if (t === 'gap_analysis' || t === 'gap') return 't-drift';
      if (t.endsWith('_drift')) return 't-drift';
      return '';
    };

    return h`<${ClusterCard} title="Insights" glyph="✦" tone="mint"
      action=${unreadCount > 0 ? h`<span class="db-tag is-attn">${unreadCount} new</span>` : null}>
      <div>
        ${visible.map(it => {
          const v = typeof it.importance === 'number' ? it.importance : 0;
          const dotCls = v >= 0.7 ? 'high' : v >= 0.4 ? 'mid' : 'low';
          const open = !!openIds[it.id];
          return h`
            <div key=${it.id}
                 class=${'db-insight' + (open ? ' is-open' : '')}
                 role="button" tabIndex=${0}
                 aria-expanded=${open}
                 onClick=${() => toggle(it.id)}
                 onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(it.id); } }}>
              <div class="db-insight-row">
                <span class=${'db-insight-dot ' + dotCls} title=${`importance ${v.toFixed(2)}`}></span>
                <span class="db-insight-title">${it.title}</span>
                ${it.type ? h`<span class=${'db-insight-type ' + typeClass(it.type)}>${typeLabel(it.type)}</span>` : null}
                <span class="db-insight-chevron">▸</span>
                <button type="button" class="db-insight-dismiss" title="Dismiss" aria-label="Dismiss insight" onClick=${(e) => dismiss(it.id, e)}>×</button>
              </div>
              ${!open ? h`<div class="db-insight-snippet">${truncate(it.contentMd, 180)}</div>` : null}
              ${open ? h`
                <div class="db-insight-full">${inlineMd(it.contentMd)}</div>
                <div class="db-insight-foot">
                  <span class="db-insight-time">${timeAgo(it.createdAt)}</span>
                </div>
              ` : h`<div class="db-insight-foot"><span class="db-insight-time">${timeAgo(it.createdAt)}</span></div>`}
            </div>
          `;
        })}
      </div>
    <//>`;
  }

  // ── Cross-course connections (largely preserved from the polished version) ─
  function CrossCourseCard(props) {
    const { ccc, onNavigateCourse, onNavigateSection } = props;
    const concepts = ccc && Array.isArray(ccc.concepts) ? ccc.concepts : [];
    const [openIds, setOpenIds] = useState({});
    const toggle = (id) => setOpenIds(prev => ({ ...prev, [id]: !prev[id] }));
    const linkInsights = ccc && Array.isArray(ccc.linkInsights) ? ccc.linkInsights : [];

    if (concepts.length === 0 && linkInsights.length === 0) {
      return h`<${ClusterCard} title="Cross-course" glyph="⤬" tone="sky">
        <${Empty} icon="⤬" headline="No cross-course overlaps yet.">They'll appear as your graph spans more topics.<//>
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

    const seedSectionFor = (c) => {
      const cs = Array.isArray(c.courses) ? c.courses : [];
      const withSection = cs.find(x => x && x.sectionId);
      return withSection ? withSection.sectionId : null;
    };

    const renderConcepts = () => h`
      <div>
        ${linkInsights.length > 0 && concepts.length > 0
          ? h`<div class="dash-divider-head">Detected overlaps</div>`
          : null}
        ${concepts.map(c => {
          const isOpen = !!openIds[c.conceptEntityId];
          const cs = Array.isArray(c.courses) ? c.courses : [];
          const seedId = seedSectionFor(c);
          const canChat = !!seedId && typeof onNavigateSection === 'function';
          return h`
            <div key=${c.conceptEntityId} class="dash-insight">
              <div class="dash-insight-body">
                <div style=${{display:'flex',alignItems:'center',marginBottom:'4px',cursor:'pointer',gap:'8px'}}
                     role="button" tabIndex=${0}
                     onClick=${() => toggle(c.conceptEntityId)}
                     onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(c.conceptEntityId); } }}>
                  <span style=${{color:'var(--muted)',fontSize:'10px',width:'10px',display:'inline-block'}}>${isOpen ? '▾' : '▸'}</span>
                  <span class="dash-insight-title" style=${{flex:'1',minWidth:'0'}}>${c.conceptName}</span>
                  <span class="dash-tag">${c.kind === 'same_as' ? 'same-as' : 'direct'}</span>
                  <span class="dash-chip" style=${{fontVariantNumeric:'tabular-nums'}}>${cs.length} courses</span>
                </div>
                ${isOpen ? h`
                  <div style=${{marginTop:'8px',paddingLeft:'18px',borderLeft:'2px solid var(--border)'}}>
                    ${cs.map(co => h`
                      <div key=${co.courseId} style=${{marginBottom:'10px'}}>
                        <div style=${{display:'flex',alignItems:'center',gap:'6px',marginBottom:'2px'}}>
                          <span class="dash-chip" style=${{cursor: typeof onNavigateCourse === 'function' ? 'pointer' : 'default'}}
                                onClick=${(e) => { e.stopPropagation(); if (typeof onNavigateCourse === 'function') onNavigateCourse(co.courseId); }}>
                            ${truncate(co.courseTitle, 36)}
                          </span>
                          ${co.sectionTitle ? h`<span style=${{color:'var(--muted)',fontSize:'11px'}}>${truncate(co.sectionTitle, 60)}</span>` : null}
                        </div>
                        ${co.snippet ? h`<div style=${{fontSize:'12px',color:'var(--muted)',lineHeight:'1.45'}}>${truncate(co.snippet, 220)}</div>` : null}
                      </div>
                    `)}
                    ${canChat ? h`
                      <button type="button" class="dash-action-btn"
                              onClick=${(e) => { e.stopPropagation(); onNavigateSection(seedId, { conceptChat: { name: c.conceptName, courses: cs.map(x => x.courseTitle) } }); }}
                              style=${{marginTop:'4px'}}>
                        Chat about this →
                      </button>
                    ` : null}
                  </div>
                ` : h`
                  <div style=${{marginTop:'2px'}}>${cs.map(co => h`<span key=${co.courseId} class="dash-chip">${truncate(co.courseTitle, 28)}</span>`)}</div>
                `}
              </div>
            </div>
          `;
        })}
      </div>
    `;

    return h`<${ClusterCard} title="Cross-course" glyph="⤬" tone="sky">
      <div class="db-xc-host">
        ${linkInsights.length > 0 ? renderLinkInsights() : null}
        ${concepts.length > 0 ? renderConcepts() : null}
      </div>
    <//>`;
  }

  // ── Graph snapshot ── now rendered inline in the header strip; the
  // exported component is retained for backward compatibility but returns null
  // when included in the grid layout.
  function GraphSnapshotCard() { return null; }

  // ── Header strip ─────────────────────────────────────────────────────────
  function HeaderStrip(props) {
    const { gs, onReload, loading, stamp } = props;
    const concepts = gs && typeof gs.conceptCount === 'number' ? gs.conceptCount : 0;
    const growth = gs && typeof gs.growthThisWeek === 'number' ? gs.growthThisWeek : 0;
    const facts = gs && typeof gs.factCount === 'number' ? gs.factCount : 0;
    return h`
      <header class="db-strip">
        <div class="db-strip-title">Today's <em>brief</em></div>
        <div class="db-strip-stats">
          <div class="db-stat" title="Concepts in your graph">
            <span class="db-stat-v">${concepts}</span>
            <span class="db-stat-l">concepts</span>
          </div>
          <div class="db-stat" title="Recorded facts">
            <span class="db-stat-v">${facts}</span>
            <span class="db-stat-l">facts</span>
          </div>
          ${growth > 0 ? h`
            <div class="db-stat" title="New concepts this week">
              <span class="db-stat-v up">+${growth}</span>
              <span class="db-stat-l">this week</span>
            </div>
          ` : null}
        </div>
        <div class="db-strip-actions">
          ${stamp ? h`<span class="db-stamp">${stamp}</span>` : null}
          <button class="db-reload" onClick=${onReload} disabled=${loading}>${loading ? 'Reloading…' : 'Reload'}</button>
        </div>
      </header>
    `;
  }

  // ── Top-level ────────────────────────────────────────────────────────────
  function DashboardCards(props) {
    const { data, loading, error, onReload, onRegenerateFlashcards, onNavigateSection, onNavigateCourse, onFixGap, regenerating } = props;
    const [lastUpdated, setLastUpdated] = useState(null);

    useEffect(() => {
      if (data) setLastUpdated(new Date());
    }, [data]);

    const [, setTick] = useState(0);
    useEffect(() => {
      const id = setInterval(() => setTick(t => t + 1), 60000);
      return () => clearInterval(id);
    }, []);

    if (loading && !data) {
      return h`
        <div class="db-page">
          <header class="db-strip">
            <div class="db-strip-title">Today's <em>brief</em></div>
            <div class="db-strip-stats">
              <div class="db-stat"><span class="db-stat-v db-skeleton" style=${{width:'40px',height:'17px'}}></span><span class="db-stat-l">concepts</span></div>
              <div class="db-stat"><span class="db-stat-v db-skeleton" style=${{width:'40px',height:'17px'}}></span><span class="db-stat-l">facts</span></div>
            </div>
          </header>
          <section class="db-hero">
            <div class="db-hero-kicker"><span class="pulse"></span>Today's focus</div>
            <div class="db-skeleton" style=${{height:'40px', width:'70%', marginBottom:'14px'}}></div>
            <div class="db-skeleton" style=${{height:'12px', width:'40%', marginBottom:'10px'}}></div>
            <div class="db-skeleton" style=${{height:'12px', width:'80%', marginBottom:'6px'}}></div>
            <div class="db-skeleton" style=${{height:'12px', width:'60%'}}></div>
          </section>
        </div>
      `;
    }

    if (error) {
      return h`
        <div class="db-page">
          <header class="db-strip">
            <div class="db-strip-title">Today's <em>brief</em></div>
            <div class="db-strip-actions">
              <button class="db-reload" onClick=${onReload}>Retry</button>
            </div>
          </header>
          <div style=${{color:'var(--db-rose)', padding:'24px', textAlign:'center', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'10px'}}>${error}</div>
        </div>
      `;
    }

    const d = data || {};
    const stamp = lastUpdated ? `updated ${timeAgo(lastUpdated.toISOString())}` : '';
    return h`
      <div class=${'db-page' + (loading ? ' is-updating' : '')}>
        <${HeaderStrip} gs=${d.graphSnapshot} onReload=${onReload} loading=${loading} stamp=${stamp} />

        <${TopGapCard} tg=${d.topGap} onFixGap=${onFixGap} onNavigateSection=${onNavigateSection} />

        <div class="db-clusters">
          <div class="db-cluster">
            <div class="db-cluster-head">
              <h2>Do <em>next</em></h2>
              <span class="hint">picked for you</span>
            </div>
            <${DailyQuizCard} dq=${d.dailyQuiz} onNavigateSection=${onNavigateSection} />
            <${JumpBackInCard} jbi=${d.jumpBackIn} onNavigateSection=${onNavigateSection} />
            <${DailyFlashcardsCard} df=${d.dailyFlashcards} onRegenerate=${onRegenerateFlashcards} regenerating=${regenerating} />
          </div>
          <div class="db-cluster">
            <div class="db-cluster-head">
              <h2>What we <em>noticed</em></h2>
              <span class="hint">surfaced by the patrol</span>
            </div>
            <${InsightsCard} ins=${d.insights} patrolMinutes=${(d.timing && d.timing.patrolMinutes) || null} />
            <${CrossCourseCard} ccc=${d.crossCourseConnections} onNavigateCourse=${onNavigateCourse} onNavigateSection=${onNavigateSection} />
          </div>
        </div>
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.DashboardCards = DashboardCards;
})();
