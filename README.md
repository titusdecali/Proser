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
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhwSRV361niRDXGW1aPAyKQlpZNVTkH6evw97E" alt="Proser running in VS Code" width="100%">
</div>

---

## ✨ The Pretty editor

A live **WYSIWYG** view backed by the real `.md` file — your edits are real edits
(undo, git diff, save all work the same as ever).

- A clean, **book-width centered page** with adjustable font size.
- **Right-click anything**: synonyms / antonyms, *Revise with AI*, and inline
  formatting (**bold**, *italic*, underline, ~~strike~~, `code`) — or just right-click a
  word, no selecting required.
- **Inline spelling squiggles**, **Find** (`Ctrl/Cmd+F`), live word-count footer, and a
  one-tap **Markdown** toggle when you want the raw source.

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
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmh3a16eat8Hsoe9Y7j6GUnVQf2AlW5Ex4bCPFO" alt="Spell check sidebar and inline squiggles" width="60%">
</div>

## 📖 Thesaurus

Right-click a word for **synonyms or antonyms** — online (Datamuse) with an offline
WordNet fallback, or **context-aware** suggestions when AI is enabled.

<div align="center">
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhVeaiZkWcNxPzGuWkTtCMpXayUmRFr740ZsoV" alt="Synonyms in the Pretty view" width="60%">
</div>

## 🔍 Editor checks (Proser sidebar → Editor tab)

Catch the things drafts hide:

- **Tense consistency** — flags sentences that drift from your narrative tense.
- **Passive voice** — finds passive constructions (works offline; sharper with AI).
- **Continuity** — AI scan for contradictions in names, details, timeline, and facts.

Run a check once, or toggle **Scan continuously** to re-check as you write. Each finding
has **Go / Fix / Ignore**, and *Go* jumps right to the passage in the Pretty view.

## 📚 Manuscript tools (Proser sidebar → Insert / Settings)

- **New Chapter** — creates a new file ordered right after the current one.
- **Add Divider** / **Add Scene Break** — inserted at your cursor.
- **Title & Author** — your manuscript's title page.
- **Export to DOCX or PDF** in **Standard Manuscript Format** (Courier 12pt,
  double-spaced, 1″ margins) — for **this file** or the **whole folder**. Also on the
  Pretty toolbar's **Export** menu, alongside a quick PDF of the current view.

<div align="center">
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhn9n9lTkLAUSNGzthslMRIE7vQT8cFXwdPB9C" alt="Manuscript export menu" width="60%">
</div>

## 🤖 Optional AI assistant

- **Revise with AI** on any selection, with reusable saved prompts.
- Powers context-aware synonyms and the continuity check.
- Choose your engine: **OpenRouter** (cloud) or **Ollama** (fully **local & private**).
  Pick, switch, or delete local models from the status-bar **Model** indicator. Your
  API key lives in the OS keychain — never in settings.

<div align="center">
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhZU4y5ZgGVnvdScZkyQ3Nm2P7jUBsLfbACh1R" alt="Revise with AI" width="60%">
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

## License

MIT

<div align="center">
  <br>
  <img src="https://9ppl2dxtsd.ufs.sh/f/9USzCh2sMPmhHzGYkr6t3AFpGEDiTqwZBQN6sSnhmcuJgv75" alt="Proser" width="96">
</div>
