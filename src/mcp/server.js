/**
 * JobAgent's MCP server (P2-4): your job data, available to Claude or any
 * other MCP client on this computer.
 *
 * It runs over stdio (no network port) and exposes exactly the tools in
 * MCP_TOOLS. It deliberately has NO tool that approves, fills, submits, sends
 * or deletes anything, or that changes configuration: an assistant can read
 * your jobs and applications, add a note, and record an outcome you tell it
 * about, and nothing more. A test enumerates the registered tools against this
 * list, so a new tool cannot be added by accident.
 *
 * The profile summary leaves out contact details (email, phone, address)
 * unless MCP_SHARE_CONTACT=1.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { applicationsWorkspace, boardPage, jobDetail, recordOutcome, setJobNote } from '../dashboard/data.js';
import { OUTCOME_VALUES } from '../domain/applicationOutcome.js';

/** The complete tool list. Nothing outside it may ever be registered. */
export const MCP_TOOLS = Object.freeze([
  'search_jobs', 'get_job', 'list_applications', 'get_application', 'get_profile_summary', 'add_note', 'record_outcome',
]);

/** Words a tool name must never contain: this server cannot act on applications. */
export const FORBIDDEN_TOOL_WORDS = /submit|apply|approve|send|delete|remove|assist|fill|config|setting/i;

const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const failure = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const APPEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function jobSummary(j) {
  return {
    id: j.id, company: j.company, title: j.title, location: j.location ?? null, score: j.score ?? null,
    tier: j.tier ?? null, status: j.appStatus ?? j.status ?? null, url: j.url ?? null, posted: j.postedLabel ?? j.posted_at ?? null,
  };
}

/**
 * @param {{ db: object, config: object, env?: NodeJS.ProcessEnv, now?: () => Date }} args
 */
export function createMcpServer({ db, config, env = process.env, now = () => new Date() }) {
  const server = new McpServer({ name: 'jobagent', version: '0.2.0' });

  server.registerTool('search_jobs', {
    title: 'Search jobs',
    description: 'Search the jobs JobAgent found, by company, title or location text. Returns the best-scored first.',
    inputSchema: { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() },
    annotations: READ,
  }, async ({ query, limit }) => {
    const page = boardPage(db, { q: query ?? '', limit: limit ?? 20, now: now() });
    return asText({ total: page.total ?? page.jobs.length, jobs: page.jobs.map(jobSummary) });
  });

  server.registerTool('get_job', {
    title: 'Get a job',
    description: 'Everything JobAgent knows about one job: score breakdown, posting, decision and application status.',
    inputSchema: { jobId: z.string().min(1).max(300) },
    annotations: READ,
  }, async ({ jobId }) => {
    try {
      const d = jobDetail(db, jobId, { now: now(), root: config?.root });
      const { packet, events, applicationState, ...rest } = d;
      return asText({ ...rest, hasApplicationPacket: Boolean(packet), recentEvents: (events ?? []).slice(0, 10).map(({ at, type, message }) => ({ at, type, message })) });
    } catch (err) {
      return failure(err.message);
    }
  });

  server.registerTool('list_applications', {
    title: 'List applications',
    description: 'Applications by stage (to review, ready, needs you, applied, interviewing, offer, closed).',
    inputSchema: { stage: z.string().max(40).optional() },
    annotations: READ,
  }, async ({ stage }) => {
    const ws = applicationsWorkspace(db, { now: now(), config });
    const items = ws.items.filter((i) => !stage || i.stage === stage)
      .map((i) => ({ id: i.id, company: i.company, title: i.title, stage: i.stage, outcome: i.outcome?.label ?? null, followUp: i.followUp?.dueOn ?? null }));
    return asText({ metrics: ws.metrics, applications: items });
  });

  server.registerTool('get_application', {
    title: 'Get an application',
    description: 'One application: its packet summary (resume, cover letter, blockers) and recruiting outcome history.',
    inputSchema: { jobId: z.string().min(1).max(300) },
    annotations: READ,
  }, async ({ jobId }) => {
    try {
      const d = jobDetail(db, jobId, { now: now(), root: config?.root });
      const p = d.packet;
      return asText({
        job: jobSummary(d),
        packet: p ? {
          blockers: p.blockers ?? [], resumeTailored: p.resumeTailored ?? false, coverLetterGenerated: p.coverLetterGenerated ?? false,
          coverLetterMode: p.coverLetterGrounding?.mode ?? null, gaps: (p.tailoring?.gaps ?? []).map((g) => g.keyword ?? g),
        } : null,
        outcomes: (d.events ?? []).filter((e) => e.type === 'application_outcome').map((e) => ({ at: e.at, message: e.message })),
      });
    } catch (err) {
      return failure(err.message);
    }
  });

  server.registerTool('get_profile_summary', {
    title: 'Get the profile summary',
    description: 'The job search profile: target titles, seniority and skills. Contact details are left out unless the owner allows them.',
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const c = config?.candidate ?? {};
    const summary = {
      headline: c.identity?.headline ?? null, targetTitles: c.targetTitles ?? [], seniority: c.seniority ?? null,
      skills: Object.values(c.technicalStack ?? {}).flat(), certifications: c.certifications ?? [],
      remote: c.locationPreferences?.remote ?? null, sponsorshipRequired: c.workAuthorization?.requiresSponsorship ?? null,
    };
    if (env.MCP_SHARE_CONTACT === '1') {
      Object.assign(summary, { name: c.identity?.fullName ?? null, email: c.contact?.email ?? null, city: c.location?.city ?? null });
    }
    return asText(summary);
  });

  server.registerTool('add_note', {
    title: 'Add a note',
    description: 'Replace the note on one job with the given text (the note shown in the dashboard).',
    inputSchema: { jobId: z.string().min(1).max(300), note: z.string().max(4000) },
    annotations: APPEND,
  }, async ({ jobId, note }) => {
    try { return asText(setJobNote(db, jobId, note)); } catch (err) { return failure(err.message); }
  });

  server.registerTool('record_outcome', {
    title: 'Record an outcome',
    description: `Record what happened with a SUBMITTED application, as the owner reports it: ${OUTCOME_VALUES.join(', ')}.`,
    inputSchema: { jobId: z.string().min(1).max(300), outcome: z.enum(OUTCOME_VALUES), note: z.string().max(500).optional() },
    annotations: APPEND,
  }, async ({ jobId, outcome, note }) => {
    try {
      const summary = recordOutcome(db, jobId, { outcome, note: note ?? null, now: now(), config });
      return asText({ recorded: outcome, application: { id: summary.id, stage: summary.stage, outcome: summary.outcome?.label ?? null } });
    } catch (err) {
      return failure(err.message);
    }
  });

  return server;
}
