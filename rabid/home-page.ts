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

        // (The full event list lives on the /events page now - the home page
        // shows just the upcoming window above.)
    ];
}
