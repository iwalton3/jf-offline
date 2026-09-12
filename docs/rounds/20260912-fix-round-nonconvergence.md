# Postmortem — jf-offline fix rounds, `489297f..8078ea8`

Written 2026-09-12 by an uninvolved triage pass. Diagnosis only; nothing in this
repository was changed except this file.

---

## 1. Executive summary

**What was being built.** A browser add-on that pretends to be a media server so the
existing web app can browse and play downloaded files with the network off.

**What happened.** A person reported two bugs, they were fixed, and the person confirmed
both by hand in the running app. That confirmation is the last independent check anything
in this window has. The person then asked for a broad automated review of the whole
project; it returned fifteen findings. All fifteen were applied as one change, in under
twenty-four minutes, with ten new automated checks — none of which was ever observed
failing against the unfixed code. Three minutes later the author re-read the change and
found that one of the fifteen fixes was worse than no fix at all, and repaired it. A second
review of that repair sweep then returned seven more findings, six of them defects in the
first sweep's own work. The person stopped the loop before those seven were applied.

**What it cost.** Small in elapsed time, large in confidence. Three commits over
twenty-six minutes. Three different instruments measure how much of this window is the
window repairing itself and they disagree by design: one third of all commits, one half of
the commits that touch existing code, one half again by a stricter rule. Do not average
them. All three are floors, because the accounting cannot see a fix that only adds a
guard, and adding a guard is what a correctness fix normally looks like. The more telling
figure is not in any instrument: of the seven findings the second review returned, six sit
in code the first sweep wrote — and that figure comes from the author's own account, not
from a record, because **no round history was found anywhere on disk**.

**Which diagnosis it is.** This is an **execution regime**, not a process defect. The
target did not move. The rules that would have caught most of this were written down in
the repository roughly six hours *before* the window opened, and were not consulted. The
repairs were scoped to the site each finding named, so the same rule was left broken at the
sibling sites the finding did not mention — in one case at a line directly below the fix
itself. A secondary and real contributing condition is that the only standard of success
in use was "the review's complaint is closed and the suite is green", and both halves of
that standard were authored by the same work they were judging.

The dominant condition is the **rate**: fifteen findings in at most ninety-four seconds
each, against this team's own audited median of just under seven minutes per finding, and
at the speed at which every previously audited batch produced documented damage. That is a
finding about the conditions, not about anyone's care.

**The one decision being asked for.** From the project owner: *do not apply the second
review's seven findings*. Choose instead between reverting the fifteen-finding change and
re-deriving it in graded pieces, or keeping it and paying for a bounded re-read of the
specific code around three named repairs. Recommendation and costs are in section 2.

---

## 2. Decision requested

**Do not run another review round, and do not apply the seven pending findings in a
batch.** That is the one thing that is wrong under every option below.

### Option A — Keep, and pay for a bounded audit of three rules (recommended)

Keep `84b99ac` and `8078ea8`. Keep every line of `tools/smoke.js`. Then, one rule at a
time, enumerate the rule's sites *before* touching any of them, and repair all sites in a
single change per rule. Three rules are already known to have unreached sites (section 5).

- **Cost:** three small changes, each preceded by a site enumeration; plus writing down
  what the played-state push must contain, which requires a person.
- **Forfeits:** nothing is thrown away, but the code around the repairs — named in
  section 4 as the unreviewed ring — stays unreviewed unless it is explicitly read.
- **Why recommended:** the fifteen fixes are not mostly wrong. Two are confirmed
  incomplete, one is confirmed to have introduced a new user-visible defect, and one rule
  (the memoised-promise rule) was confirmed complete and correct at all three of its sites.
  A revert would cost more than it recovers, and would take the test additions with it.

### Option B — Revert `84b99ac`, keep `8078ea8`'s intent, re-derive in graded pieces

- **Cost:** re-doing fifteen fixes; `8078ea8` does not apply cleanly without its parent.
- **Forfeits:** 171 lines of new checks in `tools/smoke.js` that are *sound as
  instrumentation* even where the fixes they cover are not. A revert that takes them turns
  a recovery into a second loss. If this option is chosen, `tools/smoke.js` must be kept by
  hand.
- **When to choose it:** only if the audit in Option A finds unreached sites for more than
  about half the ten rules.

### Option C — Stop and write the contract first

Author, elsewhere and beforehand, what the download pipeline and the played-state push must
guarantee, then re-judge both commits against it.

- **Cost:** blocks all code work until a person answers section 9's questions.
- **Forfeits:** time, and it does not by itself find the unreached sites — enumeration
  does. This is a necessary *component* of Option A, not a substitute for it.

### If nothing is decided

The seven pending findings get applied in the same shape that produced them, the third
review returns findings in the second sweep's own code, and the pattern compounds. The
author's account states plainly that this was the next action when the loop was stopped.

---

## 3. Timeline

| # | commit | time | what it was told, and by whom | what it changed |
|---|--------|------|-------------------------------|-----------------|
| 0 | `f56bacd`, `489297f` | 2026-09-11 23:47 and earlier | **A person**, describing two bugs they had hit | Remux classification and film grouping. **The person confirmed both by hand in the running app.** Last independent verification in this record. |
| 1 | `ab79472` | 2026-09-12 00:05 | Housekeeping | Adds `LICENSE`, 339 lines. Not part of the repair loop. |
| 2 | `84b99ac` | 2026-09-12 00:10 | An automated review of the whole project, run at the person's request. Fifteen findings. **The brief was authored by the reviewer, during this work.** | +466/−74 across twelve files. Ten rules. 34 new lines of rules in `CLAUDE.md`, written in the same commit as the fixes they describe. 171 added lines in `tools/smoke.js`, zero deletions. |
| 3 | `8078ea8` | 2026-09-12 00:13 | **The author's own re-read** of commit 2, three minutes and ten seconds later | Moves the cancel guard in front of the item write. +24/−12 in the downloader, +15/−1 in the suite. States a broader invariant than the one commit 2 had written into `CLAUDE.md` — and does not update that line, which is still stale at HEAD. |
| 4 | *(uncommitted)* | — | A second automated review, of the sweep, at the person's suggestion. Seven findings, six of them in commits 2 and 3. | Nothing. The person stopped the loop here. |

Where each brief came from is the point of this table. Rounds 2 and 4 were both briefed by
an automated reviewer with no stated contract to work from; round 3 was briefed by the
author reading their own diff. **No round produced a record on disk.**

---

## 4. Diagnosis

### Rot dominates. It is not primarily a moving target.

**Rot** means the repairs were wrong about the system: scoped to the site the report named,
with the sibling sites left broken. **Moving target** means each repair was right about
what it was told and what it was told kept changing. The remedies are opposite — one says
*enumerate and repair across sites*, the other says *stop coding and ratify a contract* —
so the choice decides the recovery.

The author's own account guesses moving target. The record does not support that as the
primary reading, for three reasons:

**1. The criterion that mattered was stable, written down, and older than the window.**
`CLAUDE.md` has said since `c9abc4f` (2026-09-11 18:21:51, about six hours before the
window opened) both *"Observe the API, do not read it out of jellyfin-web"* and *"Test
through the UI, not around it… If a check can drive the component's own methods, it
should."* Both rules bear directly on the fix that introduced the worst new defect and on
the check that failed to catch it.

```sh
cd /working/jf-offline
git log -1 --format='%h %ad' --date=iso -S 'Observe the API, do not read it out of jellyfin-web' -- CLAUDE.md
git log -1 --format='%h %ad' --date=iso -S 'Test through the UI, not around it' -- CLAUDE.md
sed -n '19,29p' CLAUDE.md
```

`CONFIRMED.` A target that was on disk six hours early did not move.

**2. At least two fixes are wrong against the rule stated in their own commit message.**
That is the rot signature exactly, and it is incompatible with "each fix was correct
against its brief". Both are in section 5 with commands.

**3. The one rule that was enumerated across its sites is complete and correct.** The
memoised-promise rule names three sites in the commit message and reaches all three:

```sh
cd /working/jf-offline
grep -rn 'once(' overlay/ps/db.js overlay/ps/source.js overlay/plugin/source.js overlay/ps-ui.js overlay/ps/schema.js | grep -v '^overlay/ps/schema.js:1[4-6]'
```

`CONFIRMED.` Where sites were counted, the repair held. Where they were not, it did not.
That is a statement about method, not about a shifting spec.

### The moving-target component is real, and secondary

The acceptance standard in force was "the reviewer's finding is closed and the suite is
green". Both halves were produced by the work being judged: the reviewer ran during the
work, and `CLAUDE.md` gained ten rules *inside the fixing commit*, so each rule and its fix
share an author and an age. The evidence pack flags `CLAUDE.md` as edited once inside the
window; `SCOPE.md`, which predates it, was not touched.

```sh
cd /working/jf-offline
git show --numstat --format='' 84b99ac3d6a4 | grep -E 'CLAUDE|SCOPE'
git log --oneline --follow -- SCOPE.md | head -3
```

This matters for the recovery — a contract does need writing (section 6, step 4) — but
ratifying one will not find an unreached site. Enumeration does that.

### There *was* an available oracle, and it was not consulted

This is worth stating because it is the near-miss: the domain knowledge needed to get the
played-state push right was on this machine the whole time, in the unmodified web-app
checkout at `/home/izzie/Desktop/jellyfin-web`, and the repository's own rules name a tool
(`tools/probe-requests.js`) for obtaining it empirically. This is therefore **not** the "no
available oracle" case. The oracle existed, in two forms, and neither was used.

---

## 5. Believed versus actual

*Addressed to whoever does the recovery. Only entries that change a decision.*

### 5.1 The parent-notification fix introduced a worse defect than the one it closed

**Believed:** commit `84b99ac` fixed "only the first parent was notified" by adding the
series to the pushed list, and the author recorded congratulating themselves on it.
**Record shows:** the series entry is a copy of the *episode's* user data with only the id
swapped. Finishing one episode therefore pushes `Played: true` for the whole series,
together with the episode's playback position and percentage.

```sh
cd /working/jf-offline
sed -n '44,56p' overlay/ps/notify.js
```

The consuming code, in the untouched web-app checkout, acts on exactly those fields:

```sh
cd /home/izzie/Desktop/jellyfin-web
sed -n '1123,1162p' src/components/cardbuilder/cardBuilder.js   # userData.Played stamps the watched tick
sed -n '1163,1190p' src/components/cardbuilder/cardBuilder.js   # PlaybackPositionTicks draws a resume bar
```

`CONFIRMED` by reading both sides. The user-visible consequence — a whole series marked
watched, its unwatched count cleared and a resume bar drawn on the series card, from one
finished episode — is `ARGUED`; it would be settled by driving the app and looking at the
card, which the repository's own "test through the UI" rule already requires.

**Why it matters:** the fix that most needed the oracle is the one where the oracle was
nearest and was not opened. Any recovery must re-derive this payload from what the app
actually consumes, not from what looks symmetrical.

### 5.2 The check written for 5.1 is structurally unable to see it

**Believed:** ten new checks cover the fifteen fixes. **Record shows:** the parent check
reads `UserDataList.map((u) => u.ItemId)` and asserts two ids are present. It never looks
at a payload field. It also passes vacuously if no episode happens to be held at that point
in the run.

```sh
cd /working/jf-offline
sed -n '1906,1935p' tools/smoke.js
```

`CONFIRMED.` **Why it matters:** the suite being green is not evidence about this fix, and
the count going 144 → 154 → 155 is not evidence either.

```sh
cd /working/jf-offline && grep -c '^\s*check(' tools/smoke.js   # 155, matches both commit messages
```

### 5.3 The artwork rule was applied at one of three write sites

**Believed:** the author states this themselves as an open worry — *"the artwork rule I
applied at exactly one site; `downloadSeries` writes an image directory for the series and
for every season and I never looked."* **Record shows:** correct, and the commit message
nevertheless claims the storage figure is now honest.

```sh
cd /working/jf-offline
grep -n 'putImages\|imageDir' overlay/plugin/downloader.js
sed -n '809,819p' overlay/plugin/downloader.js   # writes: series dir, and one per season
sed -n '1093,1099p' overlay/plugin/downloader.js # removes: the one item's dir only
```

`CONFIRMED.` Deleting every downloaded episode of a series leaves the series and season
artwork on disk, invisible to the storage figure — the exact condition `84b99ac` says it
closed. **Why it matters:** this is the cleanest available demonstration that the repair
was scoped to the report, and it is also why the test cannot see it — the check exercises a
single film (`DIRECT_ITEM`) and never calls `downloadSeries`:

```sh
cd /working/jf-offline && sed -n '1300,1340p' tools/smoke.js
```

### 5.4 The trickplay rule is violated one line below its own fix

**Believed:** the second review says the write-path version "keeps the source's full
`ThumbnailCount`", and the author has not verified it. **Record shows:** the review is
right.

```sh
cd /working/jf-offline
sed -n '396,416p' overlay/plugin/downloader.js   # tile loop breaks on first failure; returns Object.assign({width, tiles: stored}, info)
sed -n '680,692p' overlay/plugin/downloader.js   # the DTO prune, which keeps `info` whole
```

`info` is the source's description, `ThumbnailCount` included, and the tile loop `break`s
on the first failed fetch — so `stored` can be less than the count the stored record still
advertises. `CONFIRMED` by reading. **Why it matters:** the rule written into the commit
message is *"a stored DTO describes what is held, not what the source has"*, and the value
that breaks it is spread into the object by the fix itself. This is rot at a distance of one
line, which is the strongest single argument against the moving-target reading.

### 5.5 The repository's written rule for cancellation is stale at HEAD

**Believed:** `8078ea8` corrected the cancel-guard placement. **Record shows:** it
corrected the code and left the rule. `CLAUDE.md` still says the guard "belongs at the one
place COMPLETE is written" — the placement `8078ea8` declared worse than no guard.

```sh
cd /working/jf-offline
sed -n '216,220p' CLAUDE.md
git log -1 --format='%h %ad %s' --date=iso 8078ea83d9b8
git show --numstat --format='' 8078ea83d9b8    # CLAUDE.md is not in it
```

`CONFIRMED.` **Why it matters:** a confident rule raises the next reader's prior that the
code below it is right. This one is wrong and sits in the file the next session will read
first. Fix the line before anything else; it costs nothing and it is actively misleading.

### 5.6 The tests instrument in the evidence pack measured nothing

**Believed:** the evidence pack's churn table reports production 470/87 and **tests 0/+0/−0**.
**Record shows:** 186 lines of `tools/smoke.js` changed in the window; the instrument does
not classify `tools/` as tests.

```sh
cd /working/jf-offline
git diff --numstat 489297ff096b..8078ea83d9b8 -- tools/smoke.js
```

`CONFIRMED.` **Why it matters:** `tests 0/0` must be read as `MEASURED NOTHING`, not as
"no tests were written". Read as health it would justify exactly the wrong recovery — and
the suite is in fact the part most worth keeping.

### 5.7 A hypothesis I refuted, so nobody re-runs it

I expected the virtual-list key rule to have an unreached third site: there are three
`cl-virtual-list` instances and only two got named key helpers. The third's inline key is
in fact complete — the row's only state-derived appearance, the `unresolved` highlight, is
a pure function of the two values already in the key.

```sh
cd /working/jf-offline
sed -n '1141,1150p' overlay/plugin/manager.js   # what the row draws
sed -n '897,908p' overlay/plugin/manager.js     # resolved = subtitleIndex != null || audioIndex != null
sed -n '1443,1448p' overlay/plugin/manager.js   # the key carries both
```

`CONFIRMED` correct as written. I also expected orphaned series rows from a cancelled
series download to appear in the library; they do not — the library derives parents from
held episodes rather than storing them, so a childless series is filtered out at read time
(`overlay/ps/library.js:36-55`). That derivation is good design and should be preserved by
any recovery. The artwork orphan in 5.3 is a different problem and is real.

---

## 6. Recovery plan

*Written so a fresh session can execute it without reading the rest of this file.*

**Do not do first:** do not apply the seven pending review findings, in a batch or
otherwise. Do not run another review round to decide what to do. Do not revert anything
before step 1 answers whether a revert is warranted.

**Checkpoint.** The tree at the time of writing is tagged `diagnose/20260912-042609`.
To return to it: `cd /working/jf-offline && git checkout diagnose/20260912-042609`.
The tree was clean when the tag was made.

1. **Correct the stale rule.** Edit `CLAUDE.md:216-220` so it states the invariant
   `8078ea8` actually shipped — *a cancelled item must not appear in the library, wherever
   in the download the cancel landed* — rather than the guard placement that commit
   abandoned. One line. Do this before reading anything else in that file.

2. **For each of the three confirmed-incomplete rules, enumerate sites before patching.**
   Run the enumeration, write the site list down, then make one change covering all of
   them. Do not start at the site the review named.

   ```sh
   cd /working/jf-offline
   # artwork rule — every write of an image directory, against every removal of one
   grep -n 'putImages\|imageDir' overlay/plugin/downloader.js
   # stored-DTO rule — every field of a stored DTO that describes the source rather than the copy
   grep -rn 'Trickplay\|ThumbnailCount\|ChildCount\|MediaSources' overlay/plugin/downloader.js
   # cancellation rule — every path that writes an items row
   grep -n 'putItem' overlay/plugin/downloader.js
   ```

   Prefer the repair that removes a choice over the one that adds a guard: a single
   removal helper that takes an item and deletes everything keyed to it beats a second
   `removeDir` call added at each new site.

3. **Re-derive the played-state push from the consumer, not from symmetry.** Read
   `/home/izzie/Desktop/jellyfin-web/src/components/cardbuilder/cardBuilder.js:1123-1193`
   and decide which fields a *parent* entry may legitimately carry. That file is read-only
   reference; do not modify that checkout. Then rewrite the check at
   `tools/smoke.js:1906-1935` so it asserts on payload fields and fails when a series entry
   claims the episode's played state. **Watch it fail against HEAD before fixing the
   code** — if it passes against HEAD, it does not discriminate and must be rewritten, not
   kept.

4. **Needs a human decision before it runs.** Take the questions in section 9 to the
   project owner and write the answers into `SCOPE.md` — not into `CLAUDE.md`, and not in
   the same commit as any fix. Until that is done, no round has a standard of success that
   was not authored by the work it judges.

5. **Only then, re-triage the seven pending findings** — one rule at a time, each with its
   own site enumeration, each in its own commit, against the answers from step 4. Expect
   some of them to dissolve once the contract is written, and expect at least one to be
   about a site no finding named.

6. **Do not re-run the suite as evidence that any of this worked.** It was green through
   every defect in section 5. Its value is regression cover, not confirmation.

---

## 7. Process findings

Each is paired with a gate — something that fires at a moment, not advice about judgement.
The advisory version of several of these already existed in `CLAUDE.md` and did not fire,
which is the point: a written rule is a cold artifact and the moment of repair is the
hottest region there is.

| Condition | Evidence | Gate |
|---|---|---|
| **Rate.** Fifteen findings applied inside a 23m22s window between `489297f` and `84b99ac` — at most 94 seconds per finding, against this team's own audited median of 6.8 min. Every previously audited batch at this speed produced documented damage. | `git log --format='%h %ad %s' --date=iso 489297ff096b..8078ea83d9b8` | Before the first patch of a review round: if findings ÷ available minutes is under five minutes per finding, the round is split and only the first part is worked. |
| **Batch shape.** A policy of one commit per review round rewards the smallest targeted diff per finding, which is precisely the change that leaves siblings broken. | `git show --numstat --format='' 84b99ac3d6a4` — twelve files, ten rules, one commit | Before the first patch: one commit per *rule*, and the commit message must name the sites enumerated, including the ones found clean. |
| **No site enumeration.** Three rules were repaired at the site the report named. Two of those are confirmed broken at the sibling sites. | Section 5.3, 5.4 | Before the first patch of a rule: paste the enumeration command and its output into the commit message. A rule whose message names one site is rejected. |
| **Assertions written after their fix.** Ten of eleven new checks were written against already-fixed code. The author records this and names it as the thing their own instructions forbid. | Deposition §3; `git diff --numstat 489297f..8078ea8 -- tools/smoke.js` | Before a fix is committed: the check must have been observed red at the parent commit, and the commit message says so. One check in this window met that bar — the hostile-stylesheet one — and it is the only one that caught anything. |
| **Rules authored by the work they judge.** Ten rules entered `CLAUDE.md` in the commit that fixed what they describe; one was superseded 190 seconds later and is still stale. | Section 5.5 | Before a tag or merge: no commit may change both a rule file and the code that rule governs. |
| **No round record.** The evidence pack found no round history anywhere. The only account of rounds 2 and 4 is the author's memory. | `evidence/prior.md` — `NO PRIOR RECORDS FOUND` | Before the next round starts: the round's findings are written to a file in the repository, as issued, before any of them is applied. |

---

## 8. What this report cannot see

**The loop was noticed by a person, not by an instrument.** The project owner interrupted
the work twice — once to suggest reviewing the sweep, once to stop the delegated
application of its findings. Nothing automated flagged non-convergence, and the instruments
that exist would not have: the suite was green throughout and its passing count rose
monotonically.

**`NO PRIOR RECORDS FOUND.`** No round history exists in `.git/review`, `docs/`, or the
session artifact store. Everything in section 3 about what rounds 2 and 4 were told, and
the claim that six of seven second-round findings land in first-round code, rests on the
author's own account and is `ARGUED`, not measured. It would be settled by the review
transcripts if they can be recovered from the session log.

**`tests: 0 / +0 / −0` in the evidence pack is `MEASURED NOTHING`**, not health. See 5.6.

**Self-repair figures are floors.** Deletion-based attribution scores nothing for a fix
that only adds a guard, which is the normal shape of a correctness fix, and one of the
three commits in this window deleted no line at all. Quote the three instruments with their
units — 1/3 of all commits, 1/2 of commits touching existing code, 1/2 by the stricter
majority rule — never one averaged rate, and never without the floor caveat.

**Not run:** the smoke suite. A real server is listening on :8096 and the dev host on
:8099, and puppeteer is present, so it *could* have been run — but running it would only
have reproduced the known-green result, and the checks in question are confirmed unable to
discriminate by reading them. Modifying a check to watch it fail would have meant editing
the repository, which this pass does not do.

**`ARGUED`, and what would settle each:**
- The user-visible effect of the parent-notification payload (5.1) — settled by driving the
  app through the UI and looking at a series card after finishing one episode.
- That a second tab holding an old database connection blocks the version upgrade
  indefinitely — the *code* fact is `CONFIRMED` (no `versionchange` listener exists
  anywhere: `grep -rn 'versionchange' /working/jf-offline/overlay/` returns nothing, and
  `overlay/ps/db.js:33` rejects on `onblocked`), and the version did move from 1 to 2
  inside this window (`git show 489297ff096b:overlay/ps/schema.js | grep VERSION`). The
  *consequence* for a deployed user needs two real tabs to settle. Note the ordering
  argument the author raised and did not verify: a release handler only helps if it is in
  the build being replaced, so shipping it alongside the bump cannot help the first
  upgrade. I believe that argument is sound; it is `ARGUED`.
- Whether the artwork check's re-download at `tools/smoke.js:1323-1327` masks anything
  downstream. It re-seeds that item's user data from the source server, so any later check
  depending on state set earlier in the run is now reading re-seeded state. Worth one look
  during the recovery; `ARGUED`.

**Hypotheses I refuted while working** — do not re-run these: the third virtual-list key is
complete, and cancelled series downloads do not leave visible library entries. Both in 5.7,
with commands.

---

## 9. Open questions

Five, each for the project owner, who is the only person here holding the oracle.

1. When one episode is marked played, **what may the pushed entry for its season and its
   series contain?** Specifically: may it carry a played flag at all, or only an identifier
   that tells the app to refetch? (This is the question 5.1 turns on.)
2. **Is the storage figure on the settings page required to account for every byte on
   disk** — series and season artwork included — or only for the items shown in the list?
3. **What must a cancelled download guarantee?** The code currently guarantees "does not
   appear in the library"; the written rule guarantees "is never recorded complete"; the
   two are not the same, and nothing says which is the promise.
4. **Was a database version bump acceptable for a performance fix on a deployed demo?**
   The author decided yes, alone, and did not record deciding it. If the answer is no, the
   bump comes out and the table scan goes back in.
5. **Should a review round's findings be recorded in the repository before any is applied?**
   Every process gate in section 7 depends on a record that does not currently exist.

---

## Appendix

### A. The deposition, verbatim

**This is a specimen of what the executing session believed, not a set of findings.** It
was written from that session's own context before it read the evidence pack, and is
reproduced without edit because a summary of it — written by anyone, including me — is the
shape in which omissions survive. Claims in it that were checked appear in section 5 with
what the record actually said; several differ.

---

# Deposition — jf-offline fix rounds, 489297f..8078ea8

Written from my own context before reading the evidence pack, not revised afterwards.

## 1. What I was asked for, and what I decided myself

**Asked for, verbatim, in one message:**

> Two main things:
> 1. Remuxed files show as needing a transcode, but they don't need one and the default
>    720p transcode makes the situation __worse__.
> 2. Deleting the movies group deletes the entire catalog, probably best to just not group
>    movies.
> 3. Probably worth running a /code-review xhigh over the entire project and fixing
>    anything it finds, am happy with the feature set.

Items 1 and 2 are outside this window — they are `f56bacd` and `489297f`, and the user
confirmed both by hand in the app. That confirmation is why `489297f` is the window base.

The window is item 3 and only item 3: `84b99ac` (fifteen findings applied) and `8078ea8`
(a defect I found in my own fix round).

Later, mid-turn, the user added:

> (when done, we should probably run a /code-review high over the diff and blast radius of
> the last fix sweep)

**What I decided myself, which is most of what matters here:**

- That "fixing anything it finds" meant applying all fifteen findings in one commit. The
  user did not ask for that shape. I chose the batch.
- That a schema change was in scope. Finding 14 was a performance complaint — two hot-path
  lookups scanned the items table — and I answered it by adding two IndexedDB indexes and
  bumping `DB.VERSION` from 1 to 2. Nobody asked for a migration. I decided a version bump
  was an acceptable price for a performance fix on a deployed public demo, and I did not
  write down that I had decided it.
- That the precache-swap finding could ship without a test, because I could not force a
  partial precache in the harness. I decided that and recorded it in CLAUDE.md, which I
  think was right, but it was my call and not one I raised with the user first.
- The acceptance criterion throughout was **"the reviewer's finding is closed and the suite
  is green."** That criterion was authored by the reviewer during this work, not before it
  and not elsewhere. There is no external spec for any of this. `SCOPE.md` and `CLAUDE.md`
  exist but neither states the invariants these fifteen findings were about; several of
  them I wrote into `CLAUDE.md` *as part of the same commit that fixed them*, which means
  the rule and its fix have the same author and the same age.

## 2. What I changed to make something pass

This is the part I would most want a second pair of eyes on.

- **`tools/smoke.js`, the cancellation test.** My new artwork-removal check downloaded
  `DIRECT_ITEM`, removed it, and asserted the image was gone. That deleted the item row and
  userdata that a later play-state check reads, and the suite crashed with `Cannot read
  properties of undefined (reading 'PlaybackPositionTicks')`. I fixed it by re-downloading
  the item at the end of my own check to restore the state it borrowed. I believe that is
  legitimate state restoration rather than hiding a defect, but it is exactly the shape of
  "I edited the thing that detects problems until it stopped complaining", so it belongs
  here.
- **`tools/smoke.js`, the artwork-removal detail string.** I wrote a `check()` whose detail
  read "no image was written, so the check below proves nothing" — but `check()` prints its
  detail unconditionally, so a passing check printed text claiming it had proved nothing. I
  changed the string. Cosmetic, but it means I had written an assertion whose own output I
  had not read carefully.
- **`tools/smoke.js`, the phone-geometry test (just before this window).** I wrote a test
  asserting the modal's close button stays inside the panel at 412x915, ran it against the
  pre-fix code to watch it fail, and **it passed**. So the test did not discriminate. I
  deleted it and wrote a different one that injects a hostile stylesheet, which did fail
  against the old code. I record it because it is the one time in this session I checked
  whether an assertion discriminated, and the first attempt did not.
- I did **not** change any fixture, golden file, expected value, or `SCOPE.md`.
- I **did** add rules to `CLAUDE.md` in the same commit as the fixes they describe. Ten
  bullets. Every one of them is a rule I authored while fixing, not a rule that existed
  before and was violated.

## 3. Which tests I watched fail before the fix

Honestly: **almost none, and this is the claim I am least comfortable with.**

- **Watched fail:** the hostile-stylesheet modal check (ran it against the pre-fix
  `ps-ui.js` restored from git; close button measured at x=860 in a 412-wide panel, then at
  246-402 after). That is the only assertion in this session I observed red against the
  unfixed code.
- **Not watched fail, written after the fix, against the fixed code:** all ten checks I
  added in `84b99ac` — the `playedSetBy` trio, the artwork-removal pair, the `once()` pair,
  the two virtual-list key checks, the parent-notification check — and the cancelled-item
  check in `8078ea8`. I reasoned about what they would have caught. I did not run any of
  them against the pre-fix tree.
- I noted at the time that the suite went from 144 to 154 passing with no test changes
  required by the fixes, and I said out loud that this meant none of the fifteen findings
  had a test and therefore none of the fixes had one either. I then wrote the tests
  afterwards anyway, which is the exact thing my own instructions say is structurally unable
  to fail.
- The round-2 reviewer has now shown this concretely: my parent-notification check asserts
  the season and series ids are *present* in the pushed list and never looks at the payload,
  and the regression it was supposed to cover — the series entry carrying the episode's
  played state — sails straight through it.

## 4. The last point I know was good

`489297f`. The user manually confirmed the two things they had reported — the remux
classification and the ungrouped movies list — in the running app. That is human
confirmation of behaviour, which is the only kind in this session that does not come from
me. Everything after it is my own work, verified only by my own tests.

I would add that "good" there means "those two reports are fixed and the suite is green",
not "the code is correct". The fifteen round-1 findings were all present at `489297f`.

## 5. What I am unsure about, and what I was about to do next

**Unsure:**

- **The DB version bump.** Round 2 says a second tab holding a v1 connection blocks the
  upgrade forever, nothing anywhere closes a connection on `versionchange`, and the handler
  has to ship *before* the bump to help at all — because the old build is the one that has
  to let go. If that is right, shipping the handler and the bump together does nothing for
  the first upgrade, which is the one every existing user hits. I said in my last message
  that my instinct is to revert the bump and keep the scan. I still think that, but I have
  not verified the blocking claim myself and I am aware that I want it to be a small problem.
- **Whether applying fifteen findings in one commit was recoverable at all.** My own
  instructions say the window in which the correct repair exists closes on the first patch,
  silently, and that a batch I am getting through quickly is the one to break up. I grouped
  by rule, which I think helped, but I did not count sites before patching for at least two
  rules — the artwork rule and the cancellation-signal rule — and round 2 found the siblings
  of both. The artwork rule I applied at exactly one site; `downloadSeries` writes an image
  directory for the series and for every season and I never looked.
- **Whether `CLAUDE.md` rules written in the fixing commit are worth anything.** They are
  a cold artifact authored from a hot region by the person who just made the change.

**What I was about to do, if nobody had stopped me:**

Apply the seven round-2 findings. I had already stated a plan for two of them in my last
message to the user — revert the DB bump, keep the `versionchange` handler — and I was
heading for the same batch shape that produced the state being triaged. The user's
suggestion to review the fix sweep is what interrupted that.

## Order things happened in

1. User reports two bugs (remux mislabelled and capped; movies group deletes everything).
   I fix both, with tests, in `f56bacd` and `489297f`. User confirms both by hand. **Good.**
2. User asks for `/code-review xhigh` over the whole project. It returns fifteen findings.
3. I verify the severe ones against the code myself, group them into about ten rules, and
   apply all fifteen in one commit with ten new tests, none observed failing. `84b99ac`.
   Elapsed from review landing to commit: roughly half an hour for fifteen findings.
4. While waiting for the next review I re-read my own diff and find that my cancellation
   guard sits *after* the item row is written, which makes it worse than no guard, because
   the library is derived from item rows. I fix it. `8078ea8`.
5. User suggests reviewing the sweep. `/code-review high` returns seven findings, five of
   them defects in step 3's fixes and one in step 4's.
6. I invoke `/breakfix-review existing`. Its author check fires — this session wrote every
   line in the diff — so I serialise the findings and delegate. The delegate has no Workflow
   tool and starts running the phases by hand.
7. User stops it and asks for this.

## Things I backed out

- The shadow-root modal (before this window): I built it, the user reported it broke
  vdx-web's styling, and I reverted it to hand-written defensive CSS. The user diagnosed
  that; I did not.
- The phone-geometry assertion, deleted because it did not discriminate.
- A first attempt at pruning trickplay widths inside `library.js present()`, which was
  wrong because `present()` receives an items row and the trickplay data lives on the
  download row. I reverted it and moved the pruning to the write path. Round 2 now says
  that version is also incomplete — it keeps the source's full `ThumbnailCount`.

## What surprised me

- That the suite went 144 → 154 with zero test changes forced by fifteen correctness fixes.
  In hindsight that is the loudest signal in the whole session and I treated it as a
  convenience.
- That the round-2 reviewer cleared several things I expected it to flag (the `once()`
  refactor, the index migration's `onupgradeneeded` path, the generation counter) and
  flagged the one thing I had congratulated myself on — the parent notification.

## Where I think the problem is, as a guess

The acceptance criterion is "the reviewer's finding is closed", and the reviewer changes
every round. Nothing in this repository states what the download pipeline must guarantee,
so each round arrives with its own implicit spec, each fix is defensible against the round
that asked for it, and the target moves. My own instructions describe this exact case and
say the response is to stop and ratify — widen what is enumerated rather than how carefully
the diff is read — and I did not do that. I kept fixing.

The second guess, smaller: the batch rate. Fifteen findings in about half an hour, ten
tests written after the fact. Whatever the frame problem is, that rate is what turned it
into five new defects rather than one.

---

### B. Every command that produced a number in this report

All are read-only and runnable as written.

```sh
cd /working/jf-offline

# Section 3 — the window, with timestamps (gives the 23m22s and the 190s)
git log --format='%h %ad %s' --date=iso 489297ff096b..8078ea83d9b8
git log -1 --format='%h %ad' --date=iso 489297ff096b

# Section 3 / 5.6 — churn per file, per commit
git show --numstat --format='' 84b99ac3d6a4
git show --numstat --format='' 8078ea83d9b8
git diff --numstat 489297ff096b..8078ea83d9b8 -- tools/smoke.js

# Section 4 — the pre-existing rules, dated
git log -1 --format='%h %ad' --date=iso -S 'Observe the API, do not read it out of jellyfin-web' -- CLAUDE.md
git log -1 --format='%h %ad' --date=iso -S 'Test through the UI, not around it' -- CLAUDE.md
sed -n '19,29p' CLAUDE.md

# Section 4 — the one rule that was enumerated, and reached all its sites
grep -rn 'once(' overlay/ps/db.js overlay/plugin/source.js overlay/ps-ui.js

# 5.1 — the payload, and its consumer in the untouched checkout
sed -n '44,56p' overlay/ps/notify.js
sed -n '1123,1193p' /home/izzie/Desktop/jellyfin-web/src/components/cardbuilder/cardBuilder.js

# 5.2 — the check that cannot see it; and the check count
sed -n '1906,1935p' tools/smoke.js
grep -c '^\s*check(' tools/smoke.js                      # 155
git diff 489297ff096b..8078ea83d9b8 -- tools/smoke.js | grep '^+' | grep -c 'check('   # 11

# 5.3 — artwork writes vs artwork removal
grep -n 'putImages\|imageDir' overlay/plugin/downloader.js
sed -n '809,819p;1093,1099p' overlay/plugin/downloader.js
sed -n '1300,1340p' tools/smoke.js

# 5.4 — trickplay: the count that survives its own prune
sed -n '396,416p;680,692p' overlay/plugin/downloader.js

# 5.5 — the stale rule at HEAD
sed -n '216,220p' CLAUDE.md

# 5.7 — the two refuted hypotheses
sed -n '1141,1150p;897,908p;1443,1448p' overlay/plugin/manager.js
sed -n '36,55p' overlay/ps/library.js

# Section 8 — database version and release handling
git show 489297ff096b:overlay/ps/schema.js | grep -n VERSION
grep -n VERSION overlay/ps/schema.js
grep -rn 'versionchange' overlay/            # returns nothing
sed -n '28,34p' overlay/ps/db.js
```

### C. Checkpoint

The tree at the time of writing is tagged **`diagnose/20260912-042609`**, taken from a
clean tree at `8078ea83d9b8`.

```sh
cd /working/jf-offline
git checkout diagnose/20260912-042609     # return to the state this report describes
git status --short                        # expect empty, apart from this report file
```

The evidence pack this report was built against is at
`.git/diagnose/20260912-fix-round-nonconvergence/evidence/`.
