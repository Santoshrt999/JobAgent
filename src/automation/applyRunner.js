/**
 * Apply runner — browser-assisted application filling (the orchestrator).
 *
 * Given a prepared+approved packet, this opens the application page, runs the
 * safety guards, fills known fields, uploads the resume/cover letter, applies
 * config-backed screening answers, and advances through safe multi-step
 * navigation (Next / Continue / Review). By DEFAULT it stops before the final
 * submit — a human reviews the filled form and clicks Submit themselves.
 *
 * Final submission is opt-in PER RUN: when the human explicitly enables
 * options.autoSubmit, the runner clicks the final Submit — but only on a
 * completely clean form (zero blockers, all required fields filled, truthful
 * sponsorship answers, a unique confidently-identified submit control) and
 * only under the configured daily application cap. Anything risky (CAPTCHA /
 * login / MFA / bot wall / unknown required question) still ends the run as
 * `assist_blocked` with the browser left open for the human — auto-submit
 * never overrides a guard or fabricates an answer.
 *
 * Truthfulness rule for "submitted": clicking Submit is NOT proof the
 * application went through (client-side validation, a post-submit CAPTCHA, or
 * a no-op button all swallow the click). After the click the runner re-inspects
 * the page and only reports `submitted: true` when it can VERIFY the submission
 * (a confirmation message, or the URL changed and the form is gone). An
 * unverified click ends as `submit_unverified` — surfaced to the human to
 * confirm via the ATS email — and is never recorded as applied.
 *
 * All browser interaction is injectable (`deps.createSession`) so the core flow
 * is unit-testable with a fake page and exercisable with real Playwright against
 * local fixture forms.
 */

import {
  createBrowserSession, openApplicationPage, inspectCurrentPage,
  BROWSER_UNAVAILABLE_CODE, BROWSER_UNAVAILABLE_MESSAGE, isBrowserMissingError, stripPlaywrightBanner,
} from './browser.js';
import { fillFields, requiredFieldsSatisfied, verifyFilledFields } from './fieldResolver.js';
import {
  scanFields, resolveFormScope, detectValidationErrors, unfilledRequiredControls, applicationFields,
  shadowFormControlCount,
} from './domScanner.js';
import { fillScannedFields, isSensitiveChoiceLabel } from './fieldFiller.js';
import { findAdvanceControl, findSubmitControl, clickAndSettle, APPLY_START_RE } from './navigator.js';
import { uploadFiles } from './uploadRunner.js';
import { detectBlocker, visibleText } from './guards.js';
import {
  assertTruthfulSponsorship, isInvertedSponsorshipQuestion, isSponsorshipTopic,
} from '../apply/screeningQA.js';
import {
  APPLICATION_PHASE,
  applicationStatePreventsReopen,
  assertApplicationStateMatchesPacket,
  createApplicationState,
  resolveApplicationStateStore,
  transitionApplicationState,
} from '../apply/applicationState.js';
import { packetOwnershipCheck } from '../apply/applicationPacket.js';
import { LIFECYCLE } from '../lifecycle.js';
import { join } from 'node:path';

/**
 * @param {object} args
 * @param {object} args.packet application packet (built by buildApplicationPacket)
 * @param {object} args.config loadConfig bundle
 * @param {string} args.mode resolved run mode
 * @param {object} [args.approval] approval_queue row for this packet's job
 * @param {number} [args.dailyCount=0] applications submitted today
 * @param {object} [args.options]
 * @param {boolean} [args.options.headless]
 * @param {boolean} [args.options.dryRun=false] fill/upload resolve-only (no typing/attaching)
 * @param {object} [args.deps]
 * @param {Function} [args.deps.createSession] -> { page, close }
 * @param {Function} [args.deps.openPage] override openApplicationPage
 * @returns {Promise<object>} assist result (see fields assembled below)
 */
export async function assistApply({
  // `mode` and `approval` stay in the documented call shape (callers pass
  // them), but nothing in this function reads them.
  packet, config, mode: _mode, approval: _approval, dailyCount = 0, options = {}, deps = {},
} = {}) {
  const url = packet?.job?.url;
  const result = {
    jobId: packet?.job?.id ?? null,
    url: url ?? null,
    status: LIFECYCLE.ASSIST_STARTED,
    guard: { blocked: false },
    filled: [],
    unresolved: [],
    // Every question this run could not answer, deduplicated across steps and
    // carrying the live form's own metadata (required? what choices?). The
    // dashboard feeds these into the screening-answer queue so answering one by
    // hand covers every future application that asks the same thing.
    needsUser: [],
    uploads: { uploaded: [], blockers: [], skipped: [] },
    blockers: [...(packet?.blockers ?? [])],
    submitSelector: null,
    submitSelectorConfident: false,
    sponsorshipTruthful: true,
    requiredFieldsFilled: false,
    submitted: false,
    sessionLeftOpen: false,
    // Resumable-workflow trail: every phase transition with a timestamp, so the
    // human (and the audit log) can see exactly where a run got to —
    // Queued -> Precheck -> Opening -> Filling -> Validating -> Advancing ->
    // Blocked / ReadyForReview / Submitted / SubmitUnverified.
    phases: [],
    resumed: false,
    duplicatePrevented: false,
    applicationState: null,
    applicationStatePath: null,
    // Every screening answer actually committed on the live form, with the
    // option text the employer will read — the packet only records what we
    // PLANNED to say. Auto-submit compares the two (see tryAutoSubmit).
    liveAnswers: [],
  };
  const clock = deps.now ?? (() => new Date());
  const nowIso = () => {
    const value = typeof clock === 'function' ? clock() : clock;
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };
  const phaseEvent = (name, detail = null) => {
    result.phases.push({ phase: name, at: nowIso(), ...(detail ? { detail } : {}) });
  };

  let stateStore;
  let applicationState;
  try {
    stateStore = resolveApplicationStateStore({
      packet,
      root: config?.root,
      statePath: options.statePath,
      store: deps.stateStore,
      // Checkpoints are per search profile: see applicationStatePath.
      profileId: config?.profile?.id ?? null,
    });
    result.applicationStatePath = stateStore?.path ?? (typeof options.statePath === 'string' ? options.statePath : null);
    const loaded = stateStore ? await stateStore.load?.() : null;
    if (loaded) {
      try {
        assertApplicationStateMatchesPacket(loaded, packet);
        applicationState = loaded;
        result.resumed = true;
      } catch (err) {
        // A user may replace a stale/aggregator URL with the direct employer
        // application URL. That is still the SAME tracked job, but the old
        // page/step checkpoint is unsafe to resume. Start a fresh checkpoint
        // for the new URL; keep failing closed for a different job id.
        if (!/state URL does not match/i.test(err.message)) throw err;
        applicationState = createApplicationState(packet, { now: clock });
        result.checkpointReset = true;
        phaseEvent(APPLICATION_PHASE.QUEUED, 'application URL changed; starting from the new link');
        if (stateStore) await stateStore.save?.(applicationState);
      }
    } else {
      applicationState = createApplicationState(packet, { now: clock });
      phaseEvent(APPLICATION_PHASE.QUEUED);
      if (stateStore) await stateStore.save?.(applicationState);
    }
    result.applicationState = applicationState;
  } catch (err) {
    result.status = LIFECYCLE.FAILED;
    result.blockers.push(`application state could not be loaded: ${err.message}`);
    return result;
  }

  const checkpoint = async (name, patch = {}, detail = null) => {
    phaseEvent(name, detail);
    applicationState = transitionApplicationState(applicationState, name, patch, { now: clock, detail });
    try {
      if (stateStore) await stateStore.save?.(applicationState);
    } catch (err) {
      const wrapped = new Error(`application state checkpoint failed: ${err.message}`);
      wrapped.applicationStatePersistence = true;
      throw wrapped;
    }
    result.applicationState = applicationState;
    result.currentStep = applicationState.currentStep;
    return applicationState;
  };

  // A reported submission is a write-once duplicate guard. Until verification
  // exists, the safe action is human review — never re-open and possibly apply
  // a second time.
  if (applicationStatePreventsReopen(applicationState)) {
    result.duplicatePrevented = true;
    result.status = applicationState.phase === APPLICATION_PHASE.VERIFIED
      ? LIFECYCLE.SUBMITTED
      : LIFECYCLE.SUBMIT_UNVERIFIED;
    result.note = applicationState.phase === APPLICATION_PHASE.VERIFIED
      ? 'Application is already verified; browser assist was not reopened.'
      : 'Application was already reported submitted and awaits verification; browser assist was not reopened to prevent a duplicate.';
    return result;
  }

  if (!url) {
    result.status = LIFECYCLE.FAILED;
    result.blockers.push('packet has no application URL');
    try {
      await checkpoint(APPLICATION_PHASE.BLOCKED, { blockers: result.blockers }, 'packet has no application URL');
    } catch { /* the primary error is already actionable */ }
    return result;
  }

  // WHOSE APPLICATION IS THIS? The dashboard and CLI each asked before reusing
  // a stored packet, but every one of those checks lived in a caller, and a
  // caller that forgot (or a new one) filled a packet built for somebody else.
  // The runner is the one path every fill goes through, so the check lives
  // here too — before a browser opens, before anything is typed.
  const owned = (deps.ownershipCheck ?? packetOwnershipCheck)(packet, config ?? {});
  if (!owned.ok) {
    result.status = LIFECYCLE.ASSIST_BLOCKED;
    result.blockers.push(
      `packet_not_owned: this packet is not the active candidate's — ${owned.reason}. `
      + 'Prepare it again so the documents and answers describe whoever is applying.',
    );
    try {
      await checkpoint(APPLICATION_PHASE.BLOCKED, { blockers: result.blockers }, 'packet belongs to another candidate');
    } catch { /* the ownership refusal is the actionable error */ }
    return result;
  }

  // Sponsorship truthfulness is checked from the packet (no browser needed).
  try {
    await checkpoint(APPLICATION_PHASE.PRECHECK, {
      blockers: result.blockers,
      unresolvedQuestions: packet?.screeningPlan?.needsUser ?? [],
      resumeCount: applicationState.resumeCount + (result.resumed ? 1 : 0),
    });
  } catch (err) {
    result.status = LIFECYCLE.FAILED;
    result.blockers.push(err.message);
    return result;
  }
  // Packet-level truthfulness. Plan entries carry their question `label`, so
  // this also catches an affirmative answer to an INVERTED sponsorship question
  // (a bare "Yes" whose text looks innocent but whose meaning is false).
  // Judged against the candidate's OWN requirement: the same sentence is a lie
  // for one person and the truth for another, and the packet is built from a
  // profile that states which.
  const truthCheck = assertTruthfulSponsorship(packet?.screeningPlan?.answered ?? [], {
    requiresSponsorship: config?.candidate?.workAuthorization?.requiresSponsorship
      ?? config?.candidate?.sponsorshipRequired,
  });
  result.sponsorshipTruthful = truthCheck.truthful;
  if (!truthCheck.truthful) {
    result.blockers.push(`sponsorship answer not truthful: ${truthCheck.violations.join('; ')}`);
  }

  const createSession = deps.createSession ?? createBrowserSession;
  const openPage = deps.openPage ?? openApplicationPage;
  const headless = options.headless ?? config?.runtime?.headless ?? false;
  const channel = options.channel ?? config?.runtime?.browserChannel ?? null;
  // Slow each action down so the human can watch the bot type/click/upload.
  const slowMo = options.slowMo ?? config?.runtime?.browserSlowMo ?? 0;
  // Persist the browser profile across runs so you sign in ONCE (Indeed, ATS
  // SSO, etc.) and the saved cookies are reused next time — no repeated logins.
  // An explicit BROWSER_USER_DATA_DIR wins; otherwise default to a dedicated,
  // project-local profile folder. The folder is channel-specific so a real
  // Edge/Chrome profile never clashes with bundled Chromium's profile version,
  // AND it is SEPARATE from your everyday browser's profile so launching it
  // never conflicts with an already-running browser (which would otherwise
  // forward the command to the live instance and leave a dead about:blank tab).
  // Pass userDataDir:false to force isolation.
  //
  // PER SEARCH PROFILE. One shared `.browser-profile` meant the second
  // candidate inherited the first one's ATS sessions, autofill and saved
  // logins — a Workday account signed in as somebody else. With an active
  // profile id the folder is `.browser-profile-<profileId>[-<channel>]`.
  // MIGRATION: installs with no profile id keep the historical
  // `.browser-profile[-<channel>]` folder, so nobody is signed out by this
  // change; after creating a profile, sign in once more in its own browser
  // (or copy the old folder to the new name to carry the cookies over).
  let userDataDir = options.userDataDir ?? config?.runtime?.browserUserDataDir ?? null;
  if (userDataDir === null && config?.root) {
    userDataDir = join(config.root, browserProfileDirName({ channel, profileId: config?.profile?.id }));
  }
  if (userDataDir === false) userDataDir = null;

  let session;
  try {
    session = await createSession({ headless, slowMo, channel, userDataDir, deps });
  } catch (err) {
    // A missing browser binary is an ENVIRONMENT problem, not a failed
    // application: nothing about the job or packet is wrong, and "failed"
    // sent users to the RCA panel to read Playwright's 10-line ASCII banner.
    // It is recorded as blocked with a stable `browser_unavailable:` code the
    // dashboard classifies, and one line that says what to run.
    if (isBrowserMissingError(err)) {
      result.status = LIFECYCLE.ASSIST_BLOCKED;
      result.statusReason = `${BROWSER_UNAVAILABLE_CODE}: ${BROWSER_UNAVAILABLE_MESSAGE}`;
      result.blockers.push(result.statusReason);
      try {
        await checkpoint(APPLICATION_PHASE.BLOCKED, {
          currentStep: applicationState.currentStep,
          lastUrl: applicationState.lastUrl ?? url,
          blockers: result.blockers,
        }, 'browser not installed');
      } catch { /* the missing browser is the actionable error */ }
      return result;
    }
    result.status = LIFECYCLE.FAILED;
    // The most common cause when reusing a real browser profile is that the
    // browser is still running and holding a lock on the profile directory.
    const hint = channel
      ? ` — if you set BROWSER_USER_DATA_DIR, close every ${channel === 'msedge' ? 'Microsoft Edge' : channel} window first (a profile can only be opened by one process at a time)`
      : '';
    result.blockers.push(`could not start browser: ${stripPlaywrightBanner(err.message)}${hint}`);
    try {
      await checkpoint(APPLICATION_PHASE.BLOCKED, {
        currentStep: applicationState.currentStep,
        lastUrl: applicationState.lastUrl ?? url,
        blockers: result.blockers,
      }, 'browser session could not start');
    } catch { /* preserve the browser startup error */ }
    return result;
  }

  try {
    const { page } = session;
    const dryRun = options.dryRun === true;
    // LIVE_ASSIST walks multi-step forms, clicking only safe forward controls
    // (Next/Continue/Review) — never a final Submit. Cap the number of pages.
    const maxSteps = Math.max(1, Number(options.maxSteps ?? config?.runtime?.assistMaxSteps ?? 8));
    const candidate = config?.candidate ?? {};
    const screeningAnswers = config?.screeningAnswers ?? {};
    const inspectPage = deps.inspectPage ?? inspectCurrentPage;

    // ── Opt-in final submit ─────────────────────────────────────────────
    // Default behavior is unchanged: fill and STOP before submit. The final
    // Submit is clicked ONLY when the human explicitly chose auto-submit for
    // THIS run (options.autoSubmit), and only on a completely clean form:
    // zero blockers, all required fields filled, truthful sponsorship
    // answers, a confidently-identified unique submit control, and the
    // daily application cap not yet reached.
    const autoSubmit = options.autoSubmit === true;
    const dailyCap = Math.max(1, Number(config?.runtime?.maxApplicationsPerDay ?? 15) || 15);
    const tryAutoSubmit = async (scope) => {
      if (!autoSubmit) return false;
      if (result.blockers.length > 0) return false;
      if (!result.sponsorshipTruthful || !result.requiredFieldsFilled) return false;
      if (!result.submitSelector || !result.submitSelectorConfident) return false;
      // A legal / immigration / demographic answer chosen LIVE that the human
      // never reviewed in the packet is not covered by their approval: they
      // approved "Yes, I require sponsorship", not whichever option a live
      // widget ended up showing, and not an answer to a question the packet
      // did not know about.
      const unreviewed = unreviewedSensitiveAnswers(result.liveAnswers, packet?.screeningPlan?.answered ?? []);
      if (unreviewed.length) {
        result.autoSubmitWithheld = unreviewed.map((a) => `live answer to "${a.label}" ("${a.value}") was not in the reviewed packet`);
        result.note = `auto-submit withheld — ${result.autoSubmitWithheld[0]}; review it and submit yourself`;
        return false;
      }
      // Ask the live DOM, not the static plan, whether anything required is
      // still blank. `null` means the scope cannot be inspected (a unit-test
      // double); a real Playwright page always can.
      const blankRequired = await unfilledRequiredControls(scope);
      if (Array.isArray(blankRequired) && blankRequired.length) {
        result.requiredFieldsFilled = false;
        result.autoSubmitWithheld = blankRequired.map((l) => `required field is empty: ${l}`);
        result.note = `auto-submit withheld — ${blankRequired.length} required field(s) still empty (${blankRequired.slice(0, 3).join(', ')})`;
        return false;
      }
      if ((dailyCount ?? 0) >= dailyCap) {
        result.note = `daily application cap reached (${dailyCap}) — filled but left for you to submit`;
        return false;
      }
      const beforeUrl = currentUrlOf(page) ?? url;
      // What the page said BEFORE the click. A confirmation phrase that was
      // already on screen ("Once your application is submitted, you cannot
      // edit it") is not evidence that this click submitted anything.
      const baseline = await submitBaseline(page, scope);
      // Write-ahead duplicate guard: if the process dies after the click but
      // before confirmation inspection, a future run must not click Submit a
      // second time. `submitting` means the attempt is write-ahead protected;
      // it is intentionally not `verified` yet.
      await checkpoint(APPLICATION_PHASE.SUBMITTING, {
        currentStep: result.currentStep,
        lastUrl: beforeUrl,
        blockers: [],
        submissionEvidence: ['explicit per-run auto-submit authorization', 'submit attempt initiated'],
      }, 'final submit attempt initiated; verification required');
      // selectorOnly: click ONLY the selector we just verified resolves to
      // exactly one control. No accessible-name fallback on the submit path.
      const clicked = await clickAndSettle(
        scope, { selector: result.submitSelector, text: 'Submit' }, deps, { selectorOnly: true },
      );
      if (!clicked) {
        await checkpoint(APPLICATION_PHASE.VERIFYING, {
          currentStep: result.currentStep,
          lastUrl: currentUrlOf(page) ?? beforeUrl,
          blockers: ['submit control could not be confirmed after the attempt'],
          submissionEvidence: ['explicit per-run auto-submit authorization', 'submit attempt initiated'],
        }, 'submit attempt could not be confirmed; manual verification required');
        result.submitted = false;
        result.status = LIFECYCLE.SUBMIT_UNVERIFIED;
        result.note = 'The final submit attempt could not be confirmed. Automatic retry is disabled to prevent a duplicate; review the ATS and confirmation email manually.';
        return true;
      }
      // A click is not a submission. Verify before reporting `submitted` —
      // an unverified click is surfaced to the human, never recorded as applied.
      await checkpoint(APPLICATION_PHASE.VERIFYING, {
        currentStep: result.currentStep,
        lastUrl: currentUrlOf(page) ?? beforeUrl,
        blockers: [],
        submissionEvidence: ['explicit per-run auto-submit authorization', 'submit control clicked'],
      }, 'submit control clicked; checking confirmation evidence');
      const verification = await verifySubmission({ page, url, beforeUrl, inspectPage, baseline, strict: true });
      result.submitVerification = verification;
      if (verification.verified) {
        result.submitted = true;
        result.status = LIFECYCLE.SUBMITTED;
        result.note = `auto-submitted — submission confirmed (${verification.signals.join(', ')})`;
        await checkpoint(APPLICATION_PHASE.VERIFIED, {
          currentStep: result.currentStep,
          lastUrl: verification.lastUrl ?? currentUrlOf(page) ?? beforeUrl,
          blockers: [],
          verificationEvidence: verification.signals,
        }, 'submission confirmation detected');
      } else {
        result.submitted = false;
        result.status = LIFECYCLE.SUBMIT_UNVERIFIED;
        result.note = 'Submit was clicked but no confirmation page could be detected — check the open '
          + 'browser tab and your email for an ATS confirmation. If it went through, use "Mark submitted"; '
          + 'otherwise finish the application manually. NOT recorded as submitted.';
      }
      return true;
    };

    // Blockers that persist across every step (packet-level + sponsorship).
    const baseBlockers = [...result.blockers];
    // Cumulative state across multi-step pages.
    const uploadedTypes = new Set(
      (applicationState.uploadVerification ?? []).filter((u) => u.verified === true).map((u) => u.type),
    );
    let dynamicNeedsUser = [];
    let staticUnresolved = [];
    const fieldResultKeys = new Set();
    const uploadResultKeys = new Set();
    const addFilledResult = (field, step) => {
      const key = `${step}|${field.selector ?? field.field ?? field.label ?? ''}`;
      if (fieldResultKeys.has(key)) return;
      fieldResultKeys.add(key);
      result.filled.push({ ...field, step });
    };
    const needsUserKeys = new Set();
    const addNeedsUser = (item, step, source) => {
      const label = String(item?.label ?? item ?? '').trim();
      if (!label) return;
      const key = label.toLowerCase();
      if (needsUserKeys.has(key)) return;
      needsUserKeys.add(key);
      result.needsUser.push({
        label,
        required: item?.required === true,
        kind: item?.kind ?? null,
        options: Array.isArray(item?.options) ? item.options : [],
        source,
        step,
      });
    };
    const addUploadResult = (upload, step) => {
      const key = `${step}|${upload.type ?? ''}|${upload.selector ?? ''}`;
      if (uploadResultKeys.has(key)) return;
      uploadResultKeys.add(key);
      result.uploads.uploaded.push({ ...upload, step });
    };

    // 1. Open + guard. Never proceed past a protected page.
    // Resume at the saved step — unless that URL was a wall. Reopening a
    // CAPTCHA/login page "where we left off" only ever hits the same wall (or
    // an expired SSO callback); the job's own URL is the safe restart.
    const resumeUrl = result.resumed && applicationState.lastUrl && !unsafeResumeUrl(applicationState)
      ? applicationState.lastUrl : url;
    await checkpoint(APPLICATION_PHASE.OPENING, {
      currentStep: applicationState.currentStep,
      lastUrl: resumeUrl,
      blockers: baseBlockers,
    }, result.resumed ? 'resuming last checkpoint URL' : 'opening application URL');
    let nav = await openPage(page, resumeUrl);
    result.guard = nav.guard;
    if (nav.guard?.blocked) {
      result.status = LIFECYCLE.ASSIST_BLOCKED;
      result.blockers = [...baseBlockers, `page blocked (${nav.guard.kind}): ${nav.guard.reason}`];
      result.sessionLeftOpen = !headless;
      await checkpoint(APPLICATION_PHASE.BLOCKED, {
        currentStep: applicationState.currentStep,
        lastUrl: nav.url ?? resumeUrl,
        blockers: result.blockers,
        lastUrlUnsafe: true,
      }, `page blocked (${nav.guard.kind})`);
      return result;
    }

    result.steps = 0;
    let currentStep = Math.max(1, Number(applicationState.currentStep) || 1);
    for (let runStep = 0; runStep < maxSteps; runStep++) {
      if (deps.shouldCancel?.()) {
        result.status = LIFECYCLE.CANCELLED;
        result.note = 'Application run cancelled at a safe checkpoint. Resume to continue from the saved URL.';
        await checkpoint(APPLICATION_PHASE.CANCELLED, {
          currentStep: applicationState.currentStep,
          lastUrl: currentUrlOf(page) ?? applicationState.lastUrl ?? url,
          blockers: [],
        }, 'user requested cancellation');
        return result;
      }
      const stepNumber = currentStep;
      result.steps = runStep + 1;
      result.currentStep = stepNumber;

      // Re-inspect + re-guard on every step after the first (we navigated via a
      // "Next"/"Continue" click, so the DOM/URL may have changed entirely).
      if (runStep > 0) {
        nav = await inspectPage(page, resumeUrl);
        result.guard = nav.guard;
        if (nav.guard?.blocked) {
          result.status = LIFECYCLE.ASSIST_BLOCKED;
          result.blockers = [...baseBlockers, `page blocked (${nav.guard.kind}): ${nav.guard.reason}`];
          result.sessionLeftOpen = !headless;
          await checkpoint(APPLICATION_PHASE.BLOCKED, {
            currentStep: stepNumber,
            lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
            blockers: result.blockers,
            lastUrlUnsafe: true,
          }, `page blocked (${nav.guard.kind})`);
          return result;
        }
      }

      const stepBlockers = [];

      // The form may be EMBEDDED in an ATS iframe (e.g. dropbox.com / samsara.com
      // hosting a Greenhouse form). Resolve the frame that actually holds the
      // fields and run every fill/scan/upload/navigate against it; falls back to
      // the page when the form is top-level (or for unit-test fakes).
      const scope = await resolveFormScope(page);
      // A page with neither application fields nor a way forward is still
      // drawing (Oracle's cookie banner can render and hold still before the
      // posting and its "Apply Now" exist). Look again for a bounded while
      // instead of deciding on a half-drawn page.
      await waitForFormOrWayIn(scope, deps.formWaitMs ?? 10000);
      await checkpoint(APPLICATION_PHASE.FILLING, {
        currentStep: stepNumber,
        lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
        blockers: baseBlockers,
      }, `step ${stepNumber}`);

      const stepFilledKeys = new Set();
      const completedThisStep = [];

      // 2a. Re-resolve the static plan on every page. Normally it only matches
      // page one; on a resumed same-URL SPA this safely restores deterministic
      // fields instead of trusting that a previous browser process retained
      // them.
      const fill = await fillFields(scope, packet.fillPlan, { dryRun });
      for (const f of fill.filled) {
        if (f.selector) stepFilledKeys.add(f.selector);
        completedThisStep.push(f);
        addFilledResult(f, stepNumber);
      }
      staticUnresolved = fill.unresolved ?? [];
      for (const err of fill.errors ?? []) stepBlockers.push(`field ${err.field}: ${err.error}`);

      // 2b. Dynamic, type-aware fill of whatever is actually on the page now.
      // Only the application's own controls: a header search box or a
      // newsletter signup is neither filled nor counted as "this page has a
      // form" (see applicationFields / allowApplyStart below).
      const scanned = applicationFields(await scanFields(scope));
      const dyn = await fillScannedFields(scope, scanned, { candidate, screeningAnswers, alreadyFilled: stepFilledKeys });
      for (const f of dyn.filled ?? []) {
        completedThisStep.push(f);
        addFilledResult(f, stepNumber);
      }
      dynamicNeedsUser = dyn.needsUser ?? [];
      for (const err of dyn.errors ?? []) stepBlockers.push(`field ${err.label ?? err.field}: ${err.error}`);

      // A checkbox/radio/select can reveal a conditional question. Re-scan
      // once after applying the first dynamic batch and fill only newly visible
      // controls (stepFilledKeys prevents duplicate actions).
      const conditionalScan = applicationFields(await scanFields(scope));
      const conditional = await fillScannedFields(scope, conditionalScan, {
        candidate, screeningAnswers, alreadyFilled: stepFilledKeys,
      });
      for (const f of conditional.filled ?? []) {
        completedThisStep.push(f);
        addFilledResult(f, stepNumber);
      }
      const needsUserByKey = new Map(
        [...dynamicNeedsUser, ...(conditional.needsUser ?? [])]
          .map((item) => [`${item.selector ?? ''}|${item.label ?? ''}`, item]),
      );
      dynamicNeedsUser = [...needsUserByKey.values()];
      for (const f of [...(dyn.filled ?? []), ...(conditional.filled ?? [])]) {
        if (f.source !== 'screening') continue;
        result.liveAnswers.push({
          label: f.label ?? null, value: f.value ?? null, kind: f.kind ?? null, step: stepNumber,
        });
      }
      for (const err of conditional.errors ?? []) stepBlockers.push(`field ${err.label ?? err.field}: ${err.error}`);
      result.unresolved = staticUnresolved;

      // Invariant: the screening matcher must never answer an INVERTED
      // sponsorship question ("…work WITHOUT sponsorship?"). It refuses by
      // design, so reaching here means a config/matcher regression — treat it
      // as a hard blocker rather than submit a false immigration claim.
      for (const f of completedThisStep) {
        if (f.source === 'screening' && isInvertedSponsorshipQuestion(f.label)) {
          stepBlockers.push(
            `refusing to auto-answer an inverted sponsorship question: "${f.label}" — answer it yourself`,
          );
        }
      }

      // A dynamic form field we cannot answer blocks the run ONLY when the live
      // form marks it required. Optional unknowns (middle name, address line 2,
      // "decline to answer" EEO selects, …) are recorded and left blank so we
      // can still advance through the step.
      const requiredDynamicNeedsUser = dynamicNeedsUser.filter((nu) => nu.required === true);
      const optionalDynamicNeedsUser = dynamicNeedsUser.filter((nu) => nu.required !== true);
      result.optionalSkipped = optionalDynamicNeedsUser.map((nu) => nu.label ?? String(nu));

      // 3. Unknown screening questions (from the packet) + REQUIRED unknown form
      //    fields pause the run — we never fabricate answers.
      for (const nu of packet?.screeningPlan?.needsUser ?? []) {
        stepBlockers.push(`screening needs user: ${nu.label}`);
        addNeedsUser({ ...nu, required: true }, stepNumber, 'packet');
      }
      for (const nu of requiredDynamicNeedsUser) stepBlockers.push(`required field needs user: ${nu.label ?? nu}`);
      // Optional unknowns are captured too. They do not block the run, but they
      // are still fields left blank on a real application — worth answering once
      // rather than never learning they were skipped.
      for (const nu of dynamicNeedsUser) addNeedsUser(nu, stepNumber, 'form');

      // 4. Upload resume (+ optional cover letter). An upload input commonly
      //    appears only AFTER the public landing page or a profile/contact step.
      //    Hold "not found" errors until we know there is no safe forward
      //    control; otherwise the old flow blocked before clicking Workday's
      //    "Apply" button and never reached the actual upload step.
      const verifiedBeforeThisStep = new Set(uploadedTypes);
      const pendingUploadBlockers = [];
      const up = await uploadFiles(scope, packet.fillPlan, { dryRun });
      for (const u of up.uploaded ?? []) {
        addUploadResult(u, stepNumber);
        // A unit-test page double cannot inspect FileList (`verified: null`),
        // but a positive failure is never treated as success. Live Playwright
        // sessions always provide explicit true/false verification.
        if (u.type && u.verified !== false) uploadedTypes.add(u.type);
      }
      for (const s of up.skipped ?? []) result.uploads.skipped.push(s);
      for (const blocker of up.blockers ?? []) {
        const type = String(blocker).split(':', 1)[0];
        const alreadyVerified = verifiedBeforeThisStep.has(type);
        const merelyAbsentOnLaterStep = /(?:input not found|no upload selector resolved)/i.test(blocker);
        if (alreadyVerified && merelyAbsentOnLaterStep) continue;
        if (merelyAbsentOnLaterStep) {
          pendingUploadBlockers.push(blocker);
          continue;
        }
        stepBlockers.push(blocker);
        if (!result.uploads.blockers.includes(blocker)) result.uploads.blockers.push(blocker);
      }

      // 5. Required fields satisfied?
      const unresolvedQuestions = [
        ...(packet?.screeningPlan?.needsUser ?? []),
        ...dynamicNeedsUser,
      ];
      await checkpoint(APPLICATION_PHASE.VALIDATING, {
        currentStep: stepNumber,
        lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
        completedFields: completedThisStep,
        unresolvedQuestions,
        uploadVerification: up.uploaded ?? [],
        blockers: [...baseBlockers, ...stepBlockers],
      }, `step ${stepNumber}`);
      // Field-level errors visible right after OUR fill (a rejected date
      // format, a file the widget refused) — surfaced as blockers so the human
      // fixes them in the open browser instead of submitting a broken form.
      const fillErrors = await detectValidationErrors(scope);
      for (const e of fillErrors) stepBlockers.push(`form validation: ${e}`);
      const fieldVerification = await verifyFilledFields(scope, completedThisStep);
      result.fieldVerification ??= { accepted: [], rejected: [], unobservable: [] };
      for (const key of ['accepted', 'rejected', 'unobservable']) {
        result.fieldVerification[key].push(...(fieldVerification[key] ?? []).map((f) => ({ ...f, step: stepNumber })));
      }
      for (const rejected of fieldVerification.rejected ?? []) {
        stepBlockers.push(`field ${rejected.label ?? rejected.field ?? 'unknown'} was not accepted: ${rejected.reason}`);
      }
      const req = requiredFieldsSatisfied(result.filled, packet.fillPlan);
      // The auto-submit gate uses the STRICT form, which is not vacuously
      // satisfied by an empty static plan (see requiredFieldsSatisfied).
      result.requiredFieldsFilled = req.ok
        && requiredFieldsSatisfied(result.filled, packet.fillPlan, undefined, { strict: true }).ok;
      const pendingRequiredBlocker = req.ok ? null : `required fields missing: ${req.missing.join(', ')}`;

      // Rewrite the validating checkpoint with live acceptance results and the
      // final blocker set. The state contains only field identifiers/status —
      // never the values that were typed.
      const acceptedBySelector = new Map((fieldVerification.accepted ?? []).map((f) => [f.selector, f]));
      const rejectedBySelector = new Map((fieldVerification.rejected ?? []).map((f) => [f.selector, f]));
      const checkpointFields = completedThisStep.map((field) => {
        const accepted = acceptedBySelector.get(field.selector);
        const rejected = rejectedBySelector.get(field.selector);
        return {
          ...field,
          accepted: Boolean(accepted),
          verification: accepted ? 'live DOM retained an accepted value'
            : rejected?.reason ?? 'live value inspection unavailable',
        };
      });
      await checkpoint(APPLICATION_PHASE.VALIDATING, {
        currentStep: stepNumber,
        lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
        completedFields: checkpointFields,
        unresolvedQuestions,
        uploadVerification: up.uploaded ?? [],
        blockers: [...baseBlockers, ...stepBlockers],
      }, `step ${stepNumber} validation complete`);

      // 6. Identify the FINAL submit control (for awareness only — we never click
      //    it). Prefer the packet's; otherwise discover one on the current page.
      let submitSelector = packet?.fillPlan?.submitSelector ?? null;
      let submitCount = submitSelector ? await safeCount(scope, submitSelector) : 0;
      if (submitCount !== 1) {
        const discovered = await findSubmitControl(scope);
        if (discovered?.selector && (await safeCount(scope, discovered.selector)) === 1) {
          submitSelector = discovered.selector;
          submitCount = 1;
        }
      }
      result.submitSelector = submitSelector;
      result.submitSelectorConfident = Boolean(submitSelector) && submitCount === 1;

      // Resolve the forward control BEFORE deciding that a planned input is
      // missing. Landing pages and early wizard steps are expected not to have
      // the eventual resume/contact controls yet. We may safely advance through
      // Apply/Start/Next/Continue, then re-scan the new DOM. A final Submit is
      // still excluded by findAdvanceControl and remains human-gated.
      // `scanned` already excludes search boxes, consent banners and signup
      // forms: a JD landing page with a header search box is still fieldless.
      const advance = await findAdvanceControl(scope, {
        allowApplyStart: scanned.length === 0 && result.filled.length === 0,
      });
      // A page with nothing of the application on it and no way forward is
      // reported as exactly that further down ("no application form found",
      // "sign-in required"). Reporting the resume input missing first sent
      // people looking for a broken upload on what was the job description.
      const nothingHere = scanned.length === 0 && result.filled.length === 0 && uploadedTypes.size === 0;
      if (!advance && !nothingHere) {
        if (pendingRequiredBlocker) stepBlockers.push(pendingRequiredBlocker);
        for (const blocker of pendingUploadBlockers) {
          stepBlockers.push(blocker);
          if (!result.uploads.blockers.includes(blocker)) result.uploads.blockers.push(blocker);
        }
      }

      result.blockers = [...baseBlockers, ...stepBlockers];

      // Hard stops (advancing cannot fix these): a page wall, an untruthful
      // sponsorship answer, or an unknown question that needs a human.
      const hardStop = result.guard?.blocked
        || result.sponsorshipTruthful === false
        || (packet?.screeningPlan?.needsUser?.length ?? 0) > 0
        || requiredDynamicNeedsUser.length > 0;
      if (hardStop) {
        result.status = LIFECYCLE.ASSIST_BLOCKED;
        result.sessionLeftOpen = !headless;
        await checkpoint(APPLICATION_PHASE.BLOCKED, {
          currentStep: stepNumber,
          lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
          completedFields: checkpointFields,
          unresolvedQuestions,
          uploadVerification: up.uploaded ?? [],
          blockers: result.blockers,
        }, 'needs the human (wall, sponsorship, or unknown required question)');
        return result;
      }

      // Outstanding blockers we can't auto-resolve (e.g. a missing required field
      // or a resume that wouldn't upload) stop the run for the human.
      if (result.blockers.length > 0) {
        result.status = LIFECYCLE.ASSIST_BLOCKED;
        result.sessionLeftOpen = !headless;
        await checkpoint(APPLICATION_PHASE.BLOCKED, {
          currentStep: stepNumber,
          lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
          completedFields: checkpointFields,
          unresolvedQuestions,
          uploadVerification: up.uploaded ?? [],
          blockers: result.blockers,
        }, result.blockers[0]);
        return result;
      }

      // Look for a safe forward control. If none exists, this is the final page:
      // everything is filled and ready — submit automatically ONLY if the human
      // opted in for this run AND the form is completely clean; otherwise stop
      // for the human to review and click Submit.
      // "Apply now"/"Start application" counts as an advance ONLY on a
      // fieldless landing page — on a filled quick-apply form that button IS
      // the submit, and clicking it would bypass the submit gate.
      // The step budget ran out with a way forward still on the page: more
      // pages remain. That is not "filled and ready", and it is never a final
      // page the submit gate may act on.
      if (advance && runStep === maxSteps - 1) {
        result.status = LIFECYCLE.ASSIST_BLOCKED;
        result.blockers = [...baseBlockers, `step limit reached: ${maxSteps} pages filled and the form continues ("${advance.text ?? 'Next'}"). Finish the remaining pages in the open window`];
        result.sessionLeftOpen = !headless;
        await checkpoint(APPLICATION_PHASE.BLOCKED, {
          currentStep: stepNumber,
          lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
          completedFields: checkpointFields,
          unresolvedQuestions,
          uploadVerification: up.uploaded ?? [],
          blockers: result.blockers,
        }, 'step budget exhausted with pages remaining');
        return result;
      }
      if (!advance) {
        // Never call a page "filled and ready" when no application form was
        // ever found: that told the user to review and Submit a form the run
        // had not reached (Workday's start dialog, a posting with no Apply).
        if (scanned.length === 0 && result.filled.length === 0 && uploadedTypes.size === 0) {
          result.status = LIFECYCLE.ASSIST_BLOCKED;
          const pageWords = visibleText(nav?.html ?? '');
          const signIn = /\b(sign\s*in|log\s*in|create\s+(?:an\s+)?account)\b/i.test(pageWords);
          const hidden = await shadowFormControlCount(scope);
          result.blockers = [...baseBlockers, hidden > 0
            ? `form not readable: ${hidden} field(s) on this page sit inside components the assistant cannot read. Fill this application yourself in the open window`
            : signIn
              ? 'sign-in required: this site asks you to sign in or create an account before the application form. Do that in the open window, then retry auto-fill'
              : 'no application form found: open the posting, continue to the application form, then retry auto-fill'];
          result.sessionLeftOpen = !headless;
          await checkpoint(APPLICATION_PHASE.BLOCKED, {
            currentStep: stepNumber,
            lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
            completedFields: checkpointFields,
            unresolvedQuestions,
            uploadVerification: up.uploaded ?? [],
            blockers: result.blockers,
          }, 'no application form found');
          return result;
        }
        if (await tryAutoSubmit(scope)) {
          result.sessionLeftOpen = !headless; // leave the confirmation page visible
          return result;
        }
        // "Ready" means every required control the live form shows is filled,
        // checked the same way the auto-submit gate checks it.
        const blankRequired = await unfilledRequiredControls(scope);
        if (Array.isArray(blankRequired) && blankRequired.length) {
          result.status = LIFECYCLE.ASSIST_BLOCKED;
          result.requiredFieldsFilled = false;
          result.blockers = [...baseBlockers, ...blankRequired.map((l) => `required field is empty: ${l}`)];
          result.sessionLeftOpen = !headless;
          await checkpoint(APPLICATION_PHASE.BLOCKED, {
            currentStep: stepNumber,
            lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
            completedFields: checkpointFields,
            unresolvedQuestions,
            uploadVerification: up.uploaded ?? [],
            blockers: result.blockers,
          }, `${blankRequired.length} required field(s) still empty`);
          return result;
        }
        result.status = LIFECYCLE.READY_FOR_SUBMIT;
        result.sessionLeftOpen = !headless;
        await checkpoint(APPLICATION_PHASE.READY_FOR_REVIEW, {
          currentStep: stepNumber,
          lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
          completedFields: checkpointFields,
          unresolvedQuestions,
          uploadVerification: up.uploaded ?? [],
          blockers: [],
        }, 'filled — waiting for YOUR review and Submit');
        return result;
      }

      await checkpoint(APPLICATION_PHASE.ADVANCING, {
        currentStep: stepNumber,
        lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
        completedFields: checkpointFields,
        unresolvedQuestions,
        uploadVerification: up.uploaded ?? [],
        blockers: [],
      }, `step ${stepNumber}: ${advance.text ?? advance.selector ?? 'next'}`);
      const beforeStep = await stepFingerprint(page, scope);
      const confirmationBefore = await submitBaseline(page, scope);
      const clicked = await clickAndSettle(scope, advance, deps);
      if (!clicked) {
        if (await tryAutoSubmit(scope)) {
          result.sessionLeftOpen = !headless;
          return result;
        }
        result.status = LIFECYCLE.READY_FOR_SUBMIT;
        result.sessionLeftOpen = !headless;
        await checkpoint(APPLICATION_PHASE.READY_FOR_REVIEW, {
          currentStep: stepNumber,
          lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
          completedFields: checkpointFields,
          unresolvedQuestions,
          uploadVerification: up.uploaded ?? [],
          blockers: [],
        }, 'advance control could not be activated — waiting for YOUR review');
        return result;
      }

      // Validate immediately after navigation. ATSes commonly keep the same URL
      // and render inline errors when a step was rejected; a resolved click is
      // therefore not proof that advancing succeeded.
      const afterAdvance = await inspectPage(page, resumeUrl);
      result.guard = afterAdvance.guard;
      if (afterAdvance.guard?.blocked) {
        result.status = LIFECYCLE.ASSIST_BLOCKED;
        result.blockers = [...baseBlockers,
          `page blocked (${afterAdvance.guard.kind}): ${afterAdvance.guard.reason}`];
        result.sessionLeftOpen = !headless;
        await checkpoint(APPLICATION_PHASE.BLOCKED, {
          currentStep: stepNumber,
          lastUrl: afterAdvance.url ?? currentUrlOf(page) ?? resumeUrl,
          blockers: result.blockers,
          lastUrlUnsafe: true,
        }, `page blocked after advancing (${afterAdvance.guard.kind})`);
        return result;
      }
      const afterScope = await resolveFormScope(page);
      const navigationErrors = await detectValidationErrors(afterScope);
      if (navigationErrors.length) {
        result.status = LIFECYCLE.ASSIST_BLOCKED;
        result.blockers = [...baseBlockers, ...navigationErrors.map((e) => `form validation: ${e}`)];
        result.sessionLeftOpen = !headless;
        await checkpoint(APPLICATION_PHASE.BLOCKED, {
          currentStep: stepNumber,
          lastUrl: afterAdvance.url ?? currentUrlOf(page) ?? resumeUrl,
          completedFields: checkpointFields,
          unresolvedQuestions,
          uploadVerification: up.uploaded ?? [],
          blockers: result.blockers,
        }, 'validation errors after advancing');
        return result;
      }
      // An "Apply now" that the run took for the way IN may have been the
      // final submit of a quick-apply form it could not read. If a thank-you
      // message appeared that was not there before, say so and stop: the job
      // may have been submitted, and only the human can tell.
      if (APPLY_START_RE.test(advance.text ?? '') && !confirmationBefore.confirmation
        && SUBMIT_CONFIRMATION_RE.test(visibleText(afterAdvance.html ?? ''))) {
        result.status = LIFECYCLE.SUBMIT_UNVERIFIED;
        result.submitted = false;
        result.blockers = [...baseBlockers];
        result.note = `Clicking "${advance.text}" showed a confirmation message, so this may already have been submitted. `
          + 'Check the open window and your email, then record it. NOT recorded as submitted.';
        result.sessionLeftOpen = !headless;
        return result;
      }
      // A click that changed nothing did not advance. ATSes that reject a step
      // with markup this run does not recognise look exactly like this, and
      // treating it as progress re-filled the same page and reported it ready.
      const afterStep = await stepFingerprint(page, afterScope);
      if (beforeStep && afterStep && beforeStep === afterStep) {
        result.status = LIFECYCLE.ASSIST_BLOCKED;
        result.blockers = [...baseBlockers, `could not advance: the page did not change after clicking "${advance.text ?? 'Next'}". Check the open window for a message on this step`];
        result.sessionLeftOpen = !headless;
        await checkpoint(APPLICATION_PHASE.BLOCKED, {
          currentStep: stepNumber,
          lastUrl: afterAdvance.url ?? currentUrlOf(page) ?? resumeUrl,
          completedFields: checkpointFields,
          unresolvedQuestions,
          uploadVerification: up.uploaded ?? [],
          blockers: result.blockers,
        }, 'advance click did not change the page');
        return result;
      }
      result.advancedSteps = (result.advancedSteps ?? 0) + 1;
      currentStep = stepNumber + 1;
      nav = afterAdvance;
      await checkpoint(APPLICATION_PHASE.ADVANCING, {
        currentStep,
        lastUrl: afterAdvance.url ?? currentUrlOf(page) ?? resumeUrl,
        completedFields: checkpointFields,
        unresolvedQuestions: [],
        uploadVerification: up.uploaded ?? [],
        blockers: [],
      }, `step ${stepNumber} accepted; checkpointed step ${currentStep}`);
      // loop continues to the next step
    }

    // Exhausted the step budget — leave it filled and ready for the human.
    result.status = result.blockers.length > 0 ? LIFECYCLE.ASSIST_BLOCKED : LIFECYCLE.READY_FOR_SUBMIT;
    result.sessionLeftOpen = !headless;
    await checkpoint(result.blockers.length > 0 ? APPLICATION_PHASE.BLOCKED : APPLICATION_PHASE.READY_FOR_REVIEW, {
      currentStep,
      lastUrl: nav.url ?? currentUrlOf(page) ?? resumeUrl,
      blockers: result.blockers,
    }, 'assist step budget exhausted');
    return result;
  } catch (err) {
    // The human closing the assist browser window is a normal, deliberate act
    // (they finished the application by hand, or decided "not now") — NOT a
    // failure and NOT a wall. Report it as ready_for_submit so the dashboard
    // prompts "did you submit it?" instead of scaring them with "blocked".
    if (isBrowserClosedError(err)) {
      const submitMayHaveStarted = [
        APPLICATION_PHASE.SUBMITTING, APPLICATION_PHASE.VERIFYING,
        APPLICATION_PHASE.USER_SUBMITTED,
      ].includes(applicationState.phase);
      result.status = submitMayHaveStarted ? LIFECYCLE.SUBMIT_UNVERIFIED : LIFECYCLE.READY_FOR_SUBMIT;
      result.browserClosedByUser = true;
      result.note = submitMayHaveStarted
        ? 'Browser closed during the final submit attempt. Automatic retry is disabled; verify the ATS or confirmation email manually.'
        : 'Browser was closed during assist — if you finished and submitted the application yourself, mark it Submitted; otherwise resume the application.';
      if (!submitMayHaveStarted) {
        try {
          await checkpoint(APPLICATION_PHASE.READY_FOR_REVIEW, {
            currentStep: result.currentStep ?? applicationState.currentStep,
            lastUrl: currentUrlOf(session?.page) ?? applicationState.lastUrl ?? url,
            blockers: [],
          }, 'browser closed by user');
        } catch { /* state persistence error is surfaced on the next resume */ }
      }
      return result;
    }
    result.status = LIFECYCLE.FAILED;
    result.blockers.push(`assist error: ${err.message}`);
    if (!err.applicationStatePersistence && !applicationStatePreventsReopen(applicationState)) {
      try {
        await checkpoint(APPLICATION_PHASE.FAILED, {
          currentStep: result.currentStep ?? applicationState.currentStep,
          lastUrl: currentUrlOf(session?.page) ?? applicationState.lastUrl ?? url,
          blockers: result.blockers,
        }, 'unexpected assist error');
      } catch { /* preserve the original assist error */ }
    }
    return result;
  } finally {
    // Close only when we are NOT intentionally leaving the browser open for the
    // human (headed + stopped before submit). In headless/CI, always close.
    if (!result.sessionLeftOpen) {
      await session.close?.();
    } else if (shouldWatchForHumanSubmit(result, options, session?.page)) {
      // The human has the window now. If they submit and the ATS shows its
      // confirmation page, record that as a human submission PENDING their
      // confirmation — it used to go unrecorded until they remembered to press
      // "Mark submitted", while the job still read "ready to submit" and a
      // re-run could reopen it.
      result.watchingForHumanSubmit = true;
      const inspect = deps.inspectPage ?? inspectCurrentPage;
      result.humanSubmitWatch = watchForHumanSubmission({
        page: session.page,
        url,
        inspectPage: inspect,
        pollMs: options.humanSubmitPollMs,
        timeoutMs: options.humanSubmitWatchMs,
        onConfirmed: async (verification) => {
          const evidence = [
            'confirmation page seen after hand-off to the human',
            ...verification.signals,
          ];
          try {
            const next = transitionApplicationState(applicationState, APPLICATION_PHASE.USER_SUBMITTED, {
              lastUrl: verification.lastUrl ?? url,
              submissionEvidence: evidence,
              blockers: [],
            }, { now: clock, detail: 'confirmation page detected after the human took over' });
            applicationState = next;
            if (stateStore) await stateStore.save?.(next);
          } catch { /* the DB record below is still made */ }
          const update = {
            jobId: result.jobId,
            status: LIFECYCLE.SUBMIT_UNVERIFIED,
            submitted: false,
            filled: result.filled,
            blockers: [],
            humanSubmissionDetected: {
              at: nowIso(),
              url: verification.lastUrl ?? null,
              signals: verification.signals,
            },
            phases: [{ phase: APPLICATION_PHASE.USER_SUBMITTED, at: nowIso(), detail: 'confirmation page detected' }],
          };
          try { await deps.onHumanSubmitted?.(update); } catch { /* recording is best-effort here */ }
        },
      });
    }
  }
}

/** Should the runner watch a handed-over window for the human's submission? */
function shouldWatchForHumanSubmit(result, options, page) {
  if (options.watchHumanSubmit === false || result.submitted) return false;
  if (![LIFECYCLE.READY_FOR_SUBMIT, LIFECYCLE.ASSIST_BLOCKED].includes(result.status)) return false;
  return Boolean(page) && typeof page.on === 'function';
}

/** Default: stop watching a handed-over window after 45 minutes. */
const HUMAN_SUBMIT_WATCH_MS = 45 * 60 * 1000;

/**
 * Watch a page the human is finishing for the ATS's confirmation page.
 *
 * Evidence is the SAME as for an auto-submit (`verifySubmission`), but only
 * its strongest signal counts here: a visible confirmation message. "The URL
 * changed and the form is gone" is what a human browsing away looks like, so
 * it is not accepted. A confirmation phrase already visible when watching
 * starts (a sidebar "Thanks for applying to other roles") only counts after
 * the page has navigated. Stops on the first match, when the page closes, or
 * after `timeoutMs`.
 *
 * @param {object} args
 * @param {object} args.page Playwright page
 * @param {string} args.url application URL (fallback for inspection)
 * @param {Function} args.inspectPage inspectCurrentPage-compatible
 * @param {(verification: object) => Promise<void>|void} args.onConfirmed
 * @param {number} [args.pollMs=1500]
 * @param {number} [args.timeoutMs]
 * @returns {{ stop: () => void, readonly stopped: boolean, ready: Promise<void> }}
 */
export function watchForHumanSubmission({
  page, url, inspectPage = inspectCurrentPage, onConfirmed, pollMs = 1500, timeoutMs = HUMAN_SUBMIT_WATCH_MS,
} = {}) {
  let stopped = false;
  let checking = false;
  let navigated = false;
  let baselineHit = false;
  const timers = [];
  const trail = [];
  const remember = (u) => { if (u && trail.at(-1) !== u) trail.push(u); if (trail.length > 50) trail.shift(); };
  try { remember(page.url?.()); } catch { /* fakes */ }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const t of timers) { clearInterval(t); clearTimeout(t); }
    try { page.off?.('framenavigated', onNavigate); } catch { /* ignore */ }
    try { page.off?.('close', stop); } catch { /* ignore */ }
  };

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      if (page.isClosed?.()) { stop(); return; }
      let here = null;
      try { here = page.url?.() ?? null; } catch { here = null; }
      const destination = postSubmitDestination(trail, here);
      remember(here);
      if (destination) {
        stop();
        await onConfirmed?.({ verified: true, signals: [`post-submit page: ${destination}`], lastUrl: here });
        return;
      }
      if (baselineHit && !navigated) return;
      const verification = await verifySubmission({ page, url, beforeUrl: null, inspectPage });
      if (!stopped && verification.verified && verification.signals.includes('confirmation message')) {
        stop();
        await onConfirmed?.(verification);
      }
    } catch { /* a page mid-navigation is checked again on the next tick */ } finally {
      checking = false;
    }
  };

  function onNavigate(frame) {
    // Only the PAGE navigating is evidence the human moved on. An ad, analytics
    // or chat-widget iframe loading used to set `navigated` too — and that flag
    // is what lets a confirmation phrase already on screen ("Thanks for
    // applying to other roles" in a sidebar) count as this job's submission.
    try {
      if (frame && typeof page.mainFrame === 'function' && frame !== page.mainFrame()) return;
    } catch { return; }
    navigated = true;
    try { remember(frame?.url?.() ?? page.url?.()); } catch { /* ignore */ }
    // Give the new document a moment to render its confirmation text.
    const t = setTimeout(check, 250);
    t.unref?.();
    timers.push(t);
  }

  page.on('framenavigated', onNavigate);
  page.on('close', stop);
  const ready = (async () => {
    try {
      const html = await page.content();
      baselineHit = SUBMIT_CONFIRMATION_RE.test(visibleText(html));
    } catch { baselineHit = false; }
    if (stopped) return;
    const poll = setInterval(check, Math.max(50, Number(pollMs) || 1500));
    poll.unref?.();
    timers.push(poll);
    const deadline = setTimeout(stop, Math.max(1000, Number(timeoutMs) || HUMAN_SUBMIT_WATCH_MS));
    deadline.unref?.();
    timers.push(deadline);
  })();

  return { stop, get stopped() { return stopped; }, ready };
}

/**
 * Folder name of the persistent browser profile for a search profile/channel.
 * @param {{channel?: string|null, profileId?: string|null}} args
 * @returns {string}
 */
export function browserProfileDirName({ channel = null, profileId = null } = {}) {
  const profile = String(profileId ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return ['.browser-profile', profile, channel].filter(Boolean).join('-');
}

/** Lower-case, punctuation-free comparison form of a label or answer. */
function normAnswer(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Live answers to sensitive questions (sponsorship, authorization, legal,
 * EEO) that the reviewed packet does not contain with the same meaning.
 *
 * A live answer is "reviewed" when the packet planned an answer for the same
 * question and the committed text is that answer, or starts with the same
 * yes/no. Exported for tests.
 *
 * @param {Array<{label: string, value: string}>} live result.liveAnswers
 * @param {Array<{label?: string, answer?: string, value?: string}>} reviewed packet.screeningPlan.answered
 * @returns {Array<{label: string, value: string}>}
 */
export function unreviewedSensitiveAnswers(live = [], reviewed = []) {
  const planned = new Map(reviewed
    .filter((r) => r?.label)
    .map((r) => [normAnswer(r.label), normAnswer(r.answer ?? r.value)]));
  const lead = (t) => (/^(yes|y)\b/.test(t) ? 'yes' : /^(no|n)\b/.test(t) ? 'no' : null);
  return live.filter((a) => {
    const label = String(a?.label ?? '');
    if (!isSensitiveChoiceLabel(label) && !isSponsorshipTopic(label)) return false;
    const want = planned.get(normAnswer(label));
    if (want === undefined) return true;
    const got = normAnswer(a.value);
    if (!got) return true;
    if (got === want || want.startsWith(got) || got.startsWith(want)) return false;
    return !(lead(got) && lead(got) === lead(want));
  });
}

/** Was the checkpoint's last URL a wall (flagged, or a login-shaped URL)? */
function unsafeResumeUrl(state) {
  if (state?.lastUrlUnsafe === true) return true;
  return detectBlocker({ url: String(state?.lastUrl ?? '') }).blocked;
}

/** Count selector matches (0 on error / missing selector). */
async function safeCount(page, selector) {
  if (!selector) return 0;
  try { return await page.locator(selector).count(); } catch { return 0; }
}

/**
 * Phrases that ATSes render after a REAL submission. Deliberately conservative:
 * a miss only downgrades to `submit_unverified` (human verifies), while a false
 * positive would fabricate a submission — so nothing ambiguous belongs here.
 */
export const SUBMIT_CONFIRMATION_RE = new RegExp([
  'thank you for applying',
  'thanks for applying',
  'thank you for your (?:job )?application',
  'application (?:was |has been )?successfully (?:submitted|received|sent)',
  'you(?:\'|’)?ve successfully applied',
  'you have successfully applied',
  'application (?:was |has been |is )?(?:received|submitted|complete|sent)',
  'successfully (?:submitted|applied)',
  'submission (?:was |has been )?(?:received|complete|successful)',
  "we(?:'|’)?ve received your application",
  'your application has been sent',
].join('|'), 'i');

/**
 * Where an ATS sends you AFTER a successful submit, when it shows no "thank
 * you" text. Oracle Recruiting Cloud is the case that went unrecorded
 * (2026-11-12): Submit on /job/<id>/apply/section/N lands on /my-profile,
 * "My Applications", with no confirmation phrase, so the hand-off watcher —
 * which only trusted that phrase — never noticed the human had applied.
 *
 * `from` must have been seen in THIS window before `to`: arriving at "My
 * Applications" from the application form is the evidence, not the page on
 * its own. It is still recorded only as "submitted — please confirm".
 */
export const POST_SUBMIT_PAGES = Object.freeze([
  {
    name: 'Oracle Recruiting "My Applications"',
    from: /\/CandidateExperience\/.*\/job\/[^/?#]+\/apply\/(?!email\b)/i,
    to: /\/CandidateExperience\/[^?#]*\/my-profile\b/i,
  },
  {
    name: 'Greenhouse confirmation',
    from: /greenhouse\.io\/[^?#]*\/jobs\/\d+(?![^?#]*\/confirmation)/i,
    to: /greenhouse\.io\/[^?#]*\/jobs\/\d+\/confirmation\b/i,
  },
  {
    name: 'Lever thank-you page',
    from: /jobs\.lever\.co\/[^/]+\/[^/?#]+\/apply\b/i,
    to: /jobs\.lever\.co\/[^/]+\/[^/?#]+\/thanks\b/i,
  },
]);

/**
 * The post-submit page this window reached from its application form, if any.
 * @param {string[]} trail main-frame URLs seen, oldest first
 * @param {string} current the URL now
 * @returns {string|null} the page's name
 */
export function postSubmitDestination(trail = [], current = '') {
  for (const rule of POST_SUBMIT_PAGES) {
    if (!rule.to.test(current ?? '')) continue;
    if (trail.some((u) => u !== current && rule.from.test(u ?? ''))) return rule.name;
  }
  return null;
}

/** Current page URL, or null when the page object cannot report one. */
function currentUrlOf(page) {
  try { return typeof page?.url === 'function' ? (page.url() || null) : null; } catch { return null; }
}

/**
 * Text an ERROR page shows. Matched against the page's visible text and title,
 * never the raw HTML — every large site ships these same strings inside its
 * JavaScript bundles as templates for errors that have not happened.
 */
const SUBMIT_FAILURE_RE = new RegExp([
  '\\b[45]\\d{2}\\b[^.]{0,20}\\b(error|forbidden|not found|unavailable|bad gateway|timeout)',
  '\\binternal server error\\b',
  '\\bservice (?:is )?(?:temporarily )?unavailable\\b',
  '\\bbad gateway\\b',
  '\\bgateway time-?out\\b',
  '\\bpage (?:not found|cannot be found|is unavailable)\\b',
  '\\bsomething went wrong\\b',
  '\\ban? (?:unexpected |unknown )?error (?:has )?occurred\\b',
  '\\bwe(?:\'|’)?re having (?:some )?(?:technical )?(?:trouble|difficulties)\\b',
  '\\byour session (?:has )?expired\\b',
  '\\bapplication error\\b',
  '\\brequest (?:has )?failed\\b',
].join('|'), 'i');

/** Re-exported: the page guard and submit verification share one definition. */
export { visibleText };

/**
 * Does this page say the request FAILED?
 *
 * Verification treated "the URL changed and the form is gone" as proof of
 * submission, and both of those are equally true of a redirect to an error
 * page. Reproduced against a mock: a redirect to an HTTP 500 page returned
 * `status: "submitted", submitted: true`, on the evidence "page navigated,
 * form gone" — and because the tracker then counts the job as applied, the
 * duplicate guard discourages the retry that would have actually submitted it.
 *
 * So the absence of a form is no longer read as success on its own. An error
 * page vetoes verification outright, including over a confirmation phrase: a
 * page showing both is ambiguous, and the cost of being wrong here is a human
 * checking their email, against an application the user believes they sent and
 * did not.
 *
 * @param {{status?: number|null, html?: string}} page
 * @returns {string|null} the reason, or null when nothing says failure
 */
export function submissionFailureSignal({ status = null, html = '' } = {}) {
  if (Number.isFinite(status) && status >= 400) return `server responded ${status}`;
  const text = visibleText(html);
  const title = (String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? '';
  const hit = SUBMIT_FAILURE_RE.exec(title) ?? SUBMIT_FAILURE_RE.exec(text.slice(0, 4000));
  return hit ? `error page (${hit[0].trim().slice(0, 60)})` : null;
}

/**
 * Verify that a clicked Submit actually submitted.
 *
 * Evidence accepted (guard must not be blocked — a post-submit CAPTCHA is not
 * a confirmation):
 *   - a known confirmation message on the page (or inside the ATS iframe), OR
 *   - the URL changed AND the form fields are gone (classic redirect-to-
 *     thank-you flow with nothing left to fill).
 *
 * @returns {Promise<{ verified: boolean, signals: string[] }>}
 */
async function verifySubmission({ page, url, beforeUrl, inspectPage, baseline = null, strict = false }) {
  let after;
  try { after = await inspectPage(page, url); } catch { after = null; }
  if (!after) return { verified: false, signals: ['post-submit inspection failed'], lastUrl: currentUrlOf(page) ?? beforeUrl };
  if (after.guard?.blocked) {
    return { verified: false, signals: [`post-submit wall (${after.guard.kind})`], lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl };
  }

  const signals = [];
  let html = after.html ?? '';
  let formGone;
  try {
    // The confirmation (and any leftover form) may live inside an embedded ATS
    // iframe — include its content and its field count.
    const scope = await resolveFormScope(page, { timeoutMs: 500 });
    if (scope && scope !== page && typeof scope.content === 'function') {
      html += await scope.content();
    }
    // A confirmation page with a site search box still has "no form left".
    const fields = applicationFields(await scanFields(scope));
    formGone = Array.isArray(fields) && fields.length === 0;
  } catch { formGone = false; }

  // NEGATIVE EVIDENCE FIRST. A failed submission looks exactly like a
  // successful one to the two weaker signals below — it navigates somewhere new
  // and it has no form on it. See `submissionFailureSignal`.
  const failure = submissionFailureSignal({ status: after.status ?? null, html });
  if (failure) {
    return {
      verified: false,
      signals: [failure],
      lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl,
    };
  }

  // Matched against visible text, not raw HTML: "thank you for applying" ships
  // inside the JavaScript bundle of many ATSes as the template for a page the
  // applicant has not reached yet.
  const phrase = SUBMIT_CONFIRMATION_RE.test(visibleText(html));
  if (phrase && !(strict && baseline?.confirmation)) signals.push('confirmation message');
  const urlChanged = Boolean(after.url && beforeUrl && after.url !== beforeUrl);
  if (urlChanged) signals.push('page navigated');
  if (formGone) signals.push('form gone');
  const destination = strict && after.url ? postSubmitDestination([beforeUrl].filter(Boolean), after.url) : null;
  if (destination) signals.push(`post-submit page: ${destination}`);

  if (!strict) {
    const verified = signals.includes('confirmation message') || (urlChanged && formGone);
    return { verified, signals, lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl };
  }
  // STRICT (the auto-submit click). A phrase alone is not proof: it must be
  // new, and the page must have moved on (form gone or URL changed). Errors the
  // form shows after the click veto everything.
  let formErrors;
  try { formErrors = await detectValidationErrors(await resolveFormScope(page, { timeoutMs: 500 })); } catch { formErrors = []; }
  if (formErrors.length) {
    return { verified: false, signals: [...signals, `form errors after submit: ${formErrors.slice(0, 2).join('; ')}`], lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl };
  }
  const verified = Boolean(destination)
    || (signals.includes('confirmation message') && (formGone || urlChanged))
    || (urlChanged && formGone);
  return { verified, signals, lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl };
}

/**
 * What the page shows before a click that might submit: whether a
 * confirmation phrase is already visible. `confirmation: false` when the page
 * cannot be read (unit doubles), which keeps the old behaviour there.
 */
async function submitBaseline(page, scope) {
  let html;
  try { html = typeof page?.content === 'function' ? await page.content() : ''; } catch { html = ''; }
  try {
    if (scope && scope !== page && typeof scope.content === 'function') html += await scope.content();
  } catch { /* the page alone is enough */ }
  return { confirmation: SUBMIT_CONFIRMATION_RE.test(visibleText(html)) };
}

/**
 * A short fingerprint of the step a form is on: URL, headings and the labels
 * of its application fields. Equal before and after an advance click means
 * the click changed nothing. Null when the page cannot be read.
 */
async function stepFingerprint(page, scope) {
  if (!scope || typeof scope.evaluate !== 'function') return null;
  try {
    const shape = await scope.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden';
      };
      const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, legend, [role="heading"]'))
        .filter(visible).map(text).filter(Boolean).slice(0, 12).join('|');
      // A start dialog opening over the posting is progress even though the
      // URL, headings and fields behind it did not change.
      const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
        .filter(visible).map((d) => text(d).slice(0, 200)).join('|');
      const controls = Array.from(document.querySelectorAll('button, [role="button"], a[href], input:not([type="hidden"]), select, textarea'))
        .filter(visible).length;
      return `fp:${headings}\n${dialogs}\n${controls}`;
    });
    // Page doubles answer evaluate() with something else: unobservable.
    if (typeof shape !== 'string' || !shape.startsWith('fp:')) return null;
    const fields = applicationFields(await scanFields(scope)).map((f) => `${f.kind}:${f.label}`).join('|');
    return `${currentUrlOf(page) ?? ''}\n${shape}\n${fields}`;
  } catch {
    return null;
  }
}

/** True when an assist error means the HUMAN closed the browser/tab/window. */
export function isBrowserClosedError(err) {
  return /target (page|context|browser).*(closed|crashed)|browser has been closed|page.*has been closed|context.*has been closed|target closed/i
    .test(String(err?.message ?? err ?? ''));
}


/**
 * Wait (bounded) until a page shows application fields, a control that
 * moves forward, or its final Submit. Returns at once when either is already there, and on fakes
 * that cannot evaluate.
 * @param {object} scope Playwright page or frame
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true when something to act on appeared
 */
async function waitForFormOrWayIn(scope, timeoutMs) {
  if (!scope || typeof scope.evaluate !== 'function' || !(timeoutMs > 0)) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (applicationFields(await scanFields(scope)).length > 0) return true;
    if (await findAdvanceControl(scope, { allowApplyStart: true })) return true;
    // A final page may hold only its Submit (never clicked here) — it is drawn.
    if (await findSubmitControl(scope)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
