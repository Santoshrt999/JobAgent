/**
 * Reading replies (P1-7): a read-only IMAP client against a fake server, MIME
 * decoding, reply classification, matching to submitted applications, and
 * the full sync -> suggestion -> person decides flow. The fake server records
 * every command, which proves the client never writes to the mailbox.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import { ImapReadOnlyClient } from '../../src/inbox/imapClient.js';
import { bodyText, decodeWords, parseAddress, parseHeaders } from '../../src/inbox/mime.js';
import { classifyByRules, classifyReply } from '../../src/inbox/classify.js';
import { matchReply } from '../../src/inbox/match.js';
import { decideSuggestion, inboxSettings, pendingSuggestions, syncInbox } from '../../src/inbox/sync.js';
import { recordOutcome } from '../../src/dashboard/data.js';
import { startFakeImap } from './helpers/fakeImap.js';

const MESSAGES = [
  {
    uid: 11,
    header: 'From: Globex Talent <no-reply@us.greenhouse-mail.io>\nSubject: =?utf-8?B?WW91ciBhcHBsaWNhdGlvbiDigJMgR2xvYmV4?=\nMessage-ID: <m11@x>\nContent-Type: text/plain; charset=utf-8',
    body: 'Hi Test,\n\nThank you for your interest in Globex. Unfortunately, we will not be moving forward with your application at this time.\n\nBest,\nGlobex Recruiting',
  },
  {
    uid: 12,
    header: 'From: Jane at Initech <jane@initech.com>\nSubject: Next steps\nMessage-ID: <m12@x>\nContent-Type: multipart/alternative; boundary="b1"',
    body: '--b1\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nWe would love to schedule a phone screen with you. Please share your availability=\n this week.\n--b1\nContent-Type: text/html\n\n<p>ignored html</p>\n--b1--',
  },
  { uid: 13, header: 'From: news@shop.com\nSubject: Sale\nMessage-ID: <m13@x>', body: 'Big sale this weekend.' },
];

let imap;
beforeAll(async () => { imap = await startFakeImap(MESSAGES); });
afterAll(() => imap.close());

describe('read-only IMAP client', () => {
  it('reads messages, and only ever sends read-only commands', async () => {
    const c = new ImapReadOnlyClient({ host: '127.0.0.1', port: imap.port, secure: false });
    await c.connect();
    await c.login('me@example.com', 'app password');
    await c.examine('INBOX');
    expect(await c.searchSince(new Date('2026-11-01'))).toEqual([11, 12, 13]);
    const fetched = await c.fetch([11, 12]);
    expect(fetched.map((m) => m.uid)).toEqual([11, 12]);
    expect(parseHeaders(fetched[0].header).subject).toBe('Your application – Globex');
    await c.logout();
    const verbs = imap.commands.map((x) => x.split(' ').slice(0, x.startsWith('UID') ? 2 : 1).join(' '));
    expect(new Set(verbs)).toEqual(new Set(['LOGIN', 'EXAMINE', 'UID SEARCH', 'UID FETCH', 'LOGOUT']));
    expect(imap.commands.every((x) => !/\b(STORE|COPY|MOVE|APPEND|EXPUNGE|DELETE|SELECT)\b/.test(x))).toBe(true);
    expect(imap.commands.filter((x) => x.startsWith('UID FETCH')).every((x) => x.includes('BODY.PEEK['))).toBe(true);
  });

  it('refuses any write by construction', () => {
    const c = new ImapReadOnlyClient({ host: 'x' });
    for (const cmd of ['SELECT INBOX', 'UID STORE 1 +FLAGS (\\Seen)', 'UID COPY 1 Trash', 'EXPUNGE', 'APPEND INBOX {3}', 'UID FETCH 1 (BODY[])']) {
      expect(() => c.command(cmd), cmd).toThrow(/refused/);
    }
  });

  it('reports a failed login', async () => {
    const c = new ImapReadOnlyClient({ host: '127.0.0.1', port: imap.port, secure: false });
    await c.connect();
    await expect(c.login('me', 'wrong')).rejects.toThrow(/Invalid credentials/);
    await c.logout();
  });
});

describe('MIME', () => {
  it('decodes encoded words, quoted-printable multipart, and addresses', () => {
    expect(decodeWords('=?iso-8859-1?Q?Caf=E9_d=E9tails?=')).toBe('Café détails');
    const text = bodyText(MESSAGES[1].body, { contentTypeHeader: 'multipart/alternative; boundary="b1"' });
    expect(text).toContain('Please share your availability this week.');
    expect(text).not.toContain('ignored html');
    expect(bodyText(Buffer.from('SGVsbG8gdGhlcmU=').toString(), { encoding: 'base64' })).toBe('Hello there');
    expect(parseAddress('"Acme Talent" <No-Reply@Acme.com>')).toEqual({ name: 'Acme Talent', address: 'no-reply@acme.com', domain: 'acme.com' });
  });
});

describe('classifying replies', () => {
  it.each([
    ['rejection', 'Unfortunately, we have decided to move forward with other candidates.'],
    ['rejection', 'We regret to inform you that the position has been filled.'],
    ['interview', 'Could you share your availability for a phone screen next week?'],
    ['assessment', 'Please complete the HackerRank coding challenge within five days.'],
    ['offer', 'We are delighted to extend you an offer for the role.'],
    ['acknowledgement', 'Thank you for applying! We have received your application.'],
    ['unclassified', 'Our newsletter: five tips for remote work.'],
  ])('%s', (kind, body) => {
    const r = classifyByRules({ subject: '', body });
    expect(r.kind).toBe(kind);
    if (kind !== 'unclassified') expect(body.toLowerCase()).toContain(r.evidence.toLowerCase().replace(/[.!?]$/, '').slice(0, 20));
  });

  it('a polite rejection that thanks you is still a rejection', () => {
    expect(classifyByRules({ subject: '', body: MESSAGES[0].body }).kind).toBe('rejection');
  });

  it('keeps an LLM verdict only when its evidence is in the email', async () => {
    const llm = { enabled: true, provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://x/v1', timeoutMs: 500 };
    const reply = (data) => ({ fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(data) } }] }) }) });
    const message = { subject: 'Update', body: 'The hiring team chose to proceed with someone whose background fits better.' };
    const invented = await classifyReply(message, { llm, deps: reply({ kind: 'rejection', evidence: 'We are rejecting you.' }) });
    expect(invented.kind).toBe('unclassified');
    const quoted = await classifyReply(message, { llm, deps: reply({ kind: 'rejection', evidence: 'The hiring team chose to proceed with someone whose background fits better.' }) });
    expect(quoted).toMatchObject({ kind: 'rejection', method: 'llm' });
  });
});

describe('matching a reply to an application', () => {
  const jobs = [
    { id: 'g1', company: 'Globex Corporation', title: 'Data Engineer', url: 'https://boards.greenhouse.io/globex/jobs/1' },
    { id: 'i1', company: 'Initech', title: 'Analytics Engineer', url: 'https://initech.com/careers/7' },
    { id: 'h1', company: 'Hooli', title: 'Data Engineer', url: 'https://jobs.lever.co/hooli/1' },
    { id: 'h2', company: 'Hooli', title: 'Platform Engineer', url: 'https://jobs.lever.co/hooli/2' },
  ];
  it('uses the ATS sender plus the company name', () => {
    expect(matchReply({ from: { name: 'Globex Talent', domain: 'us.greenhouse-mail.io' }, subject: 'Your application', body: '' }, jobs)?.jobId).toBe('g1');
  });
  it('uses the employer domain', () => {
    expect(matchReply({ from: { name: 'Jane', domain: 'initech.com' }, subject: 'Hello', body: '' }, jobs)?.jobId).toBe('i1');
  });
  it('needs the title when one company has two applications, and refuses to guess', () => {
    expect(matchReply({ from: { name: 'Hooli', domain: 'hire.lever.co' }, subject: 'Your Platform Engineer application', body: '' }, jobs)?.jobId).toBe('h2');
    expect(matchReply({ from: { name: 'Hooli', domain: 'hire.lever.co' }, subject: 'Your application', body: '' }, jobs)).toBeNull();
    expect(matchReply({ from: { name: 'Shop', domain: 'shop.com' }, subject: 'Sale', body: '' }, jobs)).toBeNull();
  });
});

describe('sync, suggest, decide', () => {
  let db;
  const settings = { enabled: true, host: '127.0.0.1', port: 0, secure: false, user: 'me@example.com', password: 'app password', lookbackDays: 30 };
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'g1', company: 'Globex', title: 'Data Engineer', url: 'https://boards.greenhouse.io/globex/jobs/1', applied: 1, status: 'submitted', applied_at: '2026-11-01T00:00:00Z' });
    db.upsertJob({ id: 'i1', company: 'Initech', title: 'Analytics Engineer', url: 'https://initech.com/careers/7', applied: 1, status: 'submitted', applied_at: '2026-11-01T00:00:00Z' });
    db.upsertJob({ id: 'x1', company: 'Shop', title: 'Clerk', url: 'https://shop.com/jobs/1' }); // not submitted
  });

  it('suggests outcomes without storing message bodies, skips known messages, and records only on a decision', async () => {
    const stats = await syncInbox({ db, env: {}, now: new Date('2026-11-11T12:00:00Z'), deps: { inboxSettings: { ...settings, port: imap.port } } });
    expect(stats).toMatchObject({ read: 3, matched: 2, suggested: 2 });
    const pending = pendingSuggestions(db);
    expect(pending.map((s) => [s.jobId, s.kind, s.outcome])).toEqual(expect.arrayContaining([
      ['g1', 'rejection', 'rejected'], ['i1', 'interview', 'interviewing'],
    ]));
    const stored = JSON.stringify(db.listEvents());
    expect(stored).not.toContain('Globex Recruiting'); // the signature, i.e. the body, is never stored
    expect(stored).toContain('will not be moving forward'); // only the evidence sentence

    const again = await syncInbox({ db, env: {}, deps: { inboxSettings: { ...settings, port: imap.port } } });
    expect(again).toMatchObject({ suggested: 0, skippedKnown: 3 - 1 });

    const rejection = pending.find((s) => s.jobId === 'g1');
    expect(db.listEvents('g1').some((e) => e.event_type === 'application_outcome')).toBe(false);
    decideSuggestion(db, rejection.id, 'record', { recordOutcomeFn: recordOutcome, now: new Date('2026-11-11T12:00:00Z') });
    const outcome = db.listEvents('g1').find((e) => e.event_type === 'application_outcome');
    expect(JSON.parse(outcome.metadata).outcome).toBe('rejected');
    const interview = pending.find((s) => s.jobId === 'i1');
    decideSuggestion(db, interview.id, 'dismiss', { recordOutcomeFn: recordOutcome });
    expect(pendingSuggestions(db)).toEqual([]);
    expect(db.listEvents('i1').some((e) => e.event_type === 'application_outcome')).toBe(false);
  });

  it('is off until configured, and says what is missing', () => {
    expect(inboxSettings({}).reason).toMatch(/INBOX=imap/);
    expect(inboxSettings({ INBOX: 'imap' }).reason).toMatch(/INBOX_IMAP_USER/);
    expect(inboxSettings({ INBOX: 'imap', INBOX_IMAP_USER: 'me@x.com' }).reason).toMatch(/npm run secret/);
    expect(inboxSettings({ INBOX: 'imap', INBOX_IMAP_USER: 'me@x.com', INBOX_IMAP_PASSWORD: 'p' }).enabled).toBe(true);
  });
});
