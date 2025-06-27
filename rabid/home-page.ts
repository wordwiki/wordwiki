import * as markup from '../tabula/markup.ts';
import * as templates from './templates.ts';
import {Rabid, rabid} from './rabid.ts';
import {Markup} from '../tabula/markup.ts';
import {Page} from './page.ts';
import {Event} from './event.ts';

export function home(): Markup {
    const title = "Rabid - The Red Raccoon Volunteer System"
    return [
        ['h1', {}, title],

        ['br', {}],

        ['h3', {}, 'Volunteers'],
        rabid.volunteer.tableRenderer([rabid.volunteer.fieldsByName.name, rabid.volunteer.fieldsByName.email, rabid.volunteer.fieldsByName.phone]).renderTable(rabid.volunteer.volunteersByName()),

        ['h3', {}, 'Events'],
        rabid.event.tableRenderer().renderTable(rabid.event.allEvents()),
        ['h3', {}, 'Event List'],

        renderEventList(),
    ];
}

export function renderEventList(): Markup {
    const events = rabid.event.allEvents();
    return [
        ['ul', {'class': '-event-'},
         events.map(event=>[

             ['li', {'class': `-event-${event.event_id}-`},
              event.description, ' - ', event.start_time,
              renderCommittmentsForEvent(event.event_id),
             ] // li
             
         ])
        ] // ul
    ];
}

export function renderCommittmentsForEvent(event_id: number): Markup {
    const committments =
        rabid.event_commitment.getCommitmentsForEventWithVolunteerName(event_id);

    // Add menu to add/remove from 
    
    return committments.map(v=>v.volunteer_name).join(', ');
}
