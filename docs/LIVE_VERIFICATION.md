# Live ATS verification

Final Auto-submit clicks **Submit** on a real application. JobAgent's filler is
tested against saved copies of each ATS's forms (local fixtures). Those tests
cannot show that the vendor's live page still has the same fields, or that its
confirmation page is still recognised.

So Auto-submit on an ATS also needs one supervised live run, recorded in
`config/verified_live_ats.json`. The file ships with an empty list. Until an ATS
is listed there, Auto-submit refuses it. Assisted fill still works on it; you
submit yourself.

## When to run it

- Before the first Auto-submit on an ATS.
- Again after a Playwright upgrade, or when a vendor visibly redesigns its forms.
- Again whenever a run on that ATS ends `submit_unverified`.

## The run (about 15 minutes per ATS)

You need a real posting you genuinely want to apply to, on the ATS being
verified: Greenhouse, Lever, Ashby, Workday or SmartRecruiters.

1. Prepare the application in the dashboard and review the packet: resume,
   answers, uploads. Approve it.
2. Use **Auto-apply** (assisted fill). It fills the form and stops before Submit.
3. Watch the browser and check, field by field:
   - every required field is filled, with the value from your packet;
   - the resume (and the cover letter, if required) is attached;
   - sponsorship, work-authorization and EEO questions are answered as you
     reviewed them, or left for you;
   - JobAgent stopped on the final review step and did not click Submit.
4. Submit the application yourself.
5. Confirm JobAgent noticed. The job should show "submitted, awaiting your
   confirmation" (a human submission it detected). If it did not notice, the
   confirmation page is not recognised. Do not record the ATS; report it instead.

## Record it

Add one entry to `config/verified_live_ats.json`:

```json
{
  "verified": [
    { "ats": "greenhouse", "date": "2026-11-20",
      "outcome": "all required fields filled; resume attached; stopped before Submit; human submission detected",
      "verifiedBy": "initials" }
  ]
}
```

Rules:
- Use one entry per ATS. A run on Lever does not cover Workday.
- `date` must be a real `YYYY-MM-DD` date, and `outcome` must not be empty.
  Incomplete entries are ignored.
- **No personal data:** no names, emails, employers, job titles or job ids.
  The file is committed.
- Also update the ATS row in `docs/SUPPORT_MATRIX.md` (filling section) with the date.

## Removing a verification

Delete the entry. Auto-submit on that ATS is refused again from the next run.
