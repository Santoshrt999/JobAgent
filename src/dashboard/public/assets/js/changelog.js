/** The changelog dialog: renders changelog-data.js. */

import { $, el } from './dom.js';
import { openDialog } from './dialogs.js';
import { CHANGELOG, CHANGELOG_GROUPS } from './changelog-data.js';

/** "2026-11-01" -> "1 November 2026", in the reader's own locale. */
export function longDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  // Built from parts at local noon: `new Date('2026-11-01')` is UTC midnight and
  // reads as the previous day anywhere west of Greenwich.
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The release entries as DOM, newest first. */
export function renderChangelog(releases = CHANGELOG) {
  const host = el('div', { class: 'cl' });
  for (const release of releases) {
    const section = el('section', { class: 'cl-release', 'aria-labelledby': `cl-${release.date}` });
    const heading = el('h3', { id: `cl-${release.date}` },
      el('time', { datetime: release.date, text: longDate(release.date) }));
    if (release.version) heading.append(el('span', { class: 'cl-version', text: ` · ${release.version}` }));
    section.append(heading);
    if (release.summary) section.append(el('p', { class: 'cl-summary', text: release.summary }));
    for (const [key, title] of CHANGELOG_GROUPS) {
      const items = release.groups[key] ?? [];
      if (!items.length) continue;
      const group = el('div', { class: `cl-group cl-${key}` }, el('h4', { text: title }));
      const list = el('ul');
      for (const text of items) list.append(el('li', { text }));
      group.append(list);
      section.append(group);
    }
    if (release.safety) section.append(el('p', { class: 'cl-safety', text: release.safety }));
    host.append(section);
  }
  return host;
}

export function openChangelog() {
  const body = $('changelogBody');
  body.replaceChildren(renderChangelog());
  openDialog($('dlgChangelog'));
  body.scrollTop = 0;
}
