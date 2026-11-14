/** Native <dialog> open/close with per-dialog focus return, and the confirm dialog. */

import { $, el } from './dom.js';
import { jobAnchor, sheetReturnId } from './detail.js';
import { menuTrigger } from './menus.js';

/* ─────────────────────────── dialogs ─────────────────────────── */

/**
 * Where focus goes back to when each dialog closes.
 *
 * One shared variable was enough while dialogs never stacked. The detail sheet
 * now opens others on top of itself (Replace URL, I submitted it myself), and
 * the second dialog overwrote the first's return point, so closing the sheet
 * sent focus into a closed dialog. Each dialog now remembers its own.
 */
export const lastFocused = new WeakMap();

/**
 * Keep the toast area inside whichever modal dialog is on top.
 *
 * A modal <dialog> sits in the browser's top layer and makes the rest of the
 * page inert. Toasts live outside it, so while any dialog was open they drew
 * UNDER it, and their buttons ("Undo", "Switch back") could not be clicked,
 * tabbed to, or read by a screen reader — exactly when they mattered, right
 * after an action taken inside the dialog. The host is position: fixed, so
 * moving it does not move it on screen.
 */
export function placeToasts() {
  const host = $('toasts');
  if (!host) return;
  const top = [...document.querySelectorAll('dialog[open]')].at(-1);
  const parent = top ?? document.body;
  if (host.parentElement !== parent) parent.append(host);
}

export function openDialog(dialog) {
  // Opened from a menu item: that item is about to be hidden with its menu, so
  // the menu's trigger is where focus should come back to.
  const from = document.activeElement;
  const menu = from?.closest?.('.menu-pop');
  if (!dialog.open) lastFocused.set(dialog, menu ? menuTrigger(menu) ?? from : from);
  if (!dialog.open) dialog.showModal();
  placeToasts();
  // <dialog> gives us Escape, backdrop semantics, and a focus trap natively —
  // the previous hand-rolled overlays had none of those.
  // :not([hidden]) matters: focusing a hidden file input is a silent no-op that
  // leaves the caret nowhere.
  dialog.querySelector('input:not([hidden]), textarea, button.primary, button')?.focus();
}

export function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

/**
 * Dialogs that hold a form, each with a way to ask "is there typed text that
 * is not saved?". A click outside, Esc and the Close buttons all dismiss a
 * dialog, and each used to throw away whatever had been typed.
 */
const guards = new WeakMap();

export function guardDialog(dialog, isDirty) {
  if (dialog) guards.set(dialog, isDirty);
}

const hasUnsavedChanges = (dialog) => Boolean(guards.get(dialog)?.());

/**
 * Close because the PERSON asked to (Close, ×, Cancel, Esc). With unsaved text
 * that is a question, not an action. Programmatic closes after a successful
 * save keep using `closeDialog`, which never asks.
 */
export function requestClose(dialog) {
  if (!dialog?.open) return;
  if (!hasUnsavedChanges(dialog)) { dialog.close(); return; }
  confirmAction('What you typed in this window has not been saved.', () => closeDialog(dialog), {
    title: 'Discard unsaved changes?', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing',
  });
}

document.addEventListener('close', (event) => {
  const dialog = event.target;
  if (dialog.tagName !== 'DIALOG') return;
  placeToasts();
  if (dialog.id === 'dlgDetail') {
    // Back to the job the sheet showed, wherever it is on screen now (the row
    // may have been re-rendered while the sheet was open).
    (sheetReturnId && jobAnchor(sheetReturnId))?.focus();
    return;
  }
  const back = lastFocused.get(dialog);
  if (back?.isConnected) back.focus?.();
}, true);

for (const dialog of document.querySelectorAll('dialog')) {
  // Clicking the backdrop (outside the panel) closes the dialog — unless
  // something typed in it would be lost: an accidental click must not do that.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && !hasUnsavedChanges(dialog)) dialog.close();
  });
  // Esc is the browser's own close request; with unsaved text, ask instead.
  dialog.addEventListener('cancel', (event) => {
    if (!hasUnsavedChanges(dialog)) return;
    event.preventDefault();
    requestClose(dialog);
  });
}

/** What "Continue" in the confirm dialog will do; consumed exactly once. */
export let pendingConfirm = null;

/**
 * Ask before doing something. Optional: a title, the confirm button's words
 * ("Delete" says what it does; "Continue" does not), and a second choice
 * beside it (`altLabel` / `onAlt`) for questions with two real answers.
 */
export function confirmAction(message, onConfirm, { title = 'Confirm', confirmLabel = 'Continue', cancelLabel = 'Cancel', altLabel = '', onAlt = null } = {}) {
  $('dlgConfirmTitle').textContent = title;
  $('confirmGo').textContent = confirmLabel;
  $('confirmCancel').textContent = cancelLabel;
  $('confirmAlt')?.remove();
  pendingAlt = null;
  if (altLabel && onAlt) {
    pendingAlt = onAlt;
    $('confirmGo').before(el('button', { type: 'button', class: 'small', id: 'confirmAlt', 'data-action': 'confirm-alt', text: altLabel }));
  }
  $('confirmBody').textContent = '';
  for (const line of String(message).split('\n')) {
    $('confirmBody').append(el('p', { class: line.startsWith('  ') ? 'muted' : '', text: line.trim() }));
  }
  // Held in a variable rather than wired by cloning the button: the form's one
  // submit handler runs it, so Enter and a click behave identically and a
  // double submit finds nothing left to run.
  pendingConfirm = onConfirm;
  openDialog($('dlgConfirm'));
}

/** The confirm dialog's second choice; consumed exactly once. */
let pendingAlt = null;

export async function runPendingAlt() {
  const fn = pendingAlt;
  pendingAlt = null;
  pendingConfirm = null;
  closeDialog($('dlgConfirm'));
  if (fn) await fn();
}

export async function runPendingConfirm() {
  const fn = pendingConfirm;
  pendingConfirm = null;
  closeDialog($('dlgConfirm'));
  if (fn) await fn();
}
