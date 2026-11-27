# Third-party source notices

- NewsNow: https://github.com/newsnext/newsnow, commit 5da836c49c327f2c352216c5cbb4dea1abd9fcd3. Source, copyright and MIT license retained in web/.
- TrendRadar: https://github.com/sansan0/TrendRadar, commit ad2221fae0d908f6c11f40f70680dd5f9b41cd5d. Original source and GPL v3 license retained in vendor/TrendRadar/. Collector calls its original modules; collector/LICENSE is a copy of the upstream license.
- Trafilatura: https://github.com/adbar/trafilatura, version 2.4.0, Apache-2.0. Installed package and license remain in the D-drive isolated Python environment. Main-text extraction is provided by this library.
- Other Python and Node dependencies retain their own distribution notices. Their exact installed/locked versions are recorded by collector/requirements.lock.txt and web/pnpm-lock.yaml.
- zenfeed is an architecture reference only; no code from it is included. Folo UI source is now reused as described below.

No upstream LICENSE or copyright notice was removed. New integration code is identified separately in UPSTREAM.json. Upstream copyright and license files are preserved. Backend/collector integration code is distributed under GPLv3. The redesigned portal frontend and its derivative UI modules are distributed under AGPL-3.0-only; upstream components retain their original licenses.

- RapidFuzz: https://github.com/rapidfuzz/RapidFuzz, version 3.14.6, MIT. Installed in the D-drive isolated Python environment; used directly for fuzzy string matching.
- Additional TrendRadar reuse: keyword matching, AI batch templating/primary-tag parsing, JSON extraction and AIClient.chat; original GPL source and notices retained.
- Editorial step also directly reuses TrendRadar load_prompt_template, AIFilter._extract_json and AIClient.chat, plus existing local atomic I/O/hash helpers and NewsNow database dependencies. No new third-party package or upstream source modification was required for this step. Source notices and GPL/MIT licenses remain in place.
- Portal release retains upstream NewsNow React Query/Router, source cards, source cache and PWA lifecycle. New composition, local management, orchestration and a Windows Node SPA fallback join the existing content APIs; original upstream licenses are retained. No additional package was installed for the portal release.

- Distribution-only documentation change: Slack webhook example URLs in upstream README files are replaced with placeholders. Upstream license notices and reused Python modules are unchanged.

## Frontend redesign (2026-11-27)

- daily.dev apps, commit 776829c1840da97e431d2aa64615adb9445126c1, AGPL-3.0: Card.tsx primitives, Card.module.css stretched-link pointer/focus behavior and ArticleGrid.tsx composition adapted in web/src/components/portal/upstream/daily-card.{tsx,css}. Original pinned source and LICENSE are retained in vendor/frontend/daily-dev/.
- RSSNext/Folo, commit 292d15d94f9e7680899e1e2567c1c0d48a423f48, AGPL-3.0: ArticleItemStateLess source/time/title/description layout adapted in web/src/components/portal/upstream/folo-article-item.tsx. MainDestopLayout is a three-column design reference; its authentication/store code is not transplanted. Original pinned files and LICENSE retained in vendor/frontend/folo/.
- Local changes translate upstream utility classes to portal CSS, use the existing content API and bookmark store, replace service-specific hooks with props, and add responsive navigation. No Folo icons/mgc assets, daily.dev brand artwork, advertisements, analytics or third-party backend integrations are included.
- The redesigned web/src/components/portal frontend is AGPL-3.0-only. LICENSE-AGPL-3.0 contains the full text. Existing MIT NewsNow and GPLv3 collector source remain under their respective licenses. The site footer links to the public project source; source snapshots and hashes are listed in vendor/frontend/provenance.json.

## Huey

- Upstream: https://github.com/coleifer/huey
- Version: 3.5.4, installed from PyPI and pinned in collector requirements.
- License: MIT; original text retained in `vendor/huey/LICENSE`.
- Direct reuse: SqliteHuey native task serialization, priority queue, SQLite persistence, delayed scheduling, retry/backoff, dequeue and execute APIs. Local code only integrates article eligibility, extraction status and the existing outbox importer. No Huey source modifications and no Redis dependency.
