// --------------------------------------------------------------------------
// --- Character Classes
// --------------------------------------------------------------------------

// XXX nice thing to add here would be an exclusive version fo char code in the lower
// few bits (space OR name char OR operator) etc - this allows parsers to be
// written using switch statements.

/*
export enum CharClass {
  XmlNameStartChar = 0x01,
  XmlNameChar = 0x02,

  SpaceChar = 0x04,

  //XmlTextNeedsUnescapingChar = 0x04,
  //XmlTextNoBraceChar = 0x02,
  //XmlTextNoBraceNeedsUnescapingChar = 0x04,
  //XmlAttrChar = 0x04
}
*/

// Copy the char class defs into exports and the local scope to save on
// indirections.
export var XmlNameStartChar = 0x01;
export var XmlNameChar = 0x02;
export var SpaceChar = 0x04;

export function isXmlNameStartCharCode (c:number) { return charClasses[c] & XmlNameStartChar; }
export function isXmlNameCharCode (c:number) { return charClasses[c] & XmlNameChar; }
export function isSpaceCharCode (c:number) { return charClasses[c] & SpaceChar; }

var whitespaceRegex = new RegExp('^[ \r\n\t]*$');

// Returns whether the string consists entirely of whitespace characters (or is the empty string).
export function isWhitespaceString (s:string) {
  return whitespaceRegex.test (s);
}

export function ord (c:string) { return c.charCodeAt (0); }

function createCharClassesLookup () {

  var charClasses: number[] = [];
  for (var i=0; i<65536; i++)
    charClasses.push(0);

  function register (charClass:number, from:number, to:number=from) {
    for (var i=from; i<=to; i++)
      charClasses[i] |= charClass
  }

  function nameStartChar (from:number, to:number=from) {
    register(XmlNameStartChar|XmlNameChar, from, to);
  }

  function nameChar (from:number, to:number=from) {
    register(XmlNameChar, from, to)
  }

  function spaceChar (from:number, to:number=from) {
    register(SpaceChar, from, to);
  }

  // XmlNameStartChar ::= ":" | [A-Z] | "_" | [a-z] | [#xC0-#xD6] |
  //   [#xD8-#xF6] | [#xF8-#x2FF] | [#x370-#x37D] | [#x37F-#x1FFF] |
  //   [#x200C-#x200D] | [#x2070-#x218F] | [#x2C00-#x2FEF] |
  //   [#x3001-#xD7FF] | [#xF900-#xFDCF] | [#xFDF0-#xFFFD] |
  //   [#x10000-#xEFFFF]

  nameStartChar(ord(':'));
  nameStartChar(ord('A'), ord('Z'));
  nameStartChar(ord('_'));
  nameStartChar(ord('a'), ord('z'));
  nameStartChar(0xC0, 0xD6);
  nameStartChar(0xD8, 0xF6);
  nameStartChar(0xF8, 0x2FF);
  nameStartChar(0x370, 0x37D);
  nameStartChar(0x37F, 0x1FFF);
  nameStartChar(0x200C, 0x200D);
  nameStartChar(0x2070, 0x218F);
  nameStartChar(0x2C00, 0x2FEF);
  nameStartChar(0x3001, 0xD7FF);
  nameStartChar(0xF900, 0xFDCF);
  nameStartChar(0xFDF0, 0xFFFD);
  //nameStartChar(0x10000, 0xEFFFF) XXX sorry - not supported
  // (note that js charCodeAt never returns these anyway - they
  //  are represented as surrogate pairs)

  // XmlNameChar ::= XmlNameStartChar | "-" | "." | [0-9] | #xB7 |
  //   [#x0300-#x036F] | [#x203F-#x2040]
  nameChar(ord('-'));
  nameChar(ord('.'));
  nameChar(ord('0'), ord('9'));
  nameChar(0xB7);
  nameChar(0x0300, 0x036F);
  nameChar(0x203F, 0x2040);

  // S ::= (#x20 | #x9 | #xD | #xA)+
  spaceChar(0x20);
  spaceChar(0x9);
  spaceChar(0xD);
  spaceChar(0xA);

  return charClasses;
}

export var charClasses = createCharClassesLookup ();

