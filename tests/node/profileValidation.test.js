/**
 * Field rules for the profile dialogs.
 *
 * Pure functions: text in, a specific message (or '') out. Every message says
 * what to do, not just that something is wrong, and the rules agree with what
 * the server enforces, so a person is told BEFORE a save is refused.
 */
import { describe, expect, it } from 'vitest';

const v = await import('../../src/dashboard/public/assets/js/validate.js');

describe('full name', () => {
  it.each([
    ['Alex Morgan', ''],
    ['  Alex   Morgan  ', ''],
    ['Alex', 'Enter a first and last name.'],
    ['', 'Enter a first and last name.'],
    ['   ', 'Enter a first and last name.'],
  ])('%j -> %j', (input, message) => expect(v.validateFullName(input)).toBe(message));
});

describe('email', () => {
  it.each([
    ['alex@example.com', ''],
    ['  alex.m+jobs@mail.example.co ', ''],
    ['', 'Enter your email address.'],
    ['alex', 'Enter a valid email address, like name@example.com.'],
    ['alex@', 'Enter a valid email address, like name@example.com.'],
    ['alex@example', 'Enter a valid email address, like name@example.com.'],
    ['a b@example.com', 'Enter a valid email address, like name@example.com.'],
  ])('%j -> %j', (input, message) => expect(v.validateEmail(input)).toBe(message));
});

describe('job titles', () => {
  it('needs at least one', () => {
    expect(v.validateRoles([])).toBe('Add at least one job title to search for.');
  });
  it('accepts one to fifteen', () => {
    expect(v.validateRoles(['Data Engineer'])).toBe('');
    expect(v.validateRoles(Array.from({ length: 15 }, (_, i) => `Role ${i}`))).toBe('');
  });
  it('refuses a sixteenth, and a title over 80 characters', () => {
    expect(v.validateRoles(Array.from({ length: 16 }, (_, i) => `Role ${i}`))).toBe('Keep it to 15 job titles or fewer.');
    expect(v.validateRoles(['x'.repeat(81)])).toBe('Keep each job title under 80 characters.');
  });
});

describe('phone', () => {
  it.each([
    ['9195550142', ''],
    ['(919) 555-0142', ''],
    ['+1 919 555 0142', ''],
    ['', 'Enter your phone number.'],
    ['555', 'Enter a phone number with at least 7 digits.'],
    ['call me', 'Enter a phone number with at least 7 digits.'],
  ])('%j -> %j', (input, message) => expect(v.validatePhone(input)).toBe(message));
});

describe('years of experience', () => {
  const MESSAGE = 'Years of experience must be a number between 0 and 50, like 8 or 8+.';
  it.each(['0', '8', '8+', '10+ years', '7.5', '12 yrs', ' 25 years ', '50'])('accepts %j', (input) => {
    expect(v.validateYears(input)).toBe('');
  });
  it.each(['', 'lots', '51', '-1', '8-10', 'eight', '8 years of Java', '1000'])('refuses %j', (input) => {
    expect(v.validateYears(input)).toBe(MESSAGE);
  });
});

describe('a saved answer', () => {
  it('cannot be empty, and says what to do instead', () => {
    expect(v.validateAnswerText('  ')).toBe('Type an answer, or delete this one.');
  });
  it('has a length limit the server also enforces', () => {
    expect(v.validateAnswerText('x'.repeat(2000))).toBe('');
    expect(v.validateAnswerText('x'.repeat(2001))).toBe('That answer is 2001 characters; the limit is 2000.');
  });
});

describe('question phrases', () => {
  it('needs at least one', () => {
    expect(v.validatePatterns([])).toBe('Add at least one phrase that identifies the question.');
  });
  it('refuses a phrase ending in punctuation, which could never match', () => {
    expect(v.validatePatterns(['years of experience?'])).toBe(
      '"years of experience?" ends in punctuation, so it would never match. Remove the last character.',
    );
  });
  it('accepts plain phrases', () => {
    expect(v.validatePatterns(['years of experience', 'how many years'])).toBe('');
  });
});

describe('a required details field', () => {
  it('names the field in the message', () => {
    expect(v.validateRequired('City', '')).toBe('City is required.');
    expect(v.validateRequired('City', ' ')).toBe('City is required.');
    expect(v.validateRequired('City', 'Austin')).toBe('');
  });
});

describe('reading the server\'s refusal of one answer', () => {
  it('finds which answer, and what is wrong with it', () => {
    expect(v.parseAnswerError('answer "require_sponsorship": that answer contains "need visa sponsorship", which contradicts your profile.'))
      .toEqual({ id: 'require_sponsorship', text: 'that answer contains "need visa sponsorship", which contradicts your profile.' });
  });
  it('returns null for anything else', () => {
    expect(v.parseAnswerError('two answers share the id "x"')).toBeNull();
    expect(v.parseAnswerError('')).toBeNull();
    expect(v.parseAnswerError(undefined)).toBeNull();
  });
});
