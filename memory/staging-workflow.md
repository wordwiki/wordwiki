---
name: staging-workflow
description: "Staging is the LANGUAGE STAFF's server, not a test rung — dz tries everything locally and pushes to staging only after his own testing/review"
metadata:
  node_type: memory
  type: feedback
---

dz (2026-07-07): "I try everything out locally, staging is just for the language staff - and I only push there after I have done the initial testing and reviews myself - I create confusion otherwise."

**Why:** the language staff work from staging; half-reviewed features or churning data there confuses them and erodes trust in what they see.

**How to apply:** the local dev instance is the proving ground for EVERYTHING (code, migrations, reports); don't suggest "run it on staging" / "push to staging" as a next step after landing — dz decides when staging updates, after his own review. Staging-facing artifacts (cleanup reports, the Variant Cleanup queue, migration reports) should be polished on dev first for the same reason. The mechanics stay [[fix-orthographies]]'s runbook (updateStaging.sh ships dev's already-migrated db); only the TIMING is dz's.
