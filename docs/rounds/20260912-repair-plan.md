# Repair plan — jf-offline, Option A

Pinned at `8078ea83d9b8` (tag `diagnose/20260912-042609`).
v1 is kept beside this as `repair-plan-v1-superseded.md`. It was rejected for precommitting
the collapses that enumeration is supposed to test: it named helpers, merged three findings
into one rule and wrote repair shapes before running a single population command. Two of
those precommitments were then shown wrong. **That is the original failure wearing process
clothing, and the shape below exists to make it impossible rather than discouraged.**

## The oracle

Stated by the project owner: *conformance to the Jellyfin API, coherent technical design of
the internals, and the UI contract already agreed. Everything else is malleable.*

Three kinds. **Every rule names which one settles it.** A rule that cannot name one is not
ready.

| kind | settled by |
|---|---|
| API conformance | measured against real Jellyfin 12.0.0 on `:8096`, or read from jellyfin-web's consuming code in the read-only reference checkout |
| internal coherence | one invariant, one owner, enforced structurally |
| UI contract | what the settings page already promises a person |

## Gates

1. One commit per rule. Never per finding, never per round.
2. Docs and the code a doc governs never move in the same commit.
3. **Two independent population derivations before any patch.** Different *kinds* of
   instrument, not two greps. They must agree. Until they do: no helper name, no collapse,
   no site count, no repair shape.
4. A behavioural check observed red at the parent commit. **No red discriminator means the
   rule stays uncommitted** — not fixed-without-cover.
5. Stop and report at the first rule whose derivations disagree.
6. The suite is regression cover, not confirmation. It was green through every defect.

## Ledger

Candidate rules are listed separately and **deliberately not collapsed**. Whether any two
are one rule is an output of gate 3, not an input. Dependencies are stated; nothing else
about order is fixed.

---

**A — a pushed user-data entry describes the item its `ItemId` names.**
- *Oracle:* API conformance.
- *Population:* `grep -rn 'UserDataList\|userDataChanged' overlay/ | grep -v vdx/`
- *Second derivation:* capture a real `UserDataChanged` frame from `:8096` after marking one
  episode played, as a committed probe tool in the shape of `tools/remux-probe.py`. Read
  `cardBuilder.js:1123-1193` in the reference checkout for what is consumed.
- *Red-at-parent check:* with a held series of **more than one** episode, mark one played;
  the series entry must not carry that episode's state. The check must **fail loudly when no
  such series is held**, because the check it replaces passes vacuously in exactly that case.
- *Semantic exit:* every field of a parent entry is derivable from that parent, and the
  measurement says which fields a parent entry may carry at all.
- *Depends on:* nothing. **Its repair shape is decided by the measurement, not before it.**
  If the measurement shows parents carry derived counts, "build from the parent's own stored
  userdata" is wrong, because this project derives parent counts from children at read time.

**B — bytes written for an item are reclaimable when that item stops being held.**
- *Oracle:* internal coherence.
- *Population:* every write path, not only the two an earlier finding named —
  `grep -n 'writeBlob\|writeStream\|putImages\|putItem\|removeDir\|DB().del' overlay/plugin/downloader.js`
- *Second derivation:* runtime. Download one film and one series, then walk the OPFS tree and
  list every directory created. Remove everything through the UI and walk it again. This is
  the instrument that sees what a grep cannot, and it is the one that would have caught the
  case below.
- *Known to be at least three lifetimes, which is why no collapse is assumed:*
  media and download rows keyed `(srv, itemId, sourceId)`; a downloaded item's row and
  artwork keyed `(srv, itemId)`, live while any of its downloads survive; **a series or
  season's row and artwork, which have no download row at all** and whose lifetime is
  descendant reachability. `library.js` already derives parent *visibility* that way at read
  time. Bytes do not follow.
- *Red-at-parent check:* download a series, remove every episode, assert nothing remains
  under the image tree for the series or any season.
- *Semantic exit:* the second derivation's two OPFS walks differ by exactly the set the
  removals targeted.
- *Depends on:* nothing.

**C — the storage figure equals the bytes actually held.**
- *Oracle:* UI contract. The page says "Downloads are using X".
- *Kept separate from B on purpose.* `heldBytes()` sums `row.bytesDone`, which records the
  media transfer alone; subtitles, font attachments, trickplay tiles and artwork are written
  with no size contribution. **Perfect deletion still leaves the figure wrong**, so B cannot
  discharge C and a plan that merged them would have claimed a promise it had not kept.
- *Population:* `grep -n 'bytesDone\|heldBytes\|writeBlob' overlay/plugin/ overlay/ps/`
- *Second derivation:* compare the figure against a runtime sum over the OPFS walk from B.
- *Red-at-parent check:* download an item with subtitles and fonts; assert the reported
  figure is within a small tolerance of the OPFS sum.
- *Semantic exit:* the two numbers agree for a library containing a film, a series, and an
  item with sidecars.
- *Depends on:* B's walk instrument.

**D — a stored DTO's source-describing fields describe the copy.**
- *Oracle:* internal coherence.
- **Scoped, not universal.** "Every field describes the copy on disk" is false by design:
  series and season rows deliberately have no copy on disk and must keep source identity,
  names and hierarchy for offline browsing. The rule covers fields that describe *the file*.
- *Population:* `grep -n 'Trickplay\|ThumbnailCount\|ChildCount\|RecursiveItemCount\|MediaSources\|RunTimeTicks' overlay/plugin/downloader.js overlay/ps/library.js`
- *Second derivation:* for each field the grep returns, read the consumer in the reference
  checkout and record what it computes from it. A field no consumer reads is not in the rule.
- *Units warning, and this is why the earlier proposed check was wrong:* `tiles` counts tile
  **sheets**; `ThumbnailCount` counts individual **thumbnails**; the downloader derives one
  from the other. An assertion equating them compares different units and can pass while
  scrubbing still requests a missing sheet.
- *Red-at-parent check:* derived from the consumer reading, not from symmetry.
- *Semantic exit:* for every field in the population, the stored value is a function of what
  was written, and the consumer's computation over it reaches nothing absent.
- *Depends on:* nothing.

**E — a database connection releases on request, and no memo outlives it.**
- *Oracle:* API conformance, to IndexedDB.
- *Population:* `grep -rn 'indexedDB.open\|\.close()\|S.once\|PS_SCHEMA.once' overlay/ | grep -v vdx/`
- *Second derivation:* drive it. Hold a connection in one page context, request a higher
  version from another, and observe whether the second is blocked.
- *Not one line:* `once()` forgets rejections only, so closing on `versionchange` leaves a
  fulfilled memo holding a closed database and every later transaction receives it.
- *Red-at-parent check:* open a second connection at a higher version and assert it is not
  blocked; then assert the next transaction through the memo still works.
- *Semantic exit:* after a `versionchange`, a subsequent transaction succeeds against a
  freshly opened connection.
- *Known limitation, to be stated and not called fixed:* this cannot help the upgrade already
  shipped, because the connection that must let go belongs to the build without the handler.
  Acceptable on a demo nobody has been handed.
- *Depends on:* nothing.

**F — at most one question is in progress, and its state has one owner.**
- *Oracle:* internal coherence, and a UI contract decision the owner should make out loud:
  does starting a second question refuse, or cancel the first?
- *Population:* `grep -n 'askDefaults\|resetAsk\|gridLoading\|state.busy\|this.task\|exclusive(' overlay/plugin/manager.js`
- *Second derivation:* drive the component through both races, not one. A grid sweep
  interrupted by `start()`, and two `start()` inspections overlapping — `task()` does not set
  `busy`, so the second race is admitted by the rule and was not addressed by the earlier fix.
- *Red-at-parent check:* both races, separately.
- *Semantic exit:* no second question can begin while a first is in progress, by whichever
  route the owner chooses.
- *Depends on:* nothing.

---

## Docs, in their own commits

- **`SCOPE.md`** records the oracle and the answers to the postmortem's open questions. A's
  answer lands here **after** A's measurement, in a docs commit of its own — v1 scheduled it
  before the measurement that produces it, which was incoherent.
- **`CLAUDE.md`** — DONE, in its own commit. The line stated a promise the code had
  stopped keeping. It now states what `8078ea8` shipped, and quotes the rule it replaces
  so the supersession is legible.
  *Note on its exit predicate, which is a worked example of gate 3's point:* the plan said
  `grep -n 'one place COMPLETE is written' CLAUDE.md` → 0, and that passes — but only
  because the phrase survives inside the quoted supersession, line-wrapped so a
  line-oriented grep cannot see it. The right content and a predicate that would have been
  satisfied by nothing at all. **Prefer a semantic exit over a token count; a token count
  is satisfied by formatting.**

## Not in scope

Applying the seven pending findings as findings. They are inputs to the populations above.
Three are already known to name one site of a larger set, which is why none of them is a
unit of work here.
