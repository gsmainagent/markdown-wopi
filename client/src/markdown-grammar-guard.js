// Monaco's markdown grammar opens an HTML tag state on any `<` followed by word chars:
//
//   [/<(\w+)(\-|\w)*/, { token: 'tag', next: '@tag.$1' }]
//
// Math notes are full of comparison lines such as `$a_1<a_2$`, `-1<y_{k+1}<y_k<1` and
// `|x|<1`, and those lines have no
// `>` at all, so the tag state never pops and everything below loses markdown highlighting.
// The grammar's own comment says it cannot back up one character, so we guard the rule instead:
// only enter the tag state when a `>` actually closes it on the same line.
import { language as markdownGrammar } from 'monaco-editor/languages/definitions/markdown/markdown.js';

const GUARD = /<([a-zA-Z][\w-]*)(?=[^>\n]*>)/;
// Exact upstream source of the unguarded opener. Matching it by identity means a Monaco upgrade
// that rewrites the rule makes this report replaced: 0 instead of silently patching nothing.
const UNGUARDED_OPENER = /<(\w+)(\-|\w)*/.source;

export function patchMarkdownGrammar(grammar = markdownGrammar) {
  const t = grammar?.tokenizer;
  if (!t || !Array.isArray(t.html)) return { patched: false, replaced: 0, reason: 'no html state' };
  if (grammar.__wopiAngleGuard) return { patched: false, replaced: 0, reason: 'already patched' };
  let replaced = 0;
  t.html = t.html.map((rule) => {
    const head = Array.isArray(rule) ? rule[0] : null;
    if (head instanceof RegExp && head.source === UNGUARDED_OPENER) {
      replaced += 1;
      return [GUARD, { cases: { '@empty': { token: 'tag', next: '@tag.$1' }, '@default': { token: 'tag', next: '@tag.$1' } } }];
    }
    return rule;
  });
  if (replaced > 0) grammar.__wopiAngleGuard = true;
  return { patched: replaced > 0, replaced, reason: replaced > 0 ? 'ok' : 'upstream rule not found' };
}

export function registerSafeMarkdownTokens(monaco) {
  const result = patchMarkdownGrammar();
  // Mutating the shared grammar is enough for the lazy loader; setting the provider keeps it
  // correct if the language was already registered before this module ran.
  monaco.languages.setMonarchTokensProvider('markdown', markdownGrammar);
  return result;
}

export const angleGuard = GUARD;
export { markdownGrammar as language };

