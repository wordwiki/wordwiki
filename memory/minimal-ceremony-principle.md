---
name: minimal-ceremony-principle
description: "Rabid's overriding goal — maximize reporting/history captured, minimize ceremony/learning for volunteers"
metadata: 
  node_type: memory
  type: project
  originSessionId: 33098663-f83f-4a3d-b467-be218996ac1e
---

Rabid's north-star tradeoff, stated by dz (2026-07-08): **capture as much reporting & history as we can with the LEAST ceremony and learning for volunteers.**

**Why:** the history/reporting is a real need (grant requirements, nice for volunteers, good for the org's own evolution). But it's a *volunteer* org — you can't force anyone to do steps. Heavy, multi-step modeling either won't be used at all, or will be used so inconsistently that the gathered data is pointless. So a feature that adds ceremony to capture more data can NET REDUCE the data quality.

**How to apply:** prefer few fields, sensible defaults, and no mandatory workflows. When tempted to model a richer lifecycle, ask "will a volunteer actually do this every time?" — if not, drop it and infer/estimate from what's already captured (e.g. the event gives you time/place for free). Concrete decisions this drove: `service_done` removed (DIY clients just wander off when finished — there's no reliable "done" moment); dropped people-served, service check-in time, record-closed time, and work start/end/stand from Service as too much ceremony for too little reliable signal. The drop-off ("full" repair) fields are the deliberate exception — a bike left overnight genuinely needs a small ready-call/pickup checklist.

Ties to [[design-language]] (pages are reading-first documents, not data-entry editors) and [[event-centric-activity-model]] (the event supplies time/place so services needn't).
