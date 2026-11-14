/** The ACTIONS table behind every data-action, and the delegated click/submit listeners. */

import { $, el, fmt, toast, withBusy } from './dom.js';
import { state } from './state.js';
import { api, postJson } from './api.js';
import { applyFilterObject, clearFilter, filterValue, resetFilters, setFilterValue } from './filters.js';
import { loadSections, renderTabs } from './analytics.js';
import { loadBoard } from './board.js';
import { cssEscape, loadDetail, openResumePreview, renderDetail, saveNote, selectJob } from './detail.js';
import { closeDialog, openDialog, requestClose, runPendingAlt, runPendingConfirm } from './dialogs.js';
import { autofillOne, checkLink, sweepClosedPostings, fillProfileFromResume, decide, patchRow, prepareOne, runPhase, scheduleRefresh, simpleAction } from './mutations.js';
import { scheduleTodayReload, setView, todayAct } from './today.js';
import { batchApprove, batchAutofill, batchDecide, batchPrepare, clearSelection, reasonHandlers, showCompare, toggleSelect } from './selection.js';
import { openDocuments, openReports } from './reports.js';
import { openDataQuality, saveFreshness, startEnrichment, stopEnrichment, toggleEnrichment } from './dataQuality.js';
import { adoptResumeSelection, chooseResumeProfile, openMasterResume, openMergePicker, reconsiderResumeChoice, renderMasterResume, restoreMasterVersion, selectedAdoptTitles, submitMergeSelection } from './master.js';
import { backupNow, download, openHealth, openProfile, saveAllAnswers, saveProfileDetails, saveQuestionAnswer, setQuestionStatus } from './profile.js';
import { applyRunGate, openRuns, pollRun, setRunDetails } from './runs.js';
import { closeMainMenu, toggleMenu } from './menus.js';
import { applyViewPrefs, hiddenColumns, onFilterChange, savePreference, setFilterSheet, syncThemeControl } from './main.js';
import {
  closeMoveMenu, followUp, openApplicationDetail, openMoveMenu, recordOutcome, setAppsLayout, undoLastOutcome, workspaceAct,
} from './workspace.js';
import { localDay } from './detail.js';
import { openChangelog } from './changelog.js';
import { copyEmail, downloadEmailDraft, openEmailJobs, openInMailApp } from './emailJobs.js';
import { activeProfileId, addAnyway, loadProfiles, openAddProfile, openEditProfile, openRemoveProfile, removePerson, removeRole, savePerson, switchProfile } from './profiles.js';
import { rewriteActions } from './rewrites.js';
import { versionActions } from './versions.js';
import { inboxActions } from './inbox.js';
import { rerankActions } from './rerank.js';
import { LETTER_BUSY_ACTIONS, letterActions } from './letters.js';

/**
 * Which optional tools are set up (GET /api/features). Fetched once; items
 * marked data-feature stay hidden unless their tool is ready, and stay hidden
 * if the answer never comes.
 */
let features = null;
export function loadFeatures() {
  features ??= api('/api/features')
    .then((on) => {
      for (const node of document.querySelectorAll('[data-feature]')) node.hidden = !on?.[node.dataset.feature];
    })
    .catch(() => { features = null; });
  return features;
}

/* ────────────────────── event delegation ────────────────────── */

export const ACTIONS = {
  reload: () => location.reload(),
  // Grounded rewrite suggestions in a job's detail (P1-2).
  ...rewriteActions,
  // Document versions (P2-2).
  ...versionActions,
  // Email replies (P1-7).
  ...inboxActions,
  // Rank top matches by meaning (P2-1).
  ...rerankActions,
  // Your materials: master cover letter, a job's letter, resume comparison.
  ...letterActions,
  // Applications workspace. None of these approves or submits: outcomes and
  // follow-ups are validated server-side and only ever follow a submission.
  'set-apps-layout': (target) => setAppsLayout(target.dataset.layout),
  'ws-open': (target) => selectJob(target.dataset.id ?? target.closest('.ws-card')?.dataset.id, { user: true }),
  'ws-act': (target) => workspaceAct(target),
  'ws-move-menu': (target) => openMoveMenu(target),
  'ws-record': (target) => { closeMoveMenu({ returnFocus: true }); return recordOutcome(target.dataset.id, target.dataset.outcome); },
  'ws-undo-outcome': (target) => { closeMoveMenu(); return undoLastOutcome(target.dataset.id); },
  'ws-open-application': (target) => { closeMoveMenu(); return openApplicationDetail(target.dataset.id); },
  'ws-record-form': (target) => {
    const card = target.closest('.appcard');
    return recordOutcome(target.dataset.id, card.querySelector('.ap-outcome').value, {
      on: card.querySelector('.ap-on').value || null, note: card.querySelector('.ap-note').value || null,
    });
  },
  'ws-followup': (target) => followUp(target.dataset.id, target.dataset.op),
  'ws-followup-set': (target) => {
    const dueOn = target.dataset.days ? localDay(Number(target.dataset.days)) : target.closest('.appcard')?.querySelector('.ap-due')?.value;
    if (!dueOn) { toast('Pick a date for the follow-up first.', 'bad'); return undefined; }
    return followUp(target.dataset.id, 'set', { dueOn });
  },
  'cancel-run': async () => {
    try { await postJson('/api/run/cancel'); toast('Cancelling — finished work is kept.'); pollRun(); }
    catch (err) { toast(err.message, 'bad'); }
  },
  run: (target) => runPhase(target.dataset.phase),
  'toggle-run-details': () => setRunDetails($('runDetails').hidden),
  'dismiss-run': () => {
    // Remember WHICH result was dismissed, so the next run's outcome still shows.
    state.runDismissedAt = state.lastRunStatus?.finishedAt ?? null;
    setRunDetails(false);
    applyRunGate(state.lastRunStatus);
  },
  'toggle-menu': () => toggleMenu($('mainMenu')),
  'toggle-activity-menu': async () => {
    const pop = $('activityMenu');
    // Optional tools appear only once they are set up; settle that BEFORE the
    // menu opens so its items never shift under the pointer.
    if (pop.dataset.open !== 'true') await loadFeatures();
    toggleMenu(pop);
  },
  'toggle-account-menu': () => {
    toggleMenu($('accountMenu'));
    // Opened before the profile list arrived (a cold start): fetch it now.
    if (!activeProfileId()) loadProfiles();
  },
  'toggle-bulk-menu': () => toggleMenu($('bulkMenu')),
  'toggle-theme': () => {
    // The attribute is ABSENT until a theme is chosen, so it cannot be read as
    // "the current theme" — doing so made the first click compute
    // `undefined === 'light' ? … : 'light'` and set light on an already-light
    // page, i.e. the toggle did nothing the first time you pressed it. Ask the
    // stylesheet's own source of truth instead.
    const explicit = document.documentElement.dataset.theme;
    const current = explicit
      || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    savePreference('theme', next);
    syncThemeControl();
  },
  'open-keys': () => openDialog($('dlgKeys')),
  'open-changelog': openChangelog,
  'toggle-analytics': (target) => {
    const open = $('analytics').hidden;
    $('analytics').hidden = !open;
    target.setAttribute('aria-expanded', String(open));
    target.querySelector('.caret').textContent = open ? '▾' : '▸';
    savePreference('analyticsOpen', open ? '1' : '0');
    if (open) loadSections();
  },
  'toggle-breakdown': (target) => {
    // Reveals the tail that `fillBreakdown` built and hid. The rows already
    // exist, so this costs no request and cannot disagree with the summary.
    const body = target.closest('tbody');
    const open = target.getAttribute('aria-expanded') !== 'true';
    body.classList.toggle('show-tail', open);
    target.setAttribute('aria-expanded', String(open));
    target.textContent = open
      ? 'Show fewer ▴'
      : `Show all ${fmt(body.querySelectorAll('tr').length - 1)} ▾`;
  },
  'toggle-view-menu': () => toggleMenu($('viewMenu')),
  'set-density': (target) => applyViewPrefs({ density: target.dataset.density }),
  'toggle-column': (target) => {
    const set = hiddenColumns();
    const key = target.dataset.column;
    if (set.has(key)) set.delete(key); else set.add(key);
    applyViewPrefs({ hidden: set });
  },
  'open-learn': () => window.open('/learn/', '_blank', 'noopener'),
  'open-reports': openReports,
  'open-data-quality': openDataQuality,
  'save-freshness': saveFreshness,
  'toggle-enrichment': toggleEnrichment,
  'enrichment-start': startEnrichment,
  'enrichment-stop': stopEnrichment,
  'open-runs': () => { setRunDetails(false); return openRuns(); },
  'open-documents': openDocuments,
  'open-master': (target) => {
    // Never stack modals: opening this from the Resume library replaces it.
    // The job-detail sheet is the exception — it is context, not a modal task.
    closeDialog(target?.closest?.('dialog:not(#dlgDetail)'));
    openMasterResume();
  },
  'migrate-search-profile': async () => {
    try {
      const r = await postJson('/api/search-profiles/migrate', {});
      toast(r.migrated ? `Imported as profile "${r.id}".` : `Nothing to import — ${r.reason}.`, r.migrated ? 'ok' : '');
      await renderMasterResume();
    } catch (err) { toast(err.message, 'bad'); }
  },
  // One switch path for the header menu, the profile list and the resume
  // notice: it says who you now search as and offers "Switch back".
  'activate-search-profile': async (target) => {
    const id = target?.dataset?.profileId;
    if (!id || target.getAttribute('aria-checked') === 'true') return;
    try { await switchProfile(id); } catch (err) { toast(err.message, 'bad'); }
  },
  'delete-search-profile': (target) => openRemoveProfile(target?.dataset?.profileId),
  'open-add-profile': () => openAddProfile(),
  'remove-person': () => removePerson(),
  'open-edit-profile': (target) => openEditProfile(target?.dataset?.profileId).catch((err) => toast(err.message, 'bad')),
  'save-person': () => savePerson(),
  'person-add-anyway': () => addAnyway(),
  'person-use-existing': async (target) => {
    closeDialog($('dlgPerson'));
    try { await switchProfile(target.dataset.profileId); } catch (err) { toast(err.message, 'bad'); }
  },
  'person-pick-resume': () => { $('personResumeFile').value = ''; $('personResumeFile').click(); },
  'remove-role': (target) => removeRole(target.dataset.index),
  'focus-role-input': (target, event) => { if (event?.target === target) $('personRoleInput').focus(); },
  'confirm-alt': runPendingAlt,
  // Creating and activating in one step is deliberate here: the user has just
  // been shown exactly what this profile will search for and pressed the button
  // that says so. The API keeps them separable for every other caller.
  'profile-from-resume-create': () => chooseResumeProfile('create', { activate: true, seed: true }),
  'profile-from-resume-keep': () => chooseResumeProfile('keep'),
  // Merge opens the PICKER rather than submitting everything the resume
  // proposed. The button's own copy offers a choice of what to bring across,
  // and sending the full list was not that choice — it was the "create"
  // outcome with the current profile's roles left on the end.
  'profile-from-resume-merge': () => openMergePicker(),
  'confirm-merge-selection': () => submitMergeSelection(),
  'cancel-merge-selection': () => renderMasterResume(),
  'profile-from-resume-reconsider': () => reconsiderResumeChoice(),
  'adopt-resume-titles': () => adoptResumeSelection({ titles: selectedAdoptTitles() }),
  'adopt-resume-skills': async () => {
    const data = await api('/api/master-resume/suggestions').catch(() => null);
    if (data?.available) await adoptResumeSelection({ skills: data.diff.newSkills });
  },
  'preview-resume-title': () => {
    const [first] = selectedAdoptTitles();
    if (!first) { toast('Tick a title to preview.', ''); return; }
    $('jobSearchMsg').textContent = '';
    $('jobSearchInput').value = first;
    openDialog($('dlgJobSearch'));
  },
  // Carries whatever is in the board filter. The old handler blanked the
  // dialog's input every time, so the phrase you had just typed — the reason
  // you were reaching for this at all — had to be typed a second time.
  'open-job-search': (target) => openBoardSearch(target?.dataset?.query ?? $('q').value),
  'submit-job-search': () => runJobSearch(),
  'exit-role-search': () => exitRoleSearch(),
  'clear-role-search': () => clearRoleSearch(),
  'pick-master-file': () => {
    // Reset first so re-picking the SAME file still fires 'change'.
    $('masterFile').value = '';
    $('masterFile').click();
  },
  'restore-master': (target) => restoreMasterVersion(target.dataset.name),
  'open-profile': (target) => {
    closeDialog(target?.closest?.('dialog:not(#dlgDetail)'));
    openProfile();
  },
  'save-profile': saveProfileDetails,
  'save-question-answer': (target) => saveQuestionAnswer(target.dataset.key),
  'dismiss-question': (target) => setQuestionStatus(target.dataset.key, 'dismissed'),
  'use-question-choice': (target) => {
    const box = $('profileBody').querySelector(`[data-q-answer="${cssEscape(target.dataset.key)}"]`);
    if (!box) return;
    box.value = target.dataset.value;
    // One choice is the answer: show which, and keep focus on the choice so
    // the next press of Tab reaches Save.
    for (const chip of target.parentElement.querySelectorAll('.pf-choice')) chip.setAttribute('aria-pressed', String(chip === target));
  },
  'pf-jump': (target) => {
    const section = $(target.dataset.target);
    section?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // A <details> the user jumped to should not still be shut when they arrive.
    section?.querySelector('details')?.setAttribute('open', '');
  },
  'save-answers': () => saveAllAnswers(),
  'delete-answer': (target) => saveAllAnswers({ removeId: target.dataset.id }),
  'open-health': openHealth,
  'backup-now': backupNow,
  'export-jobs': () => download('/api/export/jobs.csv', 'jobagent_jobs.csv'),
  'export-tracker': () => download('/api/export/tracker.csv', 'job_tracker.csv'),
  'export-calendar': () => download('/api/calendar.ics', 'jobagent-follow-ups.ics'),
  // The cover-letter choice for one job (template instead of grounded).
  'letter-mode': async (target) => {
    await postJson(`/api/jobs/${encodeURIComponent(target.dataset.id)}/letter-mode`, { mode: target.dataset.mode });
    toast(target.dataset.mode === 'template'
      ? 'This job will use your template. Prepare it again to rebuild the letter.'
      : 'This job will have its letter written from your resume again when it is prepared.');
    // The detail rail never redraws a section that holds focus (so typing is
    // never lost); this button does, so step out, redraw, then put focus on
    // the button that replaced it.
    target.blur();
    await loadDetail(target.dataset.id);
    document.querySelector('.cl-grounding [data-action="letter-mode"]')?.focus();
  },
  'open-email-jobs': () => openEmailJobs(),
  'email-copy': () => copyEmail(),
  'email-open': () => openInMailApp(),
  'email-download': () => downloadEmailDraft(),

  'set-tab': (target) => {
    // Filters SURVIVE a tab change. They used to be wiped here for the same
    // reason a filter used to wipe the tab — to keep each badge equal to what
    // clicking it opens. The badges are now counted under the active filters,
    // so the two can coexist and "strong fits, across each stage" is one click
    // per stage instead of rebuilding the filter every time.
    state.activeTab = target.dataset.tab;
    state.page = 1;
    renderTabs();
    // A tab is a board query. The stats behind its badge did not change
    // because a different tab was clicked.
    loadBoard();
  },
  'toggle-filter-sheet': () => setFilterSheet($('filterbar').dataset.collapsed === 'true'),
  'clear-tab': () => {
    state.activeTab = 'all';
    state.page = 1;
    setView('board');
    renderTabs();
    loadBoard();
  },
  'metric-filter': (target) => {
    try { applyFilterObject(JSON.parse(target.dataset.filter)); }
    catch { /* malformed filter payload */ }
  },
  'clear-filter': (target) => {
    const id = target.dataset.filter;
    clearFilter(id);
    state.page = 1;
    loadBoard();
  },
  'reset-filters': () => resetFilters(),
  'set-posted': (target) => {
    // Clicking the active segment clears it — that IS the "any date" option, so
    // the switch needs no fourth button for "no filter".
    const next = filterValue('postedWithinHours') === target.dataset.value ? '' : target.dataset.value;
    setFilterValue('postedWithinHours', next);
    state.page = 1;
    onFilterChange();
  },
  page: (target) => {
    state.page = Math.max(1, Number(target.dataset.page) || 1);
    loadBoard();
    document.querySelector('.boardwrap')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },

  select: (target) => selectJob(target.dataset.id, { user: true }),
  // 'toggle-select' is intentionally absent: checkboxes are handled by the
  // 'change' listener below so keyboard toggling works identically, and
  // resolving to the input here still stops the row's select from firing.
  'clear-selection': clearSelection,
  'batch-autofill': () => batchAutofill(),
  'signin-retry': (target) => batchAutofill({ ids: String(target.dataset.ids ?? '').split(',').filter(Boolean) }),
  'batch-prepare': batchPrepare,
  'batch-approve': batchApprove,
  'batch-decide': (target) => batchDecide(target.dataset.decision),
  'proposal-archive': async (target) => {
    await batchDecide('archived', { ids: String(target.dataset.ids ?? '').split(',').filter(Boolean) });
    scheduleTodayReload(300);
  },
  compare: showCompare,

  decide: (target) => decide(target.dataset.id, target.dataset.decision),
  approve: (target) => simpleAction(target.dataset.id, 'approve', 'Packet approved'),
  'reject-packet': (target) => simpleAction(target.dataset.id, 'reject-packet', 'Packet rejected'),
  unapprove: (target) => simpleAction(target.dataset.id, 'unapprove', 'Approval taken back: the packet is waiting for your review again'),
  assist: (target) => simpleAction(target.dataset.id, 'assist', 'Browser opening — it stops before Submit'),
  'autofill-one': (target) => autofillOne(target.dataset.id),
  'prepare-one': (target) => prepareOne(target.dataset.id),
  'check-link': (target) => checkLink(target.dataset.id),
  'sweep-postings': () => sweepClosedPostings(),
  'fill-profile-from-resume': () => fillProfileFromResume(),
  'preview-resume': (target) => openResumePreview(target.dataset.id),
  'copy-id': (target) => copyText(target.dataset.id, 'Job id copied'),
  'save-note': () => saveNote(),

  'open-add-url': () => {
    $('addUrlInput').value = '';
    $('addUrlMsg').textContent = '';
    openDialog($('dlgAddUrl'));
  },
  'submit-add-url': submitAddUrl,
  'open-link-dialog': (target) => {
    const dialog = $('dlgLink');
    dialog.dataset.jobId = target.dataset.id;
    $('linkInput').value = state.known.get(target.dataset.id)?.url ?? '';
    $('linkMsg').textContent = '';
    openDialog(dialog);
  },
  'submit-link': submitLink,
  'open-submit-dialog': (target) => openSubmitDialog(target.dataset.id),
  'confirm-went-through': (target) => settleUnverified(target.dataset.id, true),
  'not-submitted': (target) => settleUnverified(target.dataset.id, false),
  'set-view': (target) => setView(target.dataset.view, { nav: true }),
  'today-review': (target) => selectJob(target.dataset.id, { user: true }),
  'today-act': (target) => todayAct(target),
  'today-decide': async (target) => {
    await decide(target.dataset.id, target.dataset.decision);
    scheduleTodayReload(300);
  },
  'copy-text': (target) => copyText(target.dataset.text, 'Copied'),
  'confirm-submitted': confirmSubmitted,
  'confirm-go': runPendingConfirm,
  'decision-reason': async (target) => {
    // The toast's reason row owns the request; the delegated click hands it
    // the choice, so the busy guard spans the write.
    const handler = reasonHandlers.get(target.closest('.reason-row'));
    if (!handler) return;
    try { await handler(target.dataset.reason); } catch (err) { toast(err.message, 'bad'); }
  },
  // Close, × and Cancel: the person asked, so unsaved text gets a question first.
  'close-dialog': (target) => requestClose(target.closest('dialog')),
};

/**
 * Actions that write something or start work. The dispatcher runs these
 * through `withBusy`, so each shows it is working and ignores a second press
 * until the first has settled — one list instead of a guard per handler.
 */
export const BUSY_ACTIONS = new Set([
  'cancel-run', 'run', 'migrate-search-profile', 'activate-search-profile',
  'profile-from-resume-create', 'profile-from-resume-keep', 'confirm-merge-selection',
  'profile-from-resume-reconsider', 'adopt-resume-titles', 'adopt-resume-skills',
  'restore-master', 'save-profile', 'save-question-answer', 'dismiss-question',
  'save-answers', 'delete-answer', 'backup-now',
  'propose-rewrites', 'rewrite-accept', 'rewrite-reject', 'rewrite-accept-all', 'refine-rewrites',
  'compare-versions', 'restore-version', 'letter-mode', 'inbox-sync', 'inbox-record', 'inbox-dismiss', 'inbox-draft', 'run-rerank', 'export-jobs', 'export-tracker', 'open-email-jobs', 'email-copy', 'clear-role-search',
  'batch-autofill', 'batch-prepare', 'batch-approve', 'batch-decide', 'compare', 'signin-retry', 'proposal-archive',
  'decide', 'approve', 'reject-packet', 'assist', 'autofill-one', 'prepare-one',
  'check-link', 'save-note', 'today-act', 'today-decide', 'decision-reason', 'fill-profile-from-resume', 'sweep-postings',
  'submit-add-url', 'submit-job-search', 'submit-link', 'confirm-submitted', 'confirm-go',
  'confirm-went-through', 'not-submitted',
  'ws-act', 'ws-record', 'ws-undo-outcome', 'ws-record-form', 'ws-followup', 'ws-followup-set',
  'save-person', 'confirm-alt', 'person-add-anyway', 'remove-person',
  ...LETTER_BUSY_ACTIONS,
]);

/** Run one ACTIONS entry, busy-guarded when it mutates. */
export function dispatchAction(name, target, event) {
  const action = ACTIONS[name];
  if (!action) return undefined;
  if (target.getAttribute?.('aria-busy') === 'true') return undefined;
  return BUSY_ACTIONS.has(name)
    ? withBusy(target, () => action(target, event))
    : action(target, event);
}

export function openSubmitDialog(id) {
  const dialog = $('dlgSubmit');
  dialog.dataset.jobId = id;
  const job = state.known.get(id);
  $('dlgSubmitJob').textContent = job ? `${job.company} — ${job.title}` : id;
  $('submitConf').value = '';
  $('submitNote').value = '';
  openDialog(dialog);
}

/** Clipboard, with the execCommand fallback for a non-secure context. */
export async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = el('textarea', {});
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(message);
}

export async function submitAddUrl() {
  const url = $('addUrlInput').value.trim();
  const msg = $('addUrlMsg');
  if (!url) { msg.className = 'st-blocked'; msg.textContent = 'Paste a job URL first.'; return; }
  msg.className = 'muted';
  msg.textContent = 'Reading and scoring the posting…';
  try {
    const result = await postJson('/api/add-url', { url });
    closeDialog($('dlgAddUrl'));
    toast(`Added ${result.company || 'job'} — scored ${result.score ?? '—'} (${result.tier})`, 'good');
    scheduleRefresh(0);
    if (result.id) selectJob(result.id, { user: true });
  } catch (err) {
    msg.className = 'st-blocked';
    msg.textContent = err.message;
  }
}

/**
 * Ad-hoc search of the job boards for a role the profile does not target.
 *
 * Synchronous on purpose: only the query-first sources run (Workable, Adzuna),
 * which answer in seconds. A full discovery pass spans 226 Workday tenants for
 * ~14 minutes and is driven from the Run controls instead.
 */
/**
 * Open the job-board search, seeded with the text the user already typed.
 *
 * Pre-selecting the seeded text matters: it is a starting point, not a
 * commitment. "Engineer" typed to filter the board is often too broad to send
 * to a job board, and selected text is edited by typing rather than by
 * clearing first.
 *
 * @param {string} [seed] query to prefill
 */
export function openBoardSearch(seed = '') {
  const input = $('jobSearchInput');
  $('jobSearchMsg').textContent = '';
  $('jobSearchMsg').className = 'muted';
  input.value = String(seed ?? '').trim();
  openDialog($('dlgJobSearch'));
  // After the dialog paints, or focus lands on the dialog itself.
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

/**
 * Show the escalating action only when there is something to escalate.
 *
 * An always-present button could be clicked into an empty modal, which is what
 * it used to do. Tying its existence to the query means the control appears
 * exactly when it becomes useful and cannot be pressed when it is not.
 */
export function syncBoardSearchAction() {
  const query = $('q').value.trim();
  const button = $('btnFindJobs');
  if (!button) return;
  button.hidden = query.length === 0;
  button.dataset.query = query;
  button.title = query
    ? `Ask the job boards for "${query}" — it does not have to be in your profile`
    : 'Ask the job boards for a role that is not in your profile yet';
}

export async function runJobSearch() {
  const query = $('jobSearchInput').value.trim();
  const msg = $('jobSearchMsg');
  if (!query) {
    msg.className = 'st-blocked';
    msg.textContent = 'Type a role or phrase to search for.';
    return;
  }
  msg.className = 'muted';
  msg.textContent = `Searching the job boards for "${query}"…`;
  try {
    const result = await postJson('/api/search', { query });
    const found = result.counters?.jobs_found ?? 0;
    const scored = result.counters?.jobs_scored ?? 0;
    closeDialog($('dlgJobSearch'));
    toast(
      found
        ? `Found ${fmt(found)} for "${result.query}" — ${fmt(scored)} scored, in their own list`
        : `No results for "${result.query}" from ${result.sources.join(', ')}`,
      found ? 'good' : '',
    );
    // Open the role search's OWN list. Deliberately not `$('q').value = query`:
    // that filtered the personalized board by a string, which is exactly the
    // conflation these two modes exist to prevent.
    if (found) await enterRoleSearch(result.query);
  } catch (err) {
    msg.className = 'st-blocked';
    msg.textContent = err.message;
  }
}

/**
 * Show the results of ONE role search, in place of the personalized board.
 *
 * Filters are reset because they belong to the list being left: a `fit` or
 * `sponsorship` narrowing chosen for personalized results would silently hide
 * most of a role search and make it look like it found nothing.
 *
 * @param {string} query the role that was searched for
 */
export async function enterRoleSearch(query) {
  state.discoveryMode = 'role_search';
  state.roleQuery = query;
  state.page = 1;
  state.activeTab = 'all';
  state.selected.clear();
  resetFilters({ silent: true });
  renderModeBanner();
  setView('board');
  await loadBoard();
}

/** Return to the personalized board. The role search's rows are left on disk. */
export async function exitRoleSearch() {
  state.discoveryMode = 'profile';
  state.roleQuery = null;
  state.page = 1;
  state.selected.clear();
  renderModeBanner();
  await loadBoard();
}

/** Discard one role search's rows, then go back to the personalized board. */
export async function clearRoleSearch() {
  const query = state.roleQuery;
  if (!query) return exitRoleSearch();
  try {
    const r = await api(`/api/search?query=${encodeURIComponent(query)}`, { method: 'DELETE' });
    toast(`Cleared ${fmt(r.removed ?? 0)} result${r.removed === 1 ? '' : 's'} for "${query}"`, 'good');
  } catch (err) {
    toast(err.message, 'bad');
  }
  return exitRoleSearch();
}

/** Keep the banner in step with the mode. Hidden entirely on the profile board. */
export function renderModeBanner() {
  const banner = $('modeBanner');
  if (!banner) return;
  const roleMode = state.discoveryMode === 'role_search';
  banner.hidden = !roleMode;
  document.body.dataset.discoveryMode = state.discoveryMode;
  if (roleMode) {
    $('modeBannerText').textContent = `Showing job-board results for “${state.roleQuery}”. `
      + 'These are kept separate from your personalized jobs and were not scored against your profile.';
  }
}

export async function submitLink() {
  const dialog = $('dlgLink');
  const id = dialog.dataset.jobId;
  const url = $('linkInput').value.trim();
  const msg = $('linkMsg');
  if (!url) { msg.className = 'st-blocked'; msg.textContent = 'Paste the direct application URL.'; return; }
  try {
    await postJson(`/api/jobs/${encodeURIComponent(id)}/link`, { url });
    closeDialog(dialog);
    toast('Direct application URL saved.', 'good');
    patchRow(id, { url });
    if (state.detailJob?.id === id) {
      state.detailJob = { ...state.detailJob, url };
      renderDetail(state.detailJob);
    }
    scheduleRefresh();
  } catch (err) { msg.className = 'st-blocked'; msg.textContent = err.message; }
}

/**
 * Settle an unconfirmed submission without the dialog. "I submitted it
 * myself" with no number lands here, and offering only that same button
 * again went in a circle: nothing but a confirmation number could finish it.
 * "Yes" is your confirmation; "No" takes it back to finishing it.
 */
export async function settleUnverified(id, wentThrough) {
  try {
    if (wentThrough) {
      await postJson(`/api/jobs/${encodeURIComponent(id)}/mark-submitted`, { verified: true });
      toast('Recorded as submitted.', 'good');
    } else {
      await postJson(`/api/jobs/${encodeURIComponent(id)}/not-submitted`, {});
      toast('Not counted as submitted. Finish it in the browser, then retry auto-fill or record it.');
    }
    if (state.selectedId === id) await loadDetail(id);
    scheduleRefresh(0);
  } catch (err) { toast(err.message, 'bad'); }
}

export async function confirmSubmitted() {
  const dialog = $('dlgSubmit');
  const id = dialog.dataset.jobId;
  const confirmation = $('submitConf').value.trim();
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/mark-submitted`, {
      confirmationNumber: confirmation || undefined,
      verified: Boolean(confirmation),
      note: $('submitNote').value,
    });
    closeDialog(dialog);
    toast(result.verified
      ? 'Recorded as submitted with confirmation evidence.'
      : 'Recorded as reported — pending your verification. Not counted as applied yet.',
    result.verified ? 'good' : '');
    if (state.selectedId === id) loadDetail(id);
    scheduleRefresh(0);
  } catch (err) { toast(err.message, 'bad'); }
}

document.addEventListener('click', (event) => {
  // A real link always just navigates. Rows are themselves clickable
  // (`data-action="select"`), so without this a link inside one would ALSO
  // select the row — and any future link that forgets its own `data-action`
  // would be swallowed by the row entirely. Guarding on the element clicked
  // fixes the whole class, not one instance of it.
  if (event.target.closest?.('a[href]')) return;
  const target = event.target.closest('[data-action]');
  // Any click closes an open menu except on its own trigger (which toggles) or
  // on a View-menu item — ticking two columns should not cost two round trips
  // back to the button. Choosing a header-menu item used to LEAVE it open,
  // hanging over the page behind it.
  const KEEP_MENU_OPEN = [
    'toggle-menu', 'toggle-activity-menu', 'toggle-account-menu', 'toggle-bulk-menu',
    'toggle-view-menu', 'set-density', 'toggle-column',
  ];
  if (!KEEP_MENU_OPEN.includes(target?.dataset.action)) closeMainMenu({ returnFocus: true });
  if (!$('runDetails').hidden && !$('runbox').contains(event.target)) setRunDetails(false);
  if (!target) return;
  if (!ACTIONS[target.dataset.action]) return;
  // A checkbox inside a clickable row must not also trigger row selection.
  if (target.dataset.action !== 'select') event.stopPropagation();
  if (target.tagName === 'A') return; // let real links navigate
  dispatchAction(target.dataset.action, target, event);
});

// Dialog forms: Enter in any field, or the submit button, lands here once.
// `preventDefault` keeps method="dialog" from closing the dialog before the
// request has succeeded — a failed save must leave the user's input on screen.
document.addEventListener('submit', (event) => {
  const form = event.target.closest?.('form[data-submit]');
  if (!form) return;
  event.preventDefault();
  const button = event.submitter ?? form.querySelector('[type="submit"]') ?? form;
  dispatchAction(form.dataset.submit, button, event);
});

// Checkbox changes fire on 'change', not 'click', for keyboard users.
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.dataset?.action === 'toggle-select') {
    toggleSelect(target.dataset.id, target.checked);
  }
});
