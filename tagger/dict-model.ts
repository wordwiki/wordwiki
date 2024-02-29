import * as utils from "../utils/utils.ts";
import {block} from "../utils/strings.ts";

export const dictModel = {
    $lx: {
        name: 'Entry',
        text1Name: 'Internal Note',
        text1Type: 'text',
        text2Name: 'Public note',
        text2Type: 'text',
        $sp: {
            name: 'Spelling',
        },
        $se: {
            $de: {
                name: 'Definition',
            },
        },
    }
};
