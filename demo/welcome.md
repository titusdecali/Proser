---

## title: Proser Demo

author: TitusDecali

# Welcome to Proser

This file is a playground for trying every feature. The status bar (bottom-right)
shows the **word count**, reading time, and — once you set one — a word goal.

## Things to try 

### 1. Synonyms / Antonyms

Right-click the word **happy** and choose *Synonyms* (or *Antonyms*). The list drops down
right at the word — pick one and it replaces the word in place, keeping its capitalization.

The first time, you'll be asked whether to use a **local AI model (Gemma)** for richer,
context-aware suggestions, or the **local dictionary** only. AI is the better choice if you
have [Ollama](https://ollama.com) running; if it isn't ready, Proser falls back to the
dictionary automatically. Switch anytime via the right-click menu: *Use AI for Synonyms* /
*Use Local Dictionary for Synonyms*.

### 2. Spell check

This paragraph has a deliberate mispeling and a wrnog word so you can see the squiggles.
Hover one, then use the lightbulb (Quick Fix) to correct it or *Add to dictionary*.

### 3. Writing-quality lint

This sentence is very really just basically padded with filler words, and the report was
written in passive voice. Those get a faint underline — Quick-Fix a filler word to remove it.

### 4. Word count that ignores code and links

Inline `code like this` and the URL in [the docs](https://example.com/not-counted) are not
counted as words. Neither is this block:

```js
const ignored = "these words do not count";
```

### 5. Multi-file total

Select several `.md` files in the Explorer, right-click → *Count Words in Selection*.

### 6. Focus / typewriter mode

Run **Proser: Toggle Focus / Typewriter Mode** from the Command Palette (Cmd+Shift+P).
Everything but the current paragraph dims, and your line stays centered.

### 7. The pretty editable view

Click the **open-preview icon** in the editor toolbar (top-right), or run *Proser: Open Pretty
View to the Side*. The rendered, editable view opens **beside** the raw editor — both stay live
and edits flow both ways with **no save prompt** (just like the native preview, but editable).
Type on either side and watch the other update. (You can also *Reopen Editor With… → Proser*
to replace the tab instead, but switching a tab with unsaved edits makes VS Code save first.)

### 8. Revise with AI (optional)

Select a paragraph, right-click → *Revise with AI*. First run **Proser: Set OpenRouter API
Key** (cloud) or **Proser: Set Up Local AI (Ollama)** (offline). Edit the instruction, then
accept or reject the streamed revision.

## Outline

Open the Outline view (or breadcrumbs) — every heading here should appear, nested by level.