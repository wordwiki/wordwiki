


import { _, m, render } from 'https://cdn.skypack.dev/million';
import { html,div } from 'https://cdn.skypack.dev/million/html';
let seconds = 0;

export function go_dog_go_1() {
    setInterval(() => {
        render(document.body, m('p', _, [`Time elapsed: ${seconds}`]));
        seconds++;
    }, 1000);
}

let fancy_word_idx = 1;

function next_fancy() {
    console.info('FANCY');
    fancy_word_idx++;
    go_dog_go();
}

export function go_dog_go() {
    //render(document.body, html`<div>Hello World!!!</div>`);
    console.time('render');
    let word_list = render_words(10000);
    console.timeEnd('render');
    let doc = html`<div><button onclick=${next_fancy}>NEXT</button>${word_list}</div>`;
    update(doc);
}

let prev_vdom = undefined;
function update(new_vdom) {
    console.time('update');
    render(document.body, new_vdom, prev_vdom);
    console.timeEnd('update');
    prev_vdom = new_vdom;
}

function render_words(count) {
    return div([...Array(count).keys()].map(idx => render_word(`word_${idx}`, idx==fancy_word_idx)));
}

function render_word(word_name, is_fancy) {
    //return html`<div>Hello World!!!</div>`;
    //return html`<div><b>HELLLLLO ${word_name}</b> ${render_glosses(word_name)}</div>`;
    return html`<div>${is_fancy?'FANCY':''} <b>${word_name}</b> - ${render_glosses(word_name)}</div>`;
}

function render_glosses(word_name) {
    //console.info('bar');
    //return 1;
    return [1,2,3,4,5].map(i=>html`<i>${word_name}-${i}</i> `);
}
