/**
 * Dictionary (definition) lookup for a single word. Two sources, chosen by the
 * `proser.dictionary.source` setting:
 *
 *   online  — the free Dictionary API (dictionaryapi.dev): no key, the richest
 *             entry (phonetics, examples, meanings grouped by part of speech).
 *   offline — WordNet via the optional `wordpos` dependency (~155k words). Always
 *             available, no network, but terser academic glosses.
 *   auto    — try online first; fall back to offline when offline / the word 404s
 *             / the request times out. (Mirrors `thesaurus.source`.)
 */

import * as vscode from 'vscode';
import { EXTENSION_ID, ConfigKeys } from '../../constants';
import { getWordpos } from '../thesaurus/offlineThesaurus';

const ONLINE_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const TIMEOUT_MS = 5000;

export interface Definition {
  definition: string;
  example?: string;
}

export interface Meaning {
  partOfSpeech: string;
  definitions: Definition[];
  synonyms?: string[];
  antonyms?: string[];
}

export interface DictionaryEntry {
  word: string;
  phonetic?: string;
  source: 'online' | 'offline';
  meanings: Meaning[];
}

type DictionarySource = 'auto' | 'online' | 'offline';

function configuredSource(): DictionarySource {
  const v = vscode.workspace
    .getConfiguration(EXTENSION_ID)
    .get<string>(ConfigKeys.dictionarySource, 'auto');
  return v === 'online' || v === 'offline' ? v : 'auto';
}

/** Looks up `word`, honouring the configured source (with auto fallback). Returns
 *  null when no definition can be found from the selected source(s). */
export async function lookupDefinition(word: string): Promise<DictionaryEntry | null> {
  const clean = word.trim();
  if (!clean) {
    return null;
  }
  const source = configuredSource();

  if (source === 'offline') {
    return lookupOffline(clean);
  }

  // 'online' or 'auto': try the network first.
  let online: DictionaryEntry | null = null;
  try {
    online = await lookupOnline(clean);
  } catch {
    online = null; // network error / timeout / 404 — fall through
  }
  if (online && online.meanings.length > 0) {
    return online;
  }
  if (source === 'online') {
    return online; // caller asked for online only; don't reach for WordNet
  }
  // auto: nothing usable online → WordNet.
  return lookupOffline(clean);
}

// ── Online: dictionaryapi.dev ──────────────────────────────────────────────

interface ApiDefinition {
  definition?: string;
  example?: string;
  synonyms?: string[];
  antonyms?: string[];
}
interface ApiMeaning {
  partOfSpeech?: string;
  definitions?: ApiDefinition[];
  synonyms?: string[];
  antonyms?: string[];
}
interface ApiEntry {
  word?: string;
  phonetic?: string;
  phonetics?: { text?: string }[];
  meanings?: ApiMeaning[];
}

async function lookupOnline(word: string): Promise<DictionaryEntry | null> {
  const url = ONLINE_BASE + encodeURIComponent(word.toLowerCase());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      // 404 means "no entry" — a normal miss, not an error worth surfacing.
      return null;
    }
    const data = (await res.json()) as ApiEntry[];
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }
    return mergeApiEntries(word, data);
  } finally {
    clearTimeout(timer);
  }
}

/** dictionaryapi.dev returns one object per homograph; merge their meanings and
 *  take the first non-empty phonetic. */
function mergeApiEntries(word: string, entries: ApiEntry[]): DictionaryEntry {
  const meanings: Meaning[] = [];
  let phonetic: string | undefined;
  for (const entry of entries) {
    if (!phonetic) {
      phonetic =
        entry.phonetic ||
        entry.phonetics?.find((p) => p.text && p.text.trim().length > 0)?.text;
    }
    for (const m of entry.meanings ?? []) {
      const definitions: Definition[] = (m.definitions ?? [])
        .map((d) => ({
          definition: (d.definition ?? '').trim(),
          example: d.example?.trim() || undefined
        }))
        .filter((d) => d.definition.length > 0);
      if (definitions.length === 0) {
        continue;
      }
      meanings.push({
        partOfSpeech: (m.partOfSpeech ?? '').trim() || 'other',
        definitions,
        synonyms: dedupe(m.synonyms),
        antonyms: dedupe(m.antonyms)
      });
    }
  }
  return { word: entries[0]?.word || word, phonetic: phonetic?.trim() || undefined, source: 'online', meanings };
}

// ── Offline: WordNet via wordpos ───────────────────────────────────────────

const POS_NAMES: Record<string, string> = {
  n: 'noun',
  v: 'verb',
  a: 'adjective',
  s: 'adjective',
  r: 'adverb'
};

interface Synset {
  pos?: string;
  def?: string;
  gloss?: string;
  synonyms?: string[];
}

async function lookupOffline(word: string): Promise<DictionaryEntry | null> {
  const wordpos = await getWordpos();
  if (!wordpos) {
    return null;
  }
  let synsets: Synset[] = [];
  try {
    synsets = (await wordpos.lookup(word)) ?? [];
  } catch {
    return null;
  }
  if (synsets.length === 0) {
    return null;
  }

  const lower = word.toLowerCase();
  // Group synsets by part of speech, preserving WordNet's sense order within each.
  const byPos = new Map<string, Meaning>();
  for (const s of synsets) {
    const pos = POS_NAMES[s.pos ?? ''] ?? 'other';
    const definition = (s.def ?? '').trim();
    if (!definition) {
      continue;
    }
    let meaning = byPos.get(pos);
    if (!meaning) {
      meaning = { partOfSpeech: pos, definitions: [], synonyms: [] };
      byPos.set(pos, meaning);
    }
    meaning.definitions.push({ definition, example: exampleFromGloss(s.gloss) });
    for (const syn of s.synonyms ?? []) {
      const clean = String(syn).replace(/_/g, ' ').trim();
      if (clean && clean.toLowerCase() !== lower && !meaning.synonyms!.includes(clean)) {
        meaning.synonyms!.push(clean);
      }
    }
  }
  const meanings = Array.from(byPos.values()).map((m) => ({
    ...m,
    synonyms: m.synonyms && m.synonyms.length > 0 ? m.synonyms : undefined
  }));
  if (meanings.length === 0) {
    return null;
  }
  return { word, source: 'offline', meanings };
}

/** A WordNet gloss is `definition; "example one"; "example two"`. Pull the first
 *  quoted example, if any. */
function exampleFromGloss(gloss?: string): string | undefined {
  if (!gloss) {
    return undefined;
  }
  const m = gloss.match(/"([^"]+)"/);
  return m ? m[1].trim() : undefined;
}

function dedupe(words?: string[]): string[] | undefined {
  if (!words || words.length === 0) {
    return undefined;
  }
  const out: string[] = [];
  for (const w of words) {
    const clean = String(w).trim();
    if (clean && !out.includes(clean)) {
      out.push(clean);
    }
  }
  return out.length > 0 ? out : undefined;
}
