/**
 * The grounded-rewrite claim verifier (P1-2): a table of proposals, each
 * either backed by the cited master-resume text and profile, or refused for a
 * stated reason. The job posting is never evidence.
 */
import { describe, expect, it } from 'vitest';

import { namedTermsIn, numbersIn, profileTerms, verifyRewrite } from '../../src/resume/claimVerifier.js';

const ROLE_A = 'Data Engineer, Acme Corp | 2021 - Present';
const ROLE_B = 'Analyst, Globex | 2018 - 2021';
const units = new Map([
  ['u2', { id: 'u2', role: ROLE_A, text: 'Built medallion pipelines on Azure Databricks with PySpark, cutting nightly load time by 40%.' }],
  ['u3', { id: 'u3', role: ROLE_A, text: 'Developed Power BI semantic models for 12 finance teams.' }],
  ['u4', { id: 'u4', role: ROLE_A, text: 'Contributed to the migration of 3 legacy SSIS packages to Azure Data Factory.' }],
  ['u5', { id: 'u5', role: ROLE_A, text: 'Led a team of 4 engineers delivering the customer 360 data model.' }],
  ['u7', { id: 'u7', role: ROLE_B, text: 'Reduced reporting costs by $2M by consolidating Tableau licenses.' }],
  ['u8', { id: 'u8', role: ROLE_B, text: 'Wrote SQL reports for the sales team.' }],
]);
const profile = profileTerms({
  technicalStack: { languages: ['Python', 'SQL'], cloud: ['Azure'], biAndModeling: ['Power BI', 'DAX'] },
  certifications: ['Microsoft Certified: Azure Data Engineer Associate'],
  workHistory: [{ employer: 'Acme Corp', title: 'Data Engineer' }],
});
const vocabulary = ['kafka', 'snowflake', 'dbt', 'airflow', 'databricks', 'pyspark', 'python', 'sql', 'terraform'];
const check = (unitId, rewrite, evidenceIds = []) =>
  verifyRewrite({ unit: units.get(unitId), rewrite, evidenceIds, units, profile, vocabulary });

describe('claim verifier: accepted rewrites (P1-2)', () => {
  it.each([
    ['reordered emphasis', 'u2', 'Cut nightly load time by 40% by building Azure Databricks medallion pipelines with PySpark.'],
    ['plainer wording', 'u2', 'Built Azure Databricks medallion pipelines in PySpark that cut nightly load time by 40%.'],
    ['profile skill named', 'u3', 'Developed Power BI semantic models and DAX measures for 12 finance teams.'],
    ['same number, other phrasing', 'u3', 'Developed Power BI semantic models used by 12 finance teams.'],
    ['citing a sibling bullet of the same role', 'u3', 'Developed Power BI models on Azure Databricks data for 12 finance teams.', ['u2']],
    ['a number from a cited sibling', 'u3', 'Developed Power BI semantic models for 12 finance teams; loads 40% faster.', ['u2']],
    ['keeps "contributed"', 'u4', 'Contributed to moving 3 legacy SSIS packages onto Azure Data Factory.'],
    ['keeps "led"', 'u5', 'Led 4 engineers to deliver the customer 360 data model.'],
    ['other role, own evidence', 'u7', 'Consolidated Tableau licenses, reducing reporting costs by $2M.'],
    ['lowercase vocabulary already present', 'u8', 'Wrote SQL reports used by the sales team.'],
    ['profile language added', 'u8', 'Wrote SQL and Python reports for the sales team.'],
    ['employer from the profile', 'u8', 'Wrote SQL reports for the sales team at Acme Corp.'],
  ])('accepts: %s', (_name, unitId, rewrite, evidence = []) => {
    const r = check(unitId, rewrite, evidence);
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.evidence).toContain(unitId);
  });
});

describe('claim verifier: refused rewrites (P1-2)', () => {
  it.each([
    ['invented percentage', 'u2', 'Built Azure Databricks medallion pipelines with PySpark, cutting load time by 60%.', /numbers not in the cited resume text: 60%/],
    ['invented count', 'u3', 'Developed Power BI semantic models for 15 finance teams.', /numbers.*15/],
    ['invented money', 'u3', 'Developed Power BI semantic models for 12 finance teams, saving $500K.', /numbers.*500k/i],
    ['invented multiplier', 'u2', 'Built Azure Databricks pipelines with PySpark that made loads 3x faster.', /numbers.*3x/],
    ['invented year count', 'u8', 'Wrote SQL reports for the sales team over 5 years.', /numbers.*5/],
    ['number word', 'u8', 'Wrote SQL reports for the sales team across two regions.', /numbers.*two/],
    ['posting-only tool, capitalized', 'u2', 'Built medallion pipelines on Azure Databricks with PySpark and Kafka, cutting load time by 40%.', /Kafka/],
    ['posting-only tool, lowercase', 'u2', 'Built medallion pipelines on azure databricks with pyspark and kafka, cutting load time by 40%.', /kafka/],
    ['posting-only tool, acronym', 'u8', 'Wrote SQL and dbt reports for the sales team.', /dbt/],
    ['invented cloud', 'u4', 'Contributed to the migration of 3 legacy SSIS packages to AWS Glue.', /AWS/],
    ['invented employer', 'u8', 'Wrote SQL reports for the sales team at Initech.', /Initech/],
    ['invented certification', 'u8', 'Wrote SQL reports for the sales team as a Snowflake SnowPro Core holder.', /Snowflake|SnowPro/],
    ['contributed -> led', 'u4', 'Led the migration of 3 legacy SSIS packages to Azure Data Factory.', /more ownership/],
    ['contributed -> built', 'u4', 'Built the migration of 3 legacy SSIS packages to Azure Data Factory.', /more ownership/],
    ['built -> architected', 'u2', 'Architected medallion pipelines on Azure Databricks with PySpark, cutting nightly load time by 40%.', /more ownership/],
    ['wrote -> owned', 'u8', 'Owned SQL reports for the sales team.', /more ownership/],
    ['too long', 'u8', 'Wrote SQL reports for the sales team, documenting every metric definition and walking each regional lead through the numbers each week.', /length changed too much/],
    ['too short', 'u2', 'Built pipelines.', /length changed too much/],
    ['unchanged', 'u8', 'Wrote SQL reports for the sales team.', /does not change anything/],
    ['empty', 'u8', '   ', /empty/],
  ])('refuses: %s', (_name, unitId, rewrite, reason) => {
    const r = check(unitId, rewrite);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' | ')).toMatch(reason);
  });

  it('refuses borrowing an achievement from another job', () => {
    const r = check('u8', 'Wrote SQL reports for the sales team, using Azure Databricks data.', ['u2']);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/different role/);
  });

  it('refuses a cross-role citation even when the words are fine', () => {
    expect(check('u3', 'Developed Power BI semantic models for 12 finance teams and the sales team.', ['u8']).ok).toBe(false);
  });

  it('refuses citations that do not exist', () => {
    const r = check('u8', 'Wrote SQL reports used by the sales team.', ['u99']);
    expect(r.reasons.join(' ')).toMatch(/not in the master resume: u99/);
  });

  it('refuses a rewrite of a unit that is not in the master', () => {
    const r = verifyRewrite({ unit: { id: 'u42', text: 'x', role: null }, rewrite: 'y', units, profile, vocabulary });
    expect(r.ok).toBe(false);
  });

  it('never lets a profile skill stand in for a number', () => {
    // "Python" is in the profile, but the 20% is backed by nothing.
    expect(check('u8', 'Wrote SQL and Python reports, 20% faster, for the sales team.').reasons.join(' ')).toMatch(/20%/);
  });

  it('treats a number from another role as unbacked', () => {
    expect(check('u3', 'Developed Power BI semantic models for 12 finance teams, saving $2M.', ['u7']).ok).toBe(false);
  });
});

describe('extraction helpers', () => {
  it('finds numbers in their many shapes', () => {
    expect(numbersIn('Cut costs 40% and $2.5M, 3x faster, 1,200 users, two teams').sort())
      .toEqual(['1200', '2.5m', '3x', '40%', 'two'].sort());
  });

  it('finds named things but not ordinary sentence starts', () => {
    expect(namedTermsIn('Built PySpark jobs on AWS with C# and .NET for Acme')).toEqual(['PySpark', 'AWS', 'C#', 'NET', 'Acme']);
    expect(namedTermsIn('Built and tested reliable pipelines')).toEqual([]);
  });
});
