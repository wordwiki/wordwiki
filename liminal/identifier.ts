/**
 * INJECTIVE identifier escaping: map an ARBITRARY string to a valid
 * (ASCII-conservative) identifier such that
 *
 *     toJavascriptIdentifier(A) === toJavascriptIdentifier(B)  iff  A === B.
 *
 * Ported from dz's C++ ToRustIdentifier (liminal/to_rust_identifier.cpp -
 * his other project), with ONE scheme fix made in both: the original
 * encoded a source '__' as '___', which collides ('_-' and '__dash_' both
 * encoded to '___dash_'); source '__' is now escaped AS A WORD ('__uu_')
 * like any other special, and a lone literal '_' stays literal everywhere.
 * Injectivity then holds because the encoder never emits two ADJACENT
 * literal underscores, so every '__' in output begins an escape token (or
 * is a literal '_' + an introducer, disambiguated by the token grammar:
 * word names are pure letters, '_'-terminated).  Property-tested over an
 * adversarial corpus (identifier_test.ts).
 *
 * The output alphabet is deliberately ASCII [A-Za-z0-9_] - no '$', no
 * unicode - so results survive as JS identifiers/property names, SQLite
 * column names, schema field names (model.ts FieldNameRegex), route
 * members (routeterp identifiers), and filenames.
 *
 * The escaping rules (C++ doc, amended):
 *  1. A string that is already a valid identifier, contains no '__', and
 *     is not a keyword/hazard is returned UNCHANGED (pretty names stay
 *     pretty - single underscores included).
 *  2. A keyword/hazard is prefixed with '__'.
 *  3. '' -> '__empty'.
 *  4. '_' -> '__underscore'.
 *  5. A LEADING digit gets a '__' prefix.
 *  6. [A-Za-z0-9] and isolated '_' pass through.
 *  7. Source '__' (each PAIR, left to right) -> '__uu_'.   [the fix]
 *  8. Known specials -> '__<word>_' (table below).
 *  9. Anything else -> '__x<codepoint hex>_' (code POINTS, not bytes).
 *
 * Word-table constraints (the decodability proof leans on them): words are
 * pure ASCII letters; no word matches /^x[0-9a-f]/ (the hex token); 'uu',
 * 'empty' and 'underscore' are reserved to rules 7/3/4.
 */

const CHAR_TO_WORD = new Map<string, string>([
    ['*', 'star'], ['+', 'plus'], ['-', 'dash'], ['/', 'slash'],
    ['\\', 'backslash'], ['=', 'eq'], ['<', 'lt'], ['>', 'gt'],
    ['!', 'bang'], ['?', 'qmark'], ['&', 'amp'], ['|', 'pipe'],
    ['@', 'at'], ['#', 'hash'], ['$', 'dollar'], ['%', 'percent'],
    ['^', 'caret'], ['~', 'tilde'], ['`', 'backtick'], ['.', 'dot'],
    [',', 'comma'], [';', 'semicolon'], [':', 'colon'], ["'", 'quote'],
    ['"', 'dquote'], ['(', 'lparen'], [')', 'rparen'], ['[', 'lbracket'],
    [']', 'rbracket'], ['{', 'lbrace'], ['}', 'rbrace'], [' ', 'space'],
]);

// ECMA-262 reserved words + strict-mode/module reserved.  ('async' is only
// contextual but is escaped anyway - conservative and future-safe.)
const JS_KEYWORDS = new Set<string>([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
    'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
    'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
    'typeof', 'var', 'void', 'while', 'with',
    'implements', 'interface', 'let', 'package', 'private', 'protected',
    'public', 'static', 'yield',
    'await', 'async',
]);

// Not reserved WORDS, but hazardous as the PROPERTY/BINDING names our
// outputs become: prototype-walk landmines and strict-mode-restricted
// binding names.  ('__proto__' needs no entry - rule 7 escapes it.)
const JS_HAZARDS = new Set<string>([
    'constructor', 'prototype', 'arguments', 'eval',
]);

const escapedName = (s: string) => JS_KEYWORDS.has(s) || JS_HAZARDS.has(s);

/** Valid per OUR conservative definition: ASCII [A-Za-z_][A-Za-z0-9_]*,
 *  not a keyword/hazard, not the reserved lone '_'. */
export function isJavascriptIdentifier(s: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && s !== '_' && !escapedName(s);
}

/** Does the string contain the escape-introducer sequence '__' (in which
 *  case rule 1 passthrough is unavailable and it must be re-encoded)? */
export function containsIdentifierEscapes(s: string): boolean {
    return s.includes('__');
}

export function toJavascriptIdentifier(identifier: string): string {
    // 1. Already-valid, escape-free names pass through untouched.
    if(!containsIdentifierEscapes(identifier) && isJavascriptIdentifier(identifier))
        return identifier;
    // 2-4. The whole-string special forms.
    if(escapedName(identifier)) return '__' + identifier;
    if(identifier === '') return '__empty';
    if(identifier === '_') return '__underscore';

    const out: string[] = [];
    const chars = [...identifier];               // code points, not UTF-16 units
    if(/[0-9]/.test(chars[0])) out.push('__');   // 5. leading digit
    for(let i = 0; i < chars.length; i++) {
        if(chars[i] === '_' && chars[i+1] === '_') {   // 7. the pair, as a word
            out.push('__uu_');
            i++;
            continue;
        }
        const c = chars[i];
        if(/[A-Za-z0-9_]/.test(c)) out.push(c);                       // 6.
        else if(CHAR_TO_WORD.has(c)) out.push(`__${CHAR_TO_WORD.get(c)}_`);  // 8.
        else out.push(`__x${c.codePointAt(0)!.toString(16)}_`);       // 9.
    }
    const result = out.join('');
    // The output must always be identifier-shaped - a failure here is a
    // scheme bug, never a data problem.
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result))
        throw new Error(`identifier escaping produced a non-identifier for ${JSON.stringify(identifier)}: ${JSON.stringify(result)}`);
    return result;
}
