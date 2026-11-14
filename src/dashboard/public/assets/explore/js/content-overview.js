/**
 * Explore JobAgent: the Product Overview's content, as plain data.
 *
 * No DOM access, so it can be imported by tests. Everything here describes
 * behaviour that exists in this repository; `tests/node/exploreContent.test.js`
 * compares the parts that mirror code (sources, tiers, statuses) with the code
 * itself, so this page cannot quietly drift from what the product does.
 *
 * The example posting, company and resume lines are illustrative. They are
 * labelled as such wherever they are shown.
 */

/** How finished a capability is. The four values the page distinguishes. */
export const STATUS = Object.freeze({
  shipped: { label: 'Implemented', note: 'Works out of the box, no extra setup.' },
  optional: { label: 'Optional', note: 'Built, and off until you turn it on or add a key.' },
  experimental: { label: 'Experimental', note: 'Built and tested, deliberately not offered in the dashboard.' },
  planned: { label: 'Planned', note: 'On the roadmap. Not built.' },
});

/** The illustrative posting that travels through the journey. */
export const EXAMPLE_JOB = Object.freeze({
  company: 'Northwind Analytics',
  title: 'Senior Data Engineer',
  location: 'Remote, US',
  source: 'Greenhouse',
  posted: '2 days ago',
});

/** The opening statement. The headline is the product's rule in four words. */
export const HERO = Object.freeze({
  lede: 'JobAgent finds the jobs, explains every score, tailors your resume and fills the forms, all on your own computer. You approve. You submit.',
  primary: 'See it work',
  secondary: 'Explore the architecture',
  // Three facts under the fold line. The first is counted from SOURCES where it is shown.
  proof: ['source adapters', 'Serves itself on 127.0.0.1', 'Nothing is submitted without you'],
});

/**
 * The postings floating behind the headline: one morning's worth of the boards.
 * Illustrative, like every name on this page; the first is the example posting
 * that the rest of the page follows.
 */
export const HERO_FIELD = Object.freeze([
  { title: 'Data Platform Engineer', company: 'Contoso Health', source: 'Workday' },
  { title: 'Analytics Engineer', company: 'Adventure Works', source: 'Ashby' },
  { title: 'Lead Data Engineer', company: 'Fabrikam Systems', source: 'Lever' },
  { title: 'Data Engineer', company: 'Tailspin Defense', source: 'iCIMS' },
  { title: 'Staff Data Engineer', company: 'Woodgrove Bank', source: 'Greenhouse' },
  { title: 'ML Data Engineer', company: 'Litware', source: 'SmartRecruiters' },
  { title: 'Data Engineer II', company: 'Proseware', source: 'Rippling' },
  { title: 'BI Engineer', company: 'Alpine Ski House', source: 'Lever' },
  { title: 'Senior ETL Developer', company: 'Coho Winery', source: 'Workday' },
  { title: 'Data Engineer, Payments', company: 'Wide World Importers', source: 'Ashby' },
]);

/**
 * The problem the product answers, said plainly. `lines` are lit one after
 * another as the reader scrolls; `contrast` sets JobAgent beside the two
 * things people already use, with the last line as the answer.
 */
export const PROBLEM = Object.freeze({
  lines: [
    'Job hunting is mostly retyping.',
    'The same boards every morning.',
    'The same form, again.',
    'One resume, reworded for every posting.',
  ],
  turn: 'JobAgent takes the retyping. You keep the decisions.',
  contrast: [
    { who: 'A job board', what: 'gives you a list. Everything after that is still yours to type.' },
    { who: 'An auto-apply bot', what: 'sends applications in your name that you never read.' },
    { who: 'JobAgent', what: 'prepares each application, shows its reasoning and waits for you.', ours: true },
  ],
  who: 'Built for people who apply to a lot of jobs and still want to read what goes out under their name.',
});

/**
 * The five stages of the journey, in the order work moves through them.
 * `topic` is the Technical Deep Dive section that explains the stage; `fact`
 * is the one true line printed under its stop on the route (the test checks
 * the number in Discover's against the adapter registry). `beats` are the
 * moments of the stage's scene, in the order its picture plays them, and
 * `yours` is what stays under the reader's control.
 */
export const JOURNEY = Object.freeze([
  {
    id: 'discover',
    fact: '18 source adapters',
    name: 'Discover',
    title: 'Every job board, read for you',
    body: 'One run asks every source you switched on, folds the copies of a role into one and sets aside what you ruled out. Every decision keeps its reason.',
    beats: [
      { name: 'Arrive', text: 'Postings come in from employer feeds, a cross-company search and links you paste.' },
      { name: 'Merge', text: 'The same role listed three times becomes one row.' },
      { name: 'Filter', text: 'Stale and excluded postings step back. Each keeps its reason.' },
      { name: 'Organize', text: 'What is left is one clean list, ready to score.' },
    ],
    yours: 'Which sources are on, how fresh a posting must be, what counts as a mismatch.',
    more: 'How discovery works',
    topic: 'discovery',
  },
  {
    id: 'score',
    fact: 'Every point explained',
    name: 'Score',
    title: 'A score you can read, point by point',
    body: 'No black box. The same posting and the same profile always give the same number, and every point carries its reason.',
    beats: [
      { name: 'Match', text: 'Your skills are looked up in the posting’s own words.' },
      { name: 'Weigh', text: 'Title, skills, seniority, location, freshness and sponsorship each earn points.' },
      { name: 'Decide', text: 'The total sorts the job into Priority, Apply, Queue, Near miss or Discard.' },
      { name: 'Second opinion', text: 'A rank by meaning, from text embeddings, can sit beside the score. It never changes it.', status: 'optional' },
    ],
    yours: 'The weights and thresholds live in a config file you can edit.',
    more: 'How scoring works',
    topic: 'scoring',
  },
  {
    id: 'tailor',
    fact: 'Your words, reordered',
    name: 'Tailor',
    title: 'Your resume, reordered for this job. Not rewritten.',
    body: 'A per-job copy of your master resume puts your most relevant evidence first. Nothing is added, removed or reworded.',
    beats: [
      { name: 'Read', text: 'The posting’s keywords are sorted by how much it wants them.' },
      { name: 'Reorder', text: 'Your strongest bullets and skills for this job move to the top.' },
      { name: 'Emphasize', text: 'Terms the posting asks for are set in bold, only where you already wrote them.' },
      { name: 'Report', text: 'A skill you do not have is listed as a gap. It is never added.' },
    ],
    yours: 'The master resume is opened read-only and never modified.',
    more: 'How tailoring works',
    topic: 'tailoring',
  },
  {
    id: 'fill',
    fact: 'Fields filled, files attached',
    name: 'Fill',
    title: 'It types the form. Then it stops.',
    body: 'After you approve, JobAgent opens the application in a real browser window and does the typing. The last click stays yours.',
    beats: [
      { name: 'Recognize', text: 'It scans the live form and works out what each field is.' },
      { name: 'Map', text: 'Each field is matched to your profile, your documents or an answer you saved.' },
      { name: 'Fill and check', text: 'It types, attaches, then reads each field back to confirm it.' },
      { name: 'Stop', text: 'It stops before Submit, and at once for a CAPTCHA, a login, a verification code or a bot check.' },
    ],
    yours: 'You read the form and you click Submit.',
    more: 'How autofill works',
    topic: 'autofill',
  },
  {
    id: 'track',
    fact: 'Outcomes and follow-ups',
    name: 'Track',
    title: 'What happened next, all in one place',
    body: 'Once you confirm a submission, every event is kept: outcomes, follow-up reminders and replies.',
    beats: [
      { name: 'Record', text: 'Each step lands in a history that is only ever added to.' },
      { name: 'Reply', text: 'Connect an inbox and replies are read, never changed, and suggested as outcomes.', status: 'optional' },
      { name: 'Confirm', text: 'You confirm the outcome, and the application moves to its stage.' },
    ],
    yours: 'Outcomes are recorded only when you say so.',
    more: 'How tracking works',
    topic: 'tracking',
  },
]);

/** The two points on the journey where only a person can move things forward. */
export const GATES = Object.freeze([
  { after: 'tailor', label: 'You approve', fact: 'You check the packet', detail: 'Nothing is filled until you approve the packet. If the resume, letter or your saved answers change afterwards, the approval is withdrawn.' },
  { after: 'fill', label: 'You submit', fact: 'The click is yours', detail: 'Auto-fill ends at a filled form. The final click is yours.' },
]);

/** Illustrative postings for the Discover stage, each with the outcome the pipeline would record. */
export const DISCOVER_DEMO = Object.freeze([
  { company: 'Northwind Analytics', title: 'Senior Data Engineer', meta: 'Greenhouse, Remote, 2 days ago', outcome: 'kept', label: 'Kept for scoring' },
  { company: 'Contoso Health', title: 'Data Engineer II', meta: 'Workday, listed in 3 cities', outcome: 'merged', label: '3 copies merged into 1' },
  { company: 'Fabrikam Systems', title: 'Lead Data Engineer', meta: 'Lever, posted 62 days ago', outcome: 'dropped', label: 'Set aside: older than your window' },
  { company: 'Tailspin Defense', title: 'Data Engineer', meta: 'iCIMS, active clearance required', outcome: 'excluded', label: 'Excluded: requires a security clearance' },
  { company: 'Adventure Works', title: 'Analytics Engineer', meta: 'Ashby, no posting date', outcome: 'held', label: 'Held for review: date unknown' },
]);

/**
 * Illustrative posting text for the Score stage. {Braces} mark a skill from
 * the example profile: four under the requirements and one under "nice to
 * have", which is what the Score Lab's default inputs describe (five of eight
 * skills found, one of them preferred only). Kafka is wanted and is not in
 * the profile, so it is not marked; the Tailor stage reports it as the gap.
 */
export const SCORE_EXCERPT = Object.freeze({
  requires: 'Build batch pipelines in {Spark}, orchestrate them with {Airflow}, and model marts in {dbt} and {SQL}.',
  prefers: '{Python} services, Kafka.',
  meaning: { label: 'Meaning rank', note: 'From text embeddings. Shown beside the score, never mixed into it.' },
});

/** Illustrative resume bullets for the Tailor stage. `rank` is the tailored position. */
export const TAILOR_DEMO = Object.freeze({
  wanted: ['Spark', 'Airflow', 'dbt', 'Kafka'],
  gap: 'Kafka',
  bullets: [
    { id: 'b1', rank: 3, text: 'Mentored four engineers and ran the on-call rotation.' },
    { id: 'b2', rank: 1, text: 'Rebuilt nightly batch jobs as {Spark} pipelines orchestrated in {Airflow}.' },
    { id: 'b3', rank: 4, text: 'Cut warehouse spend by retiring unused tables.' },
    { id: 'b4', rank: 2, text: 'Modelled the finance marts in {dbt} with tests on every model.' },
  ],
  skills: { master: ['SQL', 'Python', 'Power BI', 'Spark', 'Airflow', 'dbt'], tailored: ['Spark', 'Airflow', 'dbt', 'SQL', 'Python', 'Power BI'] },
});

/** Illustrative form fields for the Fill stage, in the order they are handled. */
export const FILL_DEMO = Object.freeze([
  { label: 'First name', kind: 'Text field', value: 'Jordan', from: 'Profile', state: 'filled' },
  { label: 'Email', kind: 'Email field', value: 'jordan@example.com', from: 'Profile', state: 'filled' },
  { label: 'Resume', kind: 'File upload', value: 'Northwind_Senior-Data-Engineer.pdf', from: 'Tailored for this job', state: 'filled' },
  { label: 'Will you now or in the future require sponsorship?', kind: 'Yes or no', value: 'Yes', from: 'Your saved answer', state: 'filled' },
  { label: 'Why do you want to work at Northwind?', kind: 'Long answer', value: '', from: 'No saved answer, so it asks you', state: 'ask' },
]);

/**
 * Illustrative history for the Track stage. `beat` is the moment of the scene
 * the event belongs to (see JOURNEY's track beats).
 */
export const TRACK_DEMO = Object.freeze([
  { when: 'Mon', what: 'Auto-fill stopped at Submit', who: 'JobAgent', beat: 0 },
  { when: 'Mon', what: 'You submitted and confirmed it', who: 'You', beat: 0 },
  { when: 'Mon', what: 'Follow-up reminder set', who: 'You', beat: 0 },
  { when: 'Thu', what: 'Reply read from your inbox: interview invitation', who: 'JobAgent, as a suggestion', beat: 1 },
  { when: 'Thu', what: 'Outcome recorded: Interviewing', who: 'You', beat: 2 },
]);

/** The stages an application can be recorded at, in order, and where the example ends up. */
export const TRACK_STAGES = Object.freeze({ names: ['Awaiting response', 'Interviewing', 'Offer', 'Hired'], from: 0, to: 1 });

/**
 * Under the hood, in four facts. Each restates a row of the Deep Dive's
 * technology stack (content-deep.js, STACK).
 */
export const HOOD = Object.freeze({
  title: 'Plain parts, all on your machine',
  body: 'No cloud account and no hosted service. One local process, one database file, and code you can read.',
  facts: [
    { name: 'One Node.js process', text: 'A dependency-free local server, bound to 127.0.0.1.' },
    { name: 'One SQLite file per profile', text: 'Your jobs, scores and history, with daily snapshots.' },
    { name: 'A visible Chromium window', text: 'Playwright drives the browser you watch it fill.' },
    { name: 'A Python resume engine', text: 'python-docx edits your Word file and keeps its formatting.' },
  ],
  cta: 'Explore the architecture',
});

/** What the product does on its own, and what it refuses to do. Each line is enforced in code. */
export const BOUNDARIES = Object.freeze({
  does: [
    'Runs entirely on your computer and serves its dashboard on 127.0.0.1 only.',
    'Keeps your jobs, resume, answers and history in local files and a local SQLite database.',
    'Shows the reason for every score, every discard and every stop.',
    'Builds resumes and letters only from what your master resume and profile already say.',
    'Stops and hands the browser to you the moment a page needs a human.',
  ],
  never: [
    'Submits an application without you. No command and no dashboard button does it.',
    'Solves, bypasses or works around a CAPTCHA, login, verification code or bot check.',
    'Guesses an answer to a screening question it has no saved answer for.',
    'States that you do not need sponsorship when your profile says you do.',
    'Adds a skill, number or title to your resume that is not already yours.',
    'Logs in to a job board or scrapes behind a login.',
  ],
});

/**
 * Where jobs come from. `id` is the adapter id in src/search/index.js (the test
 * checks the two lists are identical). `mode`: on = enabled in the shipped
 * config, key = needs your own API key, urls = reads only links you give it.
 */
export const SOURCE_GROUPS = Object.freeze([
  { id: 'ats', name: 'Employer ATS feeds', blurb: 'The public JSON a company’s own careers site loads. You list the boards; JobAgent reads each one.' },
  { id: 'search', name: 'Cross-company search', blurb: 'Asks a vendor’s public job search for your target titles across every employer it hosts.' },
  { id: 'careers', name: 'Company careers pages', blurb: 'Reads job links and the structured data a careers page or sitemap publishes.' },
  { id: 'aggregator', name: 'Aggregators, with your key', blurb: 'Official APIs you sign up for. Off until you add credentials.' },
  { id: 'urls', name: 'Links you supply', blurb: 'Reads the public posting at a URL you paste. No searching, no login.' },
]);

export const SOURCES = Object.freeze([
  { id: 'greenhouse', name: 'Greenhouse', group: 'ats', mode: 'on', how: 'Job Board API' },
  { id: 'lever', name: 'Lever', group: 'ats', mode: 'on', how: 'Postings API' },
  { id: 'ashby', name: 'Ashby', group: 'ats', mode: 'on', how: 'Job Posting API' },
  { id: 'smartrecruiters', name: 'SmartRecruiters', group: 'ats', mode: 'on', how: 'Posting API' },
  { id: 'workday', name: 'Workday', group: 'ats', mode: 'on', how: 'Public career-site feed' },
  { id: 'rippling', name: 'Rippling', group: 'ats', mode: 'on', how: 'Public board API' },
  { id: 'oracleRecruiting', name: 'Oracle Recruiting', group: 'ats', mode: 'on', how: 'Candidate Experience API' },
  { id: 'icims', name: 'iCIMS', group: 'ats', mode: 'on', how: 'Public career portals' },
  { id: 'amazonJobs', name: 'Amazon Jobs', group: 'ats', mode: 'on', how: 'Public search feed' },
  { id: 'atsSearch', name: 'Workable, SmartRecruiters and The Muse search', group: 'search', mode: 'on', how: 'Query by target title' },
  { id: 'careers', name: 'Careers pages and sitemaps', group: 'careers', mode: 'on', how: 'Links plus JSON-LD' },
  { id: 'adzuna', name: 'Adzuna', group: 'aggregator', mode: 'key', how: 'Official API, free developer key' },
  { id: 'apify', name: 'Apify actors', group: 'aggregator', mode: 'key', how: 'Official API, your token' },
  { id: 'manualUrls', name: 'Your links and CSV', group: 'urls', mode: 'on', how: 'Add a job by URL' },
  { id: 'genericPublicPage', name: 'Any public posting', group: 'urls', mode: 'urls', how: 'JSON-LD reader' },
  { id: 'linkedin', name: 'LinkedIn posting links', group: 'urls', mode: 'urls', how: 'Public page only' },
  { id: 'indeed', name: 'Indeed posting links', group: 'urls', mode: 'urls', how: 'Public page only' },
  { id: 'dice', name: 'Dice posting links', group: 'urls', mode: 'urls', how: 'Public page only' },
]);

export const SOURCE_MODES = Object.freeze({
  on: 'On by default',
  key: 'Needs your key',
  urls: 'Reads links you give it',
});

/**
 * The capability ledger: what is built, and how finished it is.
 * `topic` links to the Deep Dive section that explains it.
 */
export const CAPABILITIES = Object.freeze([
  { area: 'Find', name: 'Discovery from employer ATS feeds', what: 'Nine public feeds read directly, with per-host politeness limits and retries.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Cross-company title search', what: 'Searches by your target titles across employers, no key needed.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Add a job by URL', what: 'Paste any public posting; it is read, scored and tracked like the rest.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Search by job role', what: 'An ad-hoc search for a role outside your profile, kept apart from your main board.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Watch mode', what: 'Polls for new strong matches on an interval and can raise a desktop notification.', status: 'shipped', topic: 'interfaces' },
  { area: 'Find', name: 'Closed-posting sweep', what: 'Asks each ATS whether a stored posting still exists and retires the ones that do not.', status: 'shipped', topic: 'discovery' },
  { area: 'Find', name: 'Background description fetching', what: 'Reads full descriptions for postings a source listed by title only.', status: 'optional', topic: 'discovery' },
  { area: 'Find', name: 'Adzuna and Apify sources', what: 'Wider coverage through official APIs, using your own credentials.', status: 'optional', topic: 'discovery' },
  { area: 'Find', name: 'Hacker News “Who is hiring” source', what: 'A new adapter on a public API.', status: 'planned', topic: 'discovery' },

  { area: 'Match', name: 'Deterministic fit scoring', what: 'Weighted categories, tiers, and a written explanation per job.', status: 'shipped', topic: 'scoring' },
  { area: 'Match', name: 'Eligibility checks', what: 'Reads stated years, degree, licence and clearance floors and holds a job you do not meet.', status: 'shipped', topic: 'scoring' },
  { area: 'Match', name: 'Sponsorship reading', what: 'Classifies each posting as Confirmed, Likely, Unconfirmed or Denied, with the sentence that decided it.', status: 'shipped', topic: 'scoring' },
  { area: 'Match', name: 'Profiles for any profession', what: 'Search profiles built from a resume and a role-family taxonomy; several people can share one install.', status: 'shipped', topic: 'profiles' },
  { area: 'Match', name: 'Rank top matches by meaning', what: 'A second, labelled number from text embeddings. It never changes the score.', status: 'optional', topic: 'ai' },
  { area: 'Match', name: 'Weight calibration from outcomes', what: 'Proposes bounded weight changes once you have recorded enough results. You apply them.', status: 'optional', topic: 'scoring' },

  { area: 'Prepare', name: 'Resume tailoring', what: 'Reorders and emphasizes existing content in a per-job copy; produces DOCX and PDF.', status: 'shipped', topic: 'tailoring' },
  { area: 'Prepare', name: 'ATS readiness report', what: 'Keyword coverage, density band, layout problems an ATS trips on, and honest gaps.', status: 'shipped', topic: 'tailoring' },
  { area: 'Prepare', name: 'Template cover letters', what: 'Assembled from your profile and letter settings, cleaned of filler phrases.', status: 'shipped', topic: 'packets' },
  { area: 'Prepare', name: 'Document versions', what: 'Every prepared resume and letter is kept; the submitted set is frozen.', status: 'shipped', topic: 'packets' },
  { area: 'Prepare', name: 'Requirement extraction with an LLM', what: 'A model reads the posting only; every phrase must appear word for word in it.', status: 'optional', topic: 'ai' },
  { area: 'Prepare', name: 'Verified bullet rewrites', what: 'A model proposes rewordings; a deterministic verifier and then you decide.', status: 'optional', topic: 'ai' },
  { area: 'Prepare', name: 'Grounded cover letters', what: 'A model writes paragraphs that must cite your resume; unverified ones are dropped.', status: 'optional', topic: 'ai' },

  { area: 'Apply', name: 'Approval queue', what: 'Every packet waits for your approval, and the approval covers exactly what you saw.', status: 'shipped', topic: 'packets' },
  { area: 'Apply', name: 'Assisted form filling', what: 'Fills a live application in a real browser and stops before Submit.', status: 'shipped', topic: 'autofill' },
  { area: 'Apply', name: 'Answer once, reuse everywhere', what: 'A question it could not answer is queued; your answer fills every later form.', status: 'shipped', topic: 'autofill' },
  { area: 'Apply', name: 'Browser extension', what: 'Fills an approved packet in the tab you already have open. Loaded manually in Chrome or Edge.', status: 'optional', topic: 'interfaces' },
  { area: 'Apply', name: 'Final auto-submit', what: 'A server route that can click Submit under strict conditions. No dashboard button calls it, and it is refused on every ATS until one is verified live.', status: 'experimental', topic: 'autofill' },

  { area: 'Track', name: 'Applications board', what: 'Stages, outcomes, notes, follow-up reminders and conversion numbers.', status: 'shipped', topic: 'tracking' },
  { area: 'Track', name: 'Exports', what: 'CSV of every job and score, a tracker spreadsheet, and follow-ups as a calendar file.', status: 'shipped', topic: 'tracking' },
  { area: 'Track', name: 'Email replies', what: 'Reads your inbox over read-only IMAP and suggests outcomes; can draft a reply for you to send.', status: 'optional', topic: 'tracking' },
  { area: 'Track', name: 'Follow-up desktop alerts', what: 'A notification when a reminder comes due.', status: 'optional', topic: 'tracking' },
  { area: 'Track', name: 'Google Calendar sync', what: 'Writing follow-ups straight to a calendar.', status: 'planned', topic: 'tracking' },

  { area: 'Platform', name: 'Backups, export and import', what: 'Daily database snapshots and a one-file, optionally encrypted bundle of everything personal.', status: 'shipped', topic: 'data' },
  { area: 'Platform', name: 'Doctor', what: 'A preflight checklist for Node, the database, config, the resume, Python and the browser.', status: 'shipped', topic: 'interfaces' },
  { area: 'Platform', name: 'MCP server', what: 'Read access to your jobs and applications for an assistant on this computer. It cannot approve, fill or submit.', status: 'optional', topic: 'interfaces' },
  { area: 'Platform', name: 'Live run progress stream', what: 'Server-sent progress in place of polling.', status: 'planned', topic: 'interfaces' },
  { area: 'Platform', name: 'Dropped-field report on resume import', what: 'Listing what a resume import could not place.', status: 'planned', topic: 'profiles' },
]);

export const CAPABILITY_AREAS = Object.freeze(['Find', 'Match', 'Prepare', 'Apply', 'Track', 'Platform']);
