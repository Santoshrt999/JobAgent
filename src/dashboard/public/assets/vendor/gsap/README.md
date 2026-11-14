# GSAP (vendored)

`gsap.min.js` and `ScrollTrigger.min.js` are the unmodified `dist/` files of
the npm package `gsap` 3.13.0. They are loaded only by Explore JobAgent
(`assets/explore/index.html`), which uses them to play its scenes as the page
is scrolled. Nothing else in the dashboard depends on them, and the Explore
page still shows every picture, finished and still, when they are absent.

They are copied here, not fetched from a CDN, because the dashboard's Content
Security Policy allows scripts from its own origin only.

GSAP is NOT covered by this repository's MIT license. It is Copyright
GreenSock (Webflow) and is used under the GSAP "Standard no charge license",
whose terms are linked from the header of each file. Keep those headers.

To update: `npm pack gsap@<version>`, copy the two `dist/*.min.js` files over
these, update the version here, in `THIRD_PARTY_NOTICES.md` and in
`docs/LICENSE_REVIEW.md`, and run `npx vitest run tests/node/explorePage.test.js`.
