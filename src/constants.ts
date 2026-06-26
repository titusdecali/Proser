/** Central registry of identifiers so commands, config keys, and the editor
 *  viewType are defined in exactly one place. */

export const EXTENSION_ID = 'proser';

export const VIEW_TYPE_MARKDOWN_EDITOR = 'proser.markdownEditor';

export const Commands = {
  synonyms: 'proser.synonyms',
  antonyms: 'proser.antonyms',
  useAiSynonyms: 'proser.useAiSynonyms',
  useLocalSynonyms: 'proser.useLocalSynonyms',
  thesaurusSelectEngine: 'proser.thesaurus.selectEngine',
  countWordsInSelection: 'proser.countWordsInSelection',
  addToDictionary: 'proser.addToDictionary',
  spellSelectLanguage: 'proser.spellcheck.selectLanguage',
  openPretty: 'proser.openPretty',
  openPrettyToSide: 'proser.openPrettyToSide',
  setWordGoal: 'proser.setWordGoal',
  showWordStats: 'proser.showWordStats',
  toggleFocusMode: 'proser.toggleFocusMode',
  toggleTypewriterMode: 'proser.toggleTypewriterMode',
  reviseWithAI: 'proser.reviseWithAI',
  aiSetApiKey: 'proser.ai.setApiKey',
  aiClearKey: 'proser.ai.clearKey',
  aiSelectModel: 'proser.ai.selectModel',
  aiSetupLocal: 'proser.ai.setupLocal',
  aiSelectLocalModel: 'proser.ai.selectLocalModel',
  brainstorm: 'proser.brainstorm',
  brainstormClose: 'proser.brainstorm.close',
  storyMemoryBuild: 'proser.storyMemory.build',
  storyMemoryRebuild: 'proser.storyMemory.rebuild',
  storyMemoryRescanChapter: 'proser.storyMemory.rescanChapter',
  storyMemoryChooseFolder: 'proser.storyMemory.chooseFolder',
  chaptersRefresh: 'proser.chapters.refresh',
  openChapter: 'proser.openChapter',
  moveToSide: 'proser.moveToSide',
  manuscriptTitlePage: 'proser.manuscript.titlePage',
  manuscriptNewChapter: 'proser.manuscript.newChapter',
  manuscriptSceneBreak: 'proser.manuscript.sceneBreak',
  manuscriptPartDivider: 'proser.manuscript.partDivider',
  manuscriptTheEnd: 'proser.manuscript.theEnd',
  manuscriptExportDocx: 'proser.manuscript.exportDocx',
  manuscriptExportPdf: 'proser.manuscript.exportPdf',
  manuscriptDivider: 'proser.manuscript.divider',
  editorChecks: 'proser.editor.checks',
  revealInPretty: 'proser.revealInPretty',
  insertInPretty: 'proser.insertInPretty'
} as const;

/** Webview view id for the "Issues" panel (passive voice / tense scanner). */
export const VIEW_TYPE_ISSUES = 'proser.issuesView';

/** Webview view id for the "Spelling" sidebar (misspellings for the active doc). */
export const VIEW_TYPE_SPELLING = 'proser.spellingView';

/** Tree view id for the "Chapters" list (the manuscript folder's .md files). */
export const VIEW_TYPE_CHAPTERS = 'proser.chaptersView';

/** workspaceState keys for the Issues panel. */
export const STATE_ISSUES_AUTOSCAN = 'proser.issues.autoScan';
export const STATE_ISSUES_IGNORED = 'proser.issues.ignored';

export const ConfigKeys = {
  thesaurusSource: 'thesaurus.source',
  thesaurusMaxResults: 'thesaurus.maxResults',
  thesaurusAiMode: 'thesaurus.aiMode',
  /** Where the right-click Dictionary lookup gets definitions: 'online' (Free
   *  Dictionary API), 'offline' (bundled WordNet via wordpos), or 'auto' (online
   *  first, WordNet fallback). */
  dictionarySource: 'dictionary.source',
  spellcheckEnabled: 'spellcheck.enabled',
  spellcheckDebounceMs: 'spellcheck.debounceMs',
  spellcheckLanguage: 'spellcheck.language',
  /** Expected spaces after a sentence-ending period for the logic-based spacing
   *  check: 'none' (0), '1', or '2'. Mismatches get a yellow underline; gaps at a
   *  line/paragraph break are never flagged. */
  spacingAfterPeriod: 'spacing.afterPeriod',
  /** Punctuation placement relative to a closing double quote for the logic-based
   *  check: 'inside' (American — flags British placement), 'outside' (British —
   *  flags American placement), or 'off'. Non-preferred placement gets a teal
   *  underline; only double quotes are checked. */
  quotesPunctuationStyle: 'quotes.punctuationStyle',
  /** Live passive-voice underline in the editor (logic-only regex, instant). */
  checksPassiveVoice: 'checks.passiveVoice',
  /** Live tense-consistency underline in the editor (AI, throttled + cached;
   *  runs on the local model whenever this is on — independent of AI spell). */
  checksTense: 'checks.tense',
  /** Live grammar / word-choice underline in the editor (AI proofread). Lets the
   *  user silence the blue squiggles without turning off AI spell-clearing. */
  checksGrammar: 'checks.grammar',
  qualityLintEnabled: 'qualityLint.enabled',
  wordcountStatusBarEnabled: 'wordcount.statusBarEnabled',
  wordcountIncludeCodeBlocks: 'wordcount.includeCodeBlocks',
  wordcountIncludeFrontmatter: 'wordcount.includeFrontmatter',
  wordcountWordsPerMinute: 'wordcount.wordsPerMinute',
  wysiwygSyncDebounceMs: 'wysiwyg.syncDebounceMs',
  wysiwygFontSize: 'wysiwyg.fontSize',
  wysiwygMaxWidth: 'wysiwyg.maxWidth',
  aiEngine: 'ai.engine',
  aiOpenRouterModel: 'ai.openrouter.model',
  aiOpenRouterPreferGroq: 'ai.openrouter.preferGroq',
  aiOllamaModel: 'ai.ollama.model',
  aiOllamaEndpoint: 'ai.ollama.endpoint',
  /** Max context window (tokens) for Brainstorm + Story-Memory injection — the
   *  budget the folded canon is sized to. Bigger fits more of your story memory but
   *  uses more VRAM (the KV cache scales with it). Capped by the model's own window. */
  aiBrainstormContextTokens: 'ai.ollama.brainstormContextTokens',
  /** Whether AI spell/proofread runs on the single editor model. true = the model
   *  clears dictionary false-positives + grades grammar; false = Hunspell dictionary
   *  only. (Synonyms use `thesaurus.aiMode`/`thesaurus.source` for the same choice.) */
  aiSpellAi: 'ai.spellAi',
  manuscriptExclude: 'manuscript.exclude'
} as const;

/** The ONE context-window size (tokens) every local AI request uses. Ollama keeps a
 *  model resident per (model, context-size), so a varying num_ctx forces an
 *  unload+reload on each feature switch — using a single value keeps the one model
 *  resident. 8192 is ample for a spell paragraph / synonyms sentence and covers most
 *  chapters for Story-Memory extraction, while keeping the KV cache small. */
export const AI_CONTEXT_TOKENS = 8192;

/** How long Ollama keeps the model loaded after a request (session-length; each
 *  request refreshes it) so it doesn't idle-unload mid-writing. */
export const AI_KEEP_ALIVE = '8h';

/** SecretStorage key for the OpenRouter API key. Never stored in settings. */
export const SECRET_OPENROUTER_API_KEY = 'proser.openrouter.apiKey';

/** globalState key holding the user's added dictionary words. */
export const STATE_USER_DICTIONARY = 'proser.userDictionary';

/** workspaceState key for spellings the user has chosen to ignore (suppressed,
 *  but NOT added to the dictionary). */
export const STATE_SPELL_IGNORED = 'proser.spell.ignored';

/** workspaceState key for grammar/word-choice findings the user has chosen to
 *  ignore (keyed by the flagged phrase) — they never resurface in this workspace. */
export const STATE_GRAMMAR_IGNORED = 'proser.grammar.ignored';

/** The `markdown` language id, used to scope every feature to Markdown. */
export const MARKDOWN_LANGUAGE_ID = 'markdown';
