---
name: mikmaq-package
description: dz's packaging rule (2026-07-27) — mikmaq/ package holds language/MMO-project specifics; general algos in wordwiki/ with registries; general never imports specific
metadata:
  type: feedback
---

dz (2026-07-27): after the huge generalization project, he does NOT
want MMO stuff creeping back into wordwiki/.  RULE: mmo-only things
live in the new `mikmaq/` package (NOT mmo/ - that is the INSTANCE
dir); a specialization of a general algorithm = general algo in
wordwiki/ + the specialization in mikmaq/.

**Why:** keep the engine reusable for other language groups (the SAAS
goal) while the needed project-specific mass keeps growing.
**How to apply:** general engines expose REGISTRIES/config
(registerOrthoNormalizers, registerLanguageRules) or take config
objects; mikmaq/register.ts installs at the BINARY EDGE (imported by
cli.ts, side-effect); tests wanting Mi'gmaq behavior import
mikmaq/register.ts.  First residents: language.ts (normalizers +
LanguageRules incl. ROOT_LEXICON), pairing.ts ('~rand-mmo-pair').
Legacy MMO residue in wordwiki/ (entry-schema, site bits) migrates
gradually, not upfront.  See [[similarity-engine]],
[[machine-contributors]].
