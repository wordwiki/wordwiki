import * as markup from '../tabula/markup.ts';
import * as templates from './templates.ts';
import {Rabid} from './rabid.ts';
import {Markup} from '../tabula/markup.ts';
import {Page} from './page.ts';
import {Event} from './event.ts';

/**
 *
 */
export class Home extends Page {
    constructor(rabid: Rabid) {
        super(rabid);
    }

    title(): string {
        return "Rabid - The Red Raccoon Volunteer System";
    }

    body(): Markup {
        return [
            ['h1', {}, this.title()],

            ['br', {}],

            ['h3', {}, 'Volunteers'],
            this.rabid.volunteer.tableRenderer().renderTable(this.rabid.volunteer.volunteersByName()),

            ['h3', {}, 'Events'],
            this.rabid.event.tableRenderer().renderTable(this.rabid.event.allEvents()),
            ['h3', {}, 'Event List'],

            this.renderEventList(),
            
            //this.rabid.volunteer.renderAllVolunteers(),
            
            //['h3', {}, 'Search'],
            //this.searchForm(),
            // --- Add new entry button
            // ['div', {},
            //  ['button', {onclick:'imports.launchNewLexeme()'}, 'Add new Entry']],

            ['br', {}],
            ['h3', {}, 'Reports'],
            ['ul', {},
             ['li', {}, ['a', {href:'/ww/wordwiki.categoriesDirectory()'}, 'Entries by Category']],
             ['li', {}, ['a', {href:'/ww/wordwiki.entriesByPDMPageDirectory()'}, 'Entries by PDM Page']],
             ['li', {}, ['a', {href:'/ww/wordwiki.todoReport(null, null)'}, 'TODO Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.entriesByTwitterPostStatus()'}, 'Twitter Post Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.entriesByPronunciation()'}, 'Entries By Pronunciation']],
             //['li', {}, ['a', {href:'/ww/wordwiki.entriesByEnglishGloss()'}, 'Entries by English Gloss']],
            ],

            ['br', {}],
            ['h3', {}, 'Reference Books'],
            ['ul', {},
             ['li', {}, ['a', {href:`/ww/pageEditor("PDM")`}, 'PDM']],
             ['li', {}, ['a', {href:`/ww/pageEditor("Rand")`}, 'Rand']],
             ['li', {}, ['a', {href:`/ww/pageEditor("Clark")`}, 'Clark']],
             ['li', {}, ['a', {href:`/ww/pageEditor("PacifiquesGeography")`}, 'PacifiquesGeography']],
             ['li', {}, ['a', {href:`/ww/pageEditor("RandFirstReadingBook")`}, 'RandFirstReadingBook']]],
        ];
    }

    renderEventList(): Markup {
        const events = this.rabid.event.allEvents();
        return [
            ['ul', {'class': '-event-'},
             events.map(event=>[

                 ['li', {'class': `-event-${event.event_id}-`},
                  event.description, ' - ', event.start_time,
                  this.renderCommittmentsForEvent(event.event_id),
                 ] // li
                 
             ])
            ] // ul
        ];
    }

    renderCommittmentsForEvent(event_id: number): Markup {
        const committments =
            this.rabid.event_commitment.getCommitmentsForEventWithVolunteerName(event_id);

        // Add menu to add/remove from 
        
        return committments.map(v=>v.volunteer_name).join(', ');
    }
}
