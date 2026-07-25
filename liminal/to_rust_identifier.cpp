#include "to_rust_identifier.hpp"
#include <unordered_set>
#include <cctype>
#include <map>
#include <sstream>
#include <stdexcept>

namespace entropy {

// Rust keywords as per https://doc.rust-lang.org/reference/keywords.html (as of rust 1.86, April 2025)
const std::unordered_set<std::string> RustKeywords = {
    // Strict keywords
    "as",
    "break",
    "const",
    "continue",
    "crate",
    "else",
    "enum",
    "extern",
    "false",
    "fn",
    "for",
    "if",
    "impl",
    "in",
    "let",
    "loop",
    "match",
    "mod",
    "move",
    "mut",
    "pub",
    "ref",
    "return",
    "self",
    "Self",
    "static",
    "struct",
    "super",
    "trait",
    "true",
    "type",
    "unsafe",
    "use",
    "where",
    "while",
    // Strict keywords from 2018 edition
    "async",
    "await",
    "dyn",
    // Reserved keywords
    "abstract",
    "become",
    "box",
    "do",
    "final",
    "macro",
    "override",
    "priv",
    "typeof",
    "unsized",
    "virtual",
    "yield",
    // Reserved keywords from 2018 edition
    "try"
};

bool IsRustKeyword(const std::string& identifier) {
    return RustKeywords.find(identifier) != RustKeywords.end();
}

// Reserved identifiers
const std::unordered_set<std::string> ReservedIdentifiers = {
    "_"  // Underscore is reserved
};

// Map of special characters to their word representations
// (make sure that these do not collide with keywords).
// TABLE CONSTRAINTS the injectivity/decodability argument leans on:
//  - words are pure ASCII letters (no digits/underscores);
//  - no word may match ^x[0-9a-f] (would collide with the __x<hex>_ token);
//  - 'uu', 'empty' and 'underscore' are reserved (rules 7/3/4 below).
const std::map<char, std::string> CharToWord = {
    {'*', "star"},
    {'+', "plus"},
    {'-', "dash"},
    {'/', "slash"},
    {'\\', "backslash"},
    {'=', "eq"},
    {'<', "lt"},
    {'>', "gt"},
    {'!', "bang"},
    {'?', "qmark"},
    {'&', "amp"},
    {'|', "pipe"},
    {'@', "at"},
    {'#', "hash"},
    {'$', "dollar"},
    {'%', "percent"},
    {'^', "caret"},
    {'~', "tilde"},
    {'`', "backtick"},
    {'.', "dot"},
    {',', "comma"},
    {';', "semicolon"},
    {':', "colon"},
    {'\'', "quote"},
    {'"', "dquote"},
    {'(', "lparen"},
    {')', "rparen"},
    {'[', "lbracket"},
    {']', "rbracket"},
    {'{', "lbrace"},
    {'}', "rbrace"},
    {' ', "space"}
};

/**
 * Escapes a arbitrary std::string to a valid Rust identifier composed only of ASCII
 * letters, digits, or underscores.
 *
 * For all strings A and B, EscapeRustAsciiIdentifier(A) == EscapeRustAsciiIdentifier(B) iff A == B
 *
 * This is a very important property because we use this for things like transforming
 * user input like SQL field names to rust identifiers, so we must not introduce collisions.
 *
 * Our definition of a valid output Rust identifier is:
 *
 * - Starts with a letter or underscore
 * - Contains only ASCII letters, digits, or underscores
 * - is not a rust keyword.
 * - is not a single underscore (single underscore is reserved in rust)
 *
 * Furthermore, our escaping mechanism uses double underscore to introduce escape
 * sequences, so double underscores in the source identifier will be escaped.
 *
 * The escaping rules are:
 * 1. If the string is already a valid identifier, without any double underscores, it's returned unchanged
 * 2. If the string is a Rust keyword, it's prefixed with "__" (we are not using r# so
 *    we don't have 2 escaping schemes, and so that we can also use escaped names for things
 *    like filenames).
 * 3. If the string is empty, "__empty" is returned
 * 4. If the string is exactly a single underscore, "__underscore" is returned. (rust prohibits
 *    identifiers from being "_").  (This is a separate rule because otherwise single underscores
 *    are not escaped).
 * 5. A digit is escaped with a '__' prefix iff it is the first character of an identifier (
 *    another rust restriction).
 * 6. Otherwise, valid identifier characters (alphanumeric and underscore) are kept as-is
 * 7. Each source double underscore PAIR is escaped as the word "__uu_" (left to right).
 *    [SCHEME FIX 2026-07-25: the previous encoding, "___", VIOLATED the injectivity
 *    property this comment declares: ToRustIdentifier("_-") and ToRustIdentifier("__dash_")
 *    both produced "___dash_" - a literal single '_' could merge with a following
 *    escape's "__" introducer.  Encoding the pair as a WORD means the encoder never
 *    emits two ADJACENT literal underscores, so every "__" in the output begins an
 *    escape token (or is a literal '_' + an introducer, disambiguated by the token
 *    grammar: word names are pure letters, '_'-terminated).  Ported to
 *    liminal/identifier.ts (toJavascriptIdentifier) with the same scheme + a property
 *    test over an adversarial corpus - keep the two implementations rule-for-rule
 *    identical.]
 * 8. Known special characters are replaced with word equivalents (e.g., "-" → "__dash_")
 * 9. Other characters are converted to their hex representation and prefixed with "__" (and
 *    postfixed with "_" for readabilty.
 */
std::string ToRustIdentifier(std::string identifier) {
    // If it's already a valid Rust identifier, return as is
    if (!ContainsRustIdentifierEscapes(identifier) && IsRustIdentifier(identifier)) {
        return identifier;
    }

    // If it's a keyword, prefix with "__"
    if (IsRustKeyword(identifier)) {
        return "__" + identifier;
    }

    // Empty string case (supported so that all strings have an encoding)
    if (identifier.empty()) {
        return "__empty";
    }

    // Special case for just underscore (reserved in Rust)
    if (identifier == "_") {
        return "__underscore";
    }

    // Build the escaped identifier
    std::stringstream result;

    // Determine if we need a special prefix
    bool needs_prefix = false;

    // Check if the first character requires special handling
    if (isdigit(identifier[0])) {
        // Digits cannot start a valid Rust identifier
        needs_prefix = true;
    }

    // Add prefix if needed
    if (needs_prefix) {
        result << "__";
    }

    // Process each character
    for (size_t i = 0; i < identifier.length(); i++) {
        // Check for double underscore sequence (rule 7: escaped as a WORD -
        // see the scheme-fix note above; "___" collided).
        if (i < identifier.length() - 1 && identifier[i] == '_' && identifier[i + 1] == '_') {
            result << "__uu_";
            i++; // Skip the next underscore since we've processed it
            continue;
        }

        char c = identifier[i];

        if (isalnum(c) || c == '_') {
            // Keep valid identifier characters
            result << c;
        } else if (CharToWord.find(c) != CharToWord.end()) {
            // Replace special characters with word equivalents
            // Add "__" prefix for special characters
			// Add "_" suffix for readability
            result << "__" << CharToWord.at(c) << "_";
        } else {
            // For other characters, use hex representation with minimal digits
            int hex_value = static_cast<unsigned char>(c);
            result << "__x" << std::hex << hex_value << "_";
        }
    }

    std::string result_str = result.str();

    // Verify the result is a valid Rust identifier
    if (!IsRustIdentifier(result_str)) {
        throw std::runtime_error("Failed to generate a valid Rust identifier for: " + identifier);
    }

    return result_str;
}

bool ContainsRustIdentifierEscapes(const std::string &identifier) {
    // Check for reserved sequence "__" at any position in the identifier
    // This is reserved for our escaping scheme, so we need to escape identifiers
	// that contain it.
    return identifier.find("__") != std::string::npos;
}

bool IsRustIdentifier(std::string identifier) {
    // Empty identifiers are invalid
    if (identifier.empty()) {
        return false;
    }

    // Reserved identifiers
    if (ReservedIdentifiers.find(identifier) != ReservedIdentifiers.end()) {
        return false;
    }

    // Check keywords
    if (IsRustKeyword(identifier)) {
        return false;
    }

    // First character must be an ASCII letter or underscore
    if (!isalpha(identifier[0]) && identifier[0] != '_') {
        return false;
    }

    // All remaining characters must be ASCII alphanumeric or underscore
    for (size_t i = 1; i < identifier.length(); i++) {
        if (!isalnum(identifier[i]) && identifier[i] != '_') {
            return false;
        }
    }

    return true;
}

}
