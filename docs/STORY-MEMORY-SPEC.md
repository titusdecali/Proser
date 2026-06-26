# Proser Story Memory — Design Spec

**Status:** Draft for review (no code yet)
**One line:** Compile the manuscript into an event-sourced *Story State Machine* so the AI is grounded in computed canon — eliminating cross-chapter hallucination — while fitting a small context window.

---

## 1. The problems we're solving

1. **Cross-chapter hallucination.** When generating plot for a later chapter, the model invents events that never happened in earlier chapters. This is the #1 failure of every writing-AI tool.
2. **Context overrun.** A whole novel can't fit an 8k local window. Full-text chapter injection (today's [`buildMentionContext`](../src/features/ai/brainstormPanel.ts)) trips the 75% warning after ~3 chapters.
3. **No memory of craft structure.** The model has no awareness of beats, character arcs, conflicts, or — critically — the **setup↔payoff lifecycle**: open plot points, planted seeds, running jokes, foreshadowing, callbacks.

## 2. Why the standard approach fails

Other tools do **RAG over prose**: embed chapters, retrieve similar passages, stuff them in. That *causes* hallucination — retrieved prose is partial, so the model interpolates across gaps with confident invention.

## 3. Core idea — the Story State Machine (SSM)

Treat the manuscript like an **event-sourced system** (borrowed from software architecture):

- Each chapter emits **events** — atomic, append-only facts.
- A **deterministic reducer folds events → current STATE in code, not by the model.** Current truth is **computed, never recalled.** The model's only job is *local per-chapter extraction* (small, checkable, author-reviewed); the global picture is assembled by a fold the model cannot corrupt. This bounds where the model can err to a single chapter.
- Generation runs as **constrained decoding against a closed world** — the model is *bounded by* canon, not merely *informed by* it (closed-world prompting + cite-the-ID + a verify pass).

Memory is a **dual ledger**:

- **Truth ledger** — what *is* (state, events, per-character knowledge). Prevents contradiction.
- **Debt ledger** — what's *owed* (open plot points, conflicts w/ escalation, seeds, jokes, callbacks). Drives earned, generative payoffs and catches dropped threads.

## 4. Design principles

1. **Grounding over compression.** Memory is authoritative closed-world canon, not a loose summary.
2. **Computed, not recalled.** The reducer (code) folds events into STATE; the model never re-derives global truth.
3. **Machine-dense, legend-decodable.** Symbol table + caveman + fixed schema + delta encoding — but **verbatim anchors** for artifacts whose exact wording *is* the payoff (jokes, foreshadow images, callbacks). *Compress the bookkeeping, preserve the artifact.*
4. **Multi-resolution.** The same events fold into spine → act → chapter → event; retrieval picks the zoom level that fits the budget.
5. **Author is canon.** Generated records are suggestions; an author edit **locks** them. Re-extraction reconciles against locks and surfaces contradictions instead of overwriting.
6. **Audit on save (the inversion).** Extraction both *builds* memory and *polices* the new chapter against locked canon → the memory system doubles as a continuity checker.
7. **Local-first.** Default extraction to the local engine; warn before sending manuscript text to a cloud model.
8. **Corpus-agnostic.** Memory can be generated over *any* designated set of story units — the full manuscript, a multi-file selection, a single combined draft split by headings, an imported finished novel, or pasted text — with **zero assumptions about folder layout or naming**. Proser conventions (numbered chapters, `characters/`, `seed-map.md`) are *enrichment when present, never requirements*. The same machinery runs cold-start over a whole existing book and incrementally per-chapter thereafter.

## 5. The four memory artifacts

A single compact, self-describing codec. Example (illustrative):

```
# ── LEGEND ───────────────────────────────────────────────
C1=Rem  C2=Mara(mother)  C3=Architect
L1=Docks  L2=Spire
T:P1=merge-sabotage  T:X2=debt  T:S3=dock-key  T:J4=coffee-gag  T:CB5=one-legged-gull

# ── STATE @ end ch.22 (always-on; folded from events) ─────
alive:C1,C2   dead:C3(ch07,L2)
C1 @L1  arc:defiance(4/5)  knows:P1=fatal  NOT:knows-C2-betrayal  wants:expose-merge
C2 @L2  arc:guilt(2/5)     knows:X2,C2-betrayal
world: merge-vote scheduled ch24

# ── PROMISES (Debt ledger; status ●open ◐esc ○dormant ✓paid ⚠stale)
P1 plot    "who sabotaged the merge?"   ●open      opn:01.3 stakes:high drive:C1 exp:~ch24
X2 confl   C1↔C2 over the debt          ◐esc(3/5)  opn:02.1 →likely ch23
S3 setup   rusted key in dock locker    ●open ⚠    opn:04.2 promise:opens L2 vault  (stale 18ch)
J4 joke    "Mara never pays for coffee" ●open      opn:01.7 rule:she always dodges the bill; recurred:03,06,14
CB5 callbk the one-legged gull          ●open      opn:01.1 anchor:"the one-legged gull on the piling"

# ── EVENTS (retrievable log; not all injected) ───────────
07.1 C3 reveals P1=fatal→C1 @L2 ; C1=betrayed
07.2 C1 kills C3 @L2 (accident) ; CANON:C3 dead
...
22.4 C2 admits debt→C1 @L2 ; X2 escalates 2→3
```

| Artifact | Role | Always-on? |
|---|---|---|
| **Legend** | Symbol table (entities→IDs) so everything else is terse and decodable | Yes (relevant subset) |
| **State** | Folded snapshot: alive/dead, location, arc stage, **knowledge-state** (incl. `NOT:` — what a character doesn't yet know) | Yes |
| **Promises** | Typed setup↔payoff ledger with lifecycle + escalation + verbatim anchors | Open/stale entries: yes |
| **Events** | Append-only atomic facts, the source the reducer folds | No — retrieved on demand |

### Per-type fields that matter
- **Plot point** — open *question* + stakes + driver + expected resolution chapter.
- **Conflict** — parties, source, **escalation level (n/5)** so tension ratchets, never resets.
- **Setup / Chekhov's gun** — planted detail + promise + **staleness flag**.
- **Joke / running gag** — the **rule of the gag** + recurrence list (consistent escalation).
- **Callback / special moment** — the emotional/imagistic **anchor, stored verbatim**.

## 6. Stable IDs (key decision)

Events and entities are keyed by **content-stable IDs (uuid/slug), not chapter numbers**, with a separate ordering index. Inserting or reordering chapters must not break references. Chapter position is metadata on the event, not its identity.

## 7. Storage layout

```
.proser/
  memory/
    legend.json         # entity table (ids, names, aliases, type) — author-editable
    state.json          # latest folded snapshot (derived; regenerable)
    promises.json       # the Debt ledger (some entries author-locked)
    events/
      <chapterId>.json  # per-chapter extracted events + synopsis + hash
    locks.json          # author-verified canon (immutable to the extractor)
    index/              # (phase 3) embeddings for retrieval
```

- `events/*` carry a **content hash** so unchanged chapters are skipped on re-extract.
- `state.json` and folded summaries are **derived** — deletable/regenerable from `events/` + `locks.json`.
- Stored under `.proser/` (alongside the existing `.proser.json` meta), git-ignorable per the author's choice.

## 8. Sources & the corpus resolver

A **corpus resolver** turns whatever the author designates into an *ordered list of story units* (the extraction input), with no structural assumptions:

- **Whole manuscript folder** — every chapter file (the default).
- **Multi-file selection** — an arbitrary set of files the author picks.
- **A single combined draft** — one big file, segmented into units by chapter headings, scene breaks (`***`), or size.
- **Active editor selection / pasted text** — ad-hoc "story context."
- **Imported finished novel** — any folder/file layout, no Proser conventions present.

**Ordering:** default to filename-lexical (the existing reading-order convention) or document order for a single file; the author can reorder. Units carry a stable ID + an order index, so reordering never breaks event references (§6).

**Optional enrichment (used only if present, never required):**
- **`seed-map.md`** → ingested as authoritative seeds into the Promises ledger.
- **`characters/`, `continuity/`, `world/`, `bible`** → seed the Legend and locked canon (author-authored = locked by default).

The system must produce a complete SSM from a **bare set of chapter files with nothing else.**

## 8.5 Scope: the Story Root — canon vs. reference (the running true source)

The single most important anti-hallucination decision is **what counts as canon.** The fold (§9b) must ingest *only canonical manuscript prose* — never research notes, worldbuilding dumps, or scratch drafts. Notes contain speculation, abandoned branches, and planning meta-commentary ("idea: kill Rem in ch.20"); fold those as events and the model treats things-that-never-happened as established fact. **That mixing *is* the hallucination.**

So material is split by trust, and the engine treats each differently:

| | **Story Root (canon)** | **Reference** |
|---|---|---|
| What | The actual manuscript chapters, in reading order | notes, research, drafts, worldbuilding, character bible |
| Role | The **running true source** — folded into STATE / events / promises | Enrichment only — **never folded as events** |
| In context | Authoritative; closed-world; the model may not contradict it | If injected, **labeled "author notes — speculative, may not have happened"** so it's weighted as background, not fact |
| Setting | `proser.storyRoot` (one folder) | everything else (optionally `proser.referenceFolders`) |

A vetted **character bible** is the one nuance: it's reference the author *trusts*, so they may **promote** it to locked canon (seeds the Legend + `locks.json`) — but that's an explicit author act, not an automatic fold. The default for anything outside the Story Root is *speculative reference*.

**The UI must say this in plain words.** The first-load prompt (§8.6) and the Settings description read:

> *"Pick the folder with your actual manuscript chapters — your real, in-continuity story. Don't point this at research notes, worldbuilding, or scratch drafts: Proser treats this folder as canon it can never contradict, so mixing in unfinished ideas will make the AI hallucinate."*

**Keep canon clean even inside the root.** Re-apply the existing reference-exclusion list (`readme, notes, bible, threads, arcs, review, todo, memory` — [`DEFAULT_EXCLUDE`](../src/features/manuscript/compile.ts)) during the fold, so a stray notes file *inside* the manuscript folder never pollutes the truth ledger.

**Deliberate asymmetry with `@`-mentions:** the `@`-mention picker stays **broad** (you can still reference notes/bible to brainstorm), but the **fold is strict** (canon only). Two scopes, two jobs — and at generation time the model is always told *which* tier each block came from, so it can never confuse "what happened in the book" with "what the author was musing about."

## 8.6 Where scope is set — Proser's Settings tab + first-load

**Home = Proser's own Settings tab**, not native VS Code settings. The Proser panel ([`manuscriptPanel.ts`](../src/webview/manuscriptPanel.ts)) is already a tabbed webview (Editor / Insert / **Settings**); the Story Root is a new **"Story folder"** row there — current path + a **"Choose…"** button — matching the panel's existing settings UX.

**Edit flow (matches the existing pattern):** the row posts a message (`{type:'pickStoryRoot'}`) → the host ([`sidebar.ts`](../src/features/manuscript/sidebar.ts) `onDidReceiveMessage`) opens `showOpenDialog` (folder mode) → persists → broadcasts the new scope to all panels.

**Store:** `.proser.json` at the root (committable, portable, and readable by the engine without VS Code), stored relative to the workspace folder. (`workspaceState` is the lighter precedent the panel already uses for toggles — acceptable, but `.proser.json` lets the canon scope travel with the project.)

- **Default:** the workspace folder the user opened (the one containing the active file in multi-root). No structural guessing — heuristics only *rank* the picker's suggestions (e.g. by `NN-*.md` chapter density), never silently commit.
- **First-load ask:** non-blocking, **once per project** (gated by a `workspaceState` "asked" flag), on first use of Brainstorm/Story Memory — not bare activation. Pre-filled with the default → one-click confirm: *"Story folder: **THE_FRAME** — [Use this] [Choose…] [Later]."* It carries the §8.5 canon-vs-notes guidance. "Later" falls back to the default and surfaces a dismissible banner, never re-popping a modal.
- **One picker, three entry points:** the Settings-tab row, the first-load prompt, and the Brainstorm `Scope ▾` header control all invoke the *same* host picker and write the *same* store.
- **Live + shared:** on change, the host re-scopes the `@`-mention list and flags Story Memory for rebuild (the canon corpus changed).

## 9. Pipeline

### 9a. Extract-and-audit (on chapter save, debounced via the existing `**/*.md` watcher)
For the changed chapter only:
1. Send the chapter text + the current Legend + relevant locked facts to the **local** engine ([`AiClient.chat`](../src/features/ai/AiClient.ts)) with a structured extraction prompt.
2. The model returns: a 1–3 sentence **synopsis**, the chapter's **events**, **state deltas**, and **promise open/close** transitions — in the codec schema.
3. **Audit:** reconcile against `locks.json`. Any contradiction of locked canon → a **continuity diagnostic** (surfaced to the author), *not* an overwrite.
4. Persist `events/<chapterId>.json` + hash.

### 9b. Fold (deterministic, in code — no model)
Accumulate all `events/*` (in order) + `locks.json` → recompute `state.json` and the multi-resolution summaries (chapter → act → spine). Promises lifecycle is updated by open/close events.

### 9c. Bootstrap / backfill (cold-start over an arbitrary corpus)
The same per-unit extraction in §9a, run as a **batch** over a resolved corpus (§8) that has no existing memory — e.g. an imported finished novel or a freshly selected set of chapters:
1. Resolve + order the corpus into units.
2. **Map:** extract each unit (parallelizable; throttled to the engine's capacity).
3. **Fold** once at the end (§9b).
Properties that make this usable at book scale:
- **Resumable & idempotent** — hash-gated per unit, so a re-run or a crash recovery skips completed units.
- **Progress + cancelable** — long backfills report progress and honor an `AbortSignal` (the chat path already threads one).
- **Bounded** — batched with a concurrency cap; never blocks the UI.
- After bootstrap, the incremental path (§9a on save) keeps it current. Bootstrap and incremental are the *same code*, different scale/trigger.

## 10. Generation-time assembly (the budget allocator)

Replaces today's all-or-nothing injection in [`buildMentionContext`](../src/features/ai/brainstormPanel.ts). Fill the window in tiers — smallest & most authoritative first; largest & most optional last. Target budget from `OllamaClient.contextLength()` (or the cloud model's known window, replacing the current 8192 assumption).

| Tier | Content | ~Tokens | Drop order |
|---|---|---|---|
| 0 | Role + rules (closed-world, cite-IDs, flag-unestablished) | ~60 | never |
| 1 | Legend (relevant subset) | ~200 | never |
| 2 | **STATE @ end of prev chapter** (the contradiction-preventer) | ~600 | never |
| 3 | Debt ledger: open/escalating/stale + available seeds (verbatim anchors) | ~500 | never |
| 4 | Theme spine + logline | ~150 | last |
| 5 | Retrieved relevant **events** (entity-match → embeddings) | ~1–2k | trim |
| 6 | **Verbatim prose of the immediately previous chapter** (voice/tone exactness) | ~1–2k | first |
| 7 | User prompt + chat history | remainder | — |

**Net for "chapter 23 of 30":** ~4–7k tokens — fits 8k local with headroom, comfortable on cloud. The model never sees ch.1–21 in full, yet cannot contradict them (their consequences are in Tier 2) and cannot fabricate (closed-world + cite-IDs). On a smaller window it degrades gracefully (drop 6, trim 5) but Tiers 0–4 always survive, so grounding never disappears.

## 11. Anti-hallucination guards (prompt-level)

1. **Closed-world framing** — the ledger is *exhaustive* for "what has happened"; anything absent is **not yet established**; say "unestablished," never invent.
2. **Cite-or-flag** — assert a prior event only by its fact ID (`per 07.2`); a fabricated event has no ID.
3. **Verify pass (phase 3)** — a cheap second call checks each prior-event claim in the generated plot against the ledger and flags unsupported/contradictory ones before the author sees them. (Same adversarial-verify pattern as code review, pointed at canon.)

## 12. UX surfaces

- **"Build / Refresh Story Memory from…" command** — choose the corpus (§8): whole folder, selected files, the combined active document, or pasted text. Runs the bootstrap (§9c) with a progress notification and cancel. The entry point for generating memory over *any* set of chapters.
- **Story Memory view** (sidebar webview, alongside Chapters): browse/edit character cards, arcs, themes, and the Promises ledger; **lock** a card to make it canon.
- **Brainstorm toggle:** "Use story memory" (default on); the existing context meter shows the **tier breakdown** (state / debt / retrieved / prose / chat).
- **Continuity diagnostics:** contradictions from audit-on-save and stale/dropped seeds surface as warnings (reuse the quality-lint surfacing pattern).

## 13. Codebase integration points

- [`brainstormPanel.ts`](../src/features/ai/brainstormPanel.ts) — replace `buildMentionContext` injection with the tiered assembler; feed the meter the breakdown.
- Chapter watcher in [`chaptersView.ts`](../src/features/manuscript/chaptersView.ts) — hook extract-and-audit (debounced, hash-gated).
- [`AiClient`](../src/features/ai/AiClient.ts) / `createEngine` — extraction + verify calls (await full text; ignore streaming).
- [`compile.ts`](../src/features/manuscript/compile.ts) — reuse `gatherChapterFiles`, `titleFromFilename`, `manuscriptFolder`, and `DEFAULT_EXCLUDE` (canon-fold exclusion, §8.5).
- [`manuscriptPanel.ts`](../src/webview/manuscriptPanel.ts) + [`sidebar.ts`](../src/features/manuscript/sidebar.ts) — add the **"Story folder"** row to the existing Settings tab and the `pickStoryRoot` message → `showOpenDialog` → persist to `.proser.json` (§8.6).
- Settings live in **Proser's Settings tab** (above); any `proser.memory.*` native config (enable, extraction-engine override, regenerate command) is secondary.

## 14. Phased roadmap

- **Phase 0 — Plumbing + cheap win.** `.proser/memory/` scaffolding; an `@bible`/`@all` token that injects reference files (`characters/`, `bible`, `seed-map.md`) as context. No generation yet — better use of what's already written.
- **Phase 1 — Truth ledger + bootstrap.** The corpus resolver (§8) and the **"Build Story Memory from…"** command (§9c); per-unit synopsis + event extraction; deterministic STATE fold; always-on injection of Legend + STATE. Works cold-start over any imported book or selected set. Biggest awareness-per-token gain; directly attacks hallucination.
- **Phase 2 — Debt ledger.** Promises extraction (ingest `seed-map.md`); open-loops + seeds injection; stale/dropped-thread detection.
- **Phase 3 — Retrieval, verify, audit.** Entity→embedding retrieval; multi-resolution folding; verify pass; audit-on-save continuity diagnostics.
- **Phase 4 — UI + locking.** Story Memory view; author edit/lock; meter breakdown.

Each phase is independently shippable and degrades gracefully on small models.

## 15. Open questions for the author

1. **Extraction model:** reuse the chat model, or a dedicated small/fast local model for extraction?
2. **Cloud privacy:** hard-block cloud extraction (local-only), or warn-and-allow?
3. **Regeneration cost:** background extraction on every save vs. an explicit "Update Story Memory" command vs. on-idle?
4. **Storage visibility:** `.proser/memory/` committed to the repo (shareable, diff-able canon) or git-ignored (local cache)?
5. **Scope:** single book now; series/multi-book canon later?
6. **Author authority:** should author-authored `characters/`/`bible` files always win over extracted cards automatically?
7. **Multiple corpora:** one memory per workspace, or per-corpus stores keyed by folder/selection (so a side-story or series bible is independent of the main manuscript)?
8. **Single-file segmentation:** when bootstrapping one combined draft, split by heading level, scene break (`***`), or size — and which is the default?

## 16. Risks & mitigations

- **Bad extraction poisons canon** → per-chapter scope keeps errors local; author review + locks; audit surfaces contradictions.
- **Over-compression → ambiguity → hallucination** → compress only redundancy/bookkeeping; keep facts atomic; preserve verbatim anchors.
- **Stale memory after edits** → hash-gated re-extraction on save; deterministic re-fold; stable IDs survive reorder.
- **Latency** → extraction is per-chapter + debounced + background; assembly reads only small JSON.
- **Backfill cost on a whole book** → batch with a concurrency cap, hash-gated/resumable, progress + cancel; a slow local model degrades to "still working" rather than a freeze (§9c).

## 17. How we'll know it works (eval)

- **Hallucination rate:** a fixed prompt set ("plan ch.N") scored for invented/contradictory prior-events with vs. without SSM.
- **Continuity catch rate:** seed known contradictions into a test manuscript; measure audit-on-save detection.
- **Budget fit:** assembled context stays under target window across book lengths.
- **Payoff usage:** fraction of generated plots that resolve an *existing* open loop or call back an *existing* seed (vs. inventing).
