import { describe, it, expect } from 'vitest';

import { detectBlocker, isSafeToProceed } from '../../src/automation/guards.js';

describe('detectBlocker', () => {
  it('detects a reCAPTCHA challenge from page content', () => {
    const v = detectBlocker({ html: '<div class="g-recaptcha"></div> verify you are human' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('captcha');
  });

  it('detects an hCaptcha / turnstile challenge', () => {
    expect(detectBlocker({ html: 'cf-turnstile widget' }).kind).toBe('captcha');
    expect(detectBlocker({ html: 'please solve the hcaptcha' }).kind).toBe('captcha');
  });

  it('detects a login wall from content', () => {
    const v = detectBlocker({ html: 'You must be logged in to apply' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('login');
  });

  it('detects a login redirect from the URL', () => {
    const v = detectBlocker({ html: 'welcome', url: 'https://jobs.example.com/login?next=/apply' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('login');
  });

  // Measured 2026-11-13: Oracle Recruiting's Apply goes to .../apply/email, an
  // "Authentication screen" that asks for an email before the form exists. Its
  // wording ("You don't need to have an account") matches no login phrase, so the
  // run carried on and tried to fill a page with no application form on it.
  it('stops at Oracle Recruiting\'s email step, which comes before the application form', () => {
    const url = 'https://example.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345/apply/email';
    const v = detectBlocker({ html: "Authentication screen. You don't need to have an account. Email Address", url });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('login');
    expect(v.reason).toMatch(/Oracle/);
    expect(v.reason).toMatch(/email/i);
    expect(detectBlocker({ html: 'x', url: `${url}?lang=en` }).blocked).toBe(true);
  });

  it('does not stop on Oracle\'s posting page or on the form steps after the email step', () => {
    const base = 'https://example.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345';
    for (const url of [base, `${base}/apply/section/1`, `${base}/apply/emailed-me`]) {
      expect(detectBlocker({ html: 'Lead Software Engineer. Apply Now', url }).blocked).toBe(false);
    }
  });

  it('does not mistake /author-like paths for a /auth login redirect', () => {
    expect(detectBlocker({ html: 'welcome', url: 'https://jobs.example.com/authors-program' }).blocked).toBe(false);
    expect(detectBlocker({ html: 'welcome', url: 'https://example.com/careers/authorized-roles' }).blocked).toBe(false);
    expect(detectBlocker({ html: 'welcome', url: 'https://example.com/signing-bonus-jobs' }).blocked).toBe(false);
    // Real auth paths still trip the guard.
    expect(detectBlocker({ html: 'welcome', url: 'https://example.com/auth/callback' }).blocked).toBe(true);
    expect(detectBlocker({ html: 'welcome', url: 'https://example.com/auth' }).blocked).toBe(true);
  });

  it('detects an MFA prompt', () => {
    const v = detectBlocker({ html: 'Enter the verification code we sent to your phone' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('mfa');
  });

  it('detects bot protection (Cloudflare-style)', () => {
    const v = detectBlocker({ html: 'Checking your browser before accessing. Cloudflare' });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('bot');
  });

  it('detects the Indeed "Additional Verification Required" Cloudflare wall', () => {
    const v = detectBlocker({
      html: 'Additional Verification Required. Your Ray ID for this request is a074781a9cad3ae2. Troubleshooting Cloudflare Errors',
      url: 'https://www.indeed.com/viewjob?jk=01db32821377d68d',
      status: 200,
    });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('bot');
  });

  it('does NOT flag a real job page that merely embeds a reCAPTCHA widget', () => {
    // Career sites often embed reCAPTCHA on a "Get notified" newsletter form.
    // A large, content-rich page with a widget token must stay unblocked.
    const big = 'CenterWell Lead Data Engineer. Become a part of our caring community. '.repeat(2000)
      + '<div class="g-recaptcha" data-sitekey="x"></div><script src="recaptcha/api.js"></script>'
      + 'Get notified for similar jobs';
    const v = detectBlocker({ html: big, url: 'https://www.centerwellcareers.com/us/en/job/123', status: 200 });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe(null);
  });

  it('still flags a THIN dedicated captcha/turnstile interstitial', () => {
    expect(detectBlocker({ html: 'cf-turnstile widget', status: 200 }).kind).toBe('captcha');
    expect(detectBlocker({ html: 'please solve the hcaptcha', status: 200 }).kind).toBe('captcha');
  });

  it('maps HTTP status codes to blockers', () => {
    expect(detectBlocker({ status: 401 }).kind).toBe('login');
    expect(detectBlocker({ status: 403 }).kind).toBe('bot');
    expect(detectBlocker({ status: 429 }).kind).toBe('bot');
  });

  it('passes a clean application page', () => {
    const v = detectBlocker({ html: '<form id="application_form"><input id="email"></form>', status: 200 });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe(null);
    expect(isSafeToProceed({ html: 'apply now', status: 200 })).toBe(true);
  });

  it('ignores wall phrases that exist only inside script bundles', () => {
    // Regression: ATS bundles ship "please sign in to continue" / "unusual
    // traffic" as error templates; matching raw HTML stopped clean forms.
    const page = '<form><label>Email <input id="email"></label></form>'
      + '<script>const t={login:"Please sign in to continue",bot:"Unusual traffic from your network"}</script>';
    expect(detectBlocker({ html: page, status: 200 }).blocked).toBe(false);
    expect(detectBlocker({ html: '<p>Please sign in to continue</p>', status: 200 }).kind).toBe('login');
  });

  it('counts bot-vendor tokens only on thin pages or next to a challenge element', () => {
    const content = '<main>' + 'Lead Data Engineer responsibilities and benefits. '.repeat(200) + '</main>';
    const sensor = '<script src="https://js.datadome.co/tags.js"></script><div class="cf-ray-beacon"></div>'
      + '<script>window._pxAppId="PXabc"; /* perimeterx */</script>';
    expect(detectBlocker({ html: content + sensor, status: 200 }).blocked).toBe(false);
    expect(detectBlocker({ html: '<p>Access to this page is restricted.</p>' + sensor, status: 200 }).kind).toBe('bot');
    expect(detectBlocker({
      html: content + '<iframe src="https://geo.captcha-delivery.com/captcha/?x=1"></iframe><script src="https://js.datadome.co/tags.js"></script>',
      status: 200,
    }).kind).toBe('bot');
  });
});
