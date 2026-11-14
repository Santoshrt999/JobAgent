/** The application profile dialog, question queue, System health and downloads. */

import { $, el, fmt, relTime, safeHref, slowProgress, toast } from './dom.js';
import { state } from './state.js';
import { api, postJson } from './api.js';
import { cssEscape } from './detail.js';
import { guardDialog, openDialog } from './dialogs.js';
import { formIsDirty, isEdited, restoreForm, saveOnlyOnPurpose, snapshotForm, withLabel } from './forms.js';
import {
  parseAnswerError, validateAnswerText, validateEmail, validatePatterns, validatePhone, validateRequired, validateYears,
} from './validate.js';
import { scheduleTodayReload, setSystemNotices } from './today.js';
import { miniTable } from './reports.js';

/* ─────────────────── application profile + question queue ─────────────────── */

// Closing this dialog with typed-but-unsaved text asks first (see dialogs.js).
guardDialog($('dlgProfile'), () => formIsDirty($('profileBody')));

/* ─────────────────── field rules: shown on leaving a box ───────────────────
   The same pattern as Add / Edit profile: a problem appears when the person
   LEAVES a box (never while they are still typing), typing only ever clears a
   problem that has been fixed, and each Save button is off while its section
   has one, with a line beside it saying why. Only boxes the person has CHANGED
   are judged: a value that was already stored is the server's business, and an
   untouched empty box must not stop someone saving the rest. */

/** Short guidance under the answers people most often get wrong. */
const ANSWER_HINTS = {
  work_authorization: 'Whether you can work in the US today, and on what basis (for example US citizen, '
    + 'green card or H-1B). Employers read it exactly as written.',
  require_sponsorship: 'Whether you will need visa sponsorship, now or later. It has to agree with the '
    + 'sponsorship setting in your search profile, or the save is refused.',
  years_experience: 'A number from 0 to 50, like 8 or 8+. Forms often put it in a number box.',
};

const joinWords = (items) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

function showError(node, message) {
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
}

/** What is wrong with one details box ('' = fine). */
function detailProblem(input) {
  const value = input.value.trim();
  if (!value) {
    // A box still resting on its template placeholder is "not answered yet", not an error.
    return input.hasAttribute('data-required') && !input.hasAttribute('data-template')
      ? validateRequired(input.dataset.label, '') : '';
  }
  if (input.dataset.kind === 'email') return validateEmail(value);
  if (input.dataset.kind === 'phone') return validatePhone(value);
  return '';
}

const detailError = (input) => $(`pf-err-${input.id.replace(/^pf-/, '')}`);

function setDetailError(input, message) {
  showError(detailError(input), message);
  input.setAttribute('aria-invalid', String(Boolean(message)));
}

/** Changed details boxes that would be refused, with their messages. */
function detailProblems() {
  return [...$('profileBody').querySelectorAll('[data-path]')]
    .filter(isEdited)
    .map((input) => ({ input, message: detailProblem(input) }))
    .filter((p) => p.message);
}

function refreshDetailsSave() {
  const button = $('saveDetailsBtn');
  if (!button) return;
  const labels = detailProblems().map((p) => p.input.dataset.label);
  button.disabled = labels.length > 0;
  showError($('saveDetailsWhy'), labels.length ? `Save is off until you fix ${joinWords(labels)}.` : '');
}

const answerRowEdited = (row) => [...row.querySelectorAll('[data-a-answer], [data-a-patterns]')].some(isEdited);

/** What is wrong with one saved-answer row ('' = fine). */
function answerProblem(row) {
  const box = row.querySelector('[data-a-answer]');
  const value = box?.value ?? '';
  const unanswered = box?.dataset.template !== undefined && !value.trim();
  if (!unanswered) {
    const message = validateAnswerText(value)
      || (row.dataset.answerId === 'years_experience' ? validateYears(value) : '');
    if (message) return message;
  }
  return validatePatterns(splitPatterns(row.querySelector('[data-a-patterns]')?.value));
}

function setAnswerError(row, message) {
  showError($(`answer-err-${row.dataset.answerId}`), message);
  row.querySelector('[data-a-answer]')?.setAttribute('aria-invalid', String(Boolean(message)));
}

/** Changed answer rows that would be refused, with their messages. */
function answerProblems({ except = null } = {}) {
  return [...$('profileBody').querySelectorAll('[data-answer-id]')]
    .filter((row) => row.dataset.answerId !== except && answerRowEdited(row))
    .map((row) => ({ row, message: answerProblem(row) }))
    .filter((p) => p.message);
}

function refreshAnswersSave() {
  const button = $('saveAnswersBtn');
  if (!button) return;
  const count = answerProblems().length;
  button.disabled = count > 0;
  showError($('saveAnswersWhy'), count ? `Save is off until you fix ${count} answer${count === 1 ? '' : 's'}.` : '');
}

/** After a rebuild: carried-over edits keep their messages, and both Save buttons are re-judged. */
function rejudgeProfileForm() {
  for (const { input, message } of detailProblems()) setDetailError(input, message);
  for (const { row, message } of answerProblems()) setAnswerError(row, message);
  refreshDetailsSave();
  refreshAnswersSave();
}

// Typing never ADDS a message; it only clears one that has been fixed.
$('profileBody').addEventListener('input', (event) => {
  const target = event.target;
  if (target.matches?.('[data-path]')) {
    if (!detailError(target)?.hidden && !detailProblem(target)) setDetailError(target, '');
    refreshDetailsSave();
    return;
  }
  const row = target.closest?.('[data-answer-id]');
  if (row) {
    const shown = $(`answer-err-${row.dataset.answerId}`);
    // A refusal from the server is about what was sent; editing that answer is
    // the fix in progress, so it goes. A local problem goes once it is fixed.
    if (shown && !shown.hidden && (shown.dataset.server || !answerProblem(row))) {
      delete shown.dataset.server;
      setAnswerError(row, '');
    }
    refreshAnswersSave();
  }
});

// A problem is shown when the person LEAVES the box.
$('profileBody').addEventListener('focusout', (event) => {
  const target = event.target;
  if (target.matches?.('[data-path]')) {
    if (isEdited(target)) setDetailError(target, detailProblem(target));
    refreshDetailsSave();
    return;
  }
  const row = target.closest?.('[data-answer-id]');
  if (row && target.matches?.('[data-a-answer], [data-a-patterns]')) {
    const shown = $(`answer-err-${row.dataset.answerId}`);
    if (answerRowEdited(row) && !shown?.dataset.server) setAnswerError(row, answerProblem(row));
    refreshAnswersSave();
  }
});

/**
 * The profile page has three commitments, so it has three save buttons: the
 * details form, one queued question at a time, and the saved-answer list. A
 * single "Save" spanning all three would leave it unclear what a click writes.
 */
export async function openProfile() {
  const body = $('profileBody');
  const stop = slowProgress(body, 'Loading your application profile…');
  profileMessage('');
  openDialog($('dlgProfile'));
  // Opening starts from what is stored: nothing typed before is still on screen.
  try { await renderProfile({ keep: false }); } finally { stop(); }
}

export function profileMessage(text, tone = 'muted') {
  const node = $('profileMsg');
  node.className = `grow-1 ${tone}`;
  node.textContent = text;
}

/**
 * Redraw the dialog from the server's copy.
 *
 * Each of the three sections saves on its own, and each save lands here. The
 * redraw used to replace everything, so text typed into a section that was NOT
 * being saved vanished (and the open "Saved answers" list snapped shut). What
 * the person has typed is carried across instead; only controls the save just
 * COMMITTED take the stored value.
 *
 * @param {object} [options]
 * @param {boolean} [options.keep=true] carry unsaved edits across (false when opening)
 * @param {string|null} [options.committed] selector for the controls this save just wrote
 */
export async function renderProfile({ keep = true, committed = null } = {}) {
  const body = $('profileBody');
  let data;
  try { data = await api('/api/profile'); }
  catch (err) {
    body.textContent = '';
    body.append(el('div', { class: 'st-blocked', text: err.message }));
    return;
  }
  state.profile = data;
  // Taken AFTER the fetch, so keystrokes made while it was in flight count too.
  const pending = keep ? snapshotForm(body, { skip: committed }) : null;
  body.textContent = '';

  if (!data.available) {
    body.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', { text: data.reason })));
    return;
  }

  // A long question queue would otherwise bury the details form under several
  // screens of scroll, which is the section most visits are actually after.
  body.append(el('nav', { class: 'pf-nav', 'aria-label': 'Profile sections' },
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'pf-jump', 'data-target': 'pfQuestions', text: `Questions (${fmt(data.questions.openCount)})` }),
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'pf-jump', 'data-target': 'pfDetails', text: 'Your details' }),
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'pf-jump', 'data-target': 'pfAnswers', text: `Saved answers (${fmt((data.screening.answers ?? []).length)})` })));

  body.append(renderQuestionQueue(data.questions));
  body.append(renderProfileFields(data.profile));
  body.append(renderSavedAnswers(data.screening));
  restoreForm(body, pending);
  rejudgeProfileForm();
  renderHealthProfileFlag();
}

/** The work: questions a real form asked that the filler could not answer. */
export function renderQuestionQueue(queue) {
  const section = el('section', { class: 'pf-section', id: 'pfQuestions' });
  section.append(el('h3', { text: `Questions to answer once (${fmt(queue.openCount)})` }));

  if (queue.error) {
    section.append(el('div', { class: 'st-blocked', text: queue.error }));
    return section;
  }
  const open = queue.open ?? [];
  if (!open.length) {
    section.append(el('p', { class: 'muted pf-q-empty' },
      'Nothing to answer. When an application form asks something your saved answers cannot cover, '
      + 'it lands here so you can answer it once instead of on every form.'));
    return section;
  }

  // Grouped by what kind of answer the question needs (see questionKind on
  // the server). Employer-specific questions are shown, never saved: a saved
  // "No" to "Have you worked for this company?" would be typed onto every
  // employer's form, including one where it is untrue.
  const general = open.filter((q) => q.kind !== 'employer' && q.kind !== 'voluntary');
  const voluntary = open.filter((q) => q.kind === 'voluntary');
  const employer = open.filter((q) => q.kind === 'employer');

  if (general.length || voluntary.length) {
    const required = queue.requiredCount ?? 0;
    section.append(el('p', { class: 'muted pf-q-intro' },
      `${required ? `Forms marked ${fmt(required)} of these as required. ` : ''}`
      + 'Answer once and every future application that asks the same thing uses your answer.'));
  }
  for (const q of general) section.append(questionCard(q));

  if (voluntary.length) {
    section.append(el('h4', { class: 'pf-q-group', text: `Voluntary self-identification (${voluntary.length})` }),
      el('p', { class: 'muted pf-q-intro', text: 'Optional on every form, and never held against you. Declining to answer is always a choice.' }));
    for (const q of voluntary) section.append(questionCard(q));
  }

  if (employer.length) {
    section.append(el('h4', { class: 'pf-q-group', text: `Depends on the employer (${employer.length})` }),
      el('p', { class: 'muted pf-q-intro', text: 'The right answer changes from one employer or posting to the next, so these are never saved. '
        + 'Auto-fill stops on them and you answer on the form.' }));
    const list = el('ul', { class: 'pf-q-employer' });
    for (const q of employer) {
      list.append(el('li', {},
        el('div', { class: 'pf-q-text', text: q.label }),
        questionMeta(q),
        el('button', {
          type: 'button', class: 'small ghost', 'data-action': 'dismiss-question', 'data-key': q.key,
          title: 'Remove it from this list. Forms that ask it still stop for your answer.', text: 'Got it',
        })));
    }
    section.append(list);
  }
  return section;
}

/** Required flag, how often and when, and the form it came from (linked). */
function questionMeta(q) {
  const meta = el('div', { class: 'pf-q-meta' });
  if (q.required) meta.append(el('span', { class: 'chip bad', text: 'Required' }));
  const when = relTime(q.lastSeenAt);
  meta.append(el('span', { class: 'faint', text: `Asked ${fmt(q.seenCount)}×${when ? `, last ${when}` : ''}` }));
  const job = (q.jobs ?? []).find((j) => j.company || j.title);
  if (job) {
    const name = [job.company, job.title].filter(Boolean).join(' · ');
    const more = (q.jobs ?? []).length > 1 ? ` and ${(q.jobs ?? []).length - 1} more` : '';
    const href = safeHref(job.url);
    meta.append(el('span', { class: 'faint pf-q-from' }, 'From ',
      href ? el('a', { href, target: '_blank', rel: 'noopener', text: name }) : el('span', { text: name }),
      more));
  }
  return meta;
}

/** One answerable question: the form's own choices as chips, or a box. */
function questionCard(q) {
  const item = el('article', { class: 'pf-q', 'aria-labelledby': `qt-${q.key}` });
  item.append(el('h5', { class: 'pf-q-text', id: `qt-${q.key}`, text: q.label }), questionMeta(q));
  if (q.note) item.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }), el('div', { text: q.note })));

  // The live form's own choices, as one-click picks. The stored value stays
  // free text; the filler maps it onto whatever the next form calls it.
  const options = (q.options ?? []).map((o) => o.label).filter(Boolean);
  const choices = options.length && options.length <= 8;
  if (choices) {
    const group = el('div', { class: 'pf-choices', role: 'group', 'aria-label': 'The form\'s choices' });
    for (const option of options) {
      group.append(el('button', {
        type: 'button', class: 'pf-choice', 'data-action': 'use-question-choice', 'aria-pressed': 'false',
        'data-key': q.key, 'data-value': option, text: option,
      }));
    }
    item.append(group);
  }
  item.append(el('label', { class: 'pf-q-label', for: `qa-${q.key}`, text: choices ? 'Or write your own answer' : 'Your answer' }));
  item.append(choices
    ? el('input', { type: 'text', id: `qa-${q.key}`, 'data-q-answer': q.key, autocomplete: 'off' })
    : el('textarea', { id: `qa-${q.key}`, rows: '2', 'data-q-answer': q.key }));

  const details = el('details', { class: 'pf-adv' });
  details.append(el('summary', { text: 'Which wordings this answer covers' }));
  details.append(el('label', { for: `qp-${q.key}`, text: 'Match a question containing any of these phrases' }));
  details.append(el('input', {
    type: 'text', id: `qp-${q.key}`, 'data-q-patterns': q.key,
    value: (q.suggestedPatterns ?? []).join(' | '),
    title: 'Separate alternatives with |. A phrase must not end in punctuation.',
  }));
  details.append(el('label', { for: `qi-${q.key}`, text: 'Id' }));
  details.append(el('input', { type: 'text', id: `qi-${q.key}`, 'data-q-id': q.key, value: q.suggestedId }));
  item.append(details);

  item.append(el('div', { class: 'pf-q-actions' },
    el('button', { type: 'button', class: 'small primary', 'data-action': 'save-question-answer', 'data-key': q.key, text: 'Save answer' }),
    el('button', {
      type: 'button', class: 'small ghost', 'data-action': 'dismiss-question', 'data-key': q.key,
      title: 'Keep it out of this list. Forms that ask it still stop for your answer.', text: 'Answer on each form',
    })));
  return item;
}

/** Who you are — the values the filler types into contact fields. */
export function renderProfileFields(profile) {
  const section = el('section', { class: 'pf-section', id: 'pfDetails' });
  section.append(el('h3', { text: 'Your details' }));

  if (profile.error) {
    section.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', { text: profile.error })));
  }
  // State what is actually true of BOTH tiers. Saying "every field has a value"
  // while three optional boxes were blank was an overclaim in exactly the place
  // the page exists to be trusted.
  const missing = profile.missing ?? [];
  const blankOptional = (profile.fields ?? []).filter((f) => !f.required && !f.filled).length;
  const optionalNote = blankOptional
    ? ` ${blankOptional} optional field(s) are blank — a form asking for one gets nothing.`
    : '';
  section.append(el('div', { class: missing.length ? 'attention' : 'evidence-note' },
    missing.length ? el('span', { class: 'mark', text: '!' }) : null,
    el('div', {}, missing.length
      ? `${missing.length} required field(s) are empty, so every application leaves them blank — `
        + `which is what turns an auto-fill run into "blocked".${optionalNote}`
      : `Every required field has a value, typed onto forms exactly as written here.${optionalNote}`)));

  section.append(el('p', { class: 'fineprint muted pf-hint', id: 'pfLegend' },
    el('span', { class: 'pf-req', 'aria-hidden': 'true', text: '* ' }),
    'Required by most application forms. Everything else is optional.'));

  const grid = el('div', { class: 'pf-grid' });
  for (const field of profile.fields ?? []) {
    const cell = el('div', { class: 'pf-cell' });
    const errorId = `pf-err-${field.field}`;
    cell.append(el('label', { for: `pf-${field.field}` },
      field.label,
      field.required
        ? el('span', { class: 'pf-req', title: 'Required by most application forms', text: ' *' })
        : el('span', { class: 'opt', text: ' (optional)' })));
    // A value that is still the shipped template text ("Your City") is not the
    // person's answer. It is shown as grey placeholder text in an EMPTY box, so
    // it reads as "fill this in" and is never submitted as if it were theirs.
    const template = field.placeholder === true;
    cell.append(el('input', {
      type: field.type === 'url' ? 'url' : 'text',
      id: `pf-${field.field}`, 'data-path': field.path,
      value: template ? '' : (field.value ?? ''),
      placeholder: template ? field.value : null,
      'data-template': template ? '' : null,
      // What the field rules above need: its name in messages, whether it is
      // required, and which format check applies.
      'data-label': field.label,
      'data-required': field.required ? '' : null,
      'data-kind': field.field,
      'aria-describedby': errorId,
      // type=email/tel would let the browser block a save with its own bubble,
      // which hides the specific message under the box. The rules live here and on the server.
      inputmode: field.type === 'tel' ? 'tel' : null,
    }));
    cell.append(el('p', { class: 'field-error', id: errorId, hidden: true }));
    if (field.hint) cell.append(el('div', { class: 'faint fineprint', text: field.hint }));
    grid.append(cell);
  }
  // A form, so Enter in any field saves — the same one-path submit the small
  // dialogs use (see the document 'submit' listener).
  const form = el('form', { class: 'pf-form', 'data-submit': 'save-profile', novalidate: true });
  form.append(grid, el('div', { class: 'row-gap' },
    el('button', {
      type: 'submit', class: 'small primary', id: 'saveDetailsBtn', text: 'Save details',
      'aria-describedby': 'saveDetailsWhy', title: 'Save (Ctrl or ⌘ + Enter)',
    }),
    el('span', { class: 'fineprint muted pf-why', id: 'saveDetailsWhy', 'aria-live': 'polite', hidden: true }),
    el('span', { class: 'faint fineprint pf-path', text: profile.path ?? '' })));
  // Enter in a box must not save half-finished work; Ctrl/Cmd+Enter does.
  saveOnlyOnPurpose(form);
  section.append(form);
  return section;
}

/** The answers already in config, editable and deletable. */
export function renderSavedAnswers(screening) {
  const section = el('section', { class: 'pf-section', id: 'pfAnswers' });
  const wrap = el('details', { class: 'pf-saved', 'data-keep': 'saved-answers' });
  wrap.append(el('summary', { text: `Saved answers (${fmt((screening.answers ?? []).length)})` }));

  if (screening.error) {
    wrap.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', { text: screening.error })));
  }

  // ANSWERS THE ACTIVE PROFILE STATES ON YOUR BEHALF.
  //
  // These are generated from the profile and take precedence over an entry of
  // the same name below, so that switching profiles cannot leave one person's
  // work authorization or pay expectation on another person's application.
  // Without showing them, editing the entry below would appear to do nothing
  // and there would be no way to find out why.
  const derived = screening.derivedAnswers ?? [];
  let overridden = new Set();
  if (derived.length) {
    const shadowed = new Set(derived.map((d) => String(d.id).toLowerCase()));
    const note = el('div', { class: 'evidence-note' });
    note.append(el('div', {}, el('b', { text: 'From your search profile. ' }),
      `${derived.length} answer(s) are filled in from the active profile and used instead of `
      + 'anything with the same name below. Change them by editing the profile.'));
    // A real definition list: these are question -> answer pairs, and a screen
    // reader should hear them as pairs rather than as one run-on line.
    const list = el('dl', { class: 'kv' });
    for (const entry of derived) {
      list.append(el('dt', { text: entry.id }));
      list.append(el('dd', { text: entry.answer }));
    }
    note.append(list);
    wrap.append(note);
    overridden = shadowed;
  }

  for (const entry of screening.answers ?? []) {
    const row = el('div', { class: 'pf-answer', 'data-answer-id': entry.id });
    // Marked from a local set rather than by tagging the entry: these objects
    // come from the cached API response, and a flag written onto them would
    // survive into later renders after the override had gone away.
    if (overridden.has(String(entry.id).toLowerCase())) {
      row.append(el('div', { class: 'muted small' },
        'Not in use — your search profile answers this one.'));
    }
    // LABELS ARE WIRED TO THEIR CONTROLS, not merely placed above them.
    //
    // These were bare <label> elements with no `for`, so a screen reader
    // announced each box as an unlabelled edit field and clicking the caption
    // did not focus anything. `id` is derived from the answer id, which is
    // already unique within the document and constrained to
    // [a-z0-9_-] by validateAnswerEntry — so it is safe in an id attribute.
    const patternsId = `answer-patterns-${entry.id}`;
    const answerId = `answer-text-${entry.id}`;
    row.append(el('div', { class: 'pf-answer-id' }, el('b', { text: entry.id })));
    row.append(el('label', { text: 'Matches questions containing', for: patternsId }));
    row.append(el('input', {
      type: 'text', id: patternsId, 'data-a-patterns': entry.id,
      value: (entry.patterns ?? []).join(' | '),
    }));
    row.append(el('label', { text: 'Answer', for: answerId }));
    if (ANSWER_HINTS[entry.id]) row.append(el('p', { class: 'fineprint muted pf-hint', text: ANSWER_HINTS[entry.id] }));
    // `text`, not `.value =`: it sets the textarea's DEFAULT value, which is how
    // the browser (and forms.js) tells "as rendered" from "edited since".
    // Template text ("YOUR total years…") is not an answer: it is shown as grey
    // placeholder text in an empty box. The original rides along in data-template
    // so an untouched box can be saved back exactly as it was stored.
    const template = entry.placeholder === true;
    row.append(el('textarea', {
      rows: '2', id: answerId, 'data-a-answer': entry.id, 'aria-describedby': `answer-err-${entry.id}`,
      ...(template ? { placeholder: entry.answer ?? '', 'data-template': entry.answer ?? '' } : { text: entry.answer ?? '' }),
    }));
    row.append(el('p', { class: 'field-error', id: `answer-err-${entry.id}`, hidden: true }));
    row.append(el('button', {
      type: 'button', class: 'small ghost', 'data-action': 'delete-answer', 'data-id': entry.id,
      text: '✕ Delete this answer',
    }));
    wrap.append(row);
  }
  wrap.append(el('div', { class: 'row-gap' },
    el('button', {
      type: 'button', class: 'small primary', 'data-action': 'save-answers', id: 'saveAnswersBtn',
      'aria-describedby': 'saveAnswersWhy', text: 'Save all answers',
    }),
    el('span', { class: 'fineprint muted pf-why', id: 'saveAnswersWhy', 'aria-live': 'polite', hidden: true }),
    el('span', { class: 'faint fineprint pf-path', text: screening.path ?? '' })));
  section.append(wrap);
  return section;
}

/** Split a "a | b | c" pattern box into trimmed alternatives. */
export const splitPatterns = (value) => String(value ?? '').split('|').map((p) => p.trim()).filter(Boolean);

export async function saveProfileDetails() {
  // Save is off while a changed box would be refused, but Ctrl+Enter or a stray
  // submit can still land here: say what is wrong and put the cursor on it.
  const problems = detailProblems();
  if (problems.length) {
    for (const { input, message } of problems) setDetailError(input, message);
    problems[0].input.focus();
    refreshDetailsSave();
    return;
  }
  const values = {};
  for (const input of $('profileBody').querySelectorAll('[data-path]')) {
    // Still showing its template placeholder and never typed in: not the
    // person's data, so it is not sent and the stored value is left alone.
    if (input.hasAttribute('data-template') && !input.value.trim()) continue;
    values[input.dataset.path] = input.value;
  }
  profileMessage('Saving…');
  try {
    const result = await withLabel($('saveDetailsBtn'), 'Saving…', () => postJson('/api/profile', { values }));
    profileMessage(result.warning ?? (result.changed.length ? 'Saved.' : 'No changes to save.'),
      result.warning ? 'st-blocked' : 'muted');
    toast(result.changed.length
      ? `Saved — ${result.changed.length} field(s) changed. New applications use these values.`
      : 'No changes to save.', 'good');
    await renderProfile({ committed: '[data-path]' });
    // A saved value can clear a template notice and turn Prepare back on.
    scheduleTodayReload();
  } catch (err) {
    profileMessage(err.message, 'st-blocked');
  }
}

export async function saveQuestionAnswer(key) {
  const body = $('profileBody');
  const answer = body.querySelector(`[data-q-answer="${cssEscape(key)}"]`)?.value ?? '';
  const patterns = splitPatterns(body.querySelector(`[data-q-patterns="${cssEscape(key)}"]`)?.value);
  const id = body.querySelector(`[data-q-id="${cssEscape(key)}"]`)?.value ?? '';
  const question = state.profile?.questions?.open?.find((q) => q.key === key)?.label ?? '';
  if (!answer.trim()) { profileMessage('Type the answer first.', 'st-blocked'); return; }

  profileMessage('Saving…');
  try {
    await postJson('/api/profile/questions/answer', { key, id, patterns, answer, question, type: 'text' });
    toast('Answered. Every future application that asks this fills it automatically.', 'good');
    profileMessage('');
    // The answered question leaves the queue; every OTHER box keeps its text.
    const k = cssEscape(key);
    await renderProfile({ committed: `[data-q-answer="${k}"], [data-q-patterns="${k}"], [data-q-id="${k}"]` });
  } catch (err) {
    profileMessage(err.message, 'st-blocked');
  }
}

export async function setQuestionStatus(key, status) {
  try {
    await postJson('/api/profile/questions/status', { key, status });
    await renderProfile();
  } catch (err) { profileMessage(err.message, 'st-blocked'); }
}

export async function saveAllAnswers({ removeId = null } = {}) {
  const body = $('profileBody');
  // Every row is sent (the save replaces the whole list), so a changed row that
  // would be refused blocks the save, a delete included: say which, and go there.
  const problems = answerProblems({ except: removeId });
  if (problems.length) {
    for (const { row, message } of problems) setAnswerError(row, message);
    problems[0].row.querySelector('[data-a-answer]')?.focus();
    refreshAnswersSave();
    profileMessage(removeId ? 'Fix the highlighted answer first; nothing was deleted.' : '', removeId ? 'st-blocked' : 'muted');
    return;
  }
  const answers = [];
  for (const row of body.querySelectorAll('[data-answer-id]')) {
    const id = row.dataset.answerId;
    if (id === removeId) continue;
    const existing = (state.profile?.screening?.answers ?? []).find((a) => a.id === id) ?? {};
    const box = row.querySelector('[data-a-answer]');
    const typed = box?.value ?? '';
    // A box still showing its template placeholder was never answered. The save
    // replaces the whole list, so that entry goes back exactly as stored; it is
    // not something the person typed.
    const unanswered = box?.dataset.template !== undefined && !typed.trim();
    answers.push({
      id,
      patterns: splitPatterns(row.querySelector('[data-a-patterns]')?.value),
      answer: unanswered ? box.dataset.template : typed,
      type: existing.type ?? 'text',
    });
  }
  profileMessage('Saving…');
  try {
    const result = await withLabel($('saveAnswersBtn'), 'Saving…', () => postJson('/api/profile/answers', {
      defaults: state.profile?.screening?.defaults ?? {},
      answers,
    }));
    const done = removeId ? `Deleted "${removeId}".` : `Saved ${result.count} answer(s).`;
    profileMessage(result.warning ?? done, result.warning ? 'st-blocked' : 'muted');
    toast(done, 'good');
    // Every answer row was just written, so those take the stored value; an
    // unsaved details edit or queued-question answer is still the person's.
    await renderProfile({ committed: '[data-a-answer], [data-a-patterns]' });
    // Work authorization and the cover letter's facts are filled from these
    // answers (src/config/answerFallbacks.js): saving one can clear the template
    // notice and turn Prepare back on, so the page must hear about it now.
    scheduleTodayReload();
  } catch (err) {
    // The server names the answer it refused (`answer "<id>": why`). Put the
    // reason ON that answer, keep what was typed, and move the cursor there.
    const refused = parseAnswerError(err.message);
    const row = refused && body.querySelector(`[data-answer-id="${cssEscape(refused.id)}"]`);
    if (row) {
      setAnswerError(row, refused.text);
      const shown = $(`answer-err-${row.dataset.answerId}`);
      if (shown) shown.dataset.server = '1';
      row.closest('details')?.setAttribute('open', '');
      row.querySelector('[data-a-answer]')?.focus();
      profileMessage(`Not saved: the "${refused.id}" answer needs a change (see the message on it).`, 'st-blocked');
    } else {
      profileMessage(err.message, 'st-blocked');
    }
  }
}

/**
 * A pill in the health strip when the profile cannot fill a form completely.
 * The number it shows is the number of rows the dialog opens on — never a
 * separate tally that could drift from it.
 */
export function renderHealthProfileFlag() {
  const host = $('health');
  host.querySelector('.stat.pf-flag')?.remove();
  const data = state.profile;
  if (!data?.available) return;
  const open = data.questions?.openCount ?? 0;
  const missing = data.profile?.missing?.length ?? 0;
  if (!open && !missing) return;
  // Each count bold inside its own words ("1 empty field"). A separate bold
  // total in front read as "1 1 empty field" — the number twice.
  const parts = [];
  if (open) parts.push([open, ` question${open === 1 ? '' : 's'}`]);
  if (missing) parts.push([missing, ` empty field${missing === 1 ? '' : 's'}`]);
  const nodes = parts.flatMap(([n, words], i) => [...(i ? [el('span', { class: 'l', text: ' · ' })] : []),
    el('b', { text: String(n) }), el('span', { class: 'l', text: words })]);
  host.append(el('button', {
    type: 'button', class: 'stat clickable attn pf-flag', 'data-action': 'open-profile',
    title: 'Open the application profile to fill these in.',
  }, ...nodes));
}

export async function loadProfileFlag() {
  try {
    state.profile = await api('/api/profile');
    renderHealthProfileFlag();
  } catch { /* the flag is an extra; never break the board over it */ }
}

export async function openHealth() {
  const body = $('healthBody');
  const stop = slowProgress(body, 'Running the system checks — config, Python, the browser…');
  openDialog($('dlgHealth'));
  let health;
  try { health = await api('/api/health'); }
  catch (err) { stop(); body.textContent = ''; body.append(el('div', { class: 'st-blocked', text: err.message })); return; }
  stop();
  // The same report feeds Today's setup checklist; keep the two in step.
  state.health = health;
  setSystemNotices(state.today?.systemNotices ?? []);

  body.textContent = '';
  const checks = Array.isArray(health.checks) ? health.checks : [];
  if (!checks.length) {
    body.append(el('pre', { text: JSON.stringify(health, null, 2) }));
    return;
  }

  const summary = health.summary ?? {};
  const overall = el('div', { class: health.ok ? 'grounded-note' : 'attention' });
  overall.append(health.ok
    ? 'All required checks pass.'
    : `${summary.fail ?? 0} check(s) need attention${summary.warn ? `, ${summary.warn} warning(s)` : ''}.`);
  body.append(overall);

  // Doctor severities: pass / warn / fail.
  const tone = { pass: 'good', warn: 'warn', fail: 'bad' };
  body.append(miniTable(['Check', 'Status', 'Detail', 'How to fix'], checks.map((c) => [
    c.label ?? c.id ?? '—',
    el('span', { class: `chip ${tone[c.status] ?? ''}`, text: c.status ?? '—' }),
    c.detail ?? '—',
    c.fix ?? '—',
  ])));
  await renderBackups(body);
  await renderLlmUsage(body);
}

/** LLM usage over the last 30 days (P3-5): tokens per task and model. */
export async function renderLlmUsage(host) {
  let usage = null;
  try { usage = await api('/api/llm-usage'); } catch { return; }
  if (!usage?.totals?.calls) return;
  const section = el('section', { 'aria-labelledby': 'llmUsageTitle' });
  section.append(el('h3', { id: 'llmUsageTitle', text: 'AI usage (last 30 days)' }));
  const t = usage.totals;
  section.append(el('p', { text: `${fmt(t.calls)} request(s), ${fmt(t.cached)} answered from the cache; `
    + `${fmt(t.inputTokens)} tokens sent and ${fmt(t.outputTokens)} received. Only counts are kept, never what was sent.` }));
  section.append(miniTable(['Task', 'Model', 'Requests', 'Tokens in', 'Tokens out'], usage.rows.map((r) => [
    r.task, `${r.model} (${r.provider})`, fmt(r.calls), fmt(r.inputTokens), fmt(r.outputTokens),
  ])));
  host.append(section);
}

/** "1.2 GB", "640 MB" — sizes for people, not bytes. */
export function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** One sentence about the backups, from GET /api/backups (P1-6). Pure. */
export function backupSummary(info) {
  if (!info?.available) return 'Backups are not available for this dashboard.';
  const count = info.backups?.length ?? 0;
  if (!count) return 'No backups yet. The first automatic backup runs a couple of minutes after JobAgent starts.';
  const newest = info.backups[0];
  const when = relTime(newest.createdAt) ?? newest.createdAt;
  return `Last backup ${when}. ${count} kept, using ${humanBytes(info.totalBytes)} in data/backups.`;
}

/** The Backups section of System health: status, Back up now, and how to export. */
export async function renderBackups(host) {
  const section = el('section', { class: 'backups', 'aria-labelledby': 'backupsTitle' });
  section.append(el('h3', { id: 'backupsTitle', text: 'Backups' }));
  let info = null;
  try { info = await api('/api/backups'); } catch { info = null; }
  if (!info) {
    section.append(el('p', { class: 'muted', text: 'Backups need a newer dashboard process. Restart JobAgent, then reopen this window.' }));
    host.append(section);
    return;
  }
  section.append(el('p', { id: 'backupStatus', role: 'status', text: backupSummary(info) }));
  if (info.lastError) section.append(el('p', { class: 'st-blocked', text: `The last backup failed: ${info.lastError}` }));
  if (info.available) {
    section.append(el('button', { type: 'button', class: 'small', 'data-action': 'backup-now', text: 'Back up now' }));
  }
  section.append(el('p', { class: 'muted', text: 'Every job list, with its decisions, notes and applications, is copied daily and checked. '
    + 'To move everything to another computer in one file, run "npm run export" in the JobAgent folder.' }));
  host.append(section);
}

/** Back up now, then refresh the sentence. */
export async function backupNow() {
  const status = $('backupStatus');
  if (status) status.textContent = 'Backing up…';
  try {
    await postJson('/api/backups');
    const info = await api('/api/backups');
    if (status) status.textContent = backupSummary(info);
    toast('Backup saved.');
  } catch (err) {
    if (status) status.textContent = err.message;
    toast(err.message, 'bad');
  }
}

export function download(path, filename) {
  return fetch(path).then(async (res) => {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = el('a', { href, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    // Revoking in the same tick can cancel the download the click just started.
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    toast(`Downloaded ${filename}`, 'good');
  }).catch((err) => toast(err.message, 'bad'));
}

// Typing your own answer un-selects a choice chip that no longer matches it.
$('profileBody')?.addEventListener('input', (event) => {
  const box = event.target.closest?.('[data-q-answer]');
  if (!box) return;
  for (const chip of box.closest('.pf-q')?.querySelectorAll('.pf-choice') ?? []) {
    chip.setAttribute('aria-pressed', String(chip.dataset.value === box.value));
  }
});
