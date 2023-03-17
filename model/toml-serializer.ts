import { parse as toml_parse, stringify as toml_stringify } from "https://deno.land/std@0.177.0/encoding/toml.ts";
import * as _ from "https://cdn.skypack.dev/lodash";
import {CEntry as Entry} from "./entry.ts";
import {createSchema} from "./schema.ts";
// import * as _ from "./lodash.js";

async function round_trip_test(entry_toml_path: string) {
     const entry_toml_text = await Deno.readTextFile(entry_toml_path);
     const entry = toml_parse(entry_toml_text);
     const entry1 = toml_parse(super_toml_stringify(entry));
     console.info(toml_stringify(entry));
     console.log(_.isEqual(entry,entry1));
    // console.log((JSON.stringify(entry)))
    //// console.log((JSON.stringify(entry1)));
}

function check_prop (data: any, prop: any, schema: any, top :string, id: any, fix: boolean) {
    if (typeof(data) !== prop.type){
        console.log(`*${id} : Expected ${prop.type} in ${prop.key}. Found: ${typeof(data)}.`);                            
    }
    if (prop.type === 'object'){
        check_data(data, schema, prop.class, id, fix);
    }
}

function check_data (data : any, schema : any, top:string, id : any, fix: boolean){
    for (const prop of schema[top]) {
        if (!data.hasOwnProperty(prop.key)) {
            console.log(`*${id} : ${top} is missing property: ${prop.key}`);
        }
        else {
            if(prop.array){
                if (!Array.isArray(data[prop.key])){
                    console.log(`*${id} : ${top}.${prop.key} should be an array but is not`);
                }
                else {
                    for (const item of data[prop.key]) {
                        check_prop(item, prop, schema, prop.class, id, fix);
                    }
                }
            }    
            else {
                check_prop(data[prop.key], prop, schema, prop.class, id, fix);
            }
        }
    }

    for (const key in data) {    
        let found = false;
        for (const prop of schema[top]) {
            if (prop.key === key) { found = true }
        }
        if (!found) {
            console.log(`*${id} : unexpected propertry ${key} in ${top}`)
        }
    }

}

function super_toml_stringify(data: any): string {

    let output = "";

    let schema = createSchema();
     check_data(data,schema,"Entry", data._id, false);

     for (const prop of schema.Entry) {    
            output = output + toml_stringify_data("",prop.key,data[prop.key],0,false, schema, prop.class);
    }

    // return '';
    return output;
}

function toml_stringify_array(parent_key: string, key: string, data: any,tabs: number, schema: any, cls: string): string {
    const tab = "   ";
    let full_key = key;
    if (parent_key !=="") { full_key = `${parent_key}.${key}` ; }

    if (data.length === 0) {
        // console.info(`${tab.repeat((tabs < 1) ? 0 : tabs-1)}${key} = []`);
        return '';
        // return `${tab.repeat((tabs < 1) ? 0 : tabs-1)}${key} = []\n`;
    }
    else {
        let output = "";
        for (const element of data){
            // console.info(`\n${tab.repeat(tabs)}[[${full_key}]]`);
            output = output + `\n${tab.repeat(tabs)}[[${full_key}]]\n`;
            output = output + toml_stringify_data("",full_key,element,tabs,true, schema, cls);
        }
        return output;
    }
}
function toml_stringify_data(parent_key: string, key: string, data: any,tabs: number,arr: boolean,schema: any, cls: string): string {
    const tab = "   ";
    let type = "";
    let full_key = key;
    if (parent_key !=="") { full_key = `${parent_key}.${key}` ; }
    if (Array.isArray(data)) {
        type = "array";}
    else { type = typeof(data); }
    
    switch (type)
    {
        case "object":
            let output = "";
            // console.log(schema[cls]);
            for (const prop of schema[cls]) {
                // console.log (prop);
                // output = output + prop.class;
                output = output + toml_stringify_data(full_key,prop.key, data[prop.key],tabs+1,arr,schema, prop.class);
            }
            return output;
            break;
        case "array":
            return toml_stringify_array(parent_key,key,data,tabs, schema, cls);
            break;
        case "string":
            if (arr) {
                tabs--;
                full_key = key
            }
            // console.info(`${tab.repeat(tabs)}${full_key} = ${toml_string(data)}`);
            return `${tab.repeat(tabs)}${full_key} = ${toml_string(data)}\n`;
            break;
        default:
            if (arr) {
                tabs--;
                full_key = key
            }
            // console.info(`${tab.repeat(tabs)}${full_key} = ${data}`);
            return`${tab.repeat(tabs)}${full_key} = ${data}\n`;
    }

    return "";
}


function toml_string (text:string): string {
    if (typeof text !== 'string')
        throw new Error (`expected sting, got: "${text}"`);

    if (text.indexOf("'''") !== -1)
        return toml_single_line_string(text);
    else if (text.indexOf("\n") !== -1)
        return toml_multi_line_string(text);
    else
        return toml_single_line_string(text);
}

function toml_single_line_string(text:string): string {
    let newtext = text.replaceAll("\\","\\\\");
    newtext = newtext.replaceAll('"','\\"');
    newtext = newtext.replaceAll("\n","\\\n");
    return '"'+newtext+'"';
}

function toml_multi_line_string(text:string): string {
    if (text.indexOf("'''") !== -1)
        throw new Error (`too many quotes :"${text}"`);
    return "'''" + text + "'''";
}

await round_trip_test("./model/sample-data.toml");
