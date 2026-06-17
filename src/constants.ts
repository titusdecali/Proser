/** Central registry of identifiers so commands, config keys, and the editor
 *  viewType are defined in exactly one place. */

export const EXTENSION_ID = 'proser';

export const VIEW_TYPE_MARKDOWN_EDITOR = 'proser.markdownEditor';

export const Commands = {
  synonyms: 'proser.synonyms',
  antonyms: 'proser.antonyms',
  useAiSynonyms: 'proser.useAiSynonyms',
  useLocalSynonyms: 'proser.useLocalSynonyms',
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

/** workspaceState keys for the Issues panel. */
export const STATE_ISSUES_AUTOSCAN = 'proser.issues.autoScan';
export const STATE_ISSUES_IGNORED = 'proser.issues.ignored';

export const ConfigKeys = {
  thesaurusSource: 'thesaurus.source',
  thesaurusMaxResults: 'thesaurus.maxResults',
  thesaurusAiMode: 'thesaurus.aiMode',
  spellcheckEnabled: 'spellcheck.enabled',
  spellcheckDebounceMs: 'spellcheck.debounceMs',
  spellcheckLanguage: 'spellcheck.language',
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
  manuscriptExclude: 'manuscript.exclude'
} as const;

/** SecretStorage key for the OpenRouter API key. Never stored in settings. */
export const SECRET_OPENROUTER_API_KEY = 'proser.openrouter.apiKey';

/** globalState key holding the user's added dictionary words. */
export const STATE_USER_DICTIONARY = 'proser.userDictionary';

/** The `markdown` language id, used to scope every feature to Markdown. */
export const MARKDOWN_LANGUAGE_ID = 'markdown';
