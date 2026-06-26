# Changelog

All notable changes to Proser are documented here.

## [1.4.24]

### Added
- **Grammar checking, powered by Harper.** Grammar mistakes — subject–verb agreement,
  swapped homophones (*their/there*, *its/it's*), accidentally repeated words, and more —
  are now found by [Harper](https://writewithharper.com), a fast grammar engine that runs
  fully offline on your machine, instead of the local AI model. It's deterministic and
  high-precision, so it catches real mechanical errors without the model's occasional odd
  "corrections." Right-click an underlined error for a one-click fix, exactly like the
  spelling and tense fixes. Nothing leaves your computer.
- **Incorrect Punctuation & Spacing underlining.** Based on your preference, periods and 
  commas are underlined if they are **inside** (American) or **outside** (British) the 
  closing quote.

### Changed
- **Clearer Editor sidebar.** The **Scope** and **Tense** controls now sit under the
  **Checks** heading, with a caption noting they apply to the check buttons and the
  continuous scan — and that the live underlines you see while typing always check the
  file you're currently editing.

### Fixed
- **The tense check no longer flags dialogue.** A novel's narration may be past tense while
  its dialogue speaks in the present — that's correct, not an error. The tense underline now
  ignores changes that fall entirely inside quotation marks, so a line like *"I enjoy this,"*
  in a past-tense story is left alone, while a genuine tense slip in the narration is still
  caught.
- **Right-click fixes for spacing and quotation punctuation now register reliably.** These
  underlines are only a couple of characters wide, and the old hit-test often missed them;
  clicking anywhere on the highlight now opens the fix card.

## [1.4.23]

### Fixed
- **Tense underlines stopped appearing after the passive checker was added.** The new
  passive pass and the tense pass are two whole-document checks on the same single local
  model; running them at the same time made them contend, and tense could come back empty
  and silently stop flagging. The live checks are now serialized — only one runs against
  the model at a time (tense first, passive after) — so tense flags reliably again.

## [1.4.22]

### Added
- **Revise → Insert Below.** Each revision option now has an **Insert Below** button under
  **Accept**. *Accept* replaces your selected text with the revision (as before); *Insert
  Below* keeps your original text and drops the revision in as a new paragraph beneath it —
  handy for comparing versions or keeping both.

### Changed
- **Passive voice is now judged, not just detected.** Instead of flagging every passive
  sentence, your **local AI model** decides whether each one would genuinely read better in
  active voice — and only underlines those. Passive is left alone when it belongs: when the
  doer is unknown, unimportant, or obvious; when the recipient is the point; or in a formal
  register. It's flagged more readily in narration/description and treated leniently inside
  dialogue. The same judgment now drives the live editor underline (purple), the sidebar
  **Check Passive**, and the combined scan.
- The live passive underline is now an AI pass (like tense) rather than an instant regex, so
  it reflects judgment; a regex pre-filter skips the model on passive-free prose, and the
  underlying heuristic gained ~35 common irregular participles for better recall.

## [1.4.18]

### Added
- **Live writing checks right in the Pretty editor.** As you write, sentences are
  underlined in distinct colors — no sidebar scan needed:
  - **Passive voice** (purple) — instant, logic-based; works **offline** on a document of
    any size.
  - **Tense slips** (orange) — your **local AI model** flags sentences that drift from the
    narrative tense, **automatically in the background** (on open and after you pause
    typing), across the whole chapter.
  - **Grammar / word choice** (blue) — the AI proofread, now with its own on/off switch.
  - **Sentence spacing** (yellow) — flags the wrong number of spaces after a sentence
    (line and paragraph breaks are never flagged).
- **Right-click an underline to fix it.** A one-click corrected-tense rewrite for tense;
  *Rewrite in active voice* for passive; or **Dismiss** to stop flagging that sentence.
- **Settings → Live Style Checks** — toggles for **Grammar**, **Passive voice**, and
  **Tense**, plus a **Sentence Spacing** option (None / 1 space / 2 spaces). New settings:
  `proser.checks.grammar`, `proser.checks.passiveVoice`, `proser.checks.tense`,
  `proser.spacing.afterPeriod`.
- **Cloud (OpenRouter) asks for your API key the moment you pick it** — from the editor
  **Model** dropdown, the **Brainstorm** model picker, or *Select AI Model*. The cloud key
  now powers **only Brainstorm & Revise**; spell check, synonyms, the tense/passive checks,
  and Story Memory always stay on your **local** model.

### Changed
- **Background tense checking now actually runs on local models.** It used to be silently
  disabled when AI spell-check was off, and the local thinking model returned nothing
  without disabling its chain-of-thought — both fixed, so the live tense underline and the
  manual *Check Tense* work reliably.
- **Fewer false flags.** Tense only underlines a sentence when there's a real correction to
  make (no more "no change needed"), and a sentence you've **fixed or dismissed is never
  re-underlined**. The grammar proofread is more conservative and no longer second-guesses
  narrative tense (that's the dedicated tense check's job).

## [1.4.14]

### Changed
- **Chapters open in preview mode, like normal files.** A single click in the
  Chapters sidebar opens a chapter as a preview tab (italic — the next single click
  replaces it); a double click (or editing, or double-clicking the tab) opens it
  pinned. Requires `workbench.editor.enablePreview` (VS Code's default).

## [1.4.13]

### Fixed
- **Cmd/Ctrl+S now saves the document** instead of striking through the text (Toast
  UI's built-in shortcut was hijacking it).
- **Deleting all of a chapter's text now persists.** Saving with Cmd/Ctrl+S flushes
  the current editor content to the document before writing to disk, so an emptied
  (or just-edited) chapter no longer reverts to its old text when you close and reopen.

## [1.4.12]

### Changed
- **Story Memory is now a readable per-chapter summary** instead of a fragmented
  canon/entity graph. Each chapter is distilled to its major plot points, start/end
  location, key plot-progression beats, and important character arcs — and Brainstorm
  is grounded in that "story so far" rather than a list of disconnected facts, so
  replies actually respect what has happened. **Rebuild Story Memory once** (the
  format changed) to regenerate it.

## [1.4.11]

### Fixed
- **Brainstorm is usable again with Story Memory loaded.** The injected canon was
  being sized to the model's full (e.g. 256k) context, so it overflowed the actual
  window and filled the chat to ~120% before you typed. It's now budgeted to the real
  window, so it always leaves room to chat. A new setting
  `proser.ai.ollama.brainstormContextTokens` controls how big that window is —
  **default 50000** (fits ~35k of memory), adjustable up to **200000** — raise it for
  a larger story memory if you have the VRAM, or lower it if the model runs out of memory.

## [1.4.9]

### Added
- **Em-dash auto-convert.** Typing `--` becomes `—`. Typing a third dash reverts it
  to `---`, so markdown horizontal rules / frontmatter / table separators still work.

### Fixed
- **Undo/redo no longer jumps the page to the end.** Pressing Ctrl+Z / Ctrl+Shift+Z
  (or otherwise syncing an external change) used to rebuild the document and scroll
  to the bottom; it now preserves your cursor and scroll position.
- **The model stays loaded instead of constantly reloading.** Every AI feature now
  requests the same context window, so switching between spellcheck and synonyms no
  longer makes Ollama unload and reload the model, and the model is kept resident for
  the work session (no 5-minute idle unload). The footer stays "Model Ready".

## [1.4.8]

### Added
- **"N words selected" counter** in the editor footer. Select text in the editor and
  the selected word count appears in blue beside the word/char/read-time stats; it
  disappears when nothing (or only a single word) is selected.

## [1.4.7]

### Fixed
- **Footer spinner no longer spins after just opening a file.** Opening a document
  used to kick off a full-document AI proofread (one model call per paragraph), so
  the spinner ran for a long time even though you hadn't done anything. The AI
  proofread now runs incrementally as you edit (re-checking only the paragraphs you
  touch), so the spinner shows only when there's real work. The instant dictionary
  spellcheck still runs on open as before.

## [1.4.6]

### Changed
- **Story Memory captures far less noise.** The per-chapter extraction now scores
  every fact for importance and keeps only plot- and character-arc-relevant canon —
  trivial actions, daydreams, scenery, and snacks are dropped instead of becoming
  "events." Entities are cleaner too: only named, recurring people/places/things are
  recorded (no more stray phrases or one-off props), and a chapter now reads as a
  tight synopsis plus a few consequential beats rather than a wall of fragments.

### Fixed
- **Thinking models no longer stall AI features.** Local `gemma4` models are
  reasoning models; Proser now tells them to answer directly for Story Memory, spell
  check, and synonyms — which were otherwise reasoning past their budget and
  returning nothing (and running slowly). Story Memory extraction is now ~7× faster
  and reliable, and pins a low temperature so results are consistent run-to-run.

## [1.4.5]

### Changed
- **One AI model powers everything.** Brainstorm, Revise, Synonyms, and Spell Check
  now all use the single model you pick — no separate "helper" model and no second
  Ollama server. This fixes the out-of-memory crashes from running two models at
  once on 24 GB machines. Settings is now three clean rows: **Revision & Brainstorm**
  (model), **Synonyms & Antonyms** (AI / Online / Offline), **Spell Check**
  (AI / Offline), each with a ⚙ gear (manage models / thesaurus settings /
  dictionary language).
- **Only one model stays loaded.** On startup and whenever you change models, Proser
  unloads any other resident model from Ollama (and any model left by a previous
  version's helper server) so memory isn't wasted.
- **Model picker hides models that can't run on your machine.** Models needing more
  memory than your system has (e.g. 26B/31B on 24 GB) are no longer offered; an
  already-downloaded one that's too big moves to a "won't run here" row you can
  delete to free space.

### Added
- **Live model status in the editor footer** (right side, opposite the word count):
  the active model, a spinner while it's working, a **"Loading Model…" / "Model
  Ready"** state, and the model's **VRAM** usage.
- **Background work yields to what you're doing.** Synonyms and spell check pause
  while Brainstorm, Revise, or a Story Memory scan is generating, so they don't
  compete with it for the one model.
- **"Open Project Folder" button** in the Chapters sidebar when no folder is open
  (and a "Set Story Folder" button when a folder is open but has no chapters).

### Fixed
- **Story Memory scans no longer run out of memory.** Each chapter now requests only
  as much context window as it needs instead of a fixed large one, so large books
  scan within memory on a single model.

## [1.4.4]

### Changed
- **Unified "Add / Remove Models" — now a ⚙ gear button beside every model dropdown.**
  The Editor, Synonyms, Spell Check, and Brainstorm model dropdowns no longer carry
  inline "Custom… / Remove… / Download / manage…" rows (which could get stuck as the
  selected value). Instead a single **gear** next to each dropdown opens that model
  family's picker, where you download by Hugging Face / Ollama URL or delete a
  download. Same control everywhere; the list shows the right models for each.

## [1.4.3]

### Added
- **Switch the model right from Brainstorm.** The Brainstorm header now has a model
  **dropdown** (the system-fitting editor models + a Cloud option) — change it without
  going to Settings.
- **Rescan Story Memory from Brainstorm.** A **Rescan ▾** split-button with
  **Re-Scan Active Page** (just the open chapter) and **Re-Scan All Files** (rebuild
  the whole context from scratch).

### Fixed
- **More real words clear.** When the AI marks a word a "typo" but its only correction
  *is the word itself*, that means it's actually correctly spelled — Proser now clears
  it (fixes cases like `phosphoresced` staying flagged). Combined with 1.4.2's guard
  removal, words like `Woah`, `reticle`, `torturously` clear after the proofread pass.

## [1.4.2]

### Fixed
- **AI proofread no longer overloads the machine.** The live proofread (1.4.1) could
  flash the editor and crash on a large editor model. Three fixes:
  - **No more repaint storm** — results are now coalesced (≤1 repaint per ~0.7 s)
    instead of one full re-scan + repaint per paragraph (the rapid flashing).
  - **One model call at a time** (was two) — gentler on memory and compute.
  - **Memory guard** — Proser no longer loads the ~7 GB proofread helper next to an
    editor model that already fills RAM (e.g. a 26B beside Gemma E2B on 24 GB). It
    stays dictionary-only and tells you once to switch the Editor Model to the 12B.
- **Smarter false-positive clearing.** Real words the dictionary doesn't know
  (`ramen`, `ahh`, names) now clear correctly — the old guard wrongly kept any word
  that sat within an edit or two of a real word (`ramen`↔`raven`). The capable model's
  verdict is trusted instead.

## [1.4.1]

### Added
- **Live AI proofread — smarter spelling + grammar.** With a capable AI model set
  for Spell Check (Gemma E2B), Proser now proofreads as you write:
  - **Clears the dictionary's false positives** — it stops flagging real words the
    dictionary doesn't know (character/place names, slang, brands, foreign/coined
    words, sounds like "Ahhhhgkkk"), while a safety guard keeps it from ever hiding a
    genuine typo.
  - **Catches grammar / word-choice errors** the dictionary can't — wrong homophones
    (their/there, its/it's), agreement, missing words — underlined in **blue** (vs.
    the red spelling squiggle), with a **right-click one-click fix**.
  - **Incremental & cheap.** It runs on a freshly-opened file and as you type (3 s
    debounce), and **only re-checks paragraphs you actually changed** (content-hash
    cache) — unchanged text is never re-scanned. One model call per changed paragraph
    handles both spelling verdicts and grammar.
  - Uses your Spell Check helper model (recommended: **Gemma E2B**, shared with
    Synonyms = two models total alongside a 12B editor). A 1B is too small for grammar,
    so on a tiny/absent model it gracefully falls back to dictionary-only spelling.

## [1.3.9]

### Fixed
- **Spell check works again — the English dictionary now loads reliably.** The
  bundled English Hunspell data was loaded via a dynamic `import()` of an ESM-only
  package; in the *packaged* extension host that can fail **silently**, leaving spell
  check dead with no error (nothing underlined, even on obvious typos like
  "asdfsdf"). Proser now reads the dictionary's `.aff`/`.dic` files directly from the
  extension, which works in both development and packaged builds — and if the
  dictionary ever fails to load, it now says so instead of failing quietly.

## [1.3.8]

### Changed
- **Spell Check shares the Synonyms model by default — two models, never three.**
  Spell check now inherits whatever small model Synonyms uses, so only your editor
  model + one shared helper load at a time. (An earlier build could leave Spell on a
  *different* helper than Synonyms — e.g. Synonyms on Llama 3.2 1B but Spell on Gemma
  E2B — quietly running three models. A one-time fix re-points a mismatched Spell
  model back to the shared helper.) You can still pick a different model for Spell
  explicitly if you want the bigger Gemma's sound-vs-typo detection — that just loads
  a third model by choice.

### Removed
- **The active-model labels are gone from the editor.** The "✦ model" in the Pretty
  editor's page footer and the bottom-right status-bar item are both removed — the
  model now lives in the Brainstorm header and **Settings → Editor Model**, so it's
  not repeated in the corner of the page.

## [1.3.7]

### Changed
- **Proser panel: Insert moved into the Editor tab.** The separate Insert tab is gone;
  New Chapter / Add Divider / Add Scene Break now live in a compact, **wrapping**
  "Insert" section right below Checks (chips that flow in a row instead of one per
  line). One fewer tab to hop between while writing.

### Fixed
- **Editor & Brainstorm panels open at the right width — no more resize flicker.**
  They used to open at a half-screen split and then snap to their target width once
  the webview reported its size. Proser now remembers the editor-area width and
  pre-sizes the panel before it paints, so it opens at the correct size from the
  first frame (the very first open per machine still measures once, then every open
  after is flicker-free).

## [1.3.6]

### Changed
- **Synonyms/antonyms now use a small helper — never your big editor model.** Word
  lookups previously fell back to the active editor model (e.g. a 12B/26B) when no
  dedicated synonyms helper was set, which was slow and competed with Brainstorm/Revise
  for memory. Now, the first time you use AI synonyms without a helper configured,
  Proser sets a light, fast model (`llama3.2:1b`) as the default and offers a one-time
  download — it co-resides with any editor model and is plenty for synonyms. The big
  editor model is never used for word lookups. Prefer the multilingual 7 GB Gemma? Pick
  it any time in **Settings → Synonyms**. (Spell check was unaffected — it only ever used
  Hunspell plus an optional helper.)

## [1.3.5]

### Fixed
- **Chapters list now follows your Story Folder.** The sidebar's CHAPTERS list was
  showing the workspace-root files (notes, outlines, research) whenever no chapter
  was open, instead of your actual manuscript. It now lists the **Story Folder** you
  set (recursively, in reading order, with reference notes excluded) so you see your
  real chapters — falling back to the active/root folder only when no Story Folder
  is configured.

### Added
- **First-run Story Folder prompt.** Opening a writing project that has no Story
  Folder set now asks once which folder holds your manuscript chapters (so Chapters
  and Brainstorm point at chapters, not notes). Asked at most once per project; set
  or change it any time from **Settings → Story Memory → Set Story Folder**.

## [1.3.4]

### Added
- **Editor Model is now an inline dropdown** (matching the Synonyms / Spell Check
  controls) instead of a button → picker. It lists **only writing models that fit
  your system alongside the synonyms/spell helper** — the editor and helper run
  together, so the list reserves the larger configured helper's memory and shows just
  the models that co-reside stably (e.g. a 24 GB Mac with the ~7 GB Gemma helper lists
  up to the dense **12B**, never the 26B/31B). Pick a bigger helper and the editor
  list tightens automatically.
  - **Custom… (install from a URL)** lives in the dropdown: choose it to paste a
    Hugging Face or Ollama URL (or any tag) and Proser downloads + activates it.
  - **Remove a download…** is in the dropdown too — pick it to delete any pulled
    model from disk and reclaim space.
  - **Cloud (OpenRouter)…** switches the editor to a cloud model; the dropdown shows
    your active cloud model when one is selected. Your current model is always shown
    selected, and a custom/over-tier model you already pulled stays listed.

## [1.3.3]

### Added
- **Settings: clean two-dropdown controls for Synonyms and Spell Check.** Each is now a
  **Type** dropdown + a **dynamic Secondary** dropdown. Synonyms Type = AI model / Online
  (Datamuse) / Offline (WordNet); Spell Check Type = AI model / Offline Package. The Secondary
  changes with the Type — AI shows your tier-filtered models (plus a "Download / manage…" entry),
  Spell-Offline shows the language dictionary, Synonyms-Online/Offline show Datamuse / WordNet.
  Replaces the confusing separate Model / Source / Language rows.


- **Story Memory** — an event-sourced context engine that reads your manuscript and
  grounds Brainstorm in what has actually happened, so the AI doesn't contradict or
  hallucinate earlier chapters. Set it up from the Proser panel: **Settings → Story
  Memory → Story Folder**, then **Build Story Memory**.
  - **Point-in-time context**: the AI sees the state of the book, characters, and plot
    *as of the chapter you're working on* — never leaking events from later chapters.
  - Tracks a per-character knowledge-state, locations, and a setups↔payoffs ledger
    (open plot points, conflicts, planted seeds, callbacks) for earned, consistent ideas.
  - Runs locally (Ollama) by default; canon stays in `.proser/memory/`. Reliable
    extraction via schema-constrained decoding; output stays in Brainstorm for you to
    copy/paste — it never writes to your files.
- **Brainstorm `@`-mentions now span the whole workspace** (all folders, recursively),
  with fuzzy matching and folder paths shown to disambiguate same-named files.
- **Model pickers now show only what runs stably on your system.** Both the Editor
  Model and AI Helper pickers detect your tier (Low-end / Mid-tier / High-end, by
  unified RAM or GPU VRAM) and hide models that would crash or thrash — so a 24 GB Mac
  no longer even lists the 26B/31B that overflow it (it shows up to the dense **12B**),
  and the Helper only offers the ~7 GB Gemma where it can co-reside with your editor
  model (24 GB+); smaller machines see the tiny helpers. The title shows your tier, an
  over-sized model you already pulled stays (flagged) so you can still delete it, and
  “Download another model…” remains to install anything by hand.
- **Synonyms and Spell Check each get their own model.** Settings now has three independent
  AI roles: the **Editor Model** (Brainstorm, Revise, Story Memory — your larger model), a
  **Synonyms Model**, and a **Spell Check Model**. Each small model is picked in its own
  Settings section and runs on Proser's separate helper server, so none of them evicts the
  editor model — and if you choose *different* models for synonyms vs spelling, both stay
  resident too (verified). By default both word‑models recommend the same small model, so one
  download handles both; set **Off** on either to use the dictionary. Existing single‑helper
  setups migrate automatically (both inherit your old helper model).
  - **Both models stay loaded — no swapping, no setup.** A single Ollama server keeps only
    one model resident on a 24 GB Mac (it evicts the editor model when the helper loads, and
    back again), which made Brainstorm and word lookups fight over memory. Proser now runs
    the Helper on its **own dedicated Ollama server** (a second `ollama serve` on a private
    port, sharing your model files) so the two run in separate processes that never evict
    each other. Verified keeping `gemma4:12b` + `gemma4:e2b` both resident at once. It
    starts on demand and is cleaned up when Proser unloads; nothing to configure.
  - **Document-wide AI spelling.** The helper proactively corrects every misspelling
    across the open document the first time, then re-checks **only the paragraphs you add,
    edit, or paste** (content-hash cache, ≥2 s debounce, background) — so the spell card's
    corrections are already there with no per-click wait, and typing is never blocked. The
    dictionary still does the detecting (instant, reliable) and validates every AI
    correction, so a tiny model can't slip a non-word through.
  - **Tells sounds &amp; names from typos.** With a capable helper (`gemma4:e2b`), an
    intentional word — an onomatopoeia (“Ahhgh”, “Grrr”), a character/place name, dialect,
    or coined term — is recognised and **not** flagged as a misspelling. Two independent
    guards make this safe: it only runs on a capable model, and a dictionary-distance check
    means a real typo (always close to a real word) can never be hidden.

### Fixed
- **Pretty editor no longer goes blank on a chapter with an unterminated `<!-- … -->`
  HTML comment.** An unclosed comment made the WYSIWYG view swallow everything after it
  (the chapter looked empty/uneditable though the text was on disk); Proser now closes a
  dangling comment at the end of its own paragraph so the prose stays visible — and the
  Pretty/Markdown toggle always reflects the mode actually shown.

## [0.0.1] — Unreleased

First working build.

### Added
- **Synonyms & Antonyms** right-click commands (Datamuse online, optional offline
  WordNet, optional context-aware AI), replacing the word in place with matched casing.
- **Spell check** for Markdown only: squiggles, suggestion quick-fixes, and
  add-to-dictionary, skipping code, URLs, and frontmatter.
- **Status-bar word count** for the active Markdown file, with selected-word count,
  reading-time estimate, and a per-document word goal.
- **Explorer multi-select word count** — total across selected `.md` files.
- **Editable pretty viewer** — a Toast UI WYSIWYG editor backed by the real file via a
  CustomTextEditorProvider, registered as an opt-in editor with an "Edit raw markdown"
  escape hatch.
- **AI assistant (optional)** — "Revise with AI" over a selection, with a pluggable
  engine: OpenRouter (cloud, curated model picker, Groq-preferred routing, key in the OS
  keychain) or Ollama (local, RAM-advised model, in-app pull).
- Writing extras: **document outline**, **writing-quality lint** (weasel words, passive
  voice, filler), and **focus / typewriter mode**.

### Hardened (pre-release review)
- Network calls to Ollama/OpenRouter readiness + model-list endpoints now time out instead
  of hanging; the model pull is cancellable.
- "Revise with AI" and Synonyms re-validate the target before editing, so a document change
  during the async step can't corrupt unrelated text; multi-cursor revise is rejected cleanly.
- AI settings are `machine-overridable` and AI features are disabled in untrusted workspaces,
  so a workspace can't redirect AI traffic or exfiltrate selected text.
- Pretty-editor sync no longer reverts an in-flight WYSIWYG edit during the debounce window.
- Word count caches the per-document total (cursor moves no longer re-scan the whole file)
  and the explorer count includes unsaved buffers; reading time rounds up; the CSP nonce uses
  a CSPRNG; focus mode is scoped to Markdown.

### Notes
- Offline thesaurus (WordNet via `wordpos`) is excluded from the packaged build to keep
  the download small; it activates automatically if `wordpos` is installed.
