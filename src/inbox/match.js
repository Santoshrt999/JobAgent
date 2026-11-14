// @ts-check
/**
 * Which submitted application is this reply about? (P1-7)
 *
 * In order: the employer's own email domain matching the posting's domain (or
 * the company name), then an applicant-tracking-system sender together with
 * the company name in the sender, subject or body. (JobAgent sends no mail, so
 * there are no message ids of ours to follow a thread by.)
 * Anything less certain stays unmatched rather than being guessed.
 */
const ATS_SENDER = /(greenhouse(-mail)?\.io|lever\.co|hire\.lever\.co|myworkday(jobs)?\.com|workday\.com|smartrecruiters\.com|ashbyhq\.com|icims\.com|jobvite\.com|taleo\.net|oraclecloud\.com|successfactors\.(com|eu)|rippling(-ats)?\.com|bamboohr\.com|workable\.com|recruitee\.com)$/i;

const COMPANY_NOISE = /\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|plc|gmbh|technologies|technology|the)\b\.?/gi;

export function companyKey(name) {
  return String(name ?? '').toLowerCase().replace(COMPANY_NOISE, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function registrable(host) {
  const parts = String(host ?? '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  return parts.slice(-2).join('.');
}

function postingDomain(url) {
  try { return registrable(new URL(url).hostname); } catch { return ''; }
}

/**
 * @param {{ from: { name: string, domain: string }, subject: string, body: string }} message
 * @param {Array<{ id: string, company: string, url: string, title?: string }>} jobs submitted applications
 * @returns {{ jobId: string, how: string }|null}
 */
export function matchReply(message, jobs) {
  const senderDomain = registrable(message.from?.domain);
  const haystack = ` ${companyKey(`${message.from?.name ?? ''} ${message.subject ?? ''} ${String(message.body ?? '').slice(0, 4000)}`)} `;
  const named = jobs.filter((j) => {
    const key = companyKey(j.company);
    return key.length >= 3 && haystack.includes(` ${key} `);
  });

  // The employer's own domain, when it is also where the posting lives.
  const byDomain = jobs.filter((j) => senderDomain && !ATS_SENDER.test(senderDomain)
    && postingDomain(j.url) === senderDomain);
  if (byDomain.length === 1) return { jobId: byDomain[0].id, how: 'sender domain matches the posting' };
  const byCompanyDomain = jobs.filter((j) => {
    const key = companyKey(j.company).replace(/\s+/g, '');
    return key.length >= 3 && senderDomain && senderDomain.split('.')[0] === key;
  });
  if (byCompanyDomain.length === 1) return { jobId: byCompanyDomain[0].id, how: 'sender domain is the company' };

  // An ATS sender: the company must be named, and only one application fits.
  if (ATS_SENDER.test(message.from?.domain ?? '') || ATS_SENDER.test(senderDomain)) {
    const companies = new Set(named.map((j) => companyKey(j.company)));
    if (companies.size === 1) {
      // Several applications at one company: the title must narrow it down.
      if (named.length === 1) return { jobId: named[0].id, how: 'hiring system email naming the company' };
      const titled = named.filter((j) => String(message.subject ?? '').toLowerCase().includes(String(j.title ?? '').toLowerCase()));
      if (titled.length === 1) return { jobId: titled[0].id, how: 'hiring system email naming the company and role' };
    }
  }
  return null;
}
