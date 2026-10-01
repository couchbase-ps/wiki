const STATE_MARKER = 'waf-state:';

let pillars = [];
let currentPillarId = null;
let lastReportContext = null;
// In-memory working state for the current modal session. Persistence lives in
// the saved wiki markdown block, not localStorage.
let draftState = null;

function generateReviewId() {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultDraft() {
    return {
        customerName: '',
        reviewerName: '',
        workloadName: '',
        deploymentModel: 'self-managed',
        currentPillarId: null,
        answers: {}
    };
}

function currentDeployment() {
    const selected = document.querySelector('input[name="deploymentType"]:checked');
    return selected?.value || loadDraft().deploymentModel || 'self-managed';
}

function setDeployment(value) {
    const radio = document.querySelector(`input[name="deploymentType"][value="${value}"]`);
    if (radio) radio.checked = true;
}

function applicableOptions(question) {
    const deployment = currentDeployment();
    return (question.options || []).filter(opt => !opt.appliesTo || opt.appliesTo.length === 0 || opt.appliesTo.includes(deployment));
}

function visibleQuestions(pillar) {
    return (pillar.questions || []).filter(question => applicableOptions(question).length > 0);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function deploymentLabel(value) {
    const names = {
        capella: 'Capella',
        'self-managed': 'Self-managed Server',
        operator: 'Autonomous Operator'
    };
    return names[value] || value || '';
}

function audienceLabel(audience) {
    const names = { platform: 'Platform', app: 'Application', security: 'Security' };
    const list = Array.isArray(audience) ? audience : (audience ? [audience] : []);
    return list.map(name => names[name] || name).join(' · ');
}

function loadDraft() {
    if (!draftState) draftState = defaultDraft();
    return draftState;
}

function saveDraft(draft) {
    draftState = { ...defaultDraft(), ...draft, answers: draft.answers || {} };
}

function answerKey(pillarId, questionId) {
    return `${pillarId}:${questionId}`;
}

function persistCurrentPillarAnswers() {
    if (!currentPillarId) return;
    const draft = loadDraft();
    document.querySelectorAll('.question-card').forEach(card => {
        const pillarId = card.dataset.pillarId;
        const questionId = card.dataset.questionId;
        const key = answerKey(pillarId, questionId);
        const selected = Array.from(card.querySelectorAll('.practice-option:checked')).map(cb => cb.value);
        const noneOfThese = !!card.querySelector('.none-option-checkbox:checked');
        const notes = card.querySelector('.question-notes')?.value.trim() || '';
        if (selected.length > 0 || notes || noneOfThese) {
            draft.answers[key] = { pillarId, questionId, selectedPractices: selected, noneOfThese, notes: notes || null };
        } else {
            delete draft.answers[key];
        }
    });
    saveDraft(draft);
}

function persistMetaFields() {
    const draft = loadDraft();
    draft.customerName = document.getElementById('customerName').value;
    draft.reviewerName = document.getElementById('reviewerName').value;
    draft.workloadName = document.getElementById('workloadName').value;
    draft.deploymentModel = currentDeployment();
    draft.currentPillarId = currentPillarId;
    saveDraft(draft);
}

function restorePillarAnswers() {
    const draft = loadDraft();
    document.querySelectorAll('.question-card').forEach(card => {
        const key = answerKey(card.dataset.pillarId, card.dataset.questionId);
        const answer = draft.answers[key];
        if (!answer) return;
        card.querySelectorAll('.practice-option').forEach(cb => {
            cb.checked = (answer.selectedPractices || []).includes(cb.value);
            cb.disabled = false;
        });
        const noneCb = card.querySelector('.none-option-checkbox');
        if (noneCb) {
            noneCb.checked = !!answer.noneOfThese;
            if (answer.noneOfThese) {
                card.querySelectorAll('.practice-option').forEach(p => {
                    p.checked = false;
                    p.disabled = true;
                });
            }
        }
        const notesEl = card.querySelector('.question-notes');
        if (notesEl && answer.notes) notesEl.value = answer.notes;
    });
}

function collectAllAnswers() {
    persistCurrentPillarAnswers();
    return Object.values(loadDraft().answers);
}

async function boot() {
    const response = await fetch('./pillars.json');
    pillars = await response.json();
    // Signal ready so the parent (wiki editor) can send existing review state.
    if (window.parent && window.parent !== window) {
        window.parent.postMessage({ event: 'ready' }, '*');
    }
    // Standalone fallback: no parent responded, render an empty review.
    setTimeout(() => { if (!didInit) doInit(null); }, 500);
}

let didInit = false;
function doInit(markdown) {
    if (didInit) return;
    didInit = true;
    const editing = typeof markdown === 'string' && markdown.length > 0;
    if (editing) {
        try { draftState = parseWafState(markdown); } catch (err) { console.error('parseWafState failed', err); }
    }
    const draft = loadDraft();
    document.getElementById('customerName').value = draft.customerName || '';
    document.getElementById('reviewerName').value = draft.reviewerName || '';
    document.getElementById('workloadName').value = draft.workloadName || '';
    setDeployment(draft.deploymentModel || 'self-managed');
    renderSidebar();
    const startId = draft.currentPillarId || pillars[0]?.id;
    if (startId) showPillar(startId);
    // Editing an existing review opens straight on the Review tab.
    selectTab(editing ? 'review' : 'about');
}

function selectTab(name) {
    document.querySelectorAll('.page-tab').forEach(button => {
        const active = button.dataset.tab === name;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-panel]').forEach(panel => {
        panel.hidden = panel.dataset.panel !== name;
    });
}

// Parse the hidden `<!-- waf-state:BASE64 -->` line back into a draft object.
function parseWafState(markdown) {
    const line = markdown.split('\n').find(l => l.includes(STATE_MARKER));
    if (!line) return defaultDraft();
    const b64 = line.replace(/^\s*<!--\s*waf-state:/, '').replace(/-->\s*$/, '').trim();
    const json = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(json);
    return { ...defaultDraft(), ...parsed, answers: parsed.answers || {} };
}

function pillarIcon(pillarId, extraClass = '') {
    const stroke = 'stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
    const icons = {
        'operational-excellence': `<svg viewBox="0 0 24 24" ${stroke}><rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 4h6v2H9z"/><path d="M9 11l2 2 4-4"/></svg>`,
        'security': `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 3L4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3z"/></svg>`,
        'reliability': `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 3L4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3z"/><path d="M9 12l2 2 4-4"/></svg>`,
        'performance-efficiency': `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 14l3-5"/><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"/></svg>`,
        'cost-optimization': `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M9.5 10.5h4a1.5 1.5 0 0 1 0 3h-4"/><path d="M9.5 13.5h4.5"/></svg>`,
        'data-management-consistency': `<svg viewBox="0 0 24 24" ${stroke}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>`
    };
    const svg = icons[pillarId] || icons['operational-excellence'];
    return `<span class="pillar-icon ${extraClass}" aria-hidden="true">${svg}</span>`;
}

function renderSidebar() {
    const container = document.getElementById('pillars');
    container.innerHTML = pillars.map(p =>
        `<a href="#" class="pillar-link ${p.id === currentPillarId ? 'active' : ''}" onclick="showPillar('${p.id}'); return false;">${pillarIcon(p.id, 'pillar-link-icon')}<span class="pillar-link-label">${p.name}</span></a>`
    ).join('');
}

function showPillar(pillarId) {
    if (currentPillarId && currentPillarId !== pillarId) {
        persistCurrentPillarAnswers();
    }
    currentPillarId = pillarId;
    selectTab('review');
    const pillar = pillars.find(p => p.id === pillarId);
    if (!pillar) return;

    const draft = loadDraft();
    draft.currentPillarId = pillarId;
    saveDraft(draft);
    renderSidebar();

    const html = `
        <div class="title-wrap">
            ${pillarIcon(pillar.id, 'pillar-page-icon')}
            <div class="title-copy">
                <h1>${escapeHtml(pillar.name)}</h1>
                <p>${escapeHtml(pillar.description || '')}</p>
            </div>
        </div>
        ${visibleQuestions(pillar).map(q => `
            <section class="question-card" data-pillar-id="${pillar.id}" data-question-id="${q.id}">
                <div class="question-code">${formatQuestionCode(q.id)}</div>
                <h3>${escapeHtml(q.title)}</h3>
                ${audienceLabel(q.audience) ? `<div class="question-meta"><span class="chip">Audience: ${escapeHtml(audienceLabel(q.audience))}</span></div>` : ''}
                <p>${escapeHtml(q.description || '')}</p>
                ${q.guidance ? `<p class="guidance"><strong>Guidance.</strong> ${escapeHtml(q.guidance)}</p>` : ''}
                ${(q.antiPatterns || []).length ? `<div class="anti-patterns"><span>Common anti-patterns</span><ul>${q.antiPatterns.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
                ${applicableOptions(q).map(opt => `
                    <label class="practice">
                        <input class="practice-option" type="checkbox" value="${escapeHtml(opt.id || opt.label)}">
                        <span>
                            ${escapeHtml(opt.label)}
                            ${(opt.alsoRelevantTo || []).length ? `<span class="also-relevant">Also relevant to ${escapeHtml(opt.alsoRelevantTo.join(', '))}</span>` : ''}
                            ${opt.optional ? `<span class="option-guidance">Only if this applies to the workload. Leaving it unchecked is not a finding.</span>` : ''}
                            ${opt.guidance ? `<span class="option-guidance">${escapeHtml(opt.guidance)}</span>` : ''}
                        </span>
                    </label>
                `).join('')}
                <div class="none-option">
                    <label><input class="none-option-checkbox" type="checkbox" value="none"> None of these</label>
                </div>
                <div class="notes-wrap">
                    <label class="notes-label" for="notes-${pillar.id}-${q.id}">Notes (optional)</label>
                    <textarea
                        id="notes-${pillar.id}-${q.id}"
                        class="question-notes"
                        rows="4"
                        placeholder="Reviewer notes, decisions, or follow-up actions..."
                    ></textarea>
                </div>
            </section>
        `).join('')}
    `;

    document.getElementById('pillarContent').innerHTML = html;
    restorePillarAnswers();
    bindExclusiveOptions();
    bindAutoSave();
}

function bindAutoSave() {
    document.querySelectorAll('.practice-option, .none-option-checkbox, .question-notes').forEach(el => {
        el.addEventListener('change', persistCurrentPillarAnswers);
        el.addEventListener('input', persistCurrentPillarAnswers);
    });
}

function formatQuestionCode(questionId) {
    return (questionId || '').toUpperCase();
}

function getSelectedOptions(question, answer) {
    const options = applicableOptions(question);
    if (!answer || answer.noneOfThese) return [];
    const selected = new Set((answer.selectedPractices || []).map(v => (v || '').toLowerCase()));
    return options.filter(opt => selected.has((opt.id || '').toLowerCase()) || selected.has((opt.label || '').toLowerCase()));
}

function getMissingOptions(question, selectedIds) {
    const options = applicableOptions(question);
    const selected = new Set((selectedIds || []).map(v => (v || '').toLowerCase()));
    return options.filter(opt => {
        const id = (opt.id || '').toLowerCase();
        const label = (opt.label || '').toLowerCase();
        if (opt.optional) return false;
        return !selected.has(id) && !selected.has(label);
    });
}

function getRisks(missingOptions) {
    const byId = new Map();
    (missingOptions || []).forEach(opt => {
        (opt.ifNotSelected?.risks || []).forEach(risk => {
            const id = risk.id || `${risk.severity || 'medium'}:${risk.reason || 'risk'}`;
            if (!byId.has(id)) byId.set(id, risk);
        });
    });
    return Array.from(byId.values());
}

function getImprovements(missingOptions) {
    const rank = { high: 3, medium: 2, low: 1 };
    const byId = new Map();
    (missingOptions || []).forEach(opt => {
        const maxSeverity = (opt.ifNotSelected?.risks || []).reduce((max, risk) => {
            const sev = (risk.severity || 'low').toLowerCase();
            return Math.max(max, rank[sev] || 1);
        }, 1);
        const severity = Object.keys(rank).find(k => rank[k] === maxSeverity) || 'low';
        (opt.ifNotSelected?.improvements || []).forEach(improvement => {
            const id = improvement.id || `${opt.id || 'opt'}:improvement`;
            const existing = byId.get(id);
            const candidate = { ...improvement, _severity: severity, _rank: maxSeverity };
            if (!existing || candidate._rank > existing._rank) byId.set(id, candidate);
        });
    });
    return Array.from(byId.values());
}

function computeStatus(risks) {
    const severities = new Set((risks || []).map(r => (r.severity || 'low').toLowerCase()));
    if (severities.has('high')) return 'HIGH';
    if (severities.has('medium')) return 'MEDIUM';
    if (severities.has('low')) return 'LOW';
    return 'LOW';
}

function getGroupedRisksBySeverity(risks) {
    return {
        high: (risks || []).filter(r => (r.severity || '').toLowerCase() === 'high'),
        medium: (risks || []).filter(r => (r.severity || '').toLowerCase() === 'medium'),
        low: (risks || []).filter(r => (r.severity || '').toLowerCase() === 'low')
    };
}

function getCoverage(selectedIds, question) {
    const options = applicableOptions(question);
    const totalOptions = options.length;
    const selectedSet = new Set((selectedIds || []).map(v => (v || '').toLowerCase()));
    let selectedCount = 0;
    options.forEach(opt => {
        const id = (opt.id || '').toLowerCase();
        const label = (opt.label || '').toLowerCase();
        if (selectedSet.has(id) || selectedSet.has(label)) selectedCount += 1;
    });
    return { selectedCount, totalOptions, missingCount: Math.max(totalOptions - selectedCount, 0) };
}

function getPrioritizedImprovements(improvements) {
    return (improvements || []).sort((a, b) => {
        if (b._rank !== a._rank) return b._rank - a._rank;
        return (a.title || '').localeCompare(b.title || '');
    });
}

function buildQuestionResult(question, answer) {
    const selectedIds = answer?.noneOfThese ? [] : (answer?.selectedPractices || []);
    const missingOptions = getMissingOptions(question, selectedIds);
    const risks = getRisks(missingOptions);
    const improvements = getImprovements(missingOptions);
    const coverage = getCoverage(selectedIds, question);
    const status = computeStatus(risks);
    return {
        questionId: question.id,
        questionTitle: question.title,
        status,
        selectedCount: coverage.selectedCount,
        totalOptions: coverage.totalOptions,
        missingCount: coverage.missingCount,
        selectedLabels: getSelectedOptions(question, answer).map(o => o.label),
        risks,
        improvements
    };
}

    function getPillarSummary(pillar, answerByQuestionId) {
        const results = visibleQuestions(pillar).map(q => buildQuestionResult(q, answerByQuestionId[q.id]));
    const allRisks = results.flatMap(r => r.risks);
    const allImprovements = results.flatMap(r => r.improvements);
    const grouped = getGroupedRisksBySeverity(allRisks);
    const improvements = getPrioritizedImprovements(allImprovements).slice(0, 5);
    const status = computeStatus(allRisks);

    return {
        pillarId: pillar.id,
        status,
        highRiskCount: grouped.high.length,
        mediumRiskCount: grouped.medium.length,
        lowRiskCount: grouped.low.length,
        improvements,
        results
    };
}

function processReview(details, answers) {
    let highRiskCount = 0;
    let mediumRiskCount = 0;
    let lowRiskCount = 0;

    for (const pillar of pillars) {
        for (const question of visibleQuestions(pillar)) {
            const answer = answers.find(a => a.pillarId === pillar.id && a.questionId === question.id);
            if (!answer) continue;
            const result = buildQuestionResult(question, answer);
            if (result.status === 'HIGH') highRiskCount += 1;
            else if (result.status === 'MEDIUM') mediumRiskCount += 1;
            else lowRiskCount += 1;
        }
    }

    const totalQuestions = pillars.reduce((sum, pillar) => sum + visibleQuestions(pillar).length, 0);
    const now = new Date();
    const lastUpdatedDisplay = now.toLocaleString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZoneName: 'short'
    });

    return {
        reviewId: generateReviewId(),
        customerName: details.customerName,
        reviewerName: details.reviewerName,
        workloadName: details.workloadName,
        deploymentModel: details.deploymentModel,
        deploymentLabel: deploymentLabel(details.deploymentModel),
        lastUpdatedDisplay,
        answeredQuestions: answers.length,
        totalQuestions,
        highRiskCount,
        mediumRiskCount,
        lowRiskCount,
        milestoneSaved: true
    };
}

function severityRank(level) {
    const rank = { high: 3, medium: 2, low: 1 };
    return rank[(level || 'low').toLowerCase()] || 1;
}

function titleCaseSeverity(level) {
    const normalized = (level || 'low').toLowerCase();
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function buildPillarSection(pillar, pillarSummary) {
    const improvementsMap = new Map();

    (pillarSummary.results || []).forEach(question => {
        const grouped = getGroupedRisksBySeverity(question.risks || []);
        const questionSeverity = grouped.high.length > 0 ? 'high' : grouped.medium.length > 0 ? 'medium' : 'low';

        (question.improvements || []).forEach(improvement => {
            const id = improvement.id || `${question.questionId}-improvement`;
            if (!improvementsMap.has(id)) {
                improvementsMap.set(id, {
                    id,
                    title: improvement.title || 'Improvement',
                    description: improvement.description || '',
                    docUrl: improvement.docUrl || null,
                    severity: questionSeverity,
                    risks: new Map(),
                    questions: new Set()
                });
            }
            const item = improvementsMap.get(id);
            if (severityRank(questionSeverity) > severityRank(item.severity)) {
                item.severity = questionSeverity;
            }
            (question.risks || []).forEach(risk => {
                const riskId = risk.id || `${risk.severity || 'medium'}:${risk.reason || ''}`;
                item.risks.set(riskId, risk);
            });
            item.questions.add(question.questionId.toUpperCase());
        });
    });

    const improvements = Array.from(improvementsMap.values()).sort((a, b) => {
        const rankDiff = severityRank(b.severity) - severityRank(a.severity);
        if (rankDiff !== 0) return rankDiff;
        return a.title.localeCompare(b.title);
    });

    const lines = [];
    lines.push(`## ${pillar.name} - Recommended Improvements`);
    lines.push('');

    if (improvements.length === 0) {
        lines.push('No improvement required for this pillar.');
        lines.push('');
        return lines.join('\n');
    }

    improvements.forEach(item => {
        const riskDescriptions = Array.from(item.risks.values()).map(r => r.reason).filter(Boolean);
        lines.push(`### ${item.title}`);
        lines.push('');
        lines.push(`**Severity:** _${titleCaseSeverity(item.severity)}_`);
        lines.push('');
        if (riskDescriptions.length > 0) {
            lines.push(`**Description:** ${riskDescriptions.join(' ')}`);
            lines.push('');
        }
        lines.push(`**Suggested Next Steps:** ${item.description || 'Implement missing control and validate.'}`);
        lines.push('');
        if (item.docUrl) {
            lines.push(`- [Documentation](${item.docUrl})`);
            lines.push('');
        }
    });

    return lines.join('\n');
}

// Full review across all pillars, prefixed with hidden base64 state for a
// lossless edit round-trip. Parent wraps this in the well-architected sentinels.
function buildWafMarkdown() {
    persistCurrentPillarAnswers();
    persistMetaFields();
    const draft = loadDraft();
    const answers = Object.values(draft.answers);
    const answerByQuestionId = Object.fromEntries(answers.map(a => [a.questionId, a]));
    const summary = processReview(draft, answers);
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(draft))));

    const lines = [];
    lines.push(`<!-- ${STATE_MARKER}${b64} -->`);
    lines.push('');
    lines.push(`# ${draft.workloadName || 'Well-Architected Tool'}`);
    lines.push('');
    lines.push(`- **Customer:** ${draft.customerName || ''}`);
    lines.push(`- **Reviewer:** ${draft.reviewerName || ''}`);
    lines.push(`- **Workload:** ${draft.workloadName || ''}`);
    lines.push(`- **Type:** ${deploymentLabel(draft.deploymentModel)}`);
    lines.push('');
    lines.push('## Overview');
    lines.push('');
    lines.push(`- **Questions answered:** ${summary.answeredQuestions}/${summary.totalQuestions}`);
    lines.push(`- **High risks:** ${summary.highRiskCount}`);
    lines.push(`- **Medium risks:** ${summary.mediumRiskCount}`);
    lines.push(`- **Low risks:** ${summary.lowRiskCount}`);
    lines.push('');

    pillars.forEach(pillar => {
        const pillarSummary = getPillarSummary(pillar, answerByQuestionId);
        lines.push(buildPillarSection(pillar, pillarSummary));
        lines.push('');
    });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function saveToWiki() {
    persistMetaFields();
    const markdown = buildWafMarkdown();
    if (window.parent && window.parent !== window) {
        window.parent.postMessage({ event: 'save', markdown }, '*');
    }
}

function exitToWiki() {
    if (window.parent && window.parent !== window) {
        window.parent.postMessage({ event: 'exit' }, '*');
    }
}

function bindExclusiveOptions() {
    document.querySelectorAll('.question-card').forEach(card => {
        const noneOption = card.querySelector('.none-option-checkbox');
        const practices = Array.from(card.querySelectorAll('.practice-option'));
        if (!noneOption) return;

        noneOption.addEventListener('change', () => {
            if (noneOption.checked) {
                practices.forEach(p => {
                    p.checked = false;
                    p.disabled = true;
                });
            } else {
                practices.forEach(p => { p.disabled = false; });
            }
            persistCurrentPillarAnswers();
        });

        practices.forEach(practice => {
            practice.addEventListener('change', () => {
                if (practice.checked) {
                    noneOption.checked = false;
                    practices.forEach(p => { p.disabled = false; });
                }
                persistCurrentPillarAnswers();
            });
        });
    });
}

function clearReview() {
    const hasDraft = loadDraft();
    const hasContent = hasDraft.customerName || hasDraft.reviewerName || hasDraft.workloadName || Object.keys(hasDraft.answers).length > 0;
    if (hasContent && !confirm('Start a new review? This clears the current workload, answers, and results.')) {
        return;
    }

    draftState = defaultDraft();
    lastReportContext = null;
    currentPillarId = null;

    document.getElementById('customerName').value = '';
    document.getElementById('reviewerName').value = '';
    document.getElementById('workloadName').value = '';
    setDeployment('self-managed');
    document.getElementById('result').style.display = 'none';
    document.getElementById('result').innerHTML = '';
    document.getElementById('saveReview').disabled = true;

    const hint = document.getElementById('saveHint');
    if (hint) {
        hint.textContent = 'Review cleared — ready for a new workload';
        setTimeout(() => {
            if (hint.textContent === 'Review cleared — ready for a new workload') hint.textContent = '';
        }, 3000);
    }

    const startId = pillars[0]?.id;
    if (startId) showPillar(startId);
    else document.getElementById('pillarContent').innerHTML = '';
}

function submitReview() {
    persistMetaFields();
    const details = {
        customerName: document.getElementById('customerName').value.trim(),
        reviewerName: document.getElementById('reviewerName').value.trim(),
        workloadName: document.getElementById('workloadName').value.trim(),
        deploymentModel: currentDeployment()
    };
    if (!details.customerName) {
        alert('Please enter the customer name');
        return;
    }
    if (!details.reviewerName) {
        alert('Please enter the reviewer name');
        return;
    }
    if (!details.workloadName) {
        alert('Please enter the workload name');
        return;
    }

    const answers = collectAllAnswers();
    if (answers.length === 0) {
        alert('Please answer at least one question across any pillar before submitting');
        return;
    }

    const result = processReview(details, answers);
    const resultBox = document.getElementById('result');
    resultBox.style.display = 'block';
    const answerByQuestionId = Object.fromEntries(answers.map(a => [a.questionId, a]));
    const selectedPillar = pillars.find(p => p.id === currentPillarId) || pillars[0];
    const pillarsDashboard = selectedPillar
        ? [{ pillar: selectedPillar, pillarSummary: getPillarSummary(selectedPillar, answerByQuestionId) }]
        : [];
    const activePillarSummary = pillarsDashboard.length > 0 ? pillarsDashboard[0].pillarSummary : null;
    lastReportContext = {
        ...details,
        pillar: selectedPillar,
        pillarSummary: activePillarSummary,
        generatedAt: result.lastUpdatedDisplay
    };
    document.getElementById('saveReview').disabled = !lastReportContext?.pillarSummary;

    resultBox.innerHTML = `
        <h2 class="overview-title">Workload overview</h2>
        <div class="overview-actions">
            <button class="btn-secondary" type="button" onclick="document.getElementById('result').style.display='none'">Continue reviewing</button>
        </div>
        <div><span class="result-key">Customer</span> ${escapeHtml(result.customerName)}</div>
        <div><span class="result-key">Reviewer</span> ${escapeHtml(result.reviewerName)}</div>
        <div><span class="result-key">Workload</span> ${escapeHtml(result.workloadName)}</div>
        <div><span class="result-key">Type</span> ${escapeHtml(result.deploymentLabel)}</div>
        <div><span class="result-key">Last updated</span> ${result.lastUpdatedDisplay}</div>
        <div><span class="result-key">Overall questions answered</span> ${result.answeredQuestions}/${result.totalQuestions}</div>
        <div><span class="result-key">Overall risks - High risk</span> <span class="risk-high">${result.highRiskCount}</span></div>
        <div><span class="result-key">Overall risks - Medium risk</span> <span class="risk-medium">${result.mediumRiskCount}</span></div>
        <div><span class="result-key">Overall risks - Low risk</span> <span class="risk-low">${result.lowRiskCount}</span></div>
        <div><span class="result-key">Review ID</span> ${result.reviewId}</div>
        <div class="assessment-item">
            <span class="result-key">Decision dashboard - ${selectedPillar ? selectedPillar.name : 'Current pillar'}</span>
            <div class="pillars-grid">
            ${pillarsDashboard.map(({ pillar, pillarSummary }) => `
                <div class="pillar">
                    <div class="pillar-head">
                        <div>
                            <div class="pillar-title">${pillar.name}</div>
                            <div class="pillar-summary">Risks: H ${pillarSummary.highRiskCount} · M ${pillarSummary.mediumRiskCount} · L ${pillarSummary.lowRiskCount}</div>
                        </div>
                        <span class="chip chip-${(pillarSummary.status || 'low').toLowerCase()}">${pillarSummary.status}</span>
                    </div>
                    <div class="top-issues pillar-summary">
                        Top improvements: ${pillarSummary.improvements.length > 0 ? pillarSummary.improvements.slice(0, 3).map(i => i.title || i.id).join(' · ') : 'None'}
                    </div>
                    ${(pillarSummary.results || []).map(qr => {
                        const groupedRisks = getGroupedRisksBySeverity(qr.risks);
                        const improvements = getPrioritizedImprovements(qr.improvements);
                        const needsReview = qr.status === 'HIGH' || qr.status === 'MEDIUM';
                        return `
                        <details class="question-toggle">
                            <summary class="question-summary-line">
                                <span><strong>${formatQuestionCode(qr.questionId)} - ${qr.questionTitle}</strong></span>
                                <span class="chip chip-${qr.status.toLowerCase()}">${qr.status}</span>
                                <span class="chip">Coverage ${qr.selectedCount}/${qr.totalOptions}</span>
                                <span class="${needsReview ? 'status-review' : 'status-good'}">${needsReview ? 'NEEDS REVIEW' : 'OK'}</span>
                            </summary>
                            <div class="section-title">Implemented controls</div>
                            <ul class="dense-list">
                                ${(qr.selectedLabels.length > 0 ? qr.selectedLabels.map(label => `<li>${label}</li>`) : ['<li>None selected</li>']).join('')}
                            </ul>
                            <div class="section-title">Risks</div>
                            <ul class="dense-list">
                                ${groupedRisks.high.map(r => `<li class="risk-high">[HIGH] ${r.reason}</li>`).join('')}
                                ${groupedRisks.medium.map(r => `<li class="risk-medium">[MEDIUM] ${r.reason}</li>`).join('')}
                                ${groupedRisks.low.map(r => `<li class="risk-low">[LOW] ${r.reason}</li>`).join('')}
                                ${(groupedRisks.high.length + groupedRisks.medium.length + groupedRisks.low.length === 0) ? '<li>No associated risks</li>' : ''}
                            </ul>
                            <div class="section-title">Improvements</div>
                            <ul class="dense-list">
                                ${improvements.map(imp => `
                                    <li>
                                        <strong>${imp.title || 'Improvement'}</strong>${imp.description ? ` - ${imp.description}` : ''}
                                    </li>
                                `).join('')}
                                ${improvements.length === 0 ? '<li>No improvement required</li>' : ''}
                            </ul>
                        </details>
                    `;
                    }).join('')}
                </div>
            `).join('')}
            </div>
        </div>
    `;
}

document.querySelectorAll('.page-tab').forEach(button => {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
});
document.getElementById('submitReview').addEventListener('click', submitReview);
document.getElementById('clearReview').addEventListener('click', clearReview);
document.querySelectorAll('input[name="deploymentType"]').forEach(input => {
    input.addEventListener('change', () => {
        persistMetaFields();
        if (currentPillarId) showPillar(currentPillarId);
    });
});
['customerName', 'reviewerName', 'workloadName'].forEach(id => {
    document.getElementById(id).addEventListener('input', persistMetaFields);
});
document.getElementById('saveReview').addEventListener('click', () => {
    if (!lastReportContext) {
        alert('Submit a review first before saving.');
        return;
    }
    saveToWiki();
});
document.getElementById('closeReview').addEventListener('click', exitToWiki);
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (!document.getElementById('saveReview').disabled) saveToWiki();
    }
});

// postMessage bridge with the wiki editor: wait for `init`, then render.
window.addEventListener('message', evt => {
    const data = evt.data;
    if (!data || typeof data !== 'object') return;
    if (data.action === 'init') doInit(data.markdown);
});

boot();
