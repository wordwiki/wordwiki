import * as markup from '../tabula/markup.ts';
import * as templates from './templates.ts';
import {Rabid} from './rabid.ts';
import {Markup} from '../tabula/markup.ts';

/**
 *
 */
export class Page {
    constructor(public rabid: Rabid) {
    }

    title(): string {
        return 'Page';
    }

    body(): Markup {
        return ['page']
    }

    render(): Markup {
        const title = this.title();
        const body = this.body();
        return templates.pageTemplate({title, body});
    }
}
