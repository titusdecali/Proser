/* Throwaway probe: faithfully ports SpellEngine's English isCorrect() logic over
 * the bundled US+GB Hunspell dicts, to see which candidate words are FLAGGED
 * before curating the supplemental wordlist. Not shipped. */
const fs = require('fs');
const nspell = require('nspell');

function load(pkg) {
  const dir = `node_modules/${pkg}`;
  return nspell(fs.readFileSync(`${dir}/index.aff`), fs.readFileSync(`${dir}/index.dic`));
}
const spellers = [load('dictionary-en'), load('dictionary-en-gb')];

const PREFIXES = ['co','pre','re','un','non','anti','over','under','sub','super','semi','multi','inter','intra','de','dis','mis','out','up','self','well','ex','pro','counter','post','mid','off','meta','micro','macro','mini','trans'];
const COMPOUND_STOP_FIRST = new Set(['the','and','for','but','nor','yet','are','was','were','you','his','her','she','him','who','whom','why','how','did','does','done','had','has','have','its','our','your','their','them','they','this','that','then','than','with','from','not']);
const DERIV_SUFFIXES = ['ization','isation','ation','ities','ments','able','ible','ness','ment','less','ful','ity','ism','isms','ist','ists','ize','ise','ers','ors','er','or'].sort((a,b)=>b.length-a.length);

const known = (w) => { const lw=w.toLowerCase(); return spellers.some(s=>s.correct(w)||s.correct(lw)); };
function partCorrect(part){ if(part.length<2)return true; if(known(part))return true; const lower=part.toLowerCase(); if(PREFIXES.includes(lower))return true; for(const pre of PREFIXES){ if(lower.length>pre.length+2&&lower.startsWith(pre)&&known(lower.slice(pre.length)))return true; } return false; }
function closedCompoundOk(word){ const lw=word.toLowerCase(); if(lw.length<6)return false; for(let i=3;i<=lw.length-3;i++){ const first=lw.slice(0,i); if(COMPOUND_STOP_FIRST.has(first))continue; if(known(first)&&known(lw.slice(i)))return true; } return false; }
function englishWordOk(token){ return token.split('-').every(part=>partCorrect(part)||closedCompoundOk(part)); }
function derivedOk(word){ const lw=word.toLowerCase(); if(lw.length<5)return false; for(const suf of DERIV_SUFFIXES){ if(lw.length<=suf.length+2||!lw.endsWith(suf))continue; const stem=lw.slice(0,-suf.length); const candidates=[stem,stem+'e']; if(stem.endsWith('i'))candidates.push(stem.slice(0,-1)+'y'); const last=stem[stem.length-1]; if(stem.length>=3&&last===stem[stem.length-2]&&!'aeiou'.includes(last))candidates.push(stem.slice(0,-1)); if(candidates.some(c=>c.length>=2&&englishWordOk(c)))return true; } return false; }
const accepted = (t) => englishWordOk(t)||derivedOk(t);
function isCorrect(token){ if(/\d/.test(token))return true; if(token.length>=2&&token===token.toUpperCase()&&/\p{Lu}/u.test(token))return true; if(accepted(token))return true; return false; }

const candidates = [
  'wicking','toroidal','donut','donuts','pristinely','toroid','wifi','vlog','vlogs','utopian','exosuit','gauntly',
  // interjections / sounds
  'haha','hahaha','heh','hmmm','argh','aargh','grr','grrr','mmm','oof','woah','tsk','gah','ew','eww','aww',
  'owie','hmph','pfft','tch','ahh','ahhh','ohh','hm','mhm','mmhmm','yup','welp','ack','eep','yeesh','sheesh',
  'bleh','blegh','ugh','urgh','mmph','nngh','hnng','wheeze','harrumph','guffaw',
  // genre / sci-fi-fantasy common nouns
  'spaceport','hyperspace','stardrive','starship','starships','cyborg','cyborgs','android','androids',
  'mech','mechs','datapad','viewscreen','airlock','airlocks','starfighter','lightyears','plasma',
  'biomechanical','cybernetic','cybernetics','exoskeleton','nanotech','terraform','terraforming',
  'spellcasting','spellcaster','bloodmage','warlock','necromancer','dreadlord','arcanist','manaflow',
  // modern words
  'smartwatch','touchscreen','livestream','livestreaming','screenshot','screenshots','hashtag','clickbait',
  'deepfake','username','usernames','passcode','autoplay','autosave','dropdown','unfriend','doomscroll',
  'barista','matcha','sriracha','umami','kombucha','charcuterie',
  // more adverbs derivation can miss
  'wanly','dazedly','blearily','queasily','achingly','starkly','warily','lithely','sardonically','mirthlessly'
];
const flagged = candidates.filter(w => !isCorrect(w));
const accepted_ = candidates.filter(w => isCorrect(w));
console.log('FLAGGED (need supplement):', JSON.stringify(flagged));
console.log('\nALREADY ACCEPTED (skip):', JSON.stringify(accepted_));
// sanity: real typos must STAY flagged even after we add -ly-style words
const typos = ['definitly','occured','recieve','seperately','occuring','wierd','untill','alot','thier','wickign'];
console.log('\nTYPOS still flagged (should be all true):', typos.map(t=>`${t}:${!isCorrect(t)}`).join(' '));
