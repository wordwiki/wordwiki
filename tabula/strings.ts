'use strict';

/**
 * Misc string utilities.
 *
 */


// @deno-types='https://deno.land/x/xregexp/types/index.d.ts'
import XRegExp from  'https://deno.land/x/xregexp/src/index.js'

// Escape a string to allow it to be used as a literal component of a new regex.
// From: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions
export function escapeRegExp(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

/**
 * Split a string into words the posh way (using unicode segmenter - handles
 * complex punctuation, the apostrophe, multiple languages etc).
 */
export function splitIntoWords(text: string): string[] {
    const segmenter = new Intl.Segmenter([], { granularity: 'word' });
    const segmentedText = segmenter.segment(text);
    return [...segmentedText].filter(s=>s.isWordLike).map(s=>s.segment);    
}

export function stripOptionalPrefix (s: string, prefix: string) {
  if (s.startsWith (prefix))
    return s.substring (prefix.length);
  else
    return s;
}

export function stripRequiredPrefix (s: string, prefix: string) {
    if (s.startsWith (prefix))
        return s.substring (prefix.length);
    else
        throw new Error(`expected string "${s}" to have prefix "${prefix}"`);
}

export function replaceOptionalPrefix (s: string, prefix: string, replacement:string):string {
  if (s.startsWith (prefix))
    return replacement+s.substring (prefix.length);
  else
    return s;
}

export function stripOptionalSuffix (s: string, suffix: string): string {
    if (s.endsWith (suffix))
        return s.substring (0, s.length-suffix.length);
    else
        return s;
}

export function stripRequiredSuffix (s: string, suffix: string): string {
    if (s.endsWith (suffix))
        return s.substring (0, s.length-suffix.length);
    else
        throw new Error(`expected string "${s}" to have suffix "${suffix}"`);
}

export function replaceOptionalSuffix (s: string, suffix: string, replacement:string): string {
  if (s.endsWith (suffix))
    return s.substring (0, s.length-suffix.length)+replacement;
  else
    return s;
}

export function capitalize (s: string) {
  if (!s) return s;
  return s.substring (0, 1).toUpperCase ()+s.substring (1);
}

export function uncapitalize (s: string) {
  if (!s) return s;
  return s.substring (0, 1).toLowerCase ()+s.substring (1);
}

/**
 * Compares two strings in a way that is compatible with the compareFunction
 * argument to Array.sort
 */
export function stringCompare (a: string, b: string) {
    if (a < b)
        return -1;
    else if (a > b)
        return 1;
    else
        return 0;
}

/**
 * Returns whether an object is either a string or a boxed string (a String () object)
 */
export function isString (s: any) {
    return typeof (s) === 'string' || s instanceof String;
}


// ----------------------------------------------------------------------------------
// --- Upper/Lower case stuff -------------------------------------------------------
// ----------------------------------------------------------------------------------


/*

Unicode Casing Notes:

From ES6 SPEC: 

String.prototype.toUpperCase ():

This function behaves in exactly the same way as String.prototype.toLowerCase, except that the String is mapped using the toUppercase algorithm of the Unicode Default Case Conversion.

String.prototype.toLocaleUpperCase ():

This function works exactly the same as toUpperCase except that its
result is intended to yield the correct result for the host
environment's current locale, rather than a locale-independent
result. There will only be a difference in the few cases (such as
Turkish) where the rules for that language conflict with the regular
Unicode case mappings.

In xregexp-all.js we can see the regexps for identifying unicode chars
with the unicode uppercase or lowercase property set:

http://xregexp.com/v/3.2.0/xregexp-all.js

We should switch to this for much of our casing stuff.

We also want to use xregexp for identifier identifying etc.

*/


const isUpperCaseCharCache: {[char: string]: boolean;} = {}

/**
 * Returns whether a single character is a unicode upperCase character.
 *
 * Works by converting to upper case and checking if it is the same.  Need
 * to verify that this is actually correct (seems likely - but unicode is
 * a strange universe).
 *
 * Should add a cheap check for ASCII upper/lower to speed the most
 * common case.
 */
export function isUpperCaseChar (c: string) {

  // --- Must be called with a single character string
  if (c.length !== 1)
    throw new Error ('isUpperCaseChar () must be called with a single character');

  // --- If we have already cached this answer, return that.
  if (isUpperCaseCharCache.hasOwnProperty (c))
    return isUpperCaseCharCache[c];

  // --- Check if is upper by converting to lowercase using builtin toLowerCase
  //     and checking if is same.
  let lowerC = c.toLowerCase ();
  let isUpper = lowerC !== c;

  // --- Cache answer
  isUpperCaseCharCache[c] = isUpper;

  //console.info ('isUpper', c, isUpper);
  
  return isUpper;
};

/**
 *
 */
export function startsWithUpperCaseChar (s: string) {
  return s.length < 1 ? false :
    isUpperCaseChar (s.charAt (0));
}

// ---------------------------------------------------------------------------------
// --- Camel casing and identifiers ------------------------------------------------
// ---------------------------------------------------------------------------------

/**
 * Camel case to dashed.
 *
 * Converts strings in camel case format to a dashed format.
 *
 * The complicated case is multiple adjacent upper case letters.  For example
 * converting ICBMSilo to i-c-b-m-silo is gross.
 *
 * The heuristic we are presently using would convert this to:
 *
 * icbm-silo
 *
 * We define a word as starting at the beginning of the string or with the
 * last upper case letter of an upper case sequence.
 *
 * Examples:
 *
 * catFood -> cat-food
 * ICBMSilo -> icbm-silo

 * isWordStart = upper case letter followed by a lower case letter, or first upper case letter after a lower case letter.
 *
 * BigI -> big-i
 * BigEYE -> big-eye
 * BigIFood -> big-i-food
 * BigEYEFood -> big-eye-food
 */
export function camelCasedToDashedReversibly (s: string,
					      firstLetterIsConventionallyUpcased: boolean=false): string {
  let out = '';
  let sLen = s.length;
  for (let j=0; j<sLen; j++) {
    let c = s.charAt (j);
    let isUpper = isUpperCaseChar (c);
    let prefixWithDash = isUpper;
    if (j==0 && firstLetterIsConventionallyUpcased)
      prefixWithDash = !prefixWithDash;
    if (prefixWithDash)
      out += '-';
    out += isUpper ? c.toLowerCase () : c;
  }
  return out;
}

/**
 * Replace every dash-letter pair with an upcased letter.
 *
 * i.e.:
 *    hello-there -> helloThere
 *
 * This is a common requirement of XML/Java systems, where XML names
 * often may contain dash characters, while Java systems can not.
 *
 * If the source material contains an uppercase letter, it is copied through.
 *
 * @param s - the string to be camel-cased
 * @param capitalize - true iff the resulting string should be capitalized.
 **/
export function camelCase (s: string, capitalize: boolean=false): string {
  let out = '';
  let upcaseNext = capitalize;
  let sLen = s.length;
  for (let j=0; j<sLen; j++) {
    let c = s.charAt (j);
    if (c == '-') {
      upcaseNext = true;
    } else {
      if (upcaseNext)
	c = c.toUpperCase ();
      upcaseNext = false;
      out += c;
    }
  }
  return out;
}

/**
 * Camel case to dashed.
 *
 * Converts strings in camel case format to a dashed format.
 *
 * The complicated case is multiple adjacent upper case letters.  For example
 * converting ICBMSilo to i-c-b-m-silo is gross.
 *
 * The heuristic we are presently using would convert this to:
 *
 * icbm-silo
 *
 * We define a word as starting at the beginning of the string or with the
 * last upper case letter of an upper case sequence.
 *
 * Examples:
 *
 * catFood -> cat-food
 * ICBMSilo -> icbm-silo

 * isWordStart = upper case letter followed by a lower case letter, or first upper case letter after a lower case letter.
 *
 * BigI -> big-i
 * BigEYE -> big-eye
 * BigIFood -> big-i-food
 * BigEYEFood -> big-eye-food
 */
export function camelCasedToDashedFancily (s: string): string {

  let out = '';
  let pos = 0;
  let len = s.length;

  for (let pos=0; pos<len; pos++) {

    let c = s.charAt (pos);
    
    let isWordStart =
	  pos === 0 ||
	  (isUpperCaseChar (c) &&
	   ((pos-1>0 && !isUpperCaseChar (s.charAt (pos-1))) ||
	    (pos+1<len && !isUpperCaseChar (s.charAt (pos+1)))));

    if (isWordStart && pos > 0)
      out += '-';

    out += c.toLowerCase ();
  }

  return out;
}

// ----------------------------------------------------------------------------------
// --- Escaping ---------------------------------------------------------------------
// ----------------------------------------------------------------------------------

// encode64 - base64 encoding
export function encode64 (s: string) {
  if (window && window.btoa)
    return window.btoa (s);
  else
    throw new Error('This browser does not have a native btoa and our fallback is not implemented yet');
}


// JS string literal escaping.
// XXX needs more unicode support.
var unsafeJsStringLiteralCharRegex = new RegExp('[\'"\\n\\r\\t\\\\]', 'g');
var unsafeJsStringLiteralCharToEscaped: {[lit:string]:string} = {
  "'": "\\'",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\\": "\\\\"
};

export function escapeJsStringLiteral (v: string): string {
  if (!unsafeJsStringLiteralCharRegex.test(v)) return v;
  else return v.replace(unsafeJsStringLiteralCharRegex, c => unsafeJsStringLiteralCharToEscaped[c]);
}


// Html Attribute escaping.
var unsafeHtmlAttrCharRegex = new RegExp('[<>\'"&\\n\\r]', 'g');
var unsafeHtmlAttrCharToEscaped: {[c:string]:string} = {
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "\n": "&#13;",
  "\r": "&#10;"
};

export function escapeHtmlAttr (v: string) {
  if (!unsafeHtmlAttrCharRegex.test(v)) return v;
  else return v.replace(unsafeHtmlAttrCharRegex, (c) => unsafeHtmlAttrCharToEscaped[c]);
}

// Html Text escaping
var unsafeHtmlTextCharRegex = new RegExp('[<&]', 'g');
var unsafeHtmlTextCharToEscaped: {[c:string]:string} = {
  "<": "&lt;",
  "&": "&amp;",
};

export function escapeHtmlText (v: string): string {
  if (!unsafeHtmlTextCharRegex.test(v)) return v;
  else return v.replace(unsafeHtmlTextCharRegex, (c) => unsafeHtmlTextCharToEscaped[c]);
}

// --------------------------------------------------------------------------
// --- Identifiers ----------------------------------------------------------
// --------------------------------------------------------------------------

/**
 *
 * XXX should internationalize
 * XXX should rename to indicate what kind of identifier we are talking about
 * XXX probably should add in $
 */
// XXX somewhat creeped out by using a regex in a var because it's
//     state is modified on use.
var identifierRegex = /^[A-Za-z_][A-Za-z_0-9]*$/;

export function isIdentifier (name: string) {
  return !!name.match (/^[A-Za-z_][A-Za-z_0-9]*$/);
}

/**
 *
 */
//const isES2016IdentifierRegex = XRegExp (`^\\p{ID_Start}\\p{ID_Continue}*$`, 'x');
// WRONG: the above version should work as XRegExp is updated to unicode 9 (+ similar
//        syntax is coming to ES native), our current impl is only supporting
//        ASCII identifiers.
const isES2016IdentifierRegex = XRegExp (`^[A-Za-z_$][A-Za-z_$0-9]*$`, 'x');

export function isES2016Identifier (id: string) {
    return id != null && typeof id == 'string' && isES2016IdentifierRegex.test (id);
};

// ------------------------------------------------------------------------
// --- Fun with whitespace ------------------------------------------------
// ------------------------------------------------------------------------

export function ord (c:string) { return c.charCodeAt (0); }

export function removeEndOfLineSpaces (s: string) { 
  return s.replace(/[ \t]*\n/g, '\n');
}

export function removeTrailingNewlines (s: string) { 
  return s.replace(/\n+$/, '');
}

export function normalizeToOneEndingNewline (s: string) {
  return /[^\n]\n$/.test(s) ? s : (s+'\n').replace(/\n+$/, '\n');
}

/**
 * Takes a String that is delimited into lines using one of the various ways
 * that are in common usage and converts them to LF delimited.
 *
 * Make them be normal.  Normal is good.
 *
 * Also: last line is made to end with a newline (if it does not already)
 *
 * Newline conventions:
 *   LF (Unix + Modern PC/MAC)
 *   CR (Legacy Macintosh Format)
 *   CR LF (Legacy Windows/DOS Format)
 */
export function normalizeNewlines (s: string) { 
  s = s.indexOf ('\r') ? s.replace(/\r\n?/g, '\n') : s;
  if(!s.endsWith('\n'))
    s = s + '\n';
  return s;
}

// // Efficiently count the number of newline characters in a string.  If the string
// // is \r delimited, this will not work (DOS style \r\n will be fine however).
// export function countNewlines (s: string) { return countMatches (s, '\n'); }

/**
 * Returns whether a string is all whitespace.
 *
 * An empty string is defined as being all whitespace.
 */
export function isAllWhitespace (s: string) {
  return s === '' || /^[ \r\n\t]*$/m.test (s);
}

const whitespaceRegex = new RegExp('^[ \r\n\t]*$');

// Returns whether the string consists entirely of whitespace characters (or is the empty string).
export function isWhitespaceString (s:string) {
    return whitespaceRegex.test (s);
}


/**
 * Simple tab expansion that replaces each tab with 8 space characters.
 * Does not respect tab stops.
 * Our use cases involve all tabs being leading tabs - so it works out the
 * same as the tab stop version - but should do for real.
 */
export function expandTabs (s: string) {
  return s.indexOf ('\t') === -1 ? s : s.replace (/\t/g, '        ');
}

/**
 *
 */
export function countLeadingSpaces (s: string) {
  let firstNonWhitespaceCharIndex = s.search (/[^ ]/);
  return firstNonWhitespaceCharIndex === -1 ? s.length : firstNonWhitespaceCharIndex;
}

/**
 * Strip up to 'maxSpaceCount' leading spaces from a string.
 */
export function stripLeadingSpaces (s: string, maxSpaceCount: number) {
  let leadingSpaceCount = countLeadingSpaces (s);
  let toStripCount = Math.min (leadingSpaceCount, maxSpaceCount);
  return s.substring (toStripCount);
}

/**
 * Template hander funcation that removes common leading whitespace
 * from every line in a text.
 *
 * The amount to dedent is taken from the first line with a
 * non-whitespace character.
 *
 * Leading and trailing all whitespace lines are removed.
 *
 * Tabs are expanded to 8 space characters.
 */
export function dedentString (text: string, stripLinePrefix:string|null = null):string {

  // --- Split into lines
  let lines = text.split ('\n');

  // --- Expand tabs on all lines
  lines = lines.map (expandTabs);

  // --- Optionally strip linePrefix
  //     (a line prefix is sometimes used to prevent a text editor from doing
  //     wonky auto indent on code blocks)
  if(stripLinePrefix !== null) {
    lines = lines.map(v=>v.startsWith(stripLinePrefix) ? v.substring(stripLinePrefix.length) : v);
  }

  
  // --- Find index of first non whitespace line
  let firstNonWhitespaceLineIndex = lines.findIndex (v=>!isAllWhitespace (v));

  // --- If there are no non-whitespace lines, return empty string.
  if (firstNonWhitespaceLineIndex === -1)
    return '';

  // --- Strip leading whitespace lines
  lines = lines.slice (firstNonWhitespaceLineIndex);

  // --- Strip trailing all whitespace lines
  let trailingAllWhitespaceLineCount = 0;
  for (;trailingAllWhitespaceLineCount < lines.length &&
       isAllWhitespace (lines[lines.length-1-trailingAllWhitespaceLineCount]);
       trailingAllWhitespaceLineCount++);
  lines = lines.slice (0, lines.length-trailingAllWhitespaceLineCount);

  // --- Dedent amount is the amount of whitespace in the first non-whitespace line
  let firstLine = lines[0];
  let spaceCountToStrip = countLeadingSpaces (firstLine);

  // --- Strip superfluous leading spaces from each line
  if (spaceCountToStrip > 0)
    lines = lines.map (l=>stripLeadingSpaces (l, spaceCountToStrip));

  // --- Merge lines back into one big happy string
  //     (note that we always end up putting a newline at end even if src did not have one)
  return lines.join ('\n') + '\n';
}

//let dedentCache = new Map<Object,string> ();

/**
 * Dedent template handler.
 *
 * TODO: make a version of this that does the dedenting to TemplateStringsArray
 * and memoizes the work.
 */
export function dedent (strings: TemplateStringsArray, ...values: any[]) {
  return dedentString (mergeTemplate (strings, values));
}

export function dedentBlock (strings: TemplateStringsArray, ...values: any[]) {
  return dedentString (mergeTemplate (strings, values), '/**/');
}

export function block (strings: TemplateStringsArray, ...values: any[]) {
    return dedentString (mergeTemplate (strings, values), '/**/');
}

// /**
//  * Dedent template handler.
//  *
//  * Uses a dedent cache to memoize dedents.  There is no issue with cache size -
//  * is 1-1 with template strings in the source code.
//  *
//  * ON WEED WHEN I WROTE THIS ONE - MEMOZING IS NOT VALUES AWARE ...
//  */
// export function dedentBUSTED (strings: TemplateStringsArray, ...values: any[]) {
//   let dedented = dedentCache.get (strings);
//   if (!dedented) {
//     dedented = dedentString (mergeTemplate (strings, values));
//     dedentCache.set (strings, dedented);
//   }
//   return dedented;
// }

/**
 * A template hander function that merges subsitutions into the
 * template string.
 *
 * This is the same as if you did not use a template handler - so it is not
 * useful on it own, but is used as a step in custom template handlers that
 * want to work with the merged string.
 * 
 * From: http://exploringjs.com/es6/ch_template-literals.html
 * By: Dr. Axel Rauschmayer
 */
export function mergeTemplate (tmplStrs: ReadonlyArray<string>, substs: any[]) : string {
  // There is always at least one element in tmplStrs (as per ES2016 spec)
  let result = tmplStrs[0];
  substs.forEach((subst, i) => {
    result += String(subst);
    result += tmplStrs[i+1];
  });
  return result;
}

/**
 * Prepends a supplied indent string to every line of the source string.
 * The indent string does not have to be whitespace.
 */
export function indentString (text: string, indent: string) {
  return text.split ('\n').map (l=>indent+l).join ('\n') + '\n';
}


// ---------------------------------------------------------------------------------
// --- Misc Junk -------------------------------------------------------------------
// ---------------------------------------------------------------------------------

/**
 * Parse a string to a boolean supporting the most common conventions.
 *
 * (Used for crappy situations like parsing CSV)
 */
export function parseBoolean(s: string): boolean|undefined {
    let l = s.toLowerCase();
    switch(l) {
        case '1':
        case 'true':
        case 't':
        case 'yes':
        case 'y':
            return true;
        case '0':
        case 'false':
        case 'f':
        case 'no':
        case 'n':
            return true;
        default:
            return undefined;
    }
}
