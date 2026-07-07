/**
 *
 *
 */
package org.mikmaqonline;

import org.mikmaqonline.Mmo.Lexeme;
import java.util.regex.*;
import java.util.*;
import com.fasterxml.jackson.annotation.*;

/*
TODO:
- run as replacement transliterator (replacement for current API).

- rules have identity:
   - want a transliteration result to have:
       - source lexeme, output lexeme.
       - each rule that fired with after results for rule.

   "\V" -> vowel
   "\C" -> consonant

   aeiou
   consonant = all others
   apostrphe that is after vowel == long vowel
   apostrphe after a consonant is a swah

 */


public class Transliterate {

  static final Rule rule90 = new RegexRule 
    (90, "change all occurances of [g] to [k]",
     "g", "k");
  static {
    rule90.test ("cgk", "ckk");
  }

  static final Rule rule91 = new RegexRule 
    (91, "change all occurances of [G] to [K]",
     "G", "K");
  static {
    rule91.test ("cgG", "cgK");
  }

  static final Rule rule100 = new RegexRule 
    (100, "/ey/ at the end of all NOUNS should be changed to /ei/",
     "([eE])y$", "$1i") {
      public boolean precondition (String current, Lexeme l) { 
	return l != null && l.isNoun (); 
	// if (l != null && l.isNoun ()) {
	//   System.out.println ("ISNOUN "+current);
	//   return true;
	// }
	// else
	//   return false;
      }
    };
  static {
    rule100.test ("vey", "vei");
    rule100.test ("veyt", "veyt");
  }

  static final Rule rule110 = new RegexRule
    (110, "SUBSTITUTE a SPACE for the underscore symbol [_]",
     "_", " ");
  static {
    rule110.test ("v_y", "v y");
  }

  static final Rule rule120 = new RegexRule
    (120, "REMOVE the apostrophe ['] from [p' t' s' k'] in all locations",
     "([ptskPSTK])'", "$1");
  static {
    rule120.test ("P'pS's'Ta'x'", "PpSsTa'x'");
  }

  static final Rule rule130 = new RegexRule
    (130, "REMOVE the apostrophe ['] from [l' m' n']  when [l' m' n'] occur after a Consonant",
     "(\\C[lmnLMN])'", "$1");
  static {
    rule130.test ("cl'CM'al'", "clCMal'");
  }
		 
  static final Rule rule140 = new RegexRule
    (140, "ADD an apostrophe ['] to [l] when [l] is found at the beginning of a word.",
     "^([lL])(?!')", "$1'");
  static {
    rule140.test ("loll", "l'oll");
    rule140.test ("LoLL", "L'oLL");
    rule140.test ("L'oLL", "L'oLL");
  }

  static final Rule rule150 = new RegexRule
    (150, "Vowel Consonant Schwa Consonant at the end of a word -> Vowel Consonant e Consonant",
     "(\\V\\C)'(\\C)$", "$1e$2");
  static {
    rule150.test ("ac'c", "acec");
    rule150.test ("ac'cc", "ac'cc");
  }
  
  static final Rule rule160 = new RegexRule
    (160, "Remove all of the Schwas across the data set (ie. remove all ['] that occur after a Consonant)",
     "(\\C)'", "$1");
  static {
    rule160.test ("ac'cc", "accc");
    rule160.test ("aA'cc", "aA'cc");
  }

  static final Rule rule170 = new RegexRule
    (170, "Consonant Consonant Consonant -> Consonant Consonant schwa Consonant",
     "(\\C\\C)(\\C)", "$1\u00ce$2");
  static {
    rule170.test ("cCx", "cC\u00cex");
    rule170.test ("acCxa", "acC\u00cexa");
  }

  static final Rule[] activeRules = 
    new Rule [] {rule90, rule91, rule100, rule110, rule120, rule130, rule140, rule150, rule160, rule170};

  public static String rulesSummary () {
    return rulesSummary (activeRules);
  }

  public static String rulesSummary (Rule[] rules) {
    StringBuilder out = new StringBuilder ();
    out.append ("<ul>");
    for (int i=0; i<rules.length; i++) {
      Rule rule = rules[i];
      out.append ("<li><a href='/servlet/dictionary.html?method=searchByTransliterationRule&arg0="+rule.id+"&fs&target=wordFrame'>Rule #"+rule.id+": "+rule.description+"</a>\n");
    }
    out.append ("</ul>");
    return out.toString ();
  }

  /**
   *
   */
  public static Transliteration transliterate (String src, Lexeme lexeme) {
    return transliterate (src, lexeme, activeRules);
  }

  /**
   *
   */
  public static Transliteration transliterate (String src, Lexeme lexeme, Rule[] rules) {
    final ArrayList<RuleApplication> ruleApplications = new ArrayList<RuleApplication> ();
    
    String current = src;
    for (int i=0; i<rules.length; i++) {
      Rule r = activeRules[i];
      String transformed = r.apply (current, lexeme);
      if (!current.equals (transformed)) {
	ruleApplications.add (new RuleApplication (r, current, transformed));
	current = transformed;
      }
    }

    return new Transliteration (src, lexeme, current, 
				ruleApplications.toArray (new RuleApplication[0]));
  }

  /**
   *
   */
  static class Transliteration {
    public final String src;
    public final Lexeme lexeme;
    @JsonProperty()
    public final String transliterated;
    public final RuleApplication[] ruleApplications;

    public Transliteration (String _src, Lexeme _lexeme, 
			    String _transliterated, 
			    RuleApplication[] _ruleApplications) {
      src = _src;
      lexeme = _lexeme;
      transliterated = _transliterated;
      ruleApplications = _ruleApplications;
    }

    public boolean isApplied (int ruleId) {
      for (int i=0; i<ruleApplications.length; i++)
	if (ruleApplications[i].rule.id == ruleId)
	  return true;
      return false;
    }

    public String toSummaryHtml () {
      StringBuilder out = new StringBuilder ();
      out.append ("<ul>");
      for (int i=0; i<ruleApplications.length; i++) {
	out.append ("<li>");
	out.append (ruleApplications[i].toString ().replace ("\u00ce", "&icirc;"));
      }
      out.append ("</ul>");
      return out.toString ();
    }
  }

  /**
   *
   */
  static class RuleApplication {
    public final Rule rule;
    public final String in;
    public final String out;

    public RuleApplication (Rule _rule, String _in, String _out) {
      rule = _rule;
      in = _in;
      out = _out;
    }

    public String toString () {
      return in+" -> "+out+" by application of rule #"+rule.id+": "+rule.description;
    }
  }

  /**
   *
   */
  static abstract class Rule {
    final int id;
    final String description;
    public boolean precondition (String s, Lexeme l) { return true; }

    public Rule (int _id, String _description) {
      id = _id; 
      description = _description;
    }

    String apply (String s, Lexeme l) {
      return precondition (s, l) ? transform(s) : s;
    }

    abstract String transform (String s);

    void test (String input, String expect) {
      String transformed = transform (input);
      if (!expect.equals (transformed))
	throw new RuntimeException ("Rule "+id+" transformed "+input+" to "+transformed+" - expected "+expect);
    }
  }

  /**
   *
   */
  static class RegexRule extends Rule {
    final String from;
    final String expandedFrom;
    final String to;
    final Pattern compiled;

    public RegexRule (int _id, String _description, String _from, String _to) {
      super (_id, _description);
      from = _from;
      expandedFrom = from.
	replace ("\\C", "[a-zA-Z&&[^aeiouAEIOU]]").
	replace ("\\V", "[aeiouAEIOU]");
      to = _to;
      compiled = Pattern.compile (expandedFrom);
    }

    String transform (String s) {
      return compiled.matcher (s).replaceAll (to);
    }
  }


  // --------------------------------------------------------------------------


  // XXX 
  public static String listugujToSmithFrancis (String src)
  { return listugujToSmithFrancisOld (src, "&icirc;"); }

  /*
  ORTHOGRAPHIES - transliteration
  
  In converting Listuguj spellings to Smith-Francis spellings:
   ei at the end of a word becomes ey 
   g becomes k
   g' becomes k barred-i
   m' becomes m barred-i 
   n' becomes n barred-i 
   p' becomes p barred-i 
   s' becomes s barred-i 
   t' becomes t barred-i 

   ([lmn])([lmnt]) => \1'\2

  Same thing for capital letters.

  The html entity reference for the barred-i is &icirc;
  */

  public static String listugujToSmithFrancisOld (String src, 
						  String barredI)
  {
    StringBuffer out = new StringBuffer ();
    int srcLength = src.length ();
    for (int i=0; i<srcLength; i++)
      {
	char c = src.charAt (i);
	char clow = Character.toLowerCase (c);
	char peek1 = i+1 < srcLength ? src.charAt (i+1) : 0;
	char peek1low = i+1 < srcLength ? Character.toLowerCase (peek1): 0;

	if (c == 'e' && i+2 == srcLength && src.charAt (i+1) == 'i')
	  {
	    out.append ('e');
	    out.append ('y');
	    i++;
	  }
	else if (c == 'g')
	  {
	    if (i+1 < srcLength && src.charAt (i+1) == '\'')
	      {
		out.append ('k');
		out.append (barredI);
		i++;
	      }
	    else
	      out.append ('k');
	  }
	else if (c == 'G')
	  {
	    if (i+1 < srcLength && src.charAt (i+1) == '\'')
	      {
		out.append ('K');
		out.append (barredI);
		i++;
	      }
	    else
	      out.append ('K');
	  }
	else if ((c == 'm' || c == 'n' || c == 'p' || c == 's' || c == 't' ||
		  c == 'M' || c == 'N' || c == 'P' || c == 'S' || c == 'T') &&
		 i+1 < srcLength && src.charAt (i+1) == '\'')
	  {
	    out.append (c);
	    out.append (barredI);
	    i++;
	  }
	/*
	else if ((clow == 'l' || clow == 'm' || clow == 'n') &&
		 (peek1low == 'l' || peek1low == 'm' || peek1low == 'n' || 
		  peek1low == 't'))
	  {
	    out.append (c);
	    out.append ('\'');
	  }
        */
	else
	  out.append (c);
      }

    return out.toString ();
  }

  public static void main (String[] args)
  {
    System.out.println (rulesSummary ());
    for (int i=0; i<args.length; i++)
      System.out.println ("\""+args[i]+"\" -> \""+
			  listugujToSmithFrancisOld (args[i], "<BarredI>")+"\"");
  }
}
