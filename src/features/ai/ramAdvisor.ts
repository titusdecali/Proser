import * as os from 'os';
import { execFile } from 'child_process';

export interface LocalModel {
  tag: string;
  label: string;
  /** Approximate download size for this tag's quant, GB. */
  sizeGb: number;
  /** Total RAM (GB) we consider comfortable to run it. */
  minRamGb: number;
  note: string;
}

export interface ModelRecommendation {
  tag: string;
  reason: string;
  /** Platform-specific caveat shown alongside the recommendation. */
  platformNote: string;
}

/**
 * The curated local writing models, chosen for prose quality across the full span
 * of VRAM/RAM brackets so every machine gets the best writer it can run. This is
 * the Gemma 4 family (released April 2026, Apache 2.0) — best-in-class for prose
 * at each tier — capped at 31B. All entries use **native Ollama-library tags**, so
 * they pull reliably from Ollama's own registry (the `hf.co/...` GGUF pull path is
 * flaky for these multimodal/sharded models and 400s mid-download). The E2B/E4B
 * "effective" models are Gemma-3n-style nested models, so their download is heavier
 * than their active param count (and the dense 12B is a smaller download than E4B).
 * `gemma4:26b` is a Mixture-of-Experts (~4B active per token) — big-model quality at
 * roughly dense-12B speed, the sweet spot on a 24 GB Apple-Silicon machine. Any
 * other model (incl. specific HF GGUF quants) is reachable via the picker's
 * "Download another model…" entry.
 */
export const LOCAL_MODELS: LocalModel[] = [
  { tag: 'gemma4:e2b', label: 'Gemma 4 · E2B (compact)', sizeGb: 7.2, minRamGb: 8, note: 'Lightest — fast anywhere; word lookups & quick edits' },
  { tag: 'gemma4:e4b', label: 'Gemma 4 · E4B (default)', sizeGb: 9.6, minRamGb: 12, note: 'Google’s default — strong all-round writer for most laptops' },
  { tag: 'gemma4:12b', label: 'Gemma 4 · 12B (dense)', sizeGb: 7.6, minRamGb: 16, note: 'Dense 12B — best that fits a 16–24 GB machine; small download' },
  { tag: 'gemma4:26b', label: 'Gemma 4 · 26B (MoE)', sizeGb: 18, minRamGb: 32, note: 'Mixture-of-experts (~4B active = fast); needs 32 GB+ (18 GB weights + context)' },
  { tag: 'gemma4:31b', label: 'Gemma 4 · 31B (dense)', sizeGb: 20, minRamGb: 40, note: 'Largest — top quality; needs ~40 GB for weights + context' }
];

const GB = 1024 * 1024 * 1024;

/** Memory (GB) that must stay free for macOS + VS Code/Electron + the user's open
 *  documents on a unified-memory/CPU machine. The catalog's `minRamGb` sizes the
 *  model's own weights + KV cache; this is the headroom on TOP of that, so a model
 *  plus a co-resident helper can't quietly overcommit the machine (which swaps
 *  hard and crashes the editor — the 12B + 7 GB-helper failure on a 24 GB Mac). */
const APP_RESERVE_GB = 4;

function isAppleSilicon(): boolean {
  return os.platform() === 'darwin' && os.arch() === 'arm64';
}

/**
 * Tier by usable memory (GB of VRAM/unified that can hold the model). E4B is the
 * default sweet spot — fast and a strong all-round writer — so it's recommended
 * across the common laptop range; the heavier dense/MoE tiers are only suggested
 * when there's clear headroom. "Fits in memory" isn't the same as "fast" (large
 * dense models are sluggish without a fast GPU), so these thresholds stay
 * conservative and the picker always lets the user switch up.
 */
function tierByMemory(gb: number): string {
  // `gb` is *usable* memory (total × ~0.75 on Apple Silicon, or detected VRAM).
  // The pick must fit weights + the KV cache for our 16k context + OS + app — so
  // thresholds sit well above raw weight size. A 24 GB Mac → usable ~18 → 12b;
  // the 18 GB 26b crashed there, so it now needs 32 GB+ (usable ≥ 22).
  if (gb >= 30) {
    return 'gemma4:31b'; // ~40 GB total
  }
  if (gb >= 22) {
    return 'gemma4:26b'; // ~32 GB total — MoE, fast
  }
  if (gb >= 11) {
    return 'gemma4:12b'; // 16–31 GB total — dense; best that fits a 24 GB Mac
  }
  if (gb >= 8) {
    return 'gemma4:e4b';
  }
  return 'gemma4:e2b';
}

/** Best-effort NVIDIA VRAM detection (Windows/Linux). Returns GB or undefined. */
function detectNvidiaVramGb(): Promise<number | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        'nvidia-smi',
        ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
        { timeout: 2500, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(undefined);
            return;
          }
          const mbs = stdout
            .split(/\r?\n/)
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0);
          resolve(mbs.length ? Math.max(...mbs) / 1024 : undefined);
        }
      );
    } catch {
      resolve(undefined);
    }
  });
}

/** A machine's memory situation, used to size and FILTER the model lists so the
 *  picker only offers models that run stably here. `usableGb` is what we tier on
 *  (Apple unified × 0.75, NVIDIA VRAM, or CPU RAM × 0.6). */
export interface MemoryProfile {
  totalRamGb: number;
  /** Discrete-GPU VRAM, when detected (the model must fit in it). */
  vramGb?: number;
  usableGb: number;
  cpuOnly: boolean;
  tier: 'low' | 'mid' | 'high';
  /** Human label, e.g. "Mid-tier · 24 GB". */
  label: string;
}

function makeProfile(total: number, vram: number | undefined, usable: number, cpuOnly: boolean): MemoryProfile {
  const tier: MemoryProfile['tier'] = usable >= 22 ? 'high' : usable >= 11 ? 'mid' : 'low';
  const name = tier === 'high' ? 'High-end' : tier === 'mid' ? 'Mid-tier' : 'Low-end';
  const extra = vram !== undefined ? ` · ${Math.round(vram)} GB VRAM` : cpuOnly ? ' · CPU only' : '';
  return {
    totalRamGb: Math.round(total),
    vramGb: vram !== undefined ? Math.round(vram) : undefined,
    usableGb: usable,
    cpuOnly,
    tier,
    label: `${name} · ${Math.round(total)} GB${extra}`
  };
}

/**
 * Detects the memory profile from the metric that matters per platform:
 *  - Apple Silicon: total (unified) RAM × ~0.75 — it acts as the GPU's VRAM.
 *  - Windows/Linux with NVIDIA: detected VRAM (the model must fit in VRAM).
 *  - Otherwise (no detectable GPU): conservative RAM-based + a CPU-speed caveat.
 */
export async function detectMemoryProfile(): Promise<MemoryProfile> {
  const totalGB = os.totalmem() / GB;
  if (isAppleSilicon()) {
    return makeProfile(totalGB, undefined, totalGB * 0.75, false);
  }
  const vram = await detectNvidiaVramGb();
  if (vram !== undefined) {
    return makeProfile(totalGB, vram, vram, false);
  }
  return makeProfile(totalGB, undefined, totalGB * 0.6, true);
}

/** Whether a catalog model runs stably on this system.
 *  - Unified memory / CPU: gate on total RAM via the catalog's `minRamGb`, which
 *    already bakes in the KV cache (and, for helpers, the co-resident editor model).
 *  - Discrete GPU: the weights must fit VRAM. A `coResident` helper must leave room
 *    for the editor model too, so it only gets ~40% of VRAM. */
export function modelFits(model: LocalModel, p: MemoryProfile, coResident = false): boolean {
  if (p.vramGb !== undefined) {
    return model.sizeGb <= p.vramGb * (coResident ? 0.4 : 0.9);
  }
  return model.minRamGb <= p.totalRamGb;
}

/**
 * Whether an EDITOR model runs stably on this system **with `reserveGb` left for
 * the co-resident synonyms/spell helper** (they're typically used together, on
 * Proser's separate helper server). `reserveGb` is the helper's resident
 * footprint (0 when no helper is configured).
 *  - Unified memory / CPU: the editor's `minRamGb` (its weights + KV cache) plus
 *    the helper's weights plus {@link APP_RESERVE_GB} for the OS/app must fit total
 *    RAM. Pass `reserveGb = 0` when the helper reuses the editor's own copy (helper
 *    tag == editor tag) — there's no second model resident then.
 *  - Discrete GPU: both sets of weights must fit ~90% of VRAM (model weights live
 *    in VRAM while the OS/app live in separate system RAM, so no app reserve here).
 */
export function editorFitsWithHelper(editor: LocalModel, p: MemoryProfile, reserveGb: number): boolean {
  if (p.vramGb !== undefined) {
    return editor.sizeGb + reserveGb <= p.vramGb * 0.9;
  }
  return editor.minRamGb + reserveGb + APP_RESERVE_GB <= p.totalRamGb;
}

/** Recommends the editor model for this machine. Big dense/MoE models are capped
 *  out on CPU-only systems (they run but are unusably slow there). */
export function recommendLocalModel(p: MemoryProfile): ModelRecommendation {
  let tag = tierByMemory(p.usableGb);
  if (p.cpuOnly && tag !== 'gemma4:e2b' && tag !== 'gemma4:e4b') {
    tag = 'gemma4:e4b';
  }
  // Guarantee the pick actually fits (esp. NVIDIA VRAM, which needs an exact fit
  // rather than the unified-memory headroom tierByMemory assumes): step down to
  // the largest model that does.
  const picked = localModelInfo(tag);
  if (!picked || !modelFits(picked, p)) {
    const fitting = LOCAL_MODELS.filter((m) => modelFits(m, p)).sort((a, b) => b.sizeGb - a.sizeGb);
    tag = (fitting[0] ?? LOCAL_MODELS[0]).tag;
  }
  return {
    tag,
    reason: `${p.label} detected.`,
    platformNote:
      p.vramGb !== undefined
        ? 'NVIDIA GPU: the model must fit in VRAM for good speed.'
        : p.cpuOnly
          ? 'No supported GPU — expect slow CPU inference; a smaller model keeps it usable.'
          : 'Apple Silicon: unified memory acts as the GPU’s VRAM, so total RAM is what matters.'
  };
}

/** The catalog entry for a tag, if curated. */
export function localModelInfo(tag: string): LocalModel | undefined {
  return LOCAL_MODELS.find((m) => m.tag === tag);
}
