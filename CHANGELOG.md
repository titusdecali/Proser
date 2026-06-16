# Changelog

All notable changes to Proser are documented here.

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
