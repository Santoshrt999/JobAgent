/**
 * "Sign in once, retry all" (audit Backlog #1).
 *
 * Auto-fill keeps one browser profile per person, so a sign-in to an
 * employer's portal lasts. Twenty Workday jobs stopped at "Needs sign-in" used
 * to show twenty identical cards; grouped by portal, the instruction becomes
 * one sign-in per employer and one button for all of that employer's jobs.
 * The button is the ordinary batch Auto-fill: it confirms first and always
 * stops before the final Submit button.
 */
import { el } from './dom.js';

/**
 * @param {Array<{host: string, company: string|null, count: number, ids: string[]}>} groups
 * @returns {HTMLElement|null}
 */
export function signInStrip(groups = []) {
  const useful = groups.filter((g) => g.count > 0);
  if (!useful.length) return null;
  const total = useful.reduce((n, g) => n + g.count, 0);
  const list = el('ul', { class: 'signin-list' });
  for (const g of useful.slice(0, 6)) {
    const who = g.company || g.host;
    list.append(el('li', { class: 'signin-row' },
      el('span', { class: 'signin-who' },
        el('b', { text: who }),
        el('span', { class: 'faint', text: ` · ${g.host}` })),
      el('button', {
        type: 'button', class: 'small', 'data-action': 'signin-retry', 'data-ids': g.ids.join(','),
        'aria-label': `Retry Auto-fill on all ${g.count} job${g.count === 1 ? '' : 's'} at ${who}`,
        text: g.count === 1 ? 'Retry' : `Retry all ${g.count}`,
      })));
  }
  return el('section', { class: 'signin-strip', 'aria-label': 'Jobs waiting for an employer sign-in' },
    el('div', { class: 'signin-head' },
      el('h3', { text: `${total} job${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} an employer sign-in` }),
      el('p', { class: 'muted', text: 'Sign in once per employer in the Auto-fill browser window (it stays open on the sign-in page), '
        + 'then retry that employer’s jobs together. The sign-in is remembered for next time.' })),
    list);
}
