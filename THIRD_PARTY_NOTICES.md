# Third-party source notices

- NewsNow: https://github.com/newsnext/newsnow, commit 5da836c49c327f2c352216c5cbb4dea1abd9fcd3. Source, copyright and MIT license retained in web/.
- TrendRadar: https://github.com/sansan0/TrendRadar, commit ad2221fae0d908f6c11f40f70680dd5f9b41cd5d. Original source and GPL v3 license retained in vendor/TrendRadar/. Collector calls its original modules; collector/LICENSE is a copy of the upstream license.
- Trafilatura: https://github.com/adbar/trafilatura, version 2.4.0, Apache-2.0. Installed package and license remain in the D-drive isolated Python environment. Main-text extraction is provided by this library.
- Other Python and Node dependencies retain their own distribution notices. Their exact installed/locked versions are recorded by collector/requirements.lock.txt and web/pnpm-lock.yaml.
- zenfeed and Folo are architecture/reference sources only in this step; no code from them is included in this integration.

No upstream LICENSE or copyright notice was removed. New integration code is identified separately in UPSTREAM.json. Upstream copyright and license files are preserved. New integration code is distributed under GPLv3; upstream components retain their own licenses.

- RapidFuzz: https://github.com/rapidfuzz/RapidFuzz, version 3.14.6, MIT. Installed in the D-drive isolated Python environment; used directly for fuzzy string matching.
- Additional TrendRadar reuse: keyword matching, AI batch templating/primary-tag parsing, JSON extraction and AIClient.chat; original GPL source and notices retained.
- Editorial step also directly reuses TrendRadar load_prompt_template, AIFilter._extract_json and AIClient.chat, plus existing local atomic I/O/hash helpers and NewsNow database dependencies. No new third-party package or upstream source modification was required for this step. Source notices and GPL/MIT licenses remain in place.
- Portal release retains upstream NewsNow React Query/Router, source cards, source cache and PWA lifecycle. New composition, local management, orchestration and a Windows Node SPA fallback join the existing content APIs; original upstream licenses are retained. No additional package was installed for the portal release.

- Distribution-only documentation change: Slack webhook example URLs in upstream README files are replaced with placeholders. Upstream license notices and reused Python modules are unchanged.
