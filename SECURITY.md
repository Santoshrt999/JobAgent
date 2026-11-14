# Security

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:
open the repository's **Security** tab and choose **Report a vulnerability**.
Include what you found, how to reproduce it, and what an attacker could do with it.

## How JobAgent is meant to run

JobAgent is a local tool. It runs on your own machine and is not designed to be
hosted for other people.

- The dashboard listens on `127.0.0.1` only. It rejects requests with a
  missing or non-loopback `Host` header (DNS rebinding), cross-site requests
  (Fetch Metadata), and state-changing requests from other origins or without a
  JSON body or `X-Job-Agent` header (CSRF). Pages are served with a strict
  Content-Security-Policy that blocks inline scripts.
- Every API request also needs the dashboard's access token, a random 256-bit
  value in `data/.dashboard-token` that only your user account can read. The
  launcher opens a link carrying it once, and it is exchanged for an HttpOnly,
  SameSite=Strict cookie. Other programs and other user accounts on the same
  computer cannot use the API without it. `npm run dashboard:link` prints the
  link again.
- URLs from you or from job postings (Add by URL, link checks, description
  enrichment, careers pages) are fetched only if every address they resolve to
  is public. The check runs when the connection is made, on every redirect, so
  a hostname that resolves to this computer or your network is refused.
- Job postings are untrusted text. The dashboard renders them as text, never as
  HTML, and only opens `http(s)` links. Database queries use bound parameters.
- The optional browser extension talks only to `127.0.0.1`, injects nothing into
  pages until you click it, and needs a 32+ byte shared key
  (`JOB_AGENT_EXTENSION_KEY`).
- The optional LLM assist is off by default. Requirement extraction, the only
  thing `LLM_ASSIST=on` does by itself, receives only the public job description
  and title, and every phrase it returns must appear verbatim in that posting.
  Features with their own switch send more: resume rewrites, refine and grounded
  cover letters send resume bullets; drafting a reply sends resume bullets and the
  email being answered; `INBOX_LLM=on` sends up to 6,000 characters of an email
  body to classify it. Contact details, EEO answers and salary expectations are
  not sent. A local provider (Ollama, LM Studio) keeps all of it on your computer.
- Nothing is submitted to an employer unless you opt in for that run; the
  default mode is `DRY_RUN`.

## Keeping your data private

Your profile, answers, resume, job database and `.env` are git-ignored. Never
force-add them, and never expose the dashboard port to a network (for example
with port forwarding or a tunnel).
