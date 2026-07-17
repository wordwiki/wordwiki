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

        // First pane of the (restructured) home: a lean, skimmable list of
        // upcoming public events with a one-tap sign-up - the thing a volunteer
        // is most likely to want at login.  The full week-grouped schedule (with
        // rosters, volunteer-only events, remote prep) lives on /events.
        [h.section, {id: 'upcoming-events', class: 'mb-4'},
         [h.div, {class: 'd-flex align-items-baseline justify-content-between'},
          [h.h3, {class: 'mb-2'}, 'Upcoming events'],
          [h.a, {...templates.pageLinkProps('/events'), class: 'small'}, 'Full schedule →']],
         rabid.event.renderUpcomingPublicEventsCompact()],

        [h.h3, {}, 'Your recent activity'],
        //rabid.volunteer.timesheet_entry.renderRecentActivity(0),

        [h.h3, {}, 'Volunteers'],
        rabid.volunteer.renderSearchableVolunteers(),

        // A home entry point to reporting (the fuller set lives under the navbar's
        // Reports menu).  Service/sale records are logged through events; these are
        // the cross-event views.
        [h.h3, {}, 'Reports'],
        [h.ul, {class: 'list-unstyled'},
         [h.li, {}, [h.a, {...templates.pageLinkProps('/activityReport')}, 'Volunteer Activity Report']],
         [h.li, {}, [h.a, {...templates.pageLinkProps('/service')}, 'Services']],
         [h.li, {}, [h.a, {...templates.pageLinkProps('/sales')}, 'Sales']]],

        // (The full event list lives on the /events page now - the home page
        // shows just the upcoming window above.)
    ];
}
