import * as markup from '../liminal/markup.ts';
import * as templates from './templates.ts';
import {Rabid, rabid} from './rabid.ts';
import {Markup, h} from '../liminal/markup.ts';
import {Page} from './page.ts';
import {Event} from './event.ts';
import {serializeAny} from '../liminal/serializable.ts';
import {TableView} from '../liminal/table.ts';
import * as passwordUtils from '../liminal/password.ts';

export function home(): Markup {
    const title = "Rabid - The Red Raccoon Volunteer System"
    return [
        [h.h1, {}, title],

        [h.br, {}],

        //[h.h3, {}, 'Upcoming Events'],
        rabid.event.renderUpcomingEvents(),

        [h.h3, {}, 'Your recent activity'],
        //rabid.volunteer.timesheet_entry.renderRecentActivity(0),
        
        [h.h3, {}, 'Volunteers'],
        rabid.volunteer.renderSearchableVolunteers(),

        [h.h3, {}, 'Events'],
        rabid.event.tableView.render(),
        //rabid.event.
        //rabid.event.tableRenderer().renderTable(rabid.event.allEvents()),
        [h.h3, {}, 'Event List'],

        renderEventList(),
    ];
}


export function renderEventList(): Markup {
    const events = rabid.event.allEvents.all();
    return [
        [h.ul, {'class': '-event-'},
         events.map(event=>[

             [h.li, {'class': `-event-${event.event_id}-`},
              event.description, ' - ', event.start_time,
              renderCommittmentsForEvent(event.event_id),
             ] // li
             
         ])
        ] // ul
    ];
}

export function renderCommittmentsForEvent(event_id: number): Markup {
    // const committments =
    //     rabid.event_commitment.getCommitmentsForEventWithVolunteerName(event_id);
    const commitmentsClosure =
        rabid.event_commitment.commitmentsForEventWithVolunteerName.closure({event_id});

    //console.info('CC SER', serializeAny(commitmentsClosure));
    const commitments = commitmentsClosure.all();
    //console.info('COMMITMENTS', serializeAny(commitments));
    
    //console.info(rabid.event_commitment.cat);
    // Add menu to add/remove from 
    
    return commitments.map(v=>v.volunteer_name).join(', ');
}
