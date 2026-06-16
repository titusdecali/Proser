# Proser — Make VSCode the ultimate writing app

Proser turns VS Code into a first-class environment for prose. It adds the things
writers miss, scoped to Markdown so it never gets in the way of code.

## Features

- **Synonyms & Antonyms** — right-click a word, pick a replacement, done. Online
  (Datamuse) with an offline fallback.
- **Spell check** — squiggles and quick-fixes in `.md` files only, with
  add-to-dictionary. Skips code, URLs, and frontmatter.
- **Word count in the status bar** — live count for the active Markdown file, plus
  reading time and an optional per-document word goal. Shows the selected count when
  you have a selection.
- **Multi-file word count** — select several `.md` files in the Explorer, right-click
  → *Count Words in Selection* for the total.
- **Editable pretty viewer** — a rendered WYSIWYG view backed by the real file, so
  your edits are real edits (undo, git diff, save all work). Opt-in per file via
  *Reopen Editor With… → Proser*; an *Edit raw markdown* button is always one click away.
- **Optional AI assistant** — *Revise with AI* on a selection, powered by either
  OpenRouter (cloud) or a local Ollama model (private/offline). Your API key is stored
  in the OS keychain, never in settings.

### Writing extras

Document outline, reading-time estimate, word goals, writing-quality lint
(weasel words / passive voice / filler), and a focus/typewriter mode.

## Requirements

- VS Code 1.90+.
- The AI features are optional. The cloud path needs an OpenRouter API key and internet;
  the local path needs [Ollama](https://ollama.com) installed (a one-time, separate install).

## Development

```bash
npm install
npm run watch      # build + rebuild on change
# press F5 to launch the Extension Development Host
npm test           # run the test suite
npm run package    # produce a .vsix
```

## License

MIT
