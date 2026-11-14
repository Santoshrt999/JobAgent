/**
 * A stopped application says what the form wanted, in the form's own words,
 * instead of "Needs your help — open the application to complete the step…".
 */
import { describe, expect, it } from 'vitest';

import { classifyAttention } from '../../src/dashboard/data.js';

const blocked = (...blockers) => classifyAttention({ assist_blockers: JSON.stringify(blockers), url: 'https://acme.test/j' }, 'blocked');

describe('classifyAttention wording', () => {
  it('quotes a form that refused a step', () => {
    const a = blocked('form validation: You need to agree to the terms and conditions.');
    expect(a).toMatchObject({ kind: 'form_check', label: 'Finish a form step', retryable: true });
    expect(a.summary).toBe('The form said: "You need to agree to the terms and conditions."');
  });

  it('names the question a required field asked, and counts the rest', () => {
    const a = blocked('required field needs user: Phone', 'required field needs user: LinkedIn Profile');
    expect(a).toMatchObject({ kind: 'question', label: 'Answer a question' });
    expect(a.summary).toBe('The form needs your answer to "Phone" (and 1 more).');
  });

  it('keeps the specific walls ahead of both', () => {
    expect(blocked('sign-in required: this site asks you to sign in').kind).toBe('sign_in');
    expect(blocked('no application form found: open the posting').label).toBe('Continue to form');
  });
});
