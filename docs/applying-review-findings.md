# Applying review findings

How a round of findings is turned into commits here. It is written down because
the advisory version of most of it already existed and did not fire: applying a
fix is the point of maximum local attention and minimum global attention, and a
rule that has to be remembered at that moment is not a rule.

`docs/rounds/` holds the worked example this came out of.

## What settles a disagreement

Three things, and nothing else: **conformance to the Jellyfin API, coherent
technical design of the internals, and the UI contract already agreed.** The
long form, with the answers the owner has given, is the top of `SCOPE.md`.

Every rule names which of the three settles it. A rule that cannot name one is
not ready to be applied — it is a preference, and the code it would change is
about to become the thing that defines the standard it is judged by.

| kind | settled by |
| --- | --- |
| API conformance | measured against a real Jellyfin on `:8096`, or read from jellyfin-web's consuming code in the read-only reference checkout |
| internal coherence | one invariant, one owner, enforced structurally |
| UI contract | what the settings page already promises a person |

## The unit of work is a rule, not a finding

A finding names a site, because that is where the reviewer was looking. A report
organised by location reads as a proposal for one guard per location, and that
is how a bug gets fixed at one of its three sites while the report is closed.

Findings sharing a rule are one repair. Expect at least one rule in a round to
cover a site no finding named; every rule in the round `docs/rounds/` records
did.

## Enumerate before the first patch

**Two derivations of the population, using different kinds of instrument, before
any code moves.** Two greps are one instrument. A grep and a runtime measurement
are two, and so are a grep and a reading of the consumer in the reference
checkout.

They have to agree. Until they do there is no helper name, no site count, no
collapse of two candidate rules into one, and no repair shape. If they disagree,
stop and report rather than picking one.

The deadline is real rather than tidy. Patch the first site and it is solid; by
the third, the first two constrain the repair, and the cheap enforceable fix —
one accessor, a required parameter, a deletion — is no longer reachable. The
window in which the correct repair exists closes on the first patch, silently.

**Prefer the repair that removes an authority to the one that adds a guard.** A
guard, cache, retry or flag mirroring state owned elsewhere is a second
authority, and two authorities diverge. When one is added anyway, the check owed
is to the sibling paths, not to the site.

## A check, observed red at the parent

A rule ships with a behavioural check in `tools/smoke.js` that was **watched
failing at the parent commit**, and the commit message quotes the failure. An
assertion written after its own fix is structurally unable to fail: generating
the fix was the prediction, so nothing it produces can be a surprise.

No red discriminator means the rule stays uncommitted, not fixed-without-cover.
Where that is genuinely impossible the commit message says which arm is
uncovered and why, in those words.

**The suite is regression cover, not confirmation.** It was green through every
defect in the round `docs/rounds/` records, and its passing count rose while
they were being introduced. A green run says nothing about the rule just
applied.

**Treat the fixture as a suspect.** If closing a finding meant changing a
fixture, that fixture is why the bug was invisible, and its siblings are still
lying. The suite's checks are state-coupled — a check that removes a download
removes the item row and its user data, and later checks read them — so a check
that borrows shared state and puts it back has changed what the checks after it
can see.

## Commits

- **One commit per rule.** Never one per finding, never one per round.
- The message carries the enumeration commands and their output, **including the
  sites found clean**. A message naming one site is a rule that was not
  enumerated.
- The message says the check was observed red at the parent, and what it said.
- **A commit never changes both a rule file and the code that rule governs.**
  `CLAUDE.md`, `SCOPE.md` and this directory move in commits of their own.
  Otherwise the code writes the standard it is judged by, in the same breath.

## Stopping

The signal to stop applying is not that a round found nothing. It is that **the
findings are now landing in code this session wrote.** Count where they land,
say so out loud, and stop.

Non-convergence has two causes that need opposite responses. Either a fix was
wrong about the system, or it was right about what it was told and the target
keeps moving because nobody wrote down what the thing must guarantee. If each
fix was defensible against the round that asked for it, another round makes it
worse: it arrives with its own implicit specification.

A third cause no instrument can see: there is no available oracle. The code is
unremarkable, the suite passes, and the work is generically correct and
specifically wrong because nobody in the loop holds the domain knowledge that
says what right is. The tell is that the numbers look healthy and the owner is
unhappy. No amount of reviewing produces a criterion — ask the person who holds
it. The ratifying is theirs, not the session's.

Revert is a first-class option and worth pricing out loud before the next patch.
Separate the code from the coverage when doing it: tests, fixtures and probe
tools written during a bad run are usually sound even when the fixes are not,
and a revert that carries them off turns a recovery into a second loss.
