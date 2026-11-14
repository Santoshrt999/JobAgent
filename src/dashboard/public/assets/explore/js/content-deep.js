/**
 * Explore JobAgent: the Technical Deep Dive's content, as plain data.
 *
 * No DOM access. Every `files` entry is a path in this repository, and
 * `tests/node/exploreContent.test.js` fails when one of them no longer exists,
 * when LIFECYCLE drifts from src/lifecycle.js, when a CLI command listed here
 * is not in the command table, or when the score model stops agreeing with the
 * real scorer. Describe what the code does; do not describe intentions.
 */

/* ───────────────────────── system map ───────────────────────── */

/** Layers, top (closest to the person) to bottom (the outside world). */
export const ARCH_LAYERS = Object.freeze([
  { id: 'entry', name: 'Ways in', note: 'Every one of these runs on your computer.' },
  { id: 'server', name: 'Local server', note: 'One Node process, bound to 127.0.0.1.' },
  { id: 'engine', name: 'Engine', note: 'Plain modules, each testable offline.' },
  { id: 'state', name: 'Your data', note: 'Local files. Nothing is hosted.' },
  { id: 'outside', name: 'The outside world', note: 'The only places a request leaves your machine for.' },
]);

/**
 * Nodes of the system map. `talks` lists the nodes this one calls or reads,
 * which is what the diagram highlights when a node is selected.
 */
export const ARCH_NODES = Object.freeze([
  {
    id: 'launcher', layer: 'entry', name: 'Launchers',
    role: 'Double-click start for Windows, macOS and Linux.',
    detail: 'Each launcher runs `npm run app`. That validates the configuration, opens the database, finds a free port (or reuses a dashboard that is already running), starts the server and opens your browser with the access token.',
    files: ['start-job-agent.sh', 'start-job-agent.cmd', 'Start-JobAgent.ps1', 'src/cli/app.js'],
    talks: ['server'],
  },
  {
    id: 'dashboard', layer: 'entry', name: 'Dashboard',
    role: 'The browser app: Today, Jobs, Applications.',
    detail: 'Plain HTML, CSS and ES modules with no framework and no build step. It talks to the local server over JSON and is served under a Content Security Policy that forbids inline script.',
    files: ['src/dashboard/public/index.html', 'src/dashboard/public/assets/js/main.js', 'src/dashboard/public/assets/css/app.css'],
    talks: ['server'],
  },
  {
    id: 'cli', layer: 'entry', name: 'Command line',
    role: 'Every phase as a command.',
    detail: 'One command table drives dispatch and help, so a command cannot exist without being listed. No command can submit an application. Bulk commands take a cross-process run lock so the CLI and the dashboard never write the same rows at once.',
    files: ['src/index.js', 'src/cli/commands.js', 'src/cli/doctor.js', 'src/cli/watch.js', 'src/utils/runLock.js'],
    talks: ['pipeline', 'automation', 'db', 'config'],
  },
  {
    id: 'mcp', layer: 'entry', name: 'MCP server', status: 'optional',
    role: 'Read access for an assistant on this computer.',
    detail: 'Runs over stdio with no network port and exposes exactly seven tools: search jobs, get a job, list and get applications, a profile summary, add a note, record an outcome. There is no tool that approves, fills, submits or changes configuration.',
    files: ['scripts/mcpServer.mjs', 'src/mcp/server.js'],
    talks: ['db', 'tracking'],
  },
  {
    id: 'extension', layer: 'entry', name: 'Browser extension', status: 'optional',
    role: 'Fill an approved packet in the tab you have open.',
    detail: 'A Manifest V3 extension for Chrome and Edge. It asks the local server for one approved packet, authenticated with a key, and fills the current tab. It never answers work-authorization, protected-class or legal-attestation questions and always stops before Submit.',
    files: ['extension/manifest.json', 'extension/content.js', 'extension/popup.js', 'src/extension/companion.js', 'src/dashboard/routes/extensionRoutes.js'],
    talks: ['server', 'sites'],
  },

  {
    id: 'server', layer: 'server', name: 'Dashboard server',
    role: 'HTTP API, static files, schedulers.',
    detail: 'A dependency-free `node:http` server. Every request must come from a loopback host and a same-origin page, carry the access token, and (for writes) be JSON or carry a custom header, which defeats cross-site and DNS-rebinding requests. It runs one pipeline run and one auto-fill at a time and schedules the background sweeps, backups and follow-up alerts.',
    files: ['src/dashboard/server.js', 'src/dashboard/routes/jobRoutes.js', 'src/dashboard/routes/batchRoutes.js', 'src/dashboard/routes/boardRoutes.js', 'src/dashboard/data.js', 'src/dashboard/apiToken.js', 'src/dashboard/httpHelpers.js'],
    talks: ['pipeline', 'profile', 'packets', 'automation', 'tracking', 'inbox', 'llm', 'db', 'config', 'files'],
  },

  {
    id: 'pipeline', layer: 'engine', name: 'Pipeline',
    role: 'Orchestrates one run, start to finish.',
    detail: 'Search, reconcile with what is stored, freshness, exclusions, sponsorship, score, tier, persist, and (in prepare mode) build packets. Every external effect is injectable, so the whole run is tested offline. Writes are batched in transactions of 500 rows.',
    files: ['src/pipeline/index.js', 'src/outputs.js', 'src/lifecycle.js'],
    talks: ['search', 'scoring', 'packets', 'resume', 'db', 'files'],
  },
  {
    id: 'search', layer: 'engine', name: 'Search',
    role: 'Eighteen source adapters behind one shape.',
    detail: 'Each adapter returns the same normalized job. The orchestrator runs sources concurrently, limits requests per host, retries with backoff, remembers how long each source took, and never lets one failed source stop the run.',
    files: ['src/search/index.js', 'src/search/normalize.js', 'src/search/deduplicator.js', 'src/search/freshnessFilter.js', 'src/search/sources.js', 'src/search/platforms.js', 'src/utils/hostGate.js', 'src/utils/httpClient.js'],
    talks: ['boards', 'db'],
  },
  {
    id: 'scoring', layer: 'engine', name: 'Scoring',
    role: 'Deterministic fit, tiers and explanations.',
    detail: 'Exclusion rules, a sponsorship classifier, an eligibility reader, weighted category scoring and tier assignment. A fingerprint of everything that can change a verdict is stored with each score so stale scores are found and redone.',
    files: ['src/scoring/scorer.js', 'src/scoring/explainScore.js', 'src/scoring/eligibility.js', 'src/scoring/exclusionFilter.js', 'src/scoring/sponsorshipClassifier.js', 'src/scoring/fingerprint.js', 'src/scoring/jobRanking.js'],
    talks: ['profile', 'config'],
  },
  {
    id: 'profile', layer: 'engine', name: 'Profiles',
    role: 'Who is searching, and for what.',
    detail: 'A profile separates background (what your resume evidences) from search intent (what you want next). Activating a profile regenerates the three runtime config files the rest of the system reads, so no other module needs to know profiles exist. Each profile has its own database, resume and output folder.',
    files: ['src/profile/model.js', 'src/profile/store.js', 'src/profile/derive.js', 'src/profile/fromResume.js', 'src/profile/roleFamilies.js', 'src/profile/workspace.js', 'config/role_families.json'],
    talks: ['config', 'files', 'db'],
  },
  {
    id: 'resume', layer: 'engine', name: 'Resume tailoring',
    role: 'A Node runner around a Python tailor.',
    detail: 'Node spawns a Python process and exchanges one JSON message each way. The Python side uses python-docx to produce a per-job copy of the master resume by reordering and emphasizing existing content, then lints and scores it. If Python is missing, the run continues with the master resume and a warning.',
    files: ['src/resume/tailorRunner.js', 'src/resume/tailor_cli.py', 'src/resume/tailor.py', 'src/resume/jdKeywords.py', 'src/resume/atsLint.py', 'src/resume/atsReport.py', 'src/resume/validate.py', 'src/resume/chromiumPdf.js'],
    talks: ['files', 'llm'],
  },
  {
    id: 'packets', layer: 'engine', name: 'Packets and approval',
    role: 'Everything for one application, awaiting you.',
    detail: 'A packet gathers the job, score, tailored resume, cover letter, prefill plan, upload plan and detected ATS. It is never submit-ready when created. The approval queue is the single gate, and a digest of what you approved is checked again before anything is filled.',
    files: ['src/apply/applicationPacket.js', 'src/apply/approvalQueue.js', 'src/apply/approvalDigest.js', 'src/apply/coverLetter.js', 'src/apply/screeningQA.js', 'src/apply/formPrefill.js', 'src/apply/documentVersions.js'],
    talks: ['resume', 'db', 'files', 'config'],
  },
  {
    id: 'automation', layer: 'engine', name: 'Browser assist',
    role: 'Fills a live form with Playwright.',
    detail: 'Opens a visible Chromium window, checks the page for anything that needs a human, scans the real form, fills and verifies each field, uploads documents, advances through safe steps and stops before Submit. Progress is checkpointed without storing any value it typed.',
    files: ['src/automation/applyRunner.js', 'src/automation/guards.js', 'src/automation/domScanner.js', 'src/automation/fieldFiller.js', 'src/automation/navigator.js', 'src/automation/uploadRunner.js', 'src/automation/browser.js', 'src/apply/applicationState.js'],
    talks: ['packets', 'sites', 'db', 'files'],
  },
  {
    id: 'tracking', layer: 'engine', name: 'Tracking and reports',
    role: 'Statuses, outcomes, follow-ups, exports.',
    detail: 'Board status is derived from a row by pure functions. What happens after submission (interview, offer, rejection) is stored only as append-only events, so a pipeline write can never erase a hiring outcome.',
    files: ['src/domain/appStatus.js', 'src/domain/applicationOutcome.js', 'src/reports/jobTracker.js', 'src/reports/reportGenerator.js', 'src/reports/calendar.js'],
    talks: ['db', 'files'],
  },
  {
    id: 'llm', layer: 'engine', name: 'LLM assist', status: 'optional',
    role: 'Versioned, validated, cached model tasks.',
    detail: 'Off unless you turn it on. One task runner validates every reply against a JSON schema, allows a single repair attempt, caches by content hash and logs token counts only. Every task has a deterministic check on its output and a deterministic fallback.',
    files: ['src/llm/task.js', 'src/llm/client.js', 'src/llm/providers.js', 'src/llm/jdRequirements.js', 'src/llm/embeddings.js', 'src/resume/claimVerifier.js'],
    talks: ['model', 'files'],
  },
  {
    id: 'inbox', layer: 'engine', name: 'Inbox reader', status: 'optional',
    role: 'Read-only IMAP, suggestions only.',
    detail: 'A small IMAP client that can log in, open a mailbox read-only, search by date and fetch without marking mail as read. Any other command is refused before it is sent. Replies are matched to a submitted application and classified by phrase rules.',
    files: ['src/inbox/imapClient.js', 'src/inbox/sync.js', 'src/inbox/match.js', 'src/inbox/classify.js', 'src/inbox/draftReply.js'],
    talks: ['mail', 'db', 'llm'],
  },

  {
    id: 'db', layer: 'state', name: 'SQLite database',
    role: 'Jobs, runs, events, approvals.',
    detail: 'Node’s built-in `node:sqlite` in WAL mode, so there is no native module to compile. Four tables: jobs, run_log, application_events and approval_queue. Status moves made by auto-fill or by you go through one function that checks the lifecycle and records an event. A backup is taken before any schema migration.',
    files: ['src/logging/db.js', 'src/logging/backup.js', 'src/logging/bundle.js', 'src/logging/jobLogger.js'],
    talks: [],
  },
  {
    id: 'config', layer: 'state', name: 'Configuration',
    role: 'JSON files, validated on load.',
    detail: 'Profile, scoring weights, exclusions, job boards, screening answers and letter settings are JSON files checked against JSON Schemas at startup. Secrets come from the environment or the operating system’s keychain, never from a tracked file.',
    files: ['src/config/loadConfig.js', 'src/config/validateConfig.js', 'config/scoring.json', 'config/exclusions.json', 'config/jobboards.json', 'config/schemas/candidate.schema.json', 'src/utils/secretStore.js'],
    talks: [],
  },
  {
    id: 'files', layer: 'state', name: 'Documents and reports',
    role: 'Resumes, packets, exports, logs.',
    detail: 'The master resume and its history, one output folder per application with versioned documents, run reports in JSON, CSV and HTML, and structured logs with secrets redacted.',
    files: ['src/utils/outputPaths.js', 'src/apply/documentVersions.js', 'src/reports/reportGenerator.js', 'src/utils/fsSafe.js'],
    talks: [],
  },

  {
    id: 'boards', layer: 'outside', name: 'Public job boards',
    role: 'Read-only requests to public endpoints.',
    detail: 'Vendor-published feeds and public pages only. Requests identify themselves, respect per-host limits and go through a fetch that refuses private network addresses at connect time.',
    files: ['src/utils/safeFetch.js', 'src/utils/publicUrl.js', 'src/utils/rateLimiter.js', 'src/utils/retryHandler.js'],
    talks: [],
  },
  {
    id: 'sites', layer: 'outside', name: 'Application sites',
    role: 'The employer’s own form, in your browser.',
    detail: 'Reached only through a visible browser window on your machine, for a packet you approved.',
    files: ['src/automation/browser.js', 'src/apply/atsDetector.js', 'src/apply/platforms/index.js'],
    talks: [],
  },
  {
    id: 'model', layer: 'outside', name: 'Model provider', status: 'optional',
    role: 'An endpoint you choose, or a local model.',
    detail: 'Any OpenAI-compatible server, Anthropic, or a local Ollama or LM Studio server. Nothing is sent unless LLM assist is on.',
    files: ['src/llm/providers.js'],
    talks: [],
  },
  {
    id: 'mail', layer: 'outside', name: 'Your mailbox', status: 'optional',
    role: 'IMAP over TLS, read-only.',
    detail: 'Used only when the inbox reader is on. Message bodies are never stored.',
    files: ['src/inbox/imapClient.js'],
    talks: [],
  },
]);

/* ───────────────────────── stack ───────────────────────── */

export const STACK = Object.freeze([
  { part: 'Runtime', what: 'Node.js 22.13 or newer, ES modules', why: 'The first 22.x with the built-in SQLite module unflagged.', kind: 'core' },
  { part: 'Storage', what: 'SQLite through `node:sqlite`, WAL mode', why: 'No native build step and no database server.', kind: 'core' },
  { part: 'Server', what: '`node:http`, no web framework', why: 'A local cockpit needs routing and headers, not middleware.', kind: 'core' },
  { part: 'Front end', what: 'HTML, CSS and ES modules, no build step', why: 'Files are served from disk; a reload shows a change.', kind: 'core' },
  { part: 'Browser automation', what: 'Playwright (Chromium)', why: 'Drives a visible window for assisted fill; also prints PDFs.', kind: 'core' },
  { part: 'Validation', what: 'Ajv with JSON Schemas', why: 'Config files and model output are both checked against schemas.', kind: 'core' },
  { part: 'Logging', what: 'pino, with secret redaction', why: 'Structured logs plus a durable event row for every decision.', kind: 'core' },
  { part: 'Resume engine', what: 'Python 3.12 or newer with python-docx', why: 'Edits Word documents while preserving their formatting.', kind: 'core' },
  { part: 'PDF export', what: 'Word, then LibreOffice, then headless Chromium', why: 'One of the three exists on every platform.', kind: 'core' },
  { part: 'Extension', what: 'Manifest V3, Chrome and Edge', why: 'Fills the tab you already have open.', kind: 'optional' },
  { part: 'Model access', what: 'Plain fetch to an OpenAI-compatible endpoint; the Anthropic SDK; Ollama; LM Studio', why: 'Loaded only when LLM assist is on.', kind: 'optional' },
  { part: 'Assistant access', what: 'Model Context Protocol SDK over stdio', why: 'Loaded only by `npm run mcp`.', kind: 'optional' },
  { part: 'Quality', what: 'Vitest, pytest, ESLint, TypeScript `checkJs`, axe-core', why: 'Coverage thresholds and accessibility checks run in CI.', kind: 'dev' },
]);

/* ───────────────────────── one run, end to end ───────────────────────── */

export const RUN_STEPS = Object.freeze([
  {
    id: 'search', name: 'Search',
    detail: 'Every enabled source runs through its adapter, up to six sources at once and four requests in flight per host. Sources that took longest last time are started first. A failed source becomes an entry in the run’s error list; the others continue.',
    files: ['src/search/index.js', 'src/search/sourceTimings.js', 'src/utils/concurrency.js'],
  },
  {
    id: 'dedupe', name: 'De-duplicate',
    detail: 'Jobs are keyed by normalized company and title, so one role listed in many cities becomes one row, keeping the copy with the fullest description. A second key on the application URL catches cross-posts. Two genuinely different openings with the same title stay apart when their requisition ids and descriptions differ. Jobs you already applied to are suppressed.',
    files: ['src/search/deduplicator.js', 'src/utils/textNormalize.js'],
  },
  {
    id: 'fresh', name: 'Freshness',
    detail: 'Postings older than your window (24 hours, 3 days, 7 days, or no limit) are recorded as set aside rather than scored. A posting with no readable date is never mixed into fresh results; it is held for review. Jobs already on your board are exempt, so the window only governs what gets added.',
    files: ['src/search/freshnessFilter.js', 'src/config/userSettings.js'],
  },
  {
    id: 'exclude', name: 'Exclusions',
    detail: 'Hard rules remove a posting and keep the reason: an explicit sponsorship refusal (only when you may need sponsorship), an active clearance requirement, a role or employment-type mismatch, a location outside your constraints, or a posting past the retention limit.',
    files: ['src/scoring/exclusionFilter.js', 'src/scoring/searchConstraints.js', 'src/utils/sponsorshipLanguage.js'],
  },
  {
    id: 'score', name: 'Score and tier',
    detail: 'Sponsorship is classified, the posting is scored category by category, and the total is mapped to a tier. Two holds can keep a high score in Queue: the sponsorship gate and an unmet stated requirement. A posting with no description is marked as not judged instead of being given a score it cannot earn.',
    files: ['src/scoring/sponsorshipClassifier.js', 'src/scoring/scorer.js', 'src/scoring/explainScore.js'],
  },
  {
    id: 'persist', name: 'Persist',
    detail: 'Each verdict is written to the jobs table with its matched terms, gaps, explanation and scoring fingerprint. Unchanged postings scored under the same fingerprint are skipped. Postings a source has stopped listing for three complete runs are expired.',
    files: ['src/pipeline/index.js', 'src/logging/db.js', 'src/scoring/fingerprint.js'],
  },
  {
    id: 'prepare', name: 'Prepare',
    detail: 'In prepare mode, Priority and Apply jobs get a tailored resume, a cover letter and a packet, and enter the approval queue. Queue-tier jobs are prepared only when you select them. A packet is refused when the profile still holds template values or the master resume belongs to someone else.',
    files: ['src/pipeline/index.js', 'src/apply/applicationPacket.js', 'src/config/placeholders.js', 'src/profile/resumeIdentity.js'],
  },
  {
    id: 'report', name: 'Report',
    detail: 'The run writes found and queued job snapshots, a report in JSON, CSV and HTML, and a run-log row with counters for every outcome, so the numbers on the dashboard reconcile with the files.',
    files: ['src/outputs.js', 'src/reports/reportGenerator.js', 'src/utils/failureRca.js'],
  },
]);

/* ───────────────────────── feature traces ───────────────────────── */

/**
 * One trace per major feature: what the person sees, the steps the code takes,
 * and what comes out. `notes` are expandable implementation details.
 */
export const TRACES = Object.freeze([
  {
    id: 'discovery',
    title: 'Job discovery and source integrations',
    summary: 'Eighteen adapters, three kinds of source, one normalized job shape.',
    see: 'Find jobs in the header, a progress line with per-source detail, and new rows on the board.',
    output: 'Rows in the jobs table, `data/found_jobs.json`, and a run report.',
    steps: [
      { name: 'Pick sources', detail: 'Enabled sources are read from `config/jobboards.json` and sorted by priority. The registry in `sources.js` marks each adapter as discovery, URL reader or manual, so a report can never count a pasted link as discovery.', files: ['config/jobboards.json', 'src/search/sources.js', 'src/cli/sourceSelection.js'] },
      { name: 'Fetch politely', detail: 'Requests carry an identifying User-Agent and pass through a per-host gate, a rate limiter and a retry handler that honours Retry-After. Workday tenants are throttled per pod because many tenants share one.', files: ['src/utils/hostGate.js', 'src/utils/rateLimiter.js', 'src/utils/retryHandler.js', 'src/utils/httpClient.js'] },
      { name: 'Normalize', detail: 'Every adapter maps its response to the same fields: source, source job id, company, title, location, URL, description text, posted date, applicant count, employment type and raw metadata. HTML descriptions are converted to text without a DOM.', files: ['src/search/normalize.js'] },
      { name: 'Budget details', detail: 'Feeds that list titles only need a second request per job. A shared budget first reuses descriptions stored by earlier runs, then spends the remaining fetches on the titles most likely to fit.', files: ['src/search/detailBudget.js', 'src/scoring/profileFit.js'] },
      { name: 'Keep it current', detail: 'A sweep asks each ATS’s own API whether a stored posting still exists, because a closed Workday posting still answers 200 to a link check. Optional background enrichment reads descriptions for rows that were never judged.', files: ['src/search/postingLiveness.js', 'src/search/enrich.js', 'src/dashboard/linkHealth.js'] },
      { name: 'Grow coverage', detail: 'Posting URLs already in your database name the ATS board they came from. The harvester validates those coordinates against the vendor’s public API and adds them as configured sources.', files: ['src/search/sourceHarvest.js', 'src/search/platforms.js', 'scripts/harvestSources.mjs'] },
    ],
    notes: [
      { title: 'What each source kind can and cannot do', items: ['Employer ATS feeds enumerate boards you list: Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Rippling, Oracle Recruiting, iCIMS and Amazon Jobs.', 'Cross-company search asks Workable, SmartRecruiters and The Muse for your target titles across employers.', 'LinkedIn, Indeed and Dice adapters read only public posting URLs you supply. They do not search and do not log in.', 'Adzuna and Apify are official APIs that stay off until you add your own credentials.'] },
      { title: 'Ad-hoc role search', items: ['`POST /api/search` runs only the query-first adapters for a phrase you type and stores the results in a separate discovery mode, so they never mix with your profile’s board.', 'Rows that score low are kept visible in this mode, because the score reflects your profile’s vocabulary rather than the role you searched for.'] },
      { title: 'Fetching safely', items: ['`safeFetch` checks the address a hostname resolves to at connect time and refuses private, loopback and link-local ranges, which closes DNS-rebinding and server-side request forgery through a pasted URL.', 'Redirects are followed by hand so each hop is checked.'] },
    ],
  },
  {
    id: 'profiles',
    title: 'Profiles and resume parsing',
    summary: 'A resume fills in what you have done. You state what you want next.',
    see: 'Add profile, upload a resume, review the proposed search, and switch people from the Profile menu.',
    output: 'A saved profile, plus regenerated `candidate.json`, scoring categories and exclusions.',
    steps: [
      { name: 'Read the document', detail: 'A dependency-free reader opens the .docx as a ZIP, inflates `word/document.xml` and returns its text. It only reads, so a preview can never corrupt the master resume.', files: ['src/resume/docxText.js'] },
      { name: 'Extract evidence', detail: 'Deterministic text analysis splits sections and extracts roles held, years of experience, skills, seniority, education and certifications. Each finding reports what it matched. No model is involved.', files: ['src/profile/fromResume.js', 'src/resume/resumeProfile.js'] },
      { name: 'Map to role families', detail: 'Titles are matched against a taxonomy of 26 role families held as data. Every family runs through the same code, and none is a default, which is what lets one code path serve a nurse, an accountant or an engineer.', files: ['src/profile/roleFamilies.js', 'config/role_families.json'] },
      { name: 'Propose, do not assume', detail: 'Background is filled in outright. Search intent (target roles, level, locations, work mode, pay, authorization) is only proposed for you to accept or edit, because a career-changer’s resume describes the field they are leaving.', files: ['src/profile/model.js', 'src/profile/fromResume.js'] },
      { name: 'Activate', detail: 'Activation derives the runtime config: scoring categories from your titles, skills and industries, the gap vocabulary, and seniority exclusions. The result is schema-validated before it replaces a working file, written atomically, and the previous version is kept.', files: ['src/profile/derive.js', 'src/profile/store.js', 'src/config/validateConfig.js'] },
      { name: 'Isolate the workspace', detail: 'Each profile gets its own database, master resume, tracker and output folder. A new person can be seeded with postings already on the computer; only the posting’s facts are copied, never another person’s score, decision or documents.', files: ['src/profile/workspace.js', 'src/profile/seed.js'] },
    ],
    notes: [
      { title: 'Guards against applying as the wrong person', items: ['Packet preparation is refused when the master resume does not appear to belong to the active profile.', 'Template values left in a profile (a placeholder name, city or authorization answer) fail preflight and block packet preparation.', 'A packet built under one profile cannot be filled under another.'] },
      { title: 'The application profile editor', items: ['The dashboard edits only the fields the form filler uses; work history and scoring preferences pass through untouched.', 'An answer that misstates work authorization cannot be saved. The same truthfulness rules run at save time and at fill time.'] },
    ],
  },
  {
    id: 'scoring',
    title: 'Matching and deterministic scoring',
    summary: 'A weighted sum you can audit, two holds, and five tiers.',
    see: 'A score and tier on every row, and a breakdown with matched terms, gaps and reasons in the job’s detail.',
    output: 'Score 0 to 100, tier, sponsorship status, matched and missing terms, and a written explanation.',
    steps: [
      { name: 'Classify sponsorship', detail: 'The description is read for an explicit refusal first, then an un-negated affirmative phrase, then a configured likely-sponsor employer matched on whole words. The result is Denied, Confirmed, Likely or Unconfirmed, with the evidence kept.', files: ['src/scoring/sponsorshipClassifier.js', 'src/utils/sponsorshipLanguage.js'] },
      { name: 'Score categories', detail: 'Profile-derived categories (title fit, core skills, industry) award a share of their weight for the terms found. A skill named only under “nice to have” earns 30% of the credit of a required one. Structural categories cover seniority, sponsorship, location, freshness, a direct employer link and overlap with your profile’s skills.', files: ['src/scoring/scorer.js', 'src/scoring/titleMatch.js', 'src/utils/textNormalize.js'] },
      { name: 'Apply penalties', detail: 'Two factors can only subtract. Posted pay below your target costs up to 6 points. A stated floor you do not meet (years, degree, licence, clearance) costs up to 8.', files: ['src/scoring/eligibility.js', 'src/scoring/searchConstraints.js'] },
      { name: 'Normalize and tier', detail: 'Points are divided by the sum of all weights and rounded to a whole number out of 100. Thresholds in `scoring.json` map the total to Priority (85), Apply (75), Queue (60), Near miss (50) or Discard.', files: ['src/scoring/explainScore.js', 'config/scoring.json'] },
      { name: 'Hold where a person should decide', detail: 'A job that scores Apply or better is moved to Queue when you need sponsorship and the posting does not confirm it, or when a stated requirement rules you out. The explanation says which.', files: ['src/scoring/explainScore.js'] },
      { name: 'Keep verdicts honest', detail: 'A hash of the weights, thresholds, profile inputs and scorer version is stored with each score. When any of them changes, stored jobs are re-scored from their saved descriptions without touching the network.', files: ['src/scoring/fingerprint.js', 'src/pipeline/index.js'] },
    ],
    notes: [
      { title: 'How the board is ordered', items: ['Tier first, then postings from the last 24 hours, then sponsorship feasibility (skipped when you need none), then score, then direct employer links ahead of aggregators.'] },
      { title: 'How eligibility is read', items: ['Requirement clauses are separated from preferred ones before any number is read.', 'Phrases about the employer’s age (“for over 25 years”) are not requirements.', 'A range such as “3 to 5 years” states its low end as the floor.', 'A degree “or equivalent experience” is not a hard floor.', 'A gap of three or more years is ineligible; one or two is a stretch.'] },
      { title: 'Calibration is a proposal', items: ['`npm run scoring:calibrate` compares category points between applications that reached an interview and those that did not.', 'It refuses with fewer than 30 recorded outcomes or fewer than 5 on either side, moves a weight only when a bootstrap interval excludes zero, caps each change at 20%, and preserves the total.', 'It writes a report. Nothing changes until you run it with `--apply`.'] },
    ],
  },
  {
    id: 'ai',
    title: 'The optional AI layer',
    summary: 'Models may read and propose. Deterministic code decides what is kept.',
    see: 'Nothing, until you set `LLM_ASSIST=on`. Then: suggested rewrites to accept or reject, grounded letters, reply suggestions.',
    output: 'Validated JSON that has passed a deterministic check, or the deterministic fallback.',
    status: 'optional',
    steps: [
      { name: 'Run a task', detail: 'Each task has a name, a version, a JSON schema and its own post-validation. The runner answers from an on-disk cache when the same provider, model, task version and input were seen before.', files: ['src/llm/task.js', 'src/llm/client.js'] },
      { name: 'Call a provider', detail: 'One interface over an OpenAI-compatible endpoint, Anthropic, Ollama and LM Studio, with a hard timeout, a token ceiling, bounded retries and structured output where the provider supports it.', files: ['src/llm/providers.js'] },
      { name: 'Validate and repair', detail: 'The reply is parsed and validated with Ajv. On failure the model gets one repair attempt with the exact errors. Still invalid means the caller uses its deterministic path. Nothing invalid is cached.', files: ['src/llm/task.js'] },
      { name: 'Ground the result', detail: 'Extracted requirements must appear word for word in the posting. Rewrites and letter paragraphs go through the claim verifier: every number, named thing and ownership verb must be backed by the resume units the model cited, never by the posting.', files: ['src/llm/jdRequirements.js', 'src/resume/claimVerifier.js', 'src/resume/rewrites.js', 'src/apply/groundedLetter.js'] },
      { name: 'Ask the person', detail: 'A verified rewrite is shown beside the original for you to accept or reject. A refused one is shown with the reason and cannot be accepted. Accepting a rewrite after approval sends the packet back for review.', files: ['src/resume/rewrites.js', 'src/dashboard/public/assets/js/rewrites.js'] },
    ],
    notes: [
      { title: 'The six tasks', items: ['`jd-requirements`: reads a posting and lists requirement phrases. Only the public posting is sent.', '`rewrite-bullets` and `refine`: propose rewordings of your own bullets (needs `RESUME_REWRITE=suggest`).', '`cover-letter`: writes two to four cited paragraphs (needs `COVER_LETTER_MODE=grounded`).', '`classify-reply`: asked only about emails the phrase rules could not classify; its quoted evidence must appear in the message.', '`draft-reply`: drafts a reply for you to copy or download. It is never sent.'] },
      { title: 'Rank by meaning', items: ['With `RERANK=on` and an embedding model, the top matches get a second number: cosine similarity between the posting and your resume bullets, with the three closest bullets as the reason.', 'It is stored in a separate file and never changes a score, a tier or a gate.'] },
      { title: 'Cost and privacy', items: ['Usage is logged as token counts per task and model, never prompts or answers.', 'Text from a posting is wrapped as untrusted input so instructions inside it are not followed.'] },
    ],
  },
  {
    id: 'tailoring',
    title: 'Resume tailoring',
    summary: 'A permutation of your own content, checked before it is used.',
    see: 'A tailored resume preview, a keyword readout and an ATS report in the job’s detail.',
    output: 'A per-job .docx and .pdf, a keyword audit, an ATS score and band, and any warnings.',
    steps: [
      { name: 'Choose the terms', detail: 'Keywords come from your scoring vocabulary (plus verified LLM requirements when that is on). They are tiered: a term in the title, repeated, or under a Required heading outranks one mentioned once under nice-to-have.', files: ['src/resume/jdKeywords.py', 'src/resume/tailorRunner.js'] },
      { name: 'Cross the process boundary', detail: 'Node spawns Python with UTF-8 forced on both pipes and sends one JSON request on stdin. A timeout kills the whole process tree. The master resume is opened read-only.', files: ['src/resume/tailorRunner.js', 'src/resume/pythonEnv.js', 'src/resume/tailor_cli.py'] },
      { name: 'Reorder', detail: 'Summary paragraphs and bullets move within their own section and role so supported required content comes first. Comma-separated skill lists are reordered with bracket-aware splitting, so “Dimensional Modeling (Kimball, Inmon)” moves as one item.', files: ['src/resume/tailor.py'] },
      { name: 'Emphasize', detail: 'A matched keyword is bolded where your resume already uses it, by splitting the text run so only the phrase is bold. The number of emphasized terms is capped. An optional line lists terms that are both requested and already present; it is the only new sentence, and it passes through the humanizer.', files: ['src/resume/tailor.py', 'src/resume/humanizer.py', 'config/humanizer_patterns.json'] },
      { name: 'Make it ATS-safe', detail: 'Layout tables are flattened to single-column paragraphs in the copy, keeping their exact text, and manual page breaks that leave half-empty pages are repaired.', files: ['src/resume/tailor.py'] },
      { name: 'Check the result', detail: 'A validator confirms the document opens, has contact details and core sections. A linter reports constructs parsers choke on. A report estimates keyword match and density and lists gaps, each conditioned on you actually having the experience.', files: ['src/resume/validate.py', 'src/resume/atsLint.py', 'src/resume/atsReport.py', 'src/resume/keywordAudit.py'] },
      { name: 'Export a PDF', detail: 'Word is tried first, then LibreOffice. If neither exists, the document is rendered to plain HTML and printed with headless Chromium, after checking the page contains every paragraph of the source.', files: ['src/resume/pdfExport.py', 'src/resume/chromiumPdf.js', 'src/resume/pdfPreview.js'] },
    ],
    notes: [
      { title: 'When something is missing', items: ['No Python, no master resume, or a tailoring error: the packet falls back to the master resume and carries a warning you see before approving.', 'A resume with a warning is not eligible for auto-fill until you have looked at it.'] },
      { title: 'With verified rewrites on', items: ['Only rewrites you accepted reach the tailor. It replaces exactly those bullets and still checks every other unit byte for byte.'] },
    ],
  },
  {
    id: 'packets',
    title: 'Application packets and approval',
    summary: 'One reviewable bundle per job, and an approval that means what you saw.',
    see: 'A job in Needs review with its resume, letter and planned answers; Approve, Unapprove and Reject.',
    output: 'A packet JSON on disk, an approval-queue row, and versioned copies of each document.',
    steps: [
      { name: 'Detect the ATS', detail: 'The application URL’s host and markup signals identify the platform, which selects a form descriptor: Greenhouse, Lever, Ashby, Workday, iCIMS, Taleo, SmartRecruiters, Jobvite or generic.', files: ['src/apply/atsDetector.js', 'src/apply/platforms/index.js', 'src/apply/platforms/_base.js'] },
      { name: 'Write the letter', detail: 'By default the letter is assembled from your letter settings and profile, bounded by a word limit, and cleaned by the humanizer. Company and job names are protected from the banned-phrase list.', files: ['src/apply/coverLetter.js', 'src/apply/humanizer.js', 'src/apply/letterMode.js'] },
      { name: 'Plan the answers', detail: 'Standard fields are mapped to profile values. Screening questions are matched against your saved answers; anything without a confident match is marked as needing you rather than guessed.', files: ['src/apply/formPrefill.js', 'src/apply/screeningQA.js', 'src/apply/fileUpload.js'] },
      { name: 'Build the packet', detail: 'Job, score, tier, document paths, plans, detected ATS and any blockers are written as one JSON file. `submitReady` is false, and every platform plan carries `stopBeforeSubmit`.', files: ['src/apply/applicationPacket.js', 'src/utils/outputPaths.js'] },
      { name: 'Queue for approval', detail: 'The packet enters the approval queue as pending review. Approving records a digest of the resume, the letter, your saved answers and your profile fields.', files: ['src/apply/approvalQueue.js', 'src/apply/approvalDigest.js'] },
      { name: 'Re-check before use', detail: 'Before a fill, the digest is computed again. If any part differs, it is named, the approval is withdrawn and you approve again. Packets that can no longer be used are retired from the queue at startup.', files: ['src/apply/approvalDigest.js', 'src/apply/packetHygiene.js'] },
    ],
    notes: [
      { title: 'Document history', items: ['Every preparation copies the resume and letter into a numbered version folder with hashes and the cause.', 'Restoring a version records a new one, so history only grows.', 'When an application is submitted its versions are frozen, which keeps a true record of what was sent.'] },
      { title: 'Which jobs get a packet automatically', items: ['Only Priority and Apply. Queue means “worth a look”, not “worth a tailored resume”; you can still prepare any job by selecting it.'] },
    ],
  },
  {
    id: 'autofill',
    title: 'Autofill and ATS integrations',
    summary: 'Reads the form that is really there, fills what it can prove, stops for everything else.',
    see: 'Auto-fill on an approved job, a browser window filling itself, then either “ready for you to submit” or the exact reason it stopped.',
    output: 'A filled form awaiting your click, a list of fields filled and left, and any new questions queued.',
    steps: [
      { name: 'Precheck', detail: 'A side-effect-free check confirms the job is still actionable, the URL is valid, a packet exists and was approved, the approval digest still matches, the packet belongs to this profile, and there is no prior submission.', files: ['src/apply/autoApplyEligibility.js', 'src/apply/approvalDigest.js', 'src/apply/applicationPacket.js'] },
      { name: 'Open and find the form', detail: 'A visible Chromium window opens the posting with a persistent profile per person. The runner waits for the page to settle, follows an Apply button, link or popup when the form is behind one, and resolves forms embedded in an ATS iframe.', files: ['src/automation/browser.js', 'src/automation/navigator.js', 'src/automation/domScanner.js'] },
      { name: 'Guard', detail: 'Page text and URL are checked for a CAPTCHA, a login wall, a verification-code prompt or a bot-protection interstitial. Any of them ends the run as blocked and leaves the window open for you. Nothing attempts to get past one.', files: ['src/automation/guards.js'] },
      { name: 'Scan', detail: 'The live DOM is read for inputs, textareas, selects, radio groups, checkboxes and site-drawn dropdowns, with each field’s real label and choices. Fields the site already filled are left alone.', files: ['src/automation/domScanner.js'] },
      { name: 'Fill and verify', detail: 'Each field gets a value only from your profile or saved answers, applied with the action its control needs, then read back. A sponsorship choice that would contradict your stated need is refused. Documents are attached and confirmed attached.', files: ['src/automation/fieldFiller.js', 'src/automation/uploadRunner.js', 'src/apply/screeningQA.js'] },
      { name: 'Advance', detail: 'Next, Continue and Review are safe to click and are followed; validation errors are detected after each step. Submit and Finish controls are recognized separately and never clicked on this path.', files: ['src/automation/navigator.js', 'src/automation/domScanner.js'] },
      { name: 'Hand over', detail: 'The run ends as ready for submit or blocked, with the reason. Unanswered questions go to a queue you answer once. The window stays open; for up to 45 minutes the runner watches for a confirmation page and, if it sees one, records the submission as unverified for you to settle.', files: ['src/automation/applyRunner.js', 'src/apply/questionQueue.js', 'src/apply/applicationState.js'] },
    ],
    notes: [
      { title: 'Which ATSs are covered', items: ['Fixture-tested fill contracts: Greenhouse, Lever, Ashby, Workday and SmartRecruiters.', 'Selector hints plus the generic resolver: iCIMS, Taleo and Jobvite.', 'Any other site uses the generic resolver, which reads labels on the live form. It fills what it recognizes and reports the rest.'] },
      { title: 'Final auto-submit is experimental', status: 'experimental', items: ['`POST /api/auto-submit-batch` can click Submit, and no button in the dashboard calls it.', 'It needs explicit authorization for that run, a packet approved before the run began, zero blockers, truthful sponsorship answers, a uniquely identified Submit control, a fixture-tested ATS, an ATS recorded in `config/verified_live_ats.json`, and room under the daily cap (15 by default).', 'That file ships empty, so out of the box the route refuses every ATS.', 'A click is not a submission: without confirmation evidence the job is recorded as unverified, never as submitted.'] },
      { title: 'What a checkpoint stores', items: ['The phase, the fields touched by label, upload file names and the questions asked.', 'Never a typed value, an absolute path or a proposed answer.'] },
      { title: 'The extension path', items: ['The extension fills the current tab from an approved packet fetched from the local server.', 'It skips protected-class, legal-attestation and work-authorization questions entirely, and years-of-experience questions that name a specific skill.'] },
    ],
  },
  {
    id: 'tracking',
    title: 'Application tracking and follow-ups',
    summary: 'Automation status and hiring outcome are two separate records.',
    see: 'The Applications view by stage, Today’s queue of what needs you, outcomes, notes and reminders.',
    output: 'Append-only events per application, a tracker CSV, a calendar file and conversion numbers.',
    steps: [
      { name: 'Confirm the submission', detail: 'A job becomes submitted when you mark it, or when you settle an unverified one with “Yes, it went through”. “No, it didn’t” puts the job back so you can try again.', files: ['src/dashboard/routes/jobRoutes.js', 'src/dashboard/data.js', 'src/lifecycle.js'] },
      { name: 'Derive the status', detail: 'Board status is computed from the row by pure functions over an explicit map of every lifecycle value, so a new status cannot fall through to a wrong label.', files: ['src/domain/appStatus.js'] },
      { name: 'Record outcomes', detail: 'Awaiting response, Interviewing, Offer, Hired, Rejected by employer and Withdrawn are stored as events on top of a submitted row. Moves go forward only, and a mistake is fixed with undo.', files: ['src/domain/applicationOutcome.js'] },
      { name: 'Follow up', detail: 'Reminders are events too. Due ones appear on Today, can raise a desktop alert, and export as all-day calendar entries with stable ids so re-importing updates rather than duplicates.', files: ['src/reports/calendar.js', 'src/reports/followUpAlerts.js', 'src/dashboard/public/assets/js/today.js'] },
      { name: 'Read replies', detail: 'With the inbox on, each sync matches messages to one submitted application by the employer’s domain or an ATS sender plus the company name, classifies them, and records a suggestion with the sentence that triggered it. You record or dismiss it.', files: ['src/inbox/sync.js', 'src/inbox/match.js', 'src/inbox/classify.js'], status: 'optional' },
      { name: 'Export', detail: 'A spreadsheet tracker joins every job with its approval row. The Submit Status column reads Submitted only for confirmed submissions and calls out unverified clicks.', files: ['src/reports/jobTracker.js', 'src/reports/csv.js', 'src/dashboard/routes/systemRoutes.js'] },
    ],
    notes: [
      { title: 'What Today shows', items: ['One queue of the next action per job: review a packet, retry or resume a fill, answer a question, settle a submission, follow up.', 'A notice when the code on disk is newer than the running server, so you know to restart before auto-filling.'] },
      { title: 'Why failures are explained', items: ['Every failed source, phase or fill is categorized (timeout, rate limit, auth, schema changed, browser launch and so on) from error codes and statuses.', 'When the evidence does not support a cause, the category is “unknown” rather than a guess.'] },
    ],
  },
]);

/* ───────────────────────── lifecycle ───────────────────────── */

/**
 * The job lifecycle. Mirrors LIFECYCLE and TRANSITIONS in src/lifecycle.js; the
 * test asserts the two are identical.
 */
export const LIFECYCLE_GROUPS = Object.freeze([
  { id: 'intake', name: 'Intake' },
  { id: 'judged', name: 'Judged' },
  { id: 'packet', name: 'Prepared' },
  { id: 'fill', name: 'Filling' },
  { id: 'done', name: 'Closed' },
]);

export const LIFECYCLE_STATES = Object.freeze([
  { id: 'found', group: 'intake', label: 'Found', note: 'Just discovered.' },
  { id: 'needs_description', group: 'intake', label: 'Needs description', note: 'Listed by title only. Not judged.' },
  { id: 'unknown_date_review', group: 'intake', label: 'Date unknown', note: 'Held for you: no readable posting date.' },
  { id: 'hard_discarded', group: 'intake', label: 'Excluded', note: 'An exclusion rule matched. Final.' },
  { id: 'discarded', group: 'judged', label: 'Discarded', note: 'Stale, excluded or below the near-miss floor.' },
  { id: 'scored', group: 'judged', label: 'Scored', note: 'Judged; no action yet.' },
  { id: 'near_miss', group: 'judged', label: 'Near miss', note: 'Just under the queue threshold.' },
  { id: 'queued', group: 'judged', label: 'Queued', note: 'Strong enough to act on.' },
  { id: 'prepared', group: 'packet', label: 'Prepared', note: 'Packet built, awaiting approval.' },
  { id: 'skipped', group: 'packet', label: 'Skipped', note: 'You passed on it for now.' },
  { id: 'assist_started', group: 'fill', label: 'Filling', note: 'Auto-fill is running.' },
  { id: 'assist_blocked', group: 'fill', label: 'Blocked', note: 'Stopped for something that needs you.' },
  { id: 'cancelled', group: 'fill', label: 'Cancelled', note: 'You stopped it at a safe checkpoint.' },
  { id: 'failed', group: 'fill', label: 'Failed', note: 'An unexpected error. Reachable from any state.' },
  { id: 'ready_for_submit', group: 'fill', label: 'Ready for submit', note: 'Filled. Waiting for your click.' },
  { id: 'submit_unverified', group: 'done', label: 'Submit unverified', note: 'A submission was seen but not confirmed. Only you can settle it.' },
  { id: 'submitted', group: 'done', label: 'Submitted', note: 'Confirmed. Terminal.' },
]);

export const LIFECYCLE_TRANSITIONS = Object.freeze({
  found: ['scored', 'needs_description', 'hard_discarded', 'discarded', 'unknown_date_review'],
  needs_description: ['scored', 'near_miss', 'queued', 'discarded', 'hard_discarded'],
  unknown_date_review: ['scored', 'queued', 'discarded', 'hard_discarded'],
  scored: ['queued', 'near_miss', 'discarded'],
  near_miss: ['queued', 'discarded'],
  queued: ['prepared', 'skipped', 'discarded'],
  prepared: ['assist_started', 'submitted', 'skipped', 'queued', 'discarded'],
  assist_started: ['ready_for_submit', 'assist_blocked', 'submit_unverified', 'submitted', 'cancelled'],
  assist_blocked: ['assist_started', 'skipped', 'submitted', 'submit_unverified', 'queued', 'discarded'],
  cancelled: ['assist_started', 'skipped', 'queued', 'discarded'],
  ready_for_submit: ['submitted', 'submit_unverified', 'skipped'],
  submit_unverified: ['submitted', 'skipped'],
  failed: ['assist_started', 'skipped', 'queued', 'discarded'],
  skipped: ['queued', 'assist_started'],
  discarded: ['scored', 'queued'],
  hard_discarded: [],
  submitted: [],
});

/* ───────────────────────── data and security ───────────────────────── */

export const DATA_TABLES = Object.freeze([
  { name: 'jobs', holds: 'One row per posting: its facts, score, tier, explanation, status, your decision, document paths and scoring fingerprint.' },
  { name: 'run_log', holds: 'One row per run with a counter for every outcome: found, new, duplicate, stale, excluded, scored, queued, prepared.' },
  { name: 'application_events', holds: 'An append-only history. Approvals, rewrites, outcomes, follow-ups and inbox suggestions are events here, which is why adding them needed no schema change.' },
  { name: 'approval_queue', holds: 'One row per packet awaiting or holding your decision.' },
]);

export const DATA_NOTES = Object.freeze([
  'A schema migration is applied in a transaction when the database is opened, after a snapshot labelled pre-migration.',
  'Daily backups use `VACUUM INTO`, which gives a consistent copy while the dashboard is running, and are verified with a quick check.',
  'Export writes one `.jobagent` file holding every database, your personal config and master resumes, optionally encrypted with AES-256-GCM under a passphrase. API keys, the access token and logs are never included.',
  'Old discarded descriptions can be pruned to keep a large store small; `npm run db:prune` shows what would go before anything is removed.',
]);

export const SECURITY = Object.freeze([
  { name: 'Loopback only', detail: 'The server binds to 127.0.0.1 and rejects any request whose Host header is not a loopback name.', files: ['src/dashboard/server.js'] },
  { name: 'Same-origin and CSRF', detail: 'Cross-site requests are refused on Fetch Metadata and Origin. A write must be JSON or carry a custom header, which a foreign page cannot send without a preflight it will fail.', files: ['src/dashboard/server.js'] },
  { name: 'Access token', detail: 'A random 256-bit token readable only by you. The launcher exchanges it for an HttpOnly, SameSite=Strict cookie, so another program or user account on the same machine cannot call the API.', files: ['src/dashboard/apiToken.js'] },
  { name: 'Content Security Policy', detail: 'Scripts load from the app’s own origin only. Inline script and event handlers are not permitted, so injected markup cannot execute.', files: ['src/dashboard/server.js'] },
  { name: 'Outbound fetches', detail: 'URLs you paste are fetched through a client that refuses private and reserved addresses at connect time, hop by hop.', files: ['src/utils/safeFetch.js', 'src/utils/publicUrl.js'] },
  { name: 'Secrets', detail: 'Kept in the macOS Keychain, Windows DPAPI or the Linux Secret Service, with an encrypted file as a reported fallback. Logs and error messages are redacted.', files: ['src/utils/secretStore.js', 'src/utils/credentialManager.js'] },
  { name: 'File paths', detail: 'Every document read or served is resolved and checked to be inside the workspace, using real paths.', files: ['src/utils/pathSafe.js', 'src/dashboard/httpHelpers.js'] },
  { name: 'Truthful answers', detail: 'Sponsorship and work-authorization answers come only from your saved configuration. An answer that contradicts your stated need cannot be saved or typed, including when the question is phrased in reverse.', files: ['src/apply/screeningQA.js', 'src/config/screeningAnswerRules.js', 'src/automation/fieldFiller.js'] },
  { name: 'Personal data in the repository', detail: 'Personal files are git-ignored, and a CI check fails if one ever enters history.', files: ['scripts/checkPersonalData.mjs', '.gitignore'] },
]);

/* ───────────────────────── interfaces ───────────────────────── */

export const API_GROUPS = Object.freeze([
  { name: 'Board and runs', routes: ['GET /api/today', 'GET /api/jobs', 'GET /api/stats', 'GET /api/sections', 'GET /api/applications', 'POST /api/run', 'POST /api/run/cancel', 'GET /api/run/status', 'GET /api/runs', 'POST /api/search', 'POST /api/add-url'] },
  { name: 'One job', routes: ['GET /api/jobs/:id', 'POST /api/jobs/:id/decision', 'POST /api/jobs/:id/approve', 'POST /api/jobs/:id/reject-packet', 'POST /api/jobs/:id/assist', 'POST /api/jobs/:id/mark-submitted', 'POST /api/jobs/:id/not-submitted', 'POST /api/jobs/:id/note', 'POST /api/jobs/:id/check-link', 'GET /api/jobs/:id/resume'] },
  { name: 'Batches', routes: ['POST /api/prepare-batch', 'POST /api/approve-batch', 'POST /api/assist-batch', 'POST /api/decide-batch', 'POST /api/auto-apply/eligibility', 'POST /api/auto-submit-batch'] },
  { name: 'Profile and resume', routes: ['GET /api/profile', 'POST /api/profile', 'POST /api/profile/answers', 'POST /api/profile/questions/answer', 'GET /api/search-profiles', 'POST /api/search-profiles/activate', 'POST /api/search-profiles/from-resume', 'GET /api/master-resume', 'POST /api/master-resume', 'POST /api/master-resume/restore'] },
  { name: 'System', routes: ['GET /api/health', 'GET /api/data-quality', 'POST /api/settings', 'GET /api/backups', 'POST /api/backups', 'GET /api/enrichment', 'POST /api/postings/sweep', 'GET /api/rerank', 'GET /api/llm-usage', 'GET /api/export/jobs.csv', 'GET /api/export/tracker.csv', 'GET /api/calendar.ics'] },
  { name: 'Inbox', routes: ['GET /api/inbox', 'POST /api/inbox/sync', 'POST /api/inbox/decide', 'POST /api/inbox/draft'] },
]);

/** Mirrors COMMAND_TABLE in src/index.js (the test checks every name exists there). */
export const CLI_GROUPS = Object.freeze([
  { name: 'Start', commands: [['app', 'Start the dashboard and open it in your browser'], ['go', 'Guided run: preflight, discover, score, prepare, then assist'], ['dashboard', 'Start only the local server']] },
  { name: 'Setup', commands: [['doctor', 'Preflight checklist'], ['profiles', 'Show, activate, preview and create search profiles']] },
  { name: 'Pipeline', commands: [['discover', 'Search enabled job boards'], ['score', 'Discover and score against your profile'], ['rescore', 'Re-score stored jobs under the current config'], ['prepare-apps', 'Tailor resumes and build packets for strong matches'], ['end-to-end', 'Discover through assist; always stops before Submit'], ['watch', 'Poll for new strong matches on an interval']] },
  { name: 'Review', commands: [['approvals', 'List packets awaiting your review'], ['approve', 'Record your approval of a packet'], ['reject', 'Record your rejection of a packet'], ['packets', 'List prepared packets'], ['packet', 'Show one packet'], ['report', 'Regenerate the run report']] },
  { name: 'Apply', commands: [['assist', 'Fill approved applications; stops before Submit'], ['apply', 'One application at a time, pausing for you']] },
]);

export const MCP_TOOLS = Object.freeze(['search_jobs', 'get_job', 'list_applications', 'get_application', 'get_profile_summary', 'add_note', 'record_outcome']);

export const QUALITY = Object.freeze([
  { name: 'Unit and integration tests', detail: 'A Vitest suite of more than 200 test files, with coverage thresholds enforced: 88% of lines and 76% of branches.', files: ['vitest.config.js', 'tests/node/globalSetup.js'] },
  { name: 'Real-browser tests', detail: 'Playwright drives the actual dashboard and fills local, no-submit fixture forms for each supported ATS.', files: ['tests/node/atsApplicationFixtures.test.js', 'tests/node/dashboardAutofillJourney.test.js'] },
  { name: 'Accessibility', detail: 'axe-core scans each dashboard state for WCAG A and AA problems in both themes; a serious or critical finding fails the run.', files: ['tests/node/a11y.test.js'] },
  { name: 'Python tests', detail: 'pytest covers the tailor, keyword tiering, the linter, the report and the validator.', files: ['tests/python/test_tailor.py', 'pytest.ini'] },
  { name: 'Isolation', detail: 'Tests run against a temporary workspace, so they never touch your database or config.', files: ['tests/node/globalSetup.js', 'tests/node/testIsolation.test.js'] },
  { name: 'Continuous integration', detail: 'Lint, type checks, both test suites and the personal-data check run on every pull request and every push to main. The test suites run on Linux, macOS and Windows.', files: ['.github/workflows/ci.yml', 'eslint.config.js', 'jsconfig.json'] },
]);

/** The Deep Dive's table of contents, in page order. */
export const DEEP_TOPICS = Object.freeze([
  { id: 'system', name: 'System map' },
  { id: 'stack', name: 'Technology stack' },
  { id: 'run', name: 'One run, end to end' },
  { id: 'discovery', name: 'Job discovery' },
  { id: 'profiles', name: 'Profiles and resume parsing' },
  { id: 'scoring', name: 'Scoring' },
  { id: 'scorelab', name: 'Score lab' },
  { id: 'ai', name: 'The optional AI layer' },
  { id: 'tailoring', name: 'Resume tailoring' },
  { id: 'packets', name: 'Packets and approval' },
  { id: 'autofill', name: 'Autofill and ATSs' },
  { id: 'tracking', name: 'Tracking and follow-ups' },
  { id: 'lifecycle', name: 'Job lifecycle' },
  { id: 'data', name: 'Data and storage' },
  { id: 'security', name: 'Security and privacy' },
  { id: 'interfaces', name: 'API, CLI, MCP, extension' },
  { id: 'quality', name: 'How it is tested' },
]);
