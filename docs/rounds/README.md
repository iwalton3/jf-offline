# Round records

A review round's findings are recorded here before any of them is applied, and
the record stays afterwards. Every process gate in
`docs/applying-review-findings.md` depends on a record that used to exist only
in a session's memory: when the question "did this round's findings land in the
previous round's code?" was first asked here, nothing anywhere could answer it.

## 2026-09-12 — fix rounds stopped converging

`20260912-fix-round-nonconvergence.md` is the diagnosis and
`20260912-repair-plan.md` is the plan written from it. Together they are the
worked example the gates came out of, and they are kept in full, including the
parts that read badly.

What happened: fifteen findings were applied in a twenty-three minute window in
one commit, and six of the next round's seven findings landed in that sweep's
own code. Three rules had been repaired at the single site the report named,
and two of those were still broken at their siblings.

The plan's six candidate rules are all applied, one commit per rule, each with a
check watched red at its parent. Every one of them reached a site no finding had
named. Two things are committed without full cover and say so in their own
commit messages:

- Removal across a second media source of one item has no check. Source
  selection is deterministic and multiple versions are out of scope in
  `SCOPE.md`, so the case is unreachable from the UI; the repair is structural.
- The database release handler cannot help the upgrade that introduces it. See
  the end of `docs/the-store.md`.

All five of the postmortem's open questions are answered. Three are owner
answers about what the software promises and live at the top of `SCOPE.md`,
alongside the measurement that settled the first of them. The fourth kept the
database version bump and added the report a stranded tab now gets, which is
also in `SCOPE.md`. The fifth is answered by this directory existing.

The plan names a superseded first draft of itself, which is not kept. It was
rejected for naming helper functions and collapsing rules before a single
enumeration had been run, and knowing those names is exactly the contamination
the enumeration gate exists to prevent.
