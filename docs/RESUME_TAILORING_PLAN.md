# Resume tailoring: what to fix next

The plan for the next tailoring PR. Every item below was measured on a real
resume on 2026-11-12. The examples are generic stand-ins of the same shape, not
text from that resume.

The rules that do not change: tailoring never invents a skill, claim, metric or
title, never rewords a bullet without verified evidence, and opens the master
resume read-only. Every fix below works inside those rules.

## What we measured

A real resume prepared for a software engineering posting:

| Measure | Result | Expected |
|---|---|---|
| Section headings recognized by `tailor.py` | 0 of 6 | all 6 |
| Changes made | 1 keyword bolded, plus layout cleanup | skills, summary and bullets reordered toward the job |
| Length | 3 pages | 2 (the default budget) |
| ATS match | 14% | noticeably higher after tailoring |
| Job titles found by the profile parser | 0 | one per role |

The tailored copy was effectively the master resume. Nothing failed loudly: the
packet said `resumeTailored: true`, so the problem was invisible.

## Root causes

1. **Headings ending in a colon are not recognized.** `_norm_heading` in
   `src/resume/tailor.py` lowercases and collapses spaces but keeps the trailing
   `:`. "PROFESSIONAL SUMMARY:", "EDUCATION:" and "TECHNICAL SKILLS:" all miss.
   Every step that works per section (skill reordering, summary and bullet
   prioritization, page fitting) then has no section to work on.
2. **The heading vocabulary is too narrow.** Common variants are missing:
   two-word qualifiers ("Relevant Work Experience", "Volunteer Work Experience"),
   less common sections ("Affiliations", "Skills & Tools"), and headings with
   detail after a comma ("Projects, <organization>").
3. **Any line with a date counts as a role heading.** `_is_role_heading` matched
   9 lines: an education entry, a "Grade:" line, project lines and a bullet.
   Trimming and reordering then treat those as employment blocks.
4. **The page budget is not enforced when it fails.** The result stayed at 3
   pages with no warning, because trimming only works inside a recognized
   experience section.
5. **The profile parser (Node) has its own copies of the same bugs.**
   - `src/resume/docxText.js` keeps the text of drawing-position elements
     (`<wp:posOffset>`, `<wp:align>`), so a heading arrives as
     "123456789EXPERIENCE:".
   - `src/resume/resumeProfile.js` allows one word before "experience".
   - Lines labelled "Title:" and "Grade:" are not understood: the parser took
     a "Grade: Vice President" line as the current title.
   - Skills split inside brackets: "Databases (SQL, NoSQL)" became
     "Databases (SQL" and "NoSQL)".
   With no titles found, the profile kept the template's "Senior Data Engineer",
   which is why search returned data-engineering jobs for a resume in a
   different field.

## The fixes, in order

### P0: recognize the resume's structure

- [ ] **Normalize headings before matching**, in both `tailor.py` and
      `resumeProfile.js`: strip a trailing `:` and other end punctuation, and
      any leading drawing-anchor digits.
- [ ] **One heading vocabulary for both languages.** Move it to a JSON file
      (for example `config/resume_sections.json`) read by Python and Node, so
      the two parsers cannot drift again. Accept qualifiers before a known head
      noun ("relevant work experience", "volunteer work experience") and
      trailing detail after a comma ("projects, <organization>").
- [ ] **Drop drawing-position text in `docxText.js`.** Remove `<wp:posOffset>`,
      `<wp:align>` and the rest of `wp:positionH/V` before stripping tags.
- [ ] **Bracket-aware skill splitting in the Node parser,** the same rule
      `_split_skill_list` already uses in Python.

### P1: find roles correctly

- [ ] **A role heading needs a role shape,** not just a date: a title or employer
      plus a date range, and only inside an experience section. Education,
      projects and affiliations are never roles.
- [ ] **Understand labelled lines.** "Title:" names the role; "Grade:", "Level:"
      and "Band:" are seniority, not a title. Use them for seniority instead.
- [ ] **Read seniority from the summary** when no title states it
      ("Senior engineer with N years…").

### P1: make tailoring visible and honest

- [ ] **Say when tailoring did almost nothing.** If no section was recognized or
      fewer than N changes were made, set `resumeTailored: "partial"` and show
      "Tailoring could not read this resume's sections" in the job's Tailored
      resume box, with the headings it did not recognize.
- [ ] **Warn when the page budget is missed,** with the page count, instead of
      silently returning 3 pages.
- [ ] **Show before and after** in the Tailored resume box: ATS match before
      tailoring and after, keywords emphasized, items reordered.

### P2: better results inside the no-invention rules

- [ ] **Order bullets within each role** by how many of the job's required terms
      they evidence (this exists, but never ran on this resume; re-measure after P0).
- [ ] **Order summary sentences** the same way, moving sentences intact.
- [ ] **Order skill categories,** not only the skills inside each category, so
      the category that matches the job comes first.
- [ ] **Turn the "Most relevant to this role" line on by default** once P0 lands,
      since it only uses terms that are both requested and already present.
- [ ] **Report gaps by importance:** a missing *required* skill first, with the
      line in the posting that asks for it.

## Tests to add

- [ ] A synthetic fixture resume (no real person) with colon headings,
      "Title:"/"Grade:" lines, a drawing anchor before a heading, and a project
      section with dates. Assert every heading is recognized, roles are exactly
      the employment entries, skills reorder toward a sample job, and the result
      fits 2 pages.
- [ ] The same fixture through the Node parser: titles, seniority and skills
      (including "Databases (SQL, NoSQL)") come out right.
- [ ] A check that `tailor.py` and `resumeProfile.js` recognize the same
      headings, so the shared vocabulary stays shared.

## Done when

- [ ] On the measured resume, all section headings are recognized, the result
      fits 2 pages, and skills and bullets visibly move toward the job.
- [ ] The ATS match for the same posting goes up, and the before/after is shown.
- [ ] Every existing truth invariant still passes: no unit of the master is
      changed except by reordering, emphasis or an accepted, verified rewrite.
