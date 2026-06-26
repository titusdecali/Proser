/**
 * Common, correctly-spelled English words and interjections that the bundled
 * Hunspell dictionaries (US + GB) flag as unknown — verified against the real
 * engine, see `scripts/_spellcheck_probe.cjs`. Added as EXACT entries (never
 * affix-expanded), so they can only ACCEPT these specific words and never let a
 * genuine typo through. This is the cheap, instant layer for frequent offenders;
 * the long tail of coined names/sounds is handled by the AI proofread's clearing
 * pass on a capable model. English only.
 *
 * Keep entries lowercase: matching is case-insensitive, so "haha" also clears
 * sentence-initial "Haha". Add an explicit plural/inflection only when it's
 * itself flagged (affixes aren't generated for these).
 */
export const SUPPLEMENTAL_WORDS: readonly string[] = [
  // Real words the base dictionaries miss
  'wicking', 'toroidal', 'toroid', 'toroids', 'donut', 'pristinely', 'gauntly',
  'wifi', 'vlog', 'vlogs', 'vlogged', 'vlogging', 'utopian', 'exosuit', 'exosuits',
  'mech', 'mechs', 'nanotech', 'terraform', 'terraforms', 'terraformed', 'terraforming',
  'matcha', 'umami', 'kombucha', 'charcuterie',
  // …-scape compounds and other common reals the dictionary still flags
  'cityscape', 'cityscapes', 'seascape', 'seascapes', 'moonscape', 'cloudscape',
  'dreamscape', 'soundscape', 'ramen',

  // Interjections / written sounds common in fiction dialogue
  'haha', 'hahaha', 'hehe', 'heh', 'hmmm', 'hmph', 'argh', 'aargh', 'grr', 'grrr',
  'mmm', 'mmph', 'oof', 'woah', 'tsk', 'gah', 'ew', 'eww', 'aww', 'owie', 'pfft',
  'tch', 'ahh', 'ahhh', 'ohh', 'hm', 'mhm', 'mmhmm', 'welp', 'ack', 'eep', 'yeesh',
  'sheesh', 'bleh', 'blegh', 'urgh', 'nngh', 'hnng'
];
