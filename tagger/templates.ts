import * as config from './config.ts';
import {block} from "../utils/strings.ts";
import * as view from './view.ts';

export interface PageContent {
    title?: any;
    head?: any;
    body?: any;
}

export function pageTemplate(content: PageContent): any {
    return (
        ['html', {},

         ['head', {},
          ['meta', {charset:"utf-8"}],
          ['meta', {name:"viewport", content:"width=device-width, initial-scale=1"}],
          content.title !== undefined ? ['title', {}, content.title] : undefined,
          config.bootstrapCssLink,
          ['link', {href: '/resources/instance.css', rel:'stylesheet', type:'text/css'}],
          ['script', {}, block`
/**/           let imports = {};
/**/           let activeViews = undefined`],
          //['script', {src:'/scripts/tagger/instance.js', type: 'module'}],
          ['script', {type: 'module'}, block`
/**/           import * as workspace from '/scripts/tagger/workspace.js';
/**/           import * as view from '/scripts/tagger/view.js';
/**/
/**/           imports = Object.assign(
/**/                        {},
/**/                        view.exportToBrowser(),
/**/                        workspace.exportToBrowser());
/**/
/**/           activeViews = imports.activeViews;
/**/
/**/           document.addEventListener("DOMContentLoaded", (event) => {
/**/             console.log("DOM fully loaded and parsed");
/**/             view.run();
/**/             //workspace.renderSample(document.getElementById('root'))
/**/           });`
          ],
          content.head,
         ], // head

         ['body', {},

          content.body,

          view.renderModalEditorSkeleton(),

          config.bootstrapScriptTag

         ] // body
        ] // html
    );
}
