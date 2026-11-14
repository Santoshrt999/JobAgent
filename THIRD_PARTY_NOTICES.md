# Third-party notices

JobAgent's original source code and documentation are released under the
[MIT License](LICENSE). Dependencies and third-party assets retain their own
copyrights and licenses. The root license does not relicense those components.

## Bundled fonts

| Asset | Copyright | License |
| --- | --- | --- |
| `src/dashboard/public/assets/fonts/alex-brush.woff2` | Copyright 2011 The Alex Brush Project Authors | [SIL OFL 1.1](src/dashboard/public/assets/fonts/AlexBrush-OFL.txt) |
| `src/dashboard/public/assets/fonts/PlayfairDisplay-BoldItalic.woff2` | Copyright 2017 The Playfair Display Project Authors; Reserved Font Name: Playfair Display | [SIL OFL 1.1](src/dashboard/public/assets/fonts/PlayfairDisplay-OFL.txt) |
| `src/dashboard/public/assets/fonts/archivo-variable.woff2` | Copyright 2020 The Archivo Project Authors | [SIL OFL 1.1](src/dashboard/public/assets/fonts/Archivo-OFL.txt) |
| `src/dashboard/public/assets/fonts/instrument-serif-400.woff2` | Copyright 2022 The Instrument Serif Project Authors | [SIL OFL 1.1](src/dashboard/public/assets/fonts/InstrumentSerif-OFL.txt) |

Font names and copyright statements were checked against the bundled WOFF2
metadata. Upstream projects: [Alex Brush](https://github.com/googlefonts/alex-brush),
[Playfair Display](https://github.com/clauseggers/Playfair-Display)
[Archivo](https://github.com/Omnibus-Type/Archivo) (latin subset of the variable font, from `@fontsource-variable/archivo` 5.3.0)
and [Instrument Serif](https://github.com/Instrument/instrument-serif) (latin subset, regular, from `@fontsource/instrument-serif` 5.2.8).
Keep the corresponding OFL notice with each redistributed font. OFL fonts
remain under OFL; using them does not change the license of the application
or of screenshots made with them. See the [OFL FAQ](https://openfontlicense.org/ofl-faq/).

## Bundled scripts

| Asset | Copyright | License |
| --- | --- | --- |
| `src/dashboard/public/assets/vendor/gsap/gsap.min.js`, `ScrollTrigger.min.js` (GSAP 3.13.0) | Copyright 2025 GreenSock (Webflow). All rights reserved. | GSAP Standard "no charge" license, linked from each file's header. **Not MIT and not an open-source license.** |

GSAP drives the scroll-linked scenes of Explore JobAgent and nothing else. The
two files are the unmodified `dist/` builds from the npm package, copied in
because the dashboard's Content Security Policy forbids loading script from
another origin. Their license permits use at no charge, including in
commercial work, and has its own restrictions; it does not let you relicense
the files. Keep the header comment in each file. Anyone redistributing
JobAgent should read the license terms, or remove the two files: the Explore
page then shows the same content without motion. See
[the vendoring note](src/dashboard/public/assets/vendor/gsap/README.md).

## Installed packages

The npm dependency graph is pinned in `package-lock.json`; Python requirements
are declared in `requirements.txt` and `requirements-llm.txt`. These packages
are installed separately, not vendored into the application's source tree.
Preserve their license and notice files when distributing an installation,
container, binary bundle, or other package containing them.

The npm graph includes Lightning CSS and platform packages under **MPL-2.0**.
Their files remain MPL-licensed. Distributing them may require making the
corresponding MPL source available and retaining notices; it does not require
relicensing JobAgent's separate original source files. See
[Mozilla's MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) and
[Lightning CSS source](https://github.com/parcel-bundler/lightningcss).

See the dated [license review](docs/LICENSE_REVIEW.md) and
[npm inventory](docs/licenses/npm-dependencies.md) for the checked versions.
Recheck the inventory when dependencies change.

## Data, services, and identity

The MIT license covers the software, not third-party job listings, provider
data, trademarks, or access to external services. Follow each provider's
terms. Candidates retain rights in their resumes, screening answers, and
application documents. Real candidate material, credentials, databases, and
browser profiles are local data, not software licensed by this repository.
The README screenshots use synthetic demonstration data.
