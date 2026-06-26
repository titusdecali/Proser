<div align="center">
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhNKv56VCAcFm5Y9DqeydZIansl3RE0CwKivMo" alt="Proser — VS Code for writers" width="100%">
</div>

<p align="center">
  <em>VS Code for writers — a live WYSIWYG editor, multi-language spell check, thesaurus, AI-assisted prose checks (tense, passive voice &amp; continuity), and publisher-ready DOCX/PDF manuscript export.</em>
</p>

Proser turns VS Code into a calm, capable studio for **prose**: a live page you can
write on, the proofreading and reference tools writers actually need, and one-click
**manuscript export** — all scoped to Markdown so it never gets in the way of code.

Everything works **offline**. AI is entirely optional, and can run **locally**.

<div align="center">
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhe40cWYNRFGDY6UZ5anfBwuqkIEiAb71hd9Wc" alt="Write on a live, book-width page — the full Proser UI in VS Code" width="100%">
</div>

---

## ✨ The Pretty editor

A live **WYSIWYG** view backed by the real `.md` file — your edits are real edits
(undo, git diff, save all work the same as ever).

- A clean, **book-width centered page** with adjustable font size.
- **Right-click anything**: **definition** (the book icon), synonyms / antonyms,
  *Revise with AI*, and inline formatting (**bold**, *italic*, underline, ~~strike~~) — or
  just right-click a word, no selecting required.
- **Live writing checks as you type** — color-coded underlines, each fixable in one
  right-click: spelling (red), **grammar** (blue, offline via
  [Harper](https://writewithharper.com)), **passive voice** (purple), **tense slips**
  (orange, local AI in the background), **sentence spacing** (yellow), and **quotation
  punctuation** (teal). Turn each on or off in **Settings → Live Style Checks**.
- **Find** (`Ctrl/Cmd+F`), live word-count footer, and a one-tap **Markdown** toggle when
  you want the raw source.

Open it from the editor title bar (the book icon), or *Reopen Editor With… → Proser*.

## ✓ Spell check that understands prose

- Built on a real dictionary with **compound-word smarts** (it won't flag *rearview*,
  *seatbelt*, *floorboards*) and skips proper nouns, code, URLs, and frontmatter.
- A dedicated **Spelling sidebar** lists every misspelling with one-click fixes,
  **Add to dictionary**, and **Ignore** (suppress without changing your dictionary) —
  plus the inline squiggles in the Pretty view.
- **Multiple languages**: English is built in; **Spanish, French, German, Italian,
  Portuguese, Dutch, and Russian** download once and then work offline. Switch with
  *Proser: Select Spell Check Language*.

<div align="center">
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmh5q2H0rznrEbOo46XUwZkMeGamiK3yWtIfJqu" alt="Spell check that understands prose" width="60%">
</div>

## 📖 Thesaurus & Dictionary

Right-click a word for **synonyms or antonyms** — online (Datamuse) with an offline
WordNet fallback, or **context-aware** suggestions when AI is enabled.

Click the **book icon** in the same menu to open the word's full **definition** in a side
panel — pronunciation, meanings grouped by part of speech, and example sentences. It uses
the free online dictionary with an offline **WordNet** fallback, so it still works without a
connection; choose the source with `proser.dictionary.source` (auto / online / offline).

<div align="center">
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhf2sFkJvPGJDjwRp264CZ0nIQW138ytYived7" alt="The right word, in context — synonyms in the Pretty view" width="60%">
</div>

## 🔍 Editor checks

Catch the things drafts hide:

- **Grammar** — subject–verb agreement, swapped homophones (*their/there*), repeated words,
  and more, via the offline **[Harper](https://writewithharper.com)** engine.
- **Tense consistency** — flags narration that drifts from your narrative tense (dialogue,
  which may speak in any tense, is left alone).
- **Passive voice** — finds passive constructions (works offline; sharper with AI).
- **Continuity** — AI scan for contradictions in names, details, timeline, and facts.

**Grammar, tense, and passive voice also run automatically in the background** as you write,
shown as live underlines in the Pretty editor (grammar is offline via Harper; tense uses your
**local AI model**; passive is instant). Right-click any underline to fix it in one click —
or **Dismiss** it, and that sentence won't be flagged again. A fixed sentence clears
immediately and never comes back.

For a full pass, the **Proser sidebar → Editor tab** runs any check on demand (or **Scan
continuously**); each finding has **Go / Fix / Ignore**, and *Go* jumps right to the passage.

## 📚 Manuscript tools (Proser sidebar → Insert / Settings)

- **New Chapter** — creates a new file ordered right after the current one.
- **Add Divider** / **Add Scene Break** — inserted at your cursor.
- **Title & Author** — your manuscript's title page.
- **Export to DOCX or PDF** in **Standard Manuscript Format** (Courier 12pt,
  double-spaced, 1″ margins) — for **this file** or the **whole folder**. Also on the
  Pretty toolbar's **Export** menu, alongside a quick PDF of the current view.

<div align="center">
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhnuoO7xckLAUSNGzthslMRIE7vQT8cFXwdPB9" alt="Submit-ready in one click — Standard Manuscript Format export" width="60%">
</div>

## 🤖 Optional AI assistant

- **Revise with AI** on any selection, with reusable saved prompts.
- Powers context-aware synonyms, the tense and continuity checks, and Story Memory.
- Choose your engine: **OpenRouter** (cloud) or **Ollama** (fully **local & private**).
  Pick, switch, or delete local models from the status-bar **Model** indicator. Your
  API key lives in the OS keychain — never in settings.
- **Use the cloud only where it counts.** Pick **Cloud (OpenRouter)** as your editor model
  and you're prompted for the key right away — but that key powers **only Brainstorm &
  Revise**. Spell check, synonyms, and the tense/passive checks always run on your **local**
  model, so the everyday checks stay private and free.

<div align="center">
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhpycBm7FdnfFy61qwHZUv0as34zXbpu5Ai87P" alt="Revise with AI, your way" width="60%">
</div>

## 📊 Word count & goals

Live **word count, character count, and reading time** in the status bar, with an
optional **per-document word goal**. Select several `.md` files in the Explorer →
*Count Words in Selection* for a combined total.

## 🎯 And the rest

Document **outline**, **focus mode** and **typewriter mode**, and writing-quality
**lint** (weasel words / passive voice / filler).

---

## Requirements

- VS Code **1.90+**.
- AI features are optional: the cloud path needs an **OpenRouter** API key and internet;
  the local path needs **[Ollama](https://ollama.com)** installed. Everything else —
  spell check, thesaurus (offline), word count, the Pretty editor, and export — works
  with no account and no network.

## Support

If Proser makes your writing better, you can [**buy me a coffee ☕**](https://buymeacoffee.com/titusdecali) — it keeps the project going.

## License

MIT

<div align="center">
  <br>
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhHzGYkr6t3AFpGEDiTqwZBQN6sSnhmcuJgv75" alt="Proser" width="96">
</div>
