import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID, VIEW_TYPE_MARKDOWN_EDITOR } from '../../constants';
import { getEditorHtml } from './webviewHtml';
import { computeProseStats, estimateReadingMinutes } from '../../util/wordcount';
import { wordcountScanOptions } from '../../util/scanConfig';
import { diffRange } from '../../util/textDiff';
import { SecretStore } from '../ai/secretStore';
import { suggestionsFor, noResultsMessage } from '../thesaurus/thesaurusCommands';
import { ThesaurusKind } from '../thesaurus/datamuseClient';
import { lookupDefinition } from '../dictionary/dictionaryLookup';
import * as dictionaryPanel from '../dictionary/dictionaryPanel';
import { reviseOptions } from '../ai/reviseCommand';
import {
  getSpellEngine,
  getCheckEngine,
  clearCapable,
  resolveSpellModel,
  resolveLocalModel,
  proofreadFits,
  aiStatusChips
} from '../ai/engineFactory';
import { signalAi, onAiActivity, isHeavyAiBusy } from '../ai/aiActivity';
import { onModelState, currentModelState } from '../ai/modelState';
import { currentModelName } from '../ai/aiModelStatus';
import { aiSpellSuggestions } from '../spellcheck/aiSpell';
import { AiDocSpellChecker, GrammarIssue } from '../spellcheck/aiDocSpell';
import { harperGrammar } from '../spellcheck/harperGrammar';
import { proofreadTense, TenseFinding } from '../spellcheck/aiTense';
import { proofreadPassive, PassiveFinding } from '../spellcheck/aiPassive';
import { readPrompts, writePrompts, SavedPrompt } from '../ai/prompts';
import { SpellService } from '../spellcheck/spellService';

/** Open Pretty editors keyed by document URI, so the sidebar's "Go" can reveal a
 *  passage in the right Pretty webview instead of the raw Markdown editor. */
const prettyPanels = new Map<string, vscode.WebviewPanel>();

/** Registers the custom editor and the "Open Pretty Editable View" commands. */
export function registerPrettyEditor(context: vscode.ExtensionContext, spell: SpellService): void {
  function resolveTarget(uri?: vscode.Uri): vscode.Uri | undefined {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showInformationMessage('Open a Markdown file to use the pretty editor.');
      return undefined;
    }
    if (!target.path.toLowerCase().endsWith('.md')) {
      vscode.window.showInformationMessage('The pretty editor is for Markdown (.md) files.');
      return undefined;
    }
    return target;
  }

  context.subscriptions.push(
    ProserEditorProvider.register(context, spell),
    // Replace the current tab with the pretty editor (like "Reopen With").
    vscode.commands.registerCommand(Commands.openPretty, async (uri?: vscode.Uri) => {
      const target = resolveTarget(uri);
      if (target) {
        await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE_MARKDOWN_EDITOR);
      }
    }),
    // Open the pretty editor BESIDE the raw editor so both stay live and no
    // save prompt is triggered — the native-preview feel, but editable.
    vscode.commands.registerCommand(Commands.openPrettyToSide, async (uri?: vscode.Uri) => {
      const target = resolveTarget(uri);
      if (target) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          target,
          VIEW_TYPE_MARKDOWN_EDITOR,
          vscode.ViewColumn.Beside
        );
      }
    }),
    // Reveal a passage inside the open Pretty editor for `uriStr` (used by the
    // sidebar's "Go" so it lands in the Pretty view, not the raw editor).
    vscode.commands.registerCommand(Commands.revealInPretty, (uriStr: string, text: string) => {
      const panel = prettyPanels.get(uriStr);
      if (!panel) {
        return false;
      }
      try {
        panel.reveal(panel.viewColumn);
      } catch {
        /* ignore */
      }
      void panel.webview.postMessage({ type: 'reveal', text });
      return true;
    }),
    // Insert at the Pretty editor's cursor (sidebar Insert tab). `kind` is 'hr'
    // for a horizontal rule, else the literal text is inserted.
    vscode.commands.registerCommand(
      Commands.insertInPretty,
      (uriStr: string, kind: string, text: string) => {
        const panel = prettyPanels.get(uriStr);
        if (!panel) {
          return false;
        }
        try {
          panel.reveal(panel.viewColumn);
        } catch {
          /* ignore */
        }
        void panel.webview.postMessage(
          kind === 'hr' ? { type: 'insertHr' } : { type: 'insertText', text }
        );
        return true;
      }
    )
  );
}

interface FromWebview {
  type:
    | 'ready'
    | 'displayed'
    | 'edit'
    | 'editRaw'
    | 'setFontSize'
    | 'toggleSpellcheck'
    | 'addToDictionary'
    | 'ignoreWord'
    | 'ignoreGrammar'
    | 'selectModel'
    | 'thesaurusEngine'
    | 'showIssues'
    | 'openBrainstorm'
    | 'exportMenu'
    | 'exportPdf'
    | 'exportError'
    | 'thesaurusRequest'
    | 'definitionRequest'
    | 'reviseRequest'
    | 'spellAiSuggest'
    | 'promptsLoad'
    | 'promptsSave'
    | 'save';
  text?: string;
  size?: number;
  enabled?: boolean;
  data?: string;
  filename?: string;
  message?: string;
  kind?: ThesaurusKind;
  word?: string;
  phrase?: string;
  sentence?: string;
  instruction?: string;
  prompts?: SavedPrompt[];
}

/** The toolbar "Export" menu: Standard-Manuscript-Format DOCX/PDF for the active
 *  file or the whole folder, plus a quick PDF of the current styled view (which
 *  runs in the webview via html2pdf). */
async function showExportMenu(panel: vscode.WebviewPanel): Promise<void> {
  type Opt = vscode.QuickPickItem & { run: () => Thenable<unknown> };
  const opts: Opt[] = [
    {
      label: '$(file-pdf) PDF — Standard Manuscript Format',
      description: 'This file',
      run: () => vscode.commands.executeCommand(Commands.manuscriptExportPdf, 'active')
    },
    {
      label: '$(file-pdf) PDF — Standard Manuscript Format',
      description: 'All pages in folder',
      run: () => vscode.commands.executeCommand(Commands.manuscriptExportPdf, 'folder')
    },
    {
      label: '$(file) DOCX — Standard Manuscript Format',
      description: 'This file',
      run: () => vscode.commands.executeCommand(Commands.manuscriptExportDocx, 'active')
    },
    {
      label: '$(file) DOCX — Standard Manuscript Format',
      description: 'All pages in folder',
      run: () => vscode.commands.executeCommand(Commands.manuscriptExportDocx, 'folder')
    },
    {
      label: '$(device-camera) PDF — Quick (current styled view)',
      description: 'What you see in Pretty',
      run: () => panel.webview.postMessage({ type: 'doQuickPdf' })
    }
  ];
  const picked = await vscode.window.showQuickPick(opts, {
    title: 'Export',
    placeHolder: 'Choose a format and scope'
  });
  if (picked) {
    await picked.run();
  }
}

/**
 * Editable pretty viewer. A CustomTextEditorProvider backs a Toast UI WYSIWYG
 * editor with the real TextDocument, so edits are genuine document edits.
 *
 * Echo loops are prevented with a content guard rather than a timing flag:
 * `lastSynced` holds the text currently reflected in the webview. A document
 * change equal to `lastSynced` is our own write and is ignored; anything else
 * is an external edit and is pushed to the webview.
 */
export class ProserEditorProvider implements vscode.CustomTextEditorProvider {
  static register(context: vscode.ExtensionContext, spell: SpellService): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      VIEW_TYPE_MARKDOWN_EDITOR,
      new ProserEditorProvider(context, spell),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    );
  }

  /** Whole-document AI spell corrections, paragraph-cached across all open docs. */
  private readonly aiDocSpell = new AiDocSpellChecker();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly spell: SpellService
  ) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    panel.webview.html = getEditorHtml(panel.webview, this.context.extensionUri);

    const docKey = document.uri.toString();
    prettyPanels.set(docKey, panel); // so the sidebar's "Go" can reveal here

    const secrets = new SecretStore(this.context.secrets);
    let lastSynced = document.getText();
    const syncDebounceMs = vscode.workspace
      .getConfiguration(EXTENSION_ID)
      .get<number>(ConfigKeys.wysiwygSyncDebounceMs, 200);
    let syncTimer: NodeJS.Timeout | undefined;

    const pushToWebview = (text: string) => {
      void panel.webview.postMessage({ type: 'update', text });
    };

    let statsTimer: NodeJS.Timeout | undefined;
    const postStats = () => {
      const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
      const stats = computeProseStats(document.getText(), wordcountScanOptions());
      const wpm = cfg.get<number>(ConfigKeys.wordcountWordsPerMinute, 200);
      void panel.webview.postMessage({
        type: 'stats',
        stats: {
          ...stats,
          lines: document.lineCount,
          minutes: estimateReadingMinutes(stats.words, wpm)
        }
      });
    };
    const scheduleStats = () => {
      if (statsTimer) {
        clearTimeout(statsTimer);
      }
      statsTimer = setTimeout(postStats, 400);
    };

    // Misspelled words for the current text → the webview paints inline squiggles.
    // Empty list when spell check is off (which also clears the squiggles).
    // Detection is the dictionary's (instant); the optional AI helper enriches
    // each flagged word with context-aware corrections, precomputed across the
    // whole doc and merged in here so the spell card shows them with no per-click
    // wait. `lastAiSuggestions` is the latest aggregate from the doc-pass below.
    let spellTimer: NodeJS.Timeout | undefined;
    let lastAiSuggestions = new Map<string, string[]>();
    // Words a capable helper judged INTENTIONAL (a sound like "Ahhgh", a name,
    // coined term) — suppressed from squiggles so the dictionary doesn't nag about
    // them. Guarded so a real typo can never land here (see AiDocSpellChecker).
    let lastAiCleared = new Set<string>();
    // Grammar / word-choice errors from the AI proofread pass (different-color
    // underline). Same lifecycle as the AI spelling aggregate above.
    let lastGrammar: GrammarIssue[] = [];
    const postSpell = async () => {
      const words = this.spell.enabled() ? await this.spell.misspellings(document.getText()) : [];
      const merged = words
        .filter((m) => !lastAiCleared.has(m.word.toLowerCase())) // drop intentional words
        .map((m) => {
          const ai = lastAiSuggestions.get(m.word.toLowerCase());
          if (!ai || ai.length === 0) {
            return m;
          }
          const seen = new Set<string>();
          const suggestions: string[] = [];
          for (const s of [...ai, ...m.suggestions]) {
            // AI corrections first (context-aware), then the dictionary's, de-duped.
            const key = s.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              suggestions.push(s);
            }
          }
          return { word: m.word, suggestions };
        });
      const grammarOn = vscode.workspace
        .getConfiguration(EXTENSION_ID)
        .get<boolean>(ConfigKeys.checksGrammar, true);
      void panel.webview.postMessage({
        type: 'spellResult',
        words: merged,
        grammar:
          this.spell.enabled() && grammarOn
            ? lastGrammar.filter((g) => !this.spell.isGrammarIgnored(g.phrase))
            : []
      });
    };
    const scheduleSpell = () => {
      if (spellTimer) {
        clearTimeout(spellTimer);
      }
      spellTimer = setTimeout(() => void postSpell(), 400);
    };

    // ── Whole-document AI spell pass (opt-in helper; proactive + incremental) ──
    // Runs across the active doc the first time, then only re-checks paragraphs
    // that were added/edited/pasted (content-hash cache in AiDocSpellChecker).
    // Debounced ≥2s and run in the background so typing is never blocked.
    let aiSpellTimer: NodeJS.Timeout | undefined;
    let aiCtl: AbortController | undefined;
    // Coalesce the per-paragraph onUpdate stream into at most one repaint per
    // ~700 ms — without this a long doc fires dozens of full-doc rescans + repaints
    // back-to-back (the "rapid flashing"). The pending post always uses the latest
    // state, so the final result still lands.
    let aiPostTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleAiPost = () => {
      if (aiPostTimer) {
        return;
      }
      aiPostTimer = setTimeout(() => {
        aiPostTimer = undefined;
        void postSpell();
      }, 700);
    };
    const runAiSpell = async () => {
      if (!this.spell.enabled()) {
        lastAiSuggestions = new Map();
        lastAiCleared = new Set();
        lastGrammar = [];
        return;
      }
      const helper = await getSpellEngine();
      if (!helper || !(await helper.isReady()).ready) {
        return; // no spell model configured / not running → dictionary only
      }
      // Don't load a distinct proofread helper beside an editor model that already
      // fills RAM (e.g. a 7 GB E2B beside a 12B on 24 GB) — that thrashes/crashes.
      // Stay dictionary-only and tell the user once how to fix it.
      if (!(await proofreadFits())) {
        lastAiSuggestions = new Map();
        lastAiCleared = new Set();
        lastGrammar = [];
        if (!proofreadMemWarned) {
          proofreadMemWarned = true;
          void vscode.window.showWarningMessage(
            'Proser: your AI spell-check model needs more memory than your editor model leaves free, so live proofread is paused (spelling still works via the dictionary). Set the Spell Check model to “Use my editor model” in Settings to run spelling + grammar with no extra memory.'
          );
        }
        return;
      }
      // "Intentional word" suppression + grammar only with a capable model (a tiny
      // model can't tell a sound from a typo or grade grammar); tiny models still
      // get corrections. Uses the RESOLVED model — a capable editor model can stand
      // in for a weak helper.
      const spellTag = resolveSpellModel();
      const allowClear = clearCapable(spellTag);
      aiCtl?.abort();
      aiCtl = new AbortController();
      signalAi(spellTag, true);
      try {
        await this.aiDocSpell.update(
          docKey,
          document.getText(),
          helper,
          {
            findMisspellings: (t) => this.spell.misspellings(t),
            isValidWord: (w) => this.spell.isWordCorrect(w)
          },
          allowClear,
          (result) => {
            lastAiSuggestions = result.suggestions;
            lastAiCleared = result.cleared;
            // Grammar now comes from Harper (runHarperGrammar), not the LLM.
            scheduleAiPost(); // coalesced — not a post per paragraph
          },
          aiCtl.signal
        );
      } finally {
        signalAi(spellTag, false);
      }
    };
    const scheduleAiSpell = () => {
      if (aiSpellTimer) {
        clearTimeout(aiSpellTimer);
      }
      aiSpellTimer = setTimeout(() => void runAiSpell(), 3000); // 3s debounce
    };

    // ── Whole-document grammar pass (Harper; local Rust/WASM, deterministic) ──
    // Replaces the LLM as the grammar source: agreement, homophones, repetition, etc.
    // Fast and offline, so it runs on a short debounce. Loads lazily; if Harper can't
    // load in the packaged host it returns nothing and grammar simply stays quiet.
    let harperTimer: NodeJS.Timeout | undefined;
    const runHarperGrammar = async () => {
      const grammarOn = vscode.workspace
        .getConfiguration(EXTENSION_ID)
        .get<boolean>(ConfigKeys.checksGrammar, true);
      if (!this.spell.enabled() || !grammarOn) {
        return; // postSpell already hides grammar in these states — skip the lint work
      }
      lastGrammar = await harperGrammar(document.getText());
      void postSpell();
    };
    const scheduleHarperGrammar = () => {
      if (harperTimer) {
        clearTimeout(harperTimer);
      }
      harperTimer = setTimeout(() => void runHarperGrammar(), 800);
    };

    // ── Whole-document AI tense pass (live editor underline; orange) ──
    // Tense needs the WHOLE doc (dominant tense → deviations), so unlike the
    // per-paragraph spell pass this is ONE model call. Kept cheap & "smart":
    //   • only when the doc actually changed (whole-doc text cache),
    //   • only on a capable spell model that fits beside the editor model,
    //   • yields to heavy foreground work (getSpellEngine's isHeavyAiBusy gate),
    //   • skipped on very large files (the sidebar Scan covers those),
    //   • debounced longer than spell so it fires less often.
    let aiTenseTimer: ReturnType<typeof setTimeout> | undefined;
    let tenseCtl: AbortController | undefined;
    let lastTenseText = '';
    const AUTO_TENSE_MAX = 96000; // chars — chunked internally; a whole chapter fits
    // Tense and passive are TWO whole-doc passes on the SAME single Ollama model.
    // Running them concurrently makes two requests contend for one model — on tight
    // memory one can stall or come back empty, so tense would silently stop flagging.
    // Serialize every check pass onto one chain so only one hits the model at a time
    // (tense first, passive after it finishes). Each pass re-reads the latest text, so
    // a queued pass never works on stale content.
    let checkChain: Promise<unknown> = Promise.resolve();
    const enqueueCheck = (run: () => Promise<void>): void => {
      checkChain = checkChain.then(run).catch(() => {});
    };
    const tenseEnabled = () =>
      vscode.workspace.getConfiguration(EXTENSION_ID).get<boolean>(ConfigKeys.checksTense, true);
    const runAiTense = async () => {
      if (!tenseEnabled()) {
        lastTenseText = '';
        void panel.webview.postMessage({ type: 'tenseResult', findings: [] as TenseFinding[] });
        return;
      }
      const text = document.getText();
      if (text === lastTenseText) {
        return; // unchanged since the last successful pass
      }
      if (text.length > AUTO_TENSE_MAX) {
        return; // too big for an auto pass — leave it to the sidebar's Scan
      }
      // Independent of the Spell Check AI toggle — tense has its own switch, so
      // silencing grammar/spell never disables it.
      const tag = resolveLocalModel();
      if (!clearCapable(tag)) {
        return; // tense reasoning needs a capable model (Gemma-class or larger)
      }
      const helper = await getCheckEngine();
      if (!helper || !(await helper.isReady()).ready) {
        return; // no local model running / yielding to heavy work
      }
      if (!(await proofreadFits())) {
        return; // no memory headroom beside the editor model
      }
      tenseCtl?.abort();
      tenseCtl = new AbortController();
      signalAi(tag, true);
      try {
        const findings = await proofreadTense(helper, text, tenseCtl.signal);
        if (findings === null) {
          return; // unparseable/empty model output — keep prior underlines, retry next edit
        }
        lastTenseText = text;
        void panel.webview.postMessage({ type: 'tenseResult', findings });
      } catch {
        /* aborted or model error — keep the prior squiggles until the next pass */
      } finally {
        signalAi(tag, false);
      }
    };
    const scheduleAiTense = () => {
      if (aiTenseTimer) {
        clearTimeout(aiTenseTimer);
      }
      aiTenseTimer = setTimeout(() => enqueueCheck(runAiTense), 6000); // 6s — fires less often than spell
    };

    // ── Whole-document AI passive-voice pass (live editor underline; purple) ──
    // Mirrors the tense pass: ONE whole-doc model call that JUDGES each passive
    // sentence (flag only when active voice is clearly better; lenient in dialogue)
    // rather than the old regex that flagged every passive. Same gating as tense,
    // plus a regex pre-filter inside proofreadPassive that skips the model on
    // passive-free prose. Staggered AFTER tense so the single shared model isn't
    // double-queued on every keystroke.
    let aiPassiveTimer: ReturnType<typeof setTimeout> | undefined;
    let passiveCtl: AbortController | undefined;
    let lastPassiveText = '';
    const passiveEnabled = () =>
      vscode.workspace.getConfiguration(EXTENSION_ID).get<boolean>(ConfigKeys.checksPassiveVoice, true);
    const runAiPassive = async () => {
      if (!passiveEnabled()) {
        lastPassiveText = '';
        void panel.webview.postMessage({ type: 'passiveResult', findings: [] as PassiveFinding[] });
        return;
      }
      const text = document.getText();
      if (text === lastPassiveText) {
        return; // unchanged since the last successful pass
      }
      if (text.length > AUTO_TENSE_MAX) {
        return; // too big for an auto pass — leave it to the sidebar's Check Passive
      }
      const tag = resolveLocalModel();
      if (!clearCapable(tag)) {
        return; // judging passive needs a capable model (Gemma-class or larger)
      }
      const helper = await getCheckEngine();
      if (!helper || !(await helper.isReady()).ready) {
        return; // no local model running / yielding to heavy work
      }
      if (!(await proofreadFits())) {
        return; // no memory headroom beside the editor model
      }
      passiveCtl?.abort();
      passiveCtl = new AbortController();
      signalAi(tag, true);
      try {
        const findings = await proofreadPassive(helper, text, passiveCtl.signal);
        if (findings === null) {
          return; // unparseable/empty model output — keep prior underlines, retry next edit
        }
        lastPassiveText = text;
        void panel.webview.postMessage({ type: 'passiveResult', findings });
      } catch {
        /* aborted or model error — keep the prior squiggles until the next pass */
      } finally {
        signalAi(tag, false);
      }
    };
    const scheduleAiPassive = () => {
      if (aiPassiveTimer) {
        clearTimeout(aiPassiveTimer);
      }
      // Enqueued just after tense; the shared chain guarantees passive only hits the
      // model once tense's pass has finished, so the two never run concurrently.
      aiPassiveTimer = setTimeout(() => enqueueCheck(runAiPassive), 6500);
    };

    // Re-push spelling when the dictionary or the enabled toggle changes; a
    // language switch invalidates the AI cache, so re-run the doc pass too.
    const spellSub = this.spell.onDidChange(() => {
      this.aiDocSpell.dispose(docKey);
      lastAiSuggestions = new Map();
      lastAiCleared = new Set();
      lastGrammar = [];
      void postSpell();
      scheduleAiSpell();
    });

    // Changing the AI model, engine, or the spell toggle invalidates the cached
    // proofread — reset it and re-scan the whole doc (a freshly-opened-style pass).
    const spellModelSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiSpellAi}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiOllamaModel}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiEngine}`)
      ) {
        this.aiDocSpell.dispose(docKey);
        lastAiSuggestions = new Map();
        lastAiCleared = new Set();
        lastGrammar = [];
        lastTenseText = ''; // new model → re-run the tense pass too
        lastPassiveText = ''; // …and the passive pass
        void postSpell();
        scheduleAiSpell();
        scheduleAiTense();
        scheduleAiPassive();
      }
    });

    const postConfig = () => {
      const wsCfg = vscode.workspace.getConfiguration(EXTENSION_ID);
      const fontSize = wsCfg.get<number>(ConfigKeys.wysiwygFontSize, 18);
      const maxWidth = wsCfg.get<string>(ConfigKeys.wysiwygMaxWidth, '80ch');
      const spellcheckEnabled = wsCfg.get<boolean>(ConfigKeys.spellcheckEnabled, true);
      // Sentence spacing: 'none' | '1' | '2' → expected space count for the underline.
      const spacingPref = wsCfg.get<string>(ConfigKeys.spacingAfterPeriod, '1');
      const sentenceSpacing = spacingPref === 'none' ? 0 : spacingPref === '2' ? 2 : 1;
      // Quotation-punctuation placement: 'inside' (American) | 'outside' (British) | 'off'.
      const quotePunctuationStyle = wsCfg.get<string>(ConfigKeys.quotesPunctuationStyle, 'inside');
      // Live style underlines: passive (logic) + tense (AI). Both gate their webview paint.
      const passiveVoice = wsCfg.get<boolean>(ConfigKeys.checksPassiveVoice, true);
      const tenseCheck = wsCfg.get<boolean>(ConfigKeys.checksTense, true);
      const base = document.uri.path.split('/').pop() ?? 'document.md';
      void panel.webview.postMessage({
        type: 'config',
        fontSize,
        maxWidth,
        spellcheckEnabled,
        sentenceSpacing,
        quotePunctuationStyle,
        passiveVoice,
        tenseCheck,
        filename: base.replace(/\.md$/i, '') + '.pdf'
      });
    };

    // Bottom-right AI status: which models are active (writer / spell / synonyms)
    // and, via aiBusy, which is processing right now.
    const postAiStatus = async () => {
      try {
        const chips = await aiStatusChips();
        void panel.webview.postMessage({ type: 'aiStatus', chips });
      } catch {
        /* status is best-effort */
      }
    };
    const postAiBusy = (tag: string, on: boolean) => {
      if (tag) {
        void panel.webview.postMessage({ type: 'aiBusy', tag, on });
      }
    };
    // The footer spinner is driven by the global AI-activity bus, so AI work started
    // ANYWHERE (Brainstorm, Story Memory, Revise, synonyms, spell) lights it. When a
    // heavy foreground generation finishes, resume the background proofread that
    // yielded the model to it (see getSpellEngine's isHeavyAiBusy gate).
    const aiActivitySub = onAiActivity((ev) => {
      postAiBusy(ev.tag, ev.on);
      if (ev.heavy && !ev.on && !isHeavyAiBusy()) {
        scheduleAiSpell();
      }
    });
    // Footer text status ("Loading Model…" / "Model Ready" / "Idle") + VRAM readout.
    const postModelState = (s = currentModelState()) =>
      void panel.webview.postMessage({ type: 'aiModelState', status: s.status, vramGb: s.vramGb });
    const modelStateSub = onModelState((s) => postModelState(s));

    const savePdf = async (base64: string, filename: string) => {
      try {
        const bytes = Buffer.from(base64, 'base64');
        const defaultUri = vscode.Uri.joinPath(document.uri, '..', filename);
        const target = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { PDF: ['pdf'] }
        });
        if (!target) {
          return;
        }
        await vscode.workspace.fs.writeFile(target, bytes);
        const choice = await vscode.window.showInformationMessage(`Saved ${filename}`, 'Open');
        if (choice === 'Open') {
          void vscode.env.openExternal(target);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not save PDF: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    const applyFromWebview = async (text: string) => {
      // The webview is now the source of truth — cancel any pending external
      // push that would otherwise revert this edit.
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = undefined;
      }
      const current = document.getText();
      if (text === current) {
        lastSynced = text;
        return;
      }
      lastSynced = text;
      // Replace only the changed span (common prefix/suffix trimmed) rather than the
      // whole document, so a keystroke is one small edit — keeping native undo granular
      // and the applyEdit O(change) instead of O(document) on large chapters.
      const { start, end, replacement } = diffRange(current, text);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(start), document.positionAt(end)),
        replacement
      );
      await vscode.workspace.applyEdit(edit);
    };

    const messageSub = panel.webview.onDidReceiveMessage(async (msg: FromWebview) => {
      switch (msg.type) {
        case 'ready':
          // ONLY render + lightweight status here. No checks — the heavy passes
          // (Hunspell over the whole chapter, the tense model call) would run on the
          // extension's event loop and delay delivery of this content message, which
          // left files "loading forever". Checks start on the 'displayed' message.
          lastSynced = document.getText();
          postConfig();
          pushToWebview(lastSynced);
          postStats();
          void postAiStatus();
          postModelState();
          break;
        case 'displayed':
          // The webview has rendered the document and it's visible. NOW it's safe to
          // run the checks. Dictionary spell is instant; the AI proofread still only
          // runs incrementally as you edit (cached per paragraph), and tense is one
          // throttled whole-doc pass.
          void postSpell();
          scheduleHarperGrammar();
          scheduleAiTense();
          scheduleAiPassive();
          break;
        case 'edit':
          if (typeof msg.text === 'string') {
            void applyFromWebview(msg.text);
          }
          break;
        case 'save':
          // Cmd/Ctrl+S from the webview: flush the latest content (the debounced
          // edit may not have fired yet — critical when the user just deleted
          // everything) and write it to disk.
          if (typeof msg.text === 'string') {
            await applyFromWebview(msg.text);
          }
          await document.save();
          break;
        case 'editRaw':
          void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
        case 'setFontSize':
          if (typeof msg.size === 'number') {
            await vscode.workspace
              .getConfiguration(EXTENSION_ID)
              .update(ConfigKeys.wysiwygFontSize, msg.size, vscode.ConfigurationTarget.Global);
          }
          break;
        case 'toggleSpellcheck':
          if (typeof msg.enabled === 'boolean') {
            await vscode.workspace
              .getConfiguration(EXTENSION_ID)
              .update(ConfigKeys.spellcheckEnabled, msg.enabled, vscode.ConfigurationTarget.Global);
          }
          break;
        case 'addToDictionary':
          if (msg.word) {
            await this.spell.add(msg.word); // fires onDidChange → re-posts spellResult
          }
          break;
        case 'ignoreWord':
          // Suppress this word in THIS workspace only (not added to the global
          // dictionary). Fires onDidChange → re-posts spellResult without it.
          if (msg.word) {
            await this.spell.ignore(msg.word);
          }
          break;
        case 'ignoreGrammar':
          // Permanently suppress this grammar/word-choice finding (by phrase) in
          // this workspace, then re-post immediately (no full AI re-scan).
          if (msg.phrase) {
            await this.spell.ignoreGrammar(msg.phrase);
            await postSpell();
          }
          break;
        case 'selectModel':
          // Same picker as the status bar — switch model / manage pulled models.
          await vscode.commands.executeCommand(Commands.aiSelectLocalModel);
          break;
        case 'thesaurusEngine':
          // The gear by Synonyms/Antonyms — choose AI model vs dictionary.
          await vscode.commands.executeCommand(Commands.thesaurusSelectEngine);
          break;
        case 'showIssues':
          // Open the Proser sidebar on the Editor (tense/passive/continuity) tab.
          await vscode.commands.executeCommand(Commands.editorChecks);
          break;
        case 'openBrainstorm':
          try {
            await vscode.commands.executeCommand(Commands.brainstorm);
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Couldn’t open Brainstorm: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          break;
        case 'exportMenu':
          await showExportMenu(panel);
          break;
        case 'exportPdf':
          if (msg.data) {
            await savePdf(msg.data, msg.filename ?? 'document.pdf');
          }
          break;
        case 'exportError':
          vscode.window.showErrorMessage(`PDF export failed: ${msg.message ?? 'unknown error'}`);
          break;
        case 'thesaurusRequest':
          if (msg.kind && msg.word) {
            const synTag = currentModelName();
            signalAi(synTag, true);
            let res;
            try {
              res = await suggestionsFor(msg.kind, msg.word, msg.sentence ?? '');
            } finally {
              signalAi(synTag, false);
            }
            if (res.words.length === 0) {
              vscode.window.showInformationMessage(
                noResultsMessage(msg.kind, msg.word, msg.kind, res.triedAi, res.aiStatus)
              );
            } else {
              void panel.webview.postMessage({
                type: 'thesaurusResult',
                words: res.words,
                word: msg.word,
                source: res.sourceLabel
              });
            }
          }
          break;
        case 'definitionRequest':
          if (msg.word && msg.word.trim()) {
            const term = msg.word.trim();
            dictionaryPanel.showLoading(this.context, term);
            const entry = await lookupDefinition(term);
            if (entry) {
              dictionaryPanel.showEntry(this.context, entry);
            } else {
              dictionaryPanel.showNotFound(this.context, term);
            }
          }
          break;
        case 'reviseRequest':
          if (typeof msg.text === 'string' && msg.text.trim().length > 0) {
            const writerTag = currentModelName();
            signalAi(writerTag, true, true); // heavy: background spell/synonyms yield
            let options;
            try {
              options = await reviseOptions(secrets, msg.text, msg.instruction, 3);
            } finally {
              signalAi(writerTag, false, true);
            }
            if (options.length > 0) {
              void panel.webview.postMessage({ type: 'reviseResult', options });
            }
          }
          break;
        case 'spellAiSuggest': {
          // Opt-in: only runs when a tiny AI helper is configured. AI suggestions
          // AUGMENT the dictionary's (they're additive in the card) — and we keep
          // only AI words the dictionary itself accepts, so a tiny model can't slip
          // a plausible non-word ("receivs") through. Silent on any failure.
          const helper = await getSpellEngine();
          if (helper && msg.word) {
            try {
              if ((await helper.isReady()).ready) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 8000);
                const spellTag = resolveSpellModel();
                signalAi(spellTag, true);
                try {
                  const raw = await aiSpellSuggestions(
                    helper,
                    msg.word,
                    msg.sentence ?? '',
                    6,
                    controller.signal
                  );
                  const valid: string[] = [];
                  for (const w of raw) {
                    if (await this.spell.isWordCorrect(w)) {
                      valid.push(w);
                    }
                  }
                  if (valid.length > 0) {
                    void panel.webview.postMessage({ type: 'spellAiResult', word: msg.word, words: valid });
                  }
                } finally {
                  clearTimeout(timer);
                  signalAi(spellTag, false);
                }
              }
            } catch {
              /* dictionary suggestions are already shown — stay silent */
            }
          }
          break;
        }
        case 'promptsLoad': {
          const prompts = await readPrompts(document.uri);
          void panel.webview.postMessage({ type: 'promptsResult', prompts });
          break;
        }
        case 'promptsSave': {
          await writePrompts(msg.prompts ?? [], document.uri);
          const prompts = await readPrompts(document.uri);
          void panel.webview.postMessage({ type: 'promptsResult', prompts });
          break;
        }
      }
    });

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      scheduleStats(); // footer reflects every change, incl. our own writes
      scheduleSpell(); // re-check spelling on every change (incl. webview edits)
      scheduleAiSpell(); // re-run AI only on changed paragraphs (≥2s debounce)
      scheduleHarperGrammar(); // re-run the whole-doc grammar pass (Harper; fast)
      scheduleAiTense(); // re-run the whole-doc tense pass (6s debounce, cached)
      scheduleAiPassive(); // re-run the whole-doc passive pass (staggered after tense)
      const text = document.getText();
      if (text === lastSynced) {
        return; // our own write — don't echo
      }
      lastSynced = text;
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      syncTimer = setTimeout(() => {
        // Only push if no newer edit (e.g. from the webview) superseded this one.
        if (text === lastSynced) {
          pushToWebview(text);
        }
      }, syncDebounceMs);
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.wysiwygMaxWidth}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.wysiwygFontSize}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.spellcheck`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.spacingAfterPeriod}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.quotesPunctuationStyle}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.checks`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.ai`)
      ) {
        postConfig();
        void postAiStatus(); // model/engine change → refresh the status chips
      }
      // Toggling the tense check should immediately run (or clear) its underlines.
      if (e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.checksTense}`)) {
        lastTenseText = ''; // force the next pass even if the text is unchanged
        scheduleAiTense();
      }
      // Toggling the passive check likewise runs (or clears) its underlines.
      if (e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.checksPassiveVoice}`)) {
        lastPassiveText = ''; // force the next pass even if the text is unchanged
        scheduleAiPassive();
      }
      // Toggling grammar just shows/hides the existing findings — re-post spelling.
      if (e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.checksGrammar}`)) {
        void postSpell();
      }
    });

    panel.onDidDispose(() => {
      if (prettyPanels.get(docKey) === panel) {
        prettyPanels.delete(docKey);
      }
      messageSub.dispose();
      changeSub.dispose();
      configSub.dispose();
      spellSub.dispose();
      spellModelSub.dispose();
      aiActivitySub.dispose();
      modelStateSub.dispose();
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      if (statsTimer) {
        clearTimeout(statsTimer);
      }
      if (spellTimer) {
        clearTimeout(spellTimer);
      }
      if (aiSpellTimer) {
        clearTimeout(aiSpellTimer);
      }
      if (aiPostTimer) {
        clearTimeout(aiPostTimer);
      }
      if (aiTenseTimer) {
        clearTimeout(aiTenseTimer);
      }
      if (aiPassiveTimer) {
        clearTimeout(aiPassiveTimer);
      }
      if (harperTimer) {
        clearTimeout(harperTimer);
      }
      aiCtl?.abort();
      tenseCtl?.abort();
      passiveCtl?.abort();
      this.aiDocSpell.dispose(docKey);
    });
  }
}

/** Warn at most once per session that the spell model leaves no room beside the
 *  editor model (memory fit is computed by `proofreadFits` in engineFactory). */
let proofreadMemWarned = false;
