#include "to_rust_identifier.hpp"
#include "duckdb/common/unique_ptr.hpp"
#include "catch.hpp"

using namespace entropy;

TEST_CASE("Valid Rust Identifiers", "[to_rust_identifier]") {
    SECTION("Basic valid identifiers") {
        REQUIRE(IsRustIdentifier("foo"));
        REQUIRE(IsRustIdentifier("_foo"));
        REQUIRE(IsRustIdentifier("foo_bar"));
        REQUIRE(IsRustIdentifier("foo123"));
        REQUIRE(IsRustIdentifier("_123"));
    }

    SECTION("Invalid Rust identifiers") {
        // Empty string
        REQUIRE_FALSE(IsRustIdentifier(""));

        // Just underscore (reserved)
        REQUIRE_FALSE(IsRustIdentifier("_"));

        // Starting with a number
        REQUIRE_FALSE(IsRustIdentifier("123foo"));

        // Special characters
        REQUIRE_FALSE(IsRustIdentifier("foo-bar"));
        REQUIRE_FALSE(IsRustIdentifier("foo.bar"));
        REQUIRE_FALSE(IsRustIdentifier("foo bar"));
        REQUIRE_FALSE(IsRustIdentifier("*foo"));

        // Keywords
        REQUIRE_FALSE(IsRustIdentifier("if"));
        REQUIRE_FALSE(IsRustIdentifier("let"));
        REQUIRE_FALSE(IsRustIdentifier("struct"));
        REQUIRE_FALSE(IsRustIdentifier("Self"));
        REQUIRE_FALSE(IsRustIdentifier("async"));
        REQUIRE_FALSE(IsRustIdentifier("try"));
    }
}

TEST_CASE("Escaping Rust Identifiers", "[to_rust_identifier]") {
    SECTION("Valid identifiers are unchanged") {
        REQUIRE(ToRustIdentifier("foo") == "foo");
        REQUIRE(ToRustIdentifier("_foo") == "_foo");
        REQUIRE(ToRustIdentifier("foo_bar") == "foo_bar");
    }

    SECTION("Keywords") {
        REQUIRE(ToRustIdentifier("if") == "__if");
        REQUIRE(ToRustIdentifier("let") == "__let");
        REQUIRE(ToRustIdentifier("struct") == "__struct");
        REQUIRE(ToRustIdentifier("async") == "__async");
    }

    SECTION("Underscore handling") {
        // Just underscore (reserved in rust)
        REQUIRE(ToRustIdentifier("_") == "__underscore");

		// Regular single underscores left alone
        REQUIRE(ToRustIdentifier("_b") == "_b");
        REQUIRE(ToRustIdentifier("a_") == "a_");
        REQUIRE(ToRustIdentifier("a_b") == "a_b");
        REQUIRE(ToRustIdentifier("a_b_") == "a_b_");

		// Double underscore PAIRS are encoded as the word "__uu_"
		// (scheme fix 2026-07-25: the old "___" encoding collided - see below)
        REQUIRE(ToRustIdentifier("__b") == "__uu_b");
        REQUIRE(ToRustIdentifier("a__") == "a__uu_");
        REQUIRE(ToRustIdentifier("a__b") == "a__uu_b");
        REQUIRE(ToRustIdentifier("a___b___") == "a__uu__b__uu__");

		// Triple etc underscores: pairs left-to-right, then the odd single passes through
        REQUIRE(ToRustIdentifier("___a___b___") == "__uu__a__uu__b__uu__");
        REQUIRE(ToRustIdentifier("____a____b____") == "__uu___uu_a__uu___uu_b__uu___uu_");
	}

    SECTION("Injectivity regressions (the old ___ pair-encoding collided)") {
        // Under the previous scheme BOTH sides of each pair encoded to the
        // same string (e.g. "___dash_") - the doc-comment's iff property
        // failed exactly here.
        REQUIRE(ToRustIdentifier("_-") == "___dash_");
        REQUIRE(ToRustIdentifier("__dash_") == "__uu_dash_");
        REQUIRE(ToRustIdentifier("_-") != ToRustIdentifier("__dash_"));
        REQUIRE(ToRustIdentifier("a_-b") == "a___dash_b");
        REQUIRE(ToRustIdentifier("a__dash_b") == "a__uu_dash_b");
        REQUIRE(ToRustIdentifier("a_-b") != ToRustIdentifier("a__dash_b"));
        REQUIRE(ToRustIdentifier("x_!") != ToRustIdentifier("x__bang_"));
    }

    SECTION("Invalid identifiers are escaped properly") {
        // Empty string
        REQUIRE(ToRustIdentifier("") == "__empty");

        // Starting with a number
        REQUIRE(ToRustIdentifier("123foo") == "__123foo");

        // Special characters
        REQUIRE(ToRustIdentifier("foo-bar") == "foo__dash_bar");
        REQUIRE(ToRustIdentifier("foo.bar") == "foo__dot_bar");
        REQUIRE(ToRustIdentifier("foo bar") == "foo__space_bar");
        REQUIRE(ToRustIdentifier("*foo") == "__star_foo");

        // Multiple special characters
        REQUIRE(ToRustIdentifier("***") == "__star___star___star_");
        REQUIRE(ToRustIdentifier("a+b=c") == "a__plus_b__eq_c");
    }

    SECTION("Bulk cases (without confirming explicit encoding)") {
        // Check that any escaped identifier is always valid
        std::vector<std::string> test_cases = {
            "", "_", "123", "foo-bar", "*&^%", "if", "let", "a + b = c",
            "___", "***", "!@#$%^&*()_+{}|:<>?", "x²", "你好", "квас"
        };

        for (const auto& test : test_cases) {
            std::string escaped = ToRustIdentifier(test);
            INFO("Original: '" << test << "', Escaped: '" << escaped << "'");
            // Allow double underscores in the validation since our escaping uses them
            REQUIRE(IsRustIdentifier(escaped));
        }
    }

    SECTION("Extended cases") {
        // Make sure our escaping handles edge cases
        REQUIRE(IsRustIdentifier(ToRustIdentifier("\n\t\r")));
        REQUIRE(IsRustIdentifier(ToRustIdentifier("r#invalid")));
        REQUIRE(IsRustIdentifier(ToRustIdentifier("_r#keyword")));
    }
}
