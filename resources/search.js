/**
 *
 */


/*
TODO:
- hide/show search instructions.
- think about confusion with short searches
   - useles to show results on one or two letter anyway.
   - instructions are key.
   - need micmac and english instructions.
- add top image from current about us page.



*/



var pageLoadStartTime = +new Date();

var allSearchTerms = [];

/**
 * The currently active search.
 */
let currentSearch = '';

/**
 * Updates the current search from the URL
 *
 * Note: This is called during page load, before the word list is rendered
 * using an inline script tag.  This allows the filtered word list to
 * be incrementally rendered.
 */
function updateCurrentSearchFromDocumentHash() {
    let encodedActiveSearch = document.location.hash;
    if(encodedActiveSearch) {
        if(encodedActiveSearch.startsWith('#'))
            encodedActiveSearch = encodedActiveSearch.substring(1);
        let activeSearch = decodeURIComponent(encodedActiveSearch);
        console.info('active search', activeSearch);
        document.getElementById('search').value = activeSearch;
        updateCurrentSearchFromInput();
    }
}

/**
 * Updates the current search from the search input field.
 *
 * Note: Reads the current input field value, rather than using the event
 * contents so that intermediate updates will be skipped if we get
 * events faster than we can process them.
 */
function updateCurrentSearchFromInput() {
    let searchField = document.getElementById("search");
    if(!searchField)
        throw new Error("Unable to find search-field");
    let updatedSearch = searchField.value;
    if(updatedSearch != currentSearch) {
        updateCurrentSearch(updatedSearch);
        document.location.hash = encodeURIComponent(updatedSearch);
    }
}

/**
 * Updates the currently active search.
 */
function updateCurrentSearch(updatedSearch) {
    // --- If search is same as current - nothing to do.
    //     (this happens when we get a pileup of events)
    if(updatedSearch == currentSearch)
        return;
    
    currentSearch = updatedSearch;
    updateSearchResults(updatedSearch);
}

/**
 *
 */
function updateSearchResults(normalizedSearch) {
    let searchSelector = computeSelectorForSearch(normalizedSearch);

    // --- Show search instructions when we have no results
    let searchInstructionsElement = document.getElementById("searchInstructions");
    if(searchInstructionsElement != null) {
        let instructionsDisplayMode = searchSelector == emptySearchSelector ? "block" : "none";
        if (searchInstructionsElement.style.display != instructionsDisplayMode)
            searchInstructionsElement.style.display = instructionsDisplayMode;
    }

    // --- Update search results
    updateSearchSelector(searchSelector);
}

let emptySearchSelector = '_search_';


/**
 *
 */
function computeSelectorForSearch(search) {

    // --- Leading words are whole word terms, and the final word
    //     is expanded to all possibilities.  If the seach ends with
    //     a space, then all words are whole words.
    let fullWordTerms;
    let finalTerm;
    let searchTerms = search.trim().split(/[ ]+/);
    if(search.endsWith(' ')) {
        fullWordTerms = searchTerms;
        finalTerm = null;
    } else {
        fullWordTerms = searchTerms.slice(0, searchTerms.length-1);
        finalTerm = searchTerms[searchTerms.length-1];
    }

    console.info('normalizedSearch=', search, 'fullWordTerms=', fullWordTerms.join(','), 'finalTerm=', finalTerm);

    let selector;
    if(fullWordTerms.length == 0 && !finalTerm) {
        selector = emptySearchSelector;
    } else {
        selector = 'li';
    
        if(fullWordTerms.length > 0)
            selector += '.'+fullWordTerms.map(t=>normalizeSearchWord(t)).join('.');

        if(finalTerm != null) {
            let expandedFinalTerm = expandSearch(finalTerm, fullWordTerms.length>0?1:3);
            selector = expandedFinalTerm.map(s=>selector+'.'+s).join(', ');
        }
    
        if(!selector)
            selector = emptySearchSelector;
        else
            selector = '_search_, '+selector;
    }

    console.info('computed selector', selector);
    
    return selector;
}
 
/**
 * Given a search prefix, expands to the list of all words that start with
 * that prefix.  For searches less than 2 characters long, no expansion is
 * done (to avoid pontless over-long expansions).
 *
 * If the string ends with a space, it is an entire word search, and we don't
 * do prefix expansions.
 *
 * If there are multiple words, the first word must match exactly, and we do
 * stemming for subsequent words.
 *
 * '*' is a replacement for a any sequence of characters.
 */
function expandSearch(search, minLength=3) {
    search = normalizeSearchPattern(search);
    if(search.length === 0) {
        // --- Empty search gives no results
        return [];
    } else if(search.length < minLength) {
        // --- Need more than 2 characters before willing to do anything other than exact search.
        //     (no regex, no stemming) this prevents common blow up cases that make things groggy
        //     as you are typing in a search.
        return [search];
    } else if(/[\[\]*?]/.test(search)) {
        // --- Is a pattern search, convert to a regex.  Note that pattern searches (deliberately) lose
        //     the (otherwise) implicit * at the end of the search (if you are using explicit pattern
        //     characters, we drop the implicit one at the end).
        let searchRegexExpr = '^'+search.replace(/[?]/g, '.').replace(/[*]/g, '.*')+'$';
        let searchRegex;
        try {
            searchRegex = new RegExp(searchRegexExpr);
        } catch (e) {
            console.info('malformed search regex', searchRegexExpr);
            return [];
        }
        let matches = allSearchTerms.filter(w=>searchRegex.test(w));
        console.info('for search regex', searchRegex, 'got matches', matches);
        return matches;
    } else {
        // --- Normal prefix search
        return allSearchTerms.filter(w=>w.startsWith(search));
    }
}

/**
 * Normalize Search word
 */
function normalizeSearchWord(search) {
    return search.toLowerCase().replace(/[^A-Za-z0-9]/g, '_');
}

/**
 * Normalize Search pattern
 */
function normalizeSearchPattern(search) {
    return search.toLowerCase().replace(/[^A-Za-z0-9*\[\]?]/g, '_');
}

/**
 *
 */
function updateSearchSelector(searchSelector) {
    for(let stylesheet of document.styleSheets) {
        for(let rule of stylesheet.cssRules) {
            //console.info('rule.type', rule.type, 'rule.selectorText', rule.selectorText);
            if(rule.selectorText && rule.selectorText.indexOf('_search_') != -1) {
                rule.selectorText = searchSelector;
                console.info('updated selector text to', searchSelector);
                let normalizedSearchSelector = searchSelector.replace(/ /g, '');
                let normalizedAppliedSearchSelector = rule.selectorText.replace(/ /g, '');
                if(normalizedSearchSelector != normalizedAppliedSearchSelector) {
                    console.info(' set search selector to:', normalizedSearchSelector);
                    console.info(' but CSSOM converted to:', normalizedAppliedSearchSelector);
                }
                return;
            }
        }
    }
    throw new Error('Failed to update search selector');
}
