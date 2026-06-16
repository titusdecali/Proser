import * as os from 'os';
import { execFile } from 'child_process';

export interface LocalModel {
  tag: string;
  label: string;
  /** Approximate Q4 download size, GB. */
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
 * The top 5 local writing models, chosen for prose quality across the full span
 * of VRAM/RAM brackets so every machine gets the best writer it can run. This is
 * the Gemma 4 family (released April 2026, Apache 2.0) — best-in-class for prose
 * at each tier — capped at 31B. The E2B/E4B "effective" models are Gemma-3n-style
 * nested models, so their download is heavier than their active parameter count
 * (and the dense 12B is actually a smaller download than E4B). Anything else —
 * including community creative-writing finetunes — is reachable via the picker's
 * "Download another model…" entry (a Hugging Face or Ollama URL, or any tag).
 */
export const LOCAL_MODELS: LocalModel[] = [
  { tag: 'gemma4:e2b', label: 'Gemma 4 · E2B (compact)', sizeGb: 7.2, minRamGb: 8, note: 'Lightest — fast anywhere; great for word lookups & quick edits' },
  { tag: 'gemma4:e4b', label: 'Gemma 4 · E4B (default)', sizeGb: 9.6, minRamGb: 12, note: 'Google’s default — best all-round writer for most laptops' },
  { tag: 'gemma4:12b', label: 'Gemma 4 · 12B', sizeGb: 7.6, minRamGb: 16, note: 'Dense 12B — noticeably stronger prose; small download' },
  { tag: 'gemma4:26b', label: 'Gemma 4 · 26B (MoE)', sizeGb: 18, minRamGb: 32, note: 'Mixture-of-experts — big-model quality, ~4B active per token' },
  { tag: 'gemma4:31b', label: 'Gemma 4 · 31B', sizeGb: 20, minRamGb: 36, note: 'Largest — best local Gemma 4 quality' }
];

const GB = 1024 * 1024 * 1024;

function isAppleSilicon(): boolean {
  return os.platform() === 'darwin' && os.arch() === 'arm64';
}

/** Tier by available memory (GB, already usable VRAM/unified) that holds the model. */
function tierByMemory(gb: number): string {
  if (gb >= 24) {
    return 'gemma4:31b';
  }
  if (gb >= 18) {
    return 'gemma4:26b';
  }
  if (gb >= 11) {
    return 'gemma4:12b';
  }
  if (gb >= 7) {
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

/**
 * Recommends a local model from the metric that matters per platform:
 *  - Apple Silicon: total (unified) RAM — it acts as the GPU's VRAM.
 *  - Windows/Linux with NVIDIA: detected VRAM (the model must fit in VRAM).
 *  - Otherwise (no detectable GPU): conservative RAM-based + a CPU-speed caveat.
 */
export async function recommendLocalModel(): Promise<ModelRecommendation> {
  const totalGB = os.totalmem() / GB;
  const rounded = Math.round(totalGB);

  if (isAppleSilicon()) {
    // Unified memory; the GPU can use a large fraction of total RAM.
    return {
      tag: tierByMemory(totalGB * 0.7),
      reason: `${rounded} GB unified memory detected.`,
      platformNote: 'Apple Silicon: unified memory acts as the GPU’s VRAM, so total RAM is what matters.'
    };
  }

  const vram = await detectNvidiaVramGb();
  if (vram !== undefined) {
    return {
      tag: tierByMemory(vram),
      reason: `${Math.round(vram)} GB GPU VRAM detected.`,
      platformNote: 'NVIDIA GPU: the model must fit in VRAM for good speed.'
    };
  }

  // No detectable GPU — cap at a CPU-friendly size and warn.
  const ramTier = tierByMemory(totalGB * 0.6);
  const heavy = new Set(['gemma4:12b', 'gemma4:26b', 'gemma4:31b']);
  const capped = heavy.has(ramTier) ? 'gemma4:e4b' : ramTier;
  return {
    tag: capped,
    reason: `${rounded} GB RAM detected, no NVIDIA GPU found.`,
    platformNote:
      'No supported GPU detected — expect slow CPU inference. A smaller model keeps it usable; with a capable GPU you can pick a larger one.'
  };
}

/** The catalog entry for a tag, if curated. */
export function localModelInfo(tag: string): LocalModel | undefined {
  return LOCAL_MODELS.find((m) => m.tag === tag);
}
