/**
 * Search profiles (people) and the application profile: list, create, edit, switch, delete, answers and questions.
 *
 * Moved verbatim from route() in src/dashboard/server.js. `ctx` exposes the
 * server's closure through getters, so `ctx.db` and `ctx.config` are always the
 * live values (they change when the active profile changes or config reloads).
 * Returns NOT_HANDLED when no route here matched, so server.js tries the next
 * module; anything else means the request was answered.
 */
import { dismissQuestion, markQuestionAnswered, reopenQuestion } from '../../apply/questionQueue.js';
import { adoptResumeEvidence, readProfile, readScreeningAnswers, upsertScreeningAnswer, writeProfile, writeScreeningAnswers } from '../../config/profileStore.js';
import { buildBackground, profileFromResume } from '../../profile/fromResume.js';
import { acknowledgeResumeMismatch, activateProfile, createPersonProfile, deleteProfile as deleteSearchProfile, listProfiles as listSearchProfiles, mergeIntoActiveProfile, migrateLegacyCandidate, proposeProfileFromResume, readActiveProfile, readProfile as readSearchProfile, refreshBackgroundFromResume, resumeProfileToReuse, saveProfile as saveSearchProfile, updatePersonProfile } from '../../profile/store.js';
import { masterResumeFile, workspacePaths } from '../../profile/workspace.js';
import { extractDocxText } from '../../resume/docxText.js';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_UPLOAD_BODY_BYTES, decodeResumeUpload, readBody, sendJson } from '../httpHelpers.js';
import { NOT_HANDLED } from './notHandled.js';

export async function handleProfileRoutes(ctx, req, res, { path }) {
  /* ── Search profiles ───────────────────────────────────────────────────
   *
   * WHOSE SEARCH IS RUNNING? These endpoints exist so the board can answer
   * that, and so a different candidate's resume can produce a different
   * search without anyone editing JSON by hand. `/api/profile` above is a
   * different thing: the contact details the FORM FILLER types. This is what
   * the agent LOOKS FOR.
   */
  // Re-read the active profile's background (roles, employers, education,
  // skills) from the master resume — the fix for a profile still carrying
  // the template's "Example Corp". Search goals are never touched.
  if (req.method === 'POST' && path === '/api/search-profiles/refresh-background') {
    if (ctx.runState.running) {
      return sendJson(res, 409, { error: `a ${ctx.runState.phase} run is in progress — try again when it finishes` });
    }
    const root = ctx.requireConfigRoot();
    const result = await refreshBackgroundFromResume(root, masterResumeFile(root), { db: ctx.db });
    if (!result.ok) return sendJson(res, 409, { error: result.reason });
    let warning = null;
    if (result.changed.length) {
      warning = ctx.reloadConfig();
      if (!warning) ctx.scheduleRescore();
    }
    return sendJson(res, 200, { id: result.id, changed: result.changed, warning });
  }
  if (req.method === 'GET' && path === '/api/search-profiles') {
    const root = ctx.requireConfigRoot();
    const listing = listSearchProfiles(root);
    const active = readActiveProfile(root);
    return sendJson(res, 200, {
      ...listing,
      active: active ? ctx.summarizeSearchProfile(active) : null,
    });
  }
  // Read the master resume as a PROPOSAL: what it says, whether it looks like
  // the same person, and the three things the user may do about it. Read-only
  // — see src/profile/fromResume.js for why adopting stays an explicit act.
  if (req.method === 'GET' && path === '/api/search-profiles/from-resume/preview') {
    const root = ctx.requireConfigRoot();
    const result = await proposeProfileFromResume(root, masterResumeFile(root));
    return sendJson(res, 200, result);
  }
  // Catch-all by id. MUST stay after every literal sub-path above: it treats
  // whatever follows the prefix as a profile id, so a route added below it
  // silently becomes a 404 for a profile that does not exist.
  if (req.method === 'GET' && path.startsWith('/api/search-profiles/')) {
    const root = ctx.requireConfigRoot();
    const id = decodeURIComponent(path.slice('/api/search-profiles/'.length));
    const profile = readSearchProfile(root, id);
    if (!profile) return sendJson(res, 404, { error: `no profile named "${id}"` });
    return sendJson(res, 200, ctx.summarizeSearchProfile(profile));
  }
  if (req.method === 'POST' && path === '/api/search-profiles/activate') {
    const body = await readBody(req);
    /**
     * A RUN IN PROGRESS OWNS THE CONFIGURATION IT STARTED WITH.
     *
     * Activation rewrites candidate.json, scoring.json, exclusions.json and
     * the screening answers, then reloads the in-memory config. An auto-apply
     * batch holds a queue of packets built BEFORE that, but reads `config`
     * fresh on every iteration — so activating mid-batch filled the remaining
     * jobs with one profile's screening answers onto another profile's
     * documents, in the same run. The batch is short and the switch can wait.
     */
    // A dry run computes and writes nothing, so it stays available.
    if (ctx.runState.running && body.dryRun !== true) {
      return sendJson(res, 409, {
        error: `a ${ctx.runState.phase} run is in progress — wait for it to finish before switching search profiles, `
          + 'so one batch cannot mix two profiles\' answers and documents',
      });
    }
    return ctx.saving(res, () => {
      const root = ctx.requireConfigRoot();
      const summary = activateProfile(root, String(body.id ?? ''), { dryRun: body.dryRun === true });
      // Activation rewrites candidate.json, scoring.json and exclusions.json.
      // The in-memory config MUST be reloaded or the board keeps serving the
      // previous candidate's search until the process restarts.
      const warning = summary.dryRun ? null : ctx.reloadConfig();
      // A different person: every route now reads THEIR database.
      const workspaceChanged = summary.dryRun ? false : ctx.useActiveWorkspace();
      if (!summary.dryRun && !warning) ctx.scheduleRescore();
      return sendJson(res, 200, { ...summary, warning, workspaceChanged });
    });
  }
  // Re-open a resume question the user had settled with "Keep my current
  // goals". Clearing the acknowledgment is the only way back to the prompt,
  // so the decision is durable without being irreversible.
  if (req.method === 'POST' && path === '/api/search-profiles/acknowledge-resume') {
    const body = await readBody(req);
    return ctx.saving(res, () => {
      const root = ctx.requireConfigRoot();
      if (body.clear === true) {
        return sendJson(res, 200, acknowledgeResumeMismatch(root, ''));
      }
      const proposed = readActiveProfile(root);
      if (!proposed) return sendJson(res, 200, { acknowledged: false });
      return sendJson(res, 200, acknowledgeResumeMismatch(root, String(body.fingerprint ?? '')));
    });
  }
  if (req.method === 'POST' && path === '/api/search-profiles/migrate') {
    return ctx.saving(res, () => {
      const result = migrateLegacyCandidate(ctx.requireConfigRoot());
      return sendJson(res, 200, result);
    });
  }
  if (req.method === 'DELETE' && path.startsWith('/api/search-profiles/')) {
    const id = decodeURIComponent(path.slice('/api/search-profiles/'.length));
    return ctx.saving(res, () => sendJson(res, 200, deleteSearchProfile(ctx.requireConfigRoot(), id)));
  }
  /* ── adding and editing a person ──────────────────────────────────────
   * "Add profile" never replaces anyone's resume: a resume given here is read
   * for the form and saved into the NEW person's own workspace only. */
  if (req.method === 'POST' && path === '/api/search-profiles/read-resume') {
    const body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
    return ctx.saving(res, () => {
      const bytes = decodeResumeUpload(body);
      const { paragraphs } = extractDocxText(bytes);
      const draft = profileFromResume(paragraphs, {});
      return sendJson(res, 200, {
        fields: {
          fullName: draft.identity.fullName,
          email: draft.contact.email,
          phone: draft.contact.phone,
          targetRoles: draft.searchIntent.targetRoles,
          seniority: draft.searchIntent.seniority || '',
        },
        found: {
          roles: draft.searchIntent.targetRoles.length,
          jobs: draft.background.workHistory.length,
          skills: draft.background.skills.length,
        },
      });
    });
  }
  if (req.method === 'POST' && path === '/api/search-profiles') {
    const body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
    if (ctx.runState.running && body.activate === true) {
      return sendJson(res, 409, { error: `a ${ctx.runState.phase} run is in progress — add the profile after it finishes` });
    }
    return ctx.saving(res, () => {
      const root = ctx.requireConfigRoot();
      let resume = null;
      if (body.resume?.contentBase64) {
        const bytes = decodeResumeUpload(body.resume);
        resume = { bytes, background: buildBackground(extractDocxText(bytes).paragraphs, { sourceFile: '' }) };
        delete resume.background._name; delete resume.background._headline; delete resume.background._contact;
      }
      const created = createPersonProfile(root, body.fields ?? {}, { resume });
      // The list being viewed right now: seeding copies from it.
      const viewedDb = ctx.db;
      let activated = null; let warning = null; let workspaceChanged = false;
      if (body.activate === true) {
        try { activated = activateProfile(root, created.id); }
        catch (err) { deleteSearchProfile(root, created.id); throw err; }
        warning = ctx.reloadConfig();
        workspaceChanged = ctx.useActiveWorkspace();
      }
      const seed = body.seed === true ? ctx.seedNewPerson(root, created.id, viewedDb) : { seeded: 0 };
      if (activated && !warning) ctx.scheduleRescore(); // scores the seeded copies under THEIR profile
      return sendJson(res, 200, { ...created, activated, warning, workspaceChanged, seeded: seed.seeded });
    });
  }
  if (req.method === 'PATCH' && path.startsWith('/api/search-profiles/')) {
    const id = decodeURIComponent(path.slice('/api/search-profiles/'.length));
    const body = await readBody(req);
    // Editing the ACTIVE person during a run is refused BEFORE anything is
    // written. It used to save the profile file, then answer 409 "applies
    // after the run" — but nothing applied it afterwards, so the profile and
    // the candidate/scoring files it generates silently disagreed (BUG-04).
    if (ctx.runState.running && readActiveProfile(ctx.config?.root ?? '')?.id === id) {
      return sendJson(res, 409, {
        error: `${ctx.runState.phase ? `A ${ctx.runState.phase} run` : 'A run'} is using this profile right now, so nothing was saved. Save again when it finishes.`,
        notSaved: true,
      });
    }
    return ctx.saving(res, () => {
      const root = ctx.requireConfigRoot();
      const updated = updatePersonProfile(root, id, body.fields ?? {});
      let warning = null;
      // Editing the ACTIVE person changes what is searched for right now.
      if (updated.active) {
        activateProfile(root, id);
        warning = ctx.reloadConfig();
        if (!warning) ctx.scheduleRescore();
      }
      return sendJson(res, 200, { ...updated, warning });
    });
  }
  if (req.method === 'POST' && path === '/api/search-profiles/from-resume') {
    const body = await readBody(req);
    /**
     * A RUN IN PROGRESS OWNS THE CONFIGURATION IT STARTED WITH.
     *
     * Activation rewrites candidate.json, scoring.json, exclusions.json and
     * the screening answers, then reloads the in-memory config. An auto-apply
     * batch holds a queue of packets built BEFORE that, but reads `config`
     * fresh on every iteration — so activating mid-batch filled the remaining
     * jobs with one profile's screening answers onto another profile's
     * documents, in the same run. The batch is short and the switch can wait.
     */
    // "keep" is an explicit no-op and changes no configuration.
    if (ctx.runState.running && String(body.choice ?? '') !== 'keep') {
      return sendJson(res, 409, {
        error: `a ${ctx.runState.phase} run is in progress — wait for it to finish before switching search profiles, `
          + 'so one batch cannot mix two profiles\' answers and documents',
      });
    }
    return ctx.saving(res, async () => {
      const root = ctx.requireConfigRoot();
      const choice = String(body.choice ?? '');
      const proposed = await proposeProfileFromResume(root, masterResumeFile(root));

      if (choice === 'keep') {
        // DURABLY recorded, not merely acknowledged in the response. This
        // returned a message and wrote nothing, so the drawer re-ran the
        // comparison on its next render and asked the same question again —
        // a decision the user had already made, over and over.
        //
        // "Keep" is also the one choice that still means something with no
        // resume on disk: there is nothing to compare against, so there is
        // nothing to record, and the answer is the same either way.
        const ack = proposed.available
          ? acknowledgeResumeMismatch(root, proposed.resumeFingerprint)
          : { acknowledged: false };
        return sendJson(res, 200, {
          choice,
          changed: false,
          acknowledged: ack.acknowledged,
          message: ack.acknowledged
            ? 'Your current search goals are unchanged. This resume will not be queried again unless you edit it.'
            : 'Your current search goals are unchanged.',
        });
      }
      if (!proposed.available) throw new Error(proposed.reason);

      if (choice === 'create') {
        // REFUSE BEFORE SAVING. Activation rejects a profile with no target
        // roles, but this route used to save first — so the refusal left an
        // unusable profile on disk, and every retry added another copy.
        if (!(proposed.proposal.searchIntent?.targetRoles ?? []).length) {
          throw Object.assign(new Error(
            'No job titles could be read from this resume, so a profile made from it would search for nothing. '
            + 'Put each job title on its own line (or before its dates), then upload the resume again.',
          ), { statusCode: 422 });
        }
        // Building again from the same resume — or for the same person whose
        // saved profile cannot search — updates that profile instead of
        // saving another copy beside it.
        const reuseId = resumeProfileToReuse(root, proposed.proposal, proposed.resumeFingerprint);
        // The new person gets their OWN workspace (their own jobs, resume and
        // outputs), and the resume they were built from is copied into it, so
        // switching back to the previous person never tailors from theirs.
        const id = reuseId ?? proposed.proposal.id;
        const workspace = (reuseId ? readSearchProfile(root, reuseId)?.workspace : '') || id;
        const ownResume = workspacePaths(root, workspace).resume;
        if (ownResume !== masterResumeFile(root)) {
          mkdirSync(dirname(ownResume), { recursive: true });
          copyFileSync(masterResumeFile(root), ownResume);
        }
        const saved = saveSearchProfile(root, {
          ...proposed.proposal,
          id,
          workspace,
          label: body.label || proposed.proposal.label,
          background: { ...proposed.proposal.background, sourceFile: ownResume, resumeFingerprint: proposed.resumeFingerprint ?? '' },
        });
        // Saving is not activating: a new profile never takes over the search
        // without a second, deliberate action.
        const viewedDb = ctx.db;
        if (body.activate === true) {
          const summary = activateProfile(root, saved.id);
          const warning = ctx.reloadConfig();
          const workspaceChanged = ctx.useActiveWorkspace();
          const seed = body.seed === true ? ctx.seedNewPerson(root, saved.id, viewedDb) : { seeded: 0 };
          if (!warning) ctx.scheduleRescore();
          return sendJson(res, 200, { choice, changed: true, ...saved, activated: summary, warning, workspaceChanged, seeded: seed.seeded });
        }
        return sendJson(res, 200, { choice, changed: true, ...saved, activated: null });
      }
      if (choice === 'merge') {
        const merged = mergeIntoActiveProfile(root, {
          roles: Array.isArray(body.roles) ? body.roles : [],
          skills: Array.isArray(body.skills) ? body.skills : [],
          industries: Array.isArray(body.industries) ? body.industries : [],
        });
        const summary = activateProfile(root, merged.id);
        const warning = ctx.reloadConfig();
        if (!warning) ctx.scheduleRescore();
        return sendJson(res, 200, { choice, changed: true, ...merged, activated: summary, warning });
      }
      throw new Error('choice must be one of: create, keep, merge');
    });
  }

  // ── Application profile ────────────────────────────────────────────────
  // The values the form filler types, the answers it draws on, and the
  // questions it could not answer. Editing them here replaces hand-editing
  // two JSON files, and every write is validated before it reaches disk.
  if (req.method === 'GET' && path === '/api/profile') {
    return sendJson(res, 200, ctx.profileState());
  }
  if (req.method === 'POST' && path === '/api/profile') {
    const body = await readBody(req);
    return ctx.saving(res, () => {
      const root = ctx.requireConfigRoot();
      if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
        throw new Error('send { values: { "<field path>": "<value>" } }');
      }
      const saved = writeProfile(root, body.values);
      return sendJson(res, 200, { ...saved, warning: ctx.reloadConfig(), profile: readProfile(root) });
    });
  }
  if (req.method === 'POST' && path === '/api/profile/adopt') {
    const body = await readBody(req);
    const titles = Array.isArray(body.titles) ? body.titles.slice(0, 40) : [];
    const skills = Array.isArray(body.skills) ? body.skills.slice(0, 200) : [];
    if (!titles.length && !skills.length) {
      return sendJson(res, 400, { error: 'nothing was selected to adopt' });
    }
    if (ctx.runState.running) {
      return sendJson(res, 409, { error: `a ${ctx.runState.phase} run is in progress — try again when it finishes` });
    }
    return ctx.saving(res, () => {
      const result = adoptResumeEvidence(ctx.requireConfigRoot(), { titles, skills });
      // targetTitles drives every query-first source and Workday's derived
      // phrases, so the in-memory config must not keep serving the old list —
      // and verdicts judged against the old titles are re-scored.
      const warning = ctx.reloadConfig();
      if (!warning) ctx.scheduleRescore();
      return sendJson(res, 200, { ...result, warning, suggestions: ctx.resumeSuggestions() });
    });
  }
  if (req.method === 'POST' && path === '/api/profile/answers') {
    const body = await readBody(req);
    return ctx.saving(res, () => {
      const root = ctx.requireConfigRoot();
      const saved = writeScreeningAnswers(root, {
        defaults: body.defaults ?? {},
        answers: Array.isArray(body.answers) ? body.answers : [],
      });
      return sendJson(res, 200, { ...saved, warning: ctx.reloadConfig(), screening: readScreeningAnswers(root) });
    });
  }
  if (req.method === 'POST' && path === '/api/profile/questions/answer') {
    const body = await readBody(req);
    return ctx.saving(res, () => {
      const root = ctx.requireConfigRoot();
      // The original question travels with the answer so the truthfulness
      // check can see the POLARITY of what is being answered, not just the
      // text of the answer. That is the only way an affirmative reply to a
      // reversed sponsorship question can be caught.
      const saved = upsertScreeningAnswer(root, {
        id: body.id,
        patterns: Array.isArray(body.patterns) ? body.patterns : [],
        answer: body.answer,
        type: body.type,
      }, { question: body.question, replace: body.replace === true });
      if (body.key) markQuestionAnswered(root, String(body.key), { answerId: saved.id, now: ctx.nowDate() });
      return sendJson(res, 200, { ...saved, warning: ctx.reloadConfig(), ...ctx.profileState() });
    });
  }
  if (req.method === 'POST' && path === '/api/profile/questions/status') {
    const body = await readBody(req);
    return ctx.saving(res, () => {
      const root = ctx.requireConfigRoot();
      const key = String(body.key ?? '');
      if (!key) throw new Error('which question? send its key');
      const outcome = body.status === 'open'
        ? reopenQuestion(root, key)
        : dismissQuestion(root, key, { now: ctx.nowDate() });
      if (!outcome.ok) throw new Error(outcome.reason);
      return sendJson(res, 200, ctx.profileState());
    });
  }
  return NOT_HANDLED;
}
