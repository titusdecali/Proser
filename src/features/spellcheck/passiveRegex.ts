/** Shared passive-voice heuristic. A "to be" form (+ up to two adverbs) followed by
 *  a past participle — regular `-ed` or a curated set of common irregulars — with a
 *  negative lookahead that drops the most frequent `-ed`/`-en` PREDICATE ADJECTIVES
 *  ("was tired", "were excited") so they aren't treated as passives. The irregular set
 *  deliberately omits participles that read mainly as adjectives after "to be"
 *  (drunk, stuck, lit, shut) to avoid false positives — especially in the no-AI
 *  `scanLocal` fallback, which has no model to judge. Used by the AI passive pass (as
 *  a cheap pre-filter and a suggestion guard) and by the sidebar's no-AI fallback; the
 *  webview no longer keeps a copy (its underline is now AI-driven). Tested against the
 *  fixtures in scripts/. */
export const PASSIVE_RE =
  /\b(?:am|is|are|was|were|be|been|being)\b(?:\s+(?:\w+ly|very|quite|so|too|really|rather|just|also|often|always|barely|hardly|nearly)){0,2}\s+(?!(?:tired|bored|excited|interested|worried|scared|surprised|confused|pleased|annoyed|amused|frightened|exhausted|relaxed|concerned|embarrassed|delighted|disappointed|frustrated|determined|gifted|talented|aged|wicked|naked|sacred|crooked|rugged|drunken)\b)(?:\w+ed|broken|spoken|chosen|frozen|stolen|woven|driven|ridden|written|hidden|beaten|eaten|fallen|taken|given|shaken|mistaken|forgotten|forbidden|proven|thrown|grown|known|shown|flown|blown|drawn|withdrawn|worn|torn|born|borne|sworn|done|gone|seen|made|built|sent|kept|held|told|found|paid|said|laid|lost|won|left|brought|bought|caught|taught|fought|sought|met|set|put|cut|hit|read|led|fed|dealt|felt|meant|sold|heard|hurt|bound|wound|ground|struck|swept|spent|lent|bent|burnt|spelt|shot|understood|forgiven|hung|dug|sung|swung|sprung|rung|flung|clung|stung|strung|wrung|slung|spun|begun|swum|bred|shed|spread|cast|split|thrust|sunk|shrunk|bitten|overridden|awoken|woken|forsaken|sown|mown|sewn)\b/giu;

/** Counts passive-voice constructions in `s`. Used to verify a suggested rewrite
 *  actually REMOVES passive voice (strictly fewer hits than the original). */
export function passiveHits(s: string): number {
  PASSIVE_RE.lastIndex = 0;
  let n = 0;
  while (PASSIVE_RE.exec(s) !== null) {
    n++;
  }
  return n;
}
