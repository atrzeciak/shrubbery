## What this changes, and why

<!-- The why matters more than the what; the what is in the diff. -->

## Checks

- [ ] `make check` passes (verify, lint, then the full test suite)
- [ ] Covered by a test, or an explanation below of why it cannot be
- [ ] No new runtime dependency and no build step
- [ ] Nothing under `public/` references an external origin
- [ ] `pl.json` and `en.json` still have identical keys, if either changed
- [ ] A new SQL statement lives in `src/db/queries.js`
- [ ] A new migration is the next number, and no applied migration was edited
- [ ] A new route states whether it needs `requireAdmin` or `requireRole`
- [ ] No real names, addresses or domains in the diff (`make scrub-check`)

<!--
Feature pull requests are often declined, and not because they are bad: everything here has to
still work in twenty years with nobody watching. If this adds a feature, say in a line or two what
keeps working when it breaks. See CONTRIBUTING.md.
-->
