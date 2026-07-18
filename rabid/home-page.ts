import * as templates from './templates.ts';
import {rabid} from './rabid.ts';
import {Markup, h} from '../liminal/markup.ts';

// The internal home: a document of the few things a volunteer wants at login,
// as sections with a jump menu at the top (the event-detail-page pattern).  The
// weight order matters - "Happening now" (check in, the primary task) first when
// there is anything on, then the upcoming schedule, then the reports directory.
export function home(): Markup {
    const title = "Rabid - The Red Raccoon Volunteer System";

    // "Happening now" is optional: rendered only when an event is ongoing, and it
    // drops out of the jump menu too when absent.
    const ongoing = rabid.event.renderHomeOngoingEvents();

    const sections: [string, string][] = [];
    if (ongoing) sections.push(['ongoing', 'Happening now']);
    sections.push(['upcoming-events', 'Upcoming events']);
    sections.push(['reports', 'Reports']);

    return [h.div, {class: 'container py-3'},
        [h.h2, {class: 'mb-2'}, title],
        renderHomeNav(sections),

        // 1. Happening now (optional) - the check-in prompt, first.
        ongoing,

        // 2. Upcoming events - the lean, skimmable public schedule with one-tap RSVP.
        [h.section, {id: 'upcoming-events', class: 'mb-5'},
         [h.div, {class: 'd-flex align-items-baseline justify-content-between'},
          [h.h3, {class: 'mb-2'}, 'Upcoming events'],
          [h.a, {...templates.pageLinkProps('/events'), class: 'small'}, 'Full schedule →']],
         rabid.event.renderUpcomingPublicEventsCompact()],

        // 3. Reports - a small directory of the cross-event views (the fuller set
        // lives under the navbar's Reports menu).  The links here will change; the
        // section is styled to match the others (heading + accent-link list).
        [h.section, {id: 'reports', class: 'mb-4'},
         [h.h3, {class: 'mb-2'}, 'Reports'],
         [h.ul, {class: 'list-unstyled mb-0'},
          reportLinks.map(([href, label]) =>
              [h.li, {class: 'mb-1'},
               [h.a, {...templates.pageLinkProps(href), class: 'lm-nav-link'}, label]])]],
    ];
}

// The cross-event report views (service/sale records are logged THROUGH events;
// these are the roll-ups across them).
const reportLinks: [string, string][] = [
    ['/activityReport', 'Volunteer Activity Report'],
    ['/service', 'Services'],
    ['/sales', 'Sales'],
];

// The home jump menu: small, muted, slash-separated links that scroll to each
// section by fragment id - the same quiet strip as the event detail page's
// section nav (design-language.md), so the two pages read the same way.
function renderHomeNav(sections: [string, string][]): Markup {
    return [h.nav, {class: 'lm-section-nav small mb-4 pb-2 border-bottom', 'aria-label': 'Sections'},
        sections.map(([id, label], i) => [
            i > 0 ? [h.span, {class: 'text-muted mx-2'}, '/'] : undefined,
            [h.a, {href: `#${id}`, class: 'link-secondary text-decoration-none'}, label],
        ])];
}
