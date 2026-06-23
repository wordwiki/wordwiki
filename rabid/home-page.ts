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
    return [h.div, {class: 'container py-3'},
        [h.h2, {}, title],

        [h.br, {}],

        //[h.h3, {}, 'Upcoming Events'],
        rabid.event.renderUpcomingEvents(),

        [h.h3, {}, 'Your recent activity'],
        //rabid.volunteer.timesheet_entry.renderRecentActivity(0),

        [h.h3, {}, 'Volunteers'],
        rabid.volunteer.renderSearchableVolunteers(),

        // Standard editable-item list (a standin like the volunteer section -
        // this page will grow into structured summaries).  Replaces both the
        // old generic column table and the scratch <ul> event list.
        [h.h3, {}, 'Events'],
        rabid.event.renderEventList(rabid.event.allEvents.all()),
    ];
}
