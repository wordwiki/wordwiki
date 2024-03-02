import * as acorn from "npm:acorn@8.11.3";
import {Node, Expression, Identifier, Literal, ArrayExpression,
        ObjectExpression, UnaryExpression,
        BinaryExpression, LogicalExpression, MemberExpression, ConditionalExpression,
        CallExpression, NewExpression, SequenceExpression,
        ArrowFunctionExpression, TemplateLiteral,
        ParenthesizedExpression, Property, SpreadElement,
        PrivateIdentifier} from "npm:acorn@8.11.3";
import * as strings from '../utils/strings.ts';


// Users of this module may prefer to use this renamed re-export of 'Node' to avoid
// taking a dependency on acorn.
export type JsNode = Node;

export type Scope = Record<string, any>;

export function parseJsExpr(jsExprSrc: string): JsNode {
    return acorn.parseExpressionAt(jsExprSrc, 0, {ecmaVersion: 2023})
}

export function dumpJsExpr(jsExprSrc: string): string {
    return JSON.stringify(parseJsExpr(jsExprSrc), undefined, 2);
}

export function evalJsExprSrc(s: Scope, jsExprSrc: string): any {
    return new Eval().eval(s, parseJsExpr(jsExprSrc));
}

/**
 * An partial interpreter for JS expressions represented as estree parse
 * trees as emitted by acornjs.
 *
 * For estree node documentation see: https://github.com/estree/estree
 */
export class Eval {
    constructor(readonly safeMode: boolean = false) {
    }
    
    eval(s: Scope, e: Node): any {
        switch(e.type) {
            case 'Identifier': return this.evalIdentifier(s, e as Identifier);
            case 'Literal': return this.evalLiteral(s, e as Literal);
            case 'ArrayExpression': return this.evalArrayExpression(s, e as ArrayExpression);
            case 'ObjectExpression': return this.evalObjectExpression(s, e as ObjectExpression);
            case 'UnaryExpression': return this.evalUnaryExpression(s, e as UnaryExpression);
            case 'BinaryExpression': return this.evalBinaryExpression(s, e as BinaryExpression);
            case 'LogicalExpression': return this.evalLogicalExpression(s, e as LogicalExpression);
            case 'MemberExpression': return this.evalMemberExpression(s, e as MemberExpression);
            case 'ConditionalExpression': return this.evalConditionalExpression(s, e as ConditionalExpression);
            case 'CallExpression': return this.evalCallExpression(s, e as CallExpression);
            case 'NewExpression': return this.evalNewExpression(s, e as NewExpression);
            case 'SequenceExpression': return this.evalSequenceExpression(s, e as SequenceExpression);
            case 'ArrowFunctionExpression': return this.evalArrowFunctionExpression(s, e as ArrowFunctionExpression);
            case 'TemplateLiteral': return this.evalTemplateLiteral(s, e as TemplateLiteral);
            case 'ParenthesizedExpression': return this.evalParenthesizedExpression(s, e as ParenthesizedExpression);
            default: throw new Error(`jsterp: unsupported node type ${e.type}`);
        }
    }
    
    evalIdentifier(s: Scope, e: Identifier): any {
        let v = s[e.name];
        if(v === undefined && !(v in s))
            throw new Error(`jsterp: unbound identifier '${e.name}'`);
        return v;
    }

    evalLiteral(s: Scope, e: Literal): any {
        return e.value;
    }

    evalArrayExpression(s: Scope, e: ArrayExpression): any {
        let array: any[] = [];
        for(let v of e.elements) {
            if(v === null)
                throw new Error('jsterp: sparse arrays are not supported');
            array.push(this.eval(s, v));
        }
        return array;
    }

    evalObjectExpression(s: Scope, e: ObjectExpression): any {
        let obj: Record<PropertyKey,any> = {};//Object = {};
        for(let p of e.properties) {
            if(p.type !== 'Property')
                throw new Error('jsterp: only property members of object expressions are supported');
            const prop = p as Property;
            // TODO figure what we should do kind/method/shorthand properties
            obj[this.evalProperty(s, prop.key, prop.computed) as PropertyKey] =
                this.eval(s, prop.value);
        }
        return obj;
    }

    evalUnaryExpression(s: Scope, e: UnaryExpression): any {
        switch(e.operator) {
            case "-": return - this.eval(s, e.argument);
            case "+": return + this.eval(s, e.argument);
            case "!": return ! this.eval(s, e.argument);
            case "~": return ~ this.eval(s, e.argument);
            case "typeof": return typeof this.eval(s, e.argument);
            case "void": return void this.eval(s, e.argument);
            case "delete": throw new Error('jsterp: delete operator not allowed');
            default: throw new Error(`jsterp: unexpected unary operator ${e.operator}`);
        }
    }
    
    evalBinaryExpression(s: Scope, e: BinaryExpression): any {
        switch(e.operator) {
            case "==": return this.eval(s, e.left) + this.eval(s, e.right);
            case "!=": return this.eval(s, e.left) != this.eval(s, e.right);
            case "===": return this.eval(s, e.left) === this.eval(s, e.right);
            case "!==": return this.eval(s, e.left) !== this.eval(s, e.right);
            case "<": return this.eval(s, e.left) < this.eval(s, e.right);
            case "<=": return this.eval(s, e.left) <= this.eval(s, e.right);
            case ">": return this.eval(s, e.left) > this.eval(s, e.right);
            case ">=": return this.eval(s, e.left) >= this.eval(s, e.right);
            case "<<": return this.eval(s, e.left) << this.eval(s, e.right);
            case ">>": return this.eval(s, e.left) >> this.eval(s, e.right);
            case ">>>": return this.eval(s, e.left) >>> this.eval(s, e.right);
            case "+": return this.eval(s, e.left) + this.eval(s, e.right);
            case "-": return this.eval(s, e.left) - this.eval(s, e.right);
            case "*": return this.eval(s, e.left) * this.eval(s, e.right);
            case "/": return this.eval(s, e.left) / this.eval(s, e.right);
            case "%": return this.eval(s, e.left) % this.eval(s, e.right);
            case "|": return this.eval(s, e.left) | this.eval(s, e.right);
            case "^": return this.eval(s, e.left) ^ this.eval(s, e.right);
            case "&": return this.eval(s, e.left) & this.eval(s, e.right);
            case "in": return this.eval(s, e.left) in this.eval(s, e.right);
            case "instanceof": return this.eval(s, e.left) instanceof this.eval(s, e.right);
            case "**": return this.eval(s, e.left) ** this.eval(s, e.right);
            default: throw new Error(`jsterp: unexpected binary operator ${e.operator}`);
        }
    }

    evalLogicalExpression(s: Scope, e: LogicalExpression): any {
        switch(e.operator) {
            case "||": return this.eval(s, e.left) || this.eval(s, e.right);
            case "&&": return this.eval(s, e.left) && this.eval(s, e.right);
            case "??": return this.eval(s, e.left) ?? this.eval(s, e.right);
            default: throw new Error(`jsterp: unexpected logical operator ${e.operator}`);
        }
    }

    evalMemberExpression(s: Scope, e: MemberExpression): any {
        let propertyKey = this.evalProperty(s, e.property, e.computed) as PropertyKey;
        if(this.safeMode) {
            if(typeof propertyKey === 'string')
                propertyKey = propertyKey + '$';
        }
        const obj = this.eval(s, e.object);
        let member = obj[propertyKey];
        // if(!member && obj instanceof Array) {
        //     switch(propertyKey) {
        //         case 'filter': member = member['filter']; break;
        //             //Array.prototype.filter; break;
        //     }
        // }
        //console.info('got member', member, 'for name', propertyKey);

        // TODO: this is borked - we are doing the bind even for function
        //       valued properties.
        if(member instanceof Function)
            member = member.bind(obj);
        
        return member;
    }

    evalConditionalExpression(s: Scope, e: ConditionalExpression): any {
        return this.eval(s, e.test) ?
            this.eval(s, e.consequent) : this.eval(s, e.alternate);
    }

    evalCallExpression(s: Scope, e: CallExpression): any {
        const callee = this.eval(s, e.callee)
        const args = this.evalArguments(s, e.arguments);
        return callee(...args);
    }

    evalNewExpression(s: Scope, e: NewExpression): any {
        const callee = this.eval(s, e.callee)
        const args = this.evalArguments(s, e.arguments);
        const obj = new callee(...args);
        return obj;
    }
    
    evalSequenceExpression(s: Scope, e: SequenceExpression): any {
        let r: any = undefined;
        for(let x of e.expressions)
            r = this.eval(s, x);
        return r;
    }

    evalArrowFunctionExpression(s: Scope, e: ArrowFunctionExpression): any {
        if(!e.expression)
            throw new Error('jsterp: only expr arrow functions are supported');
        let paramNames:string[] = [];
        for(const param of e.params) {
            if(param.type !== 'Identifier')
                throw new Error('jsterp: only supports simple argument lists for arrow functions');
            paramNames.push((param as Identifier).name);
        }
        return (...args: any[]) => {
            const fnScope = Object.create(s);
            for(let i=0; i<paramNames.length; i++) {
                fnScope[paramNames[i]] = args[i];
            }
            return this.eval(fnScope, e.body);
        }
    }
    
    evalTemplateLiteral(s: Scope, e: TemplateLiteral): any {
        throw new Error('jsterp: TemplateLiteral not implemented yet');
    }

    evalParenthesizedExpression(s: Scope, e: ParenthesizedExpression): any {
        return this.eval(s, e.expression);
    }

    evalArguments(s: Scope, args: Array<Expression|SpreadElement>): any[] {
        let evaluatedArgs: any[] = [];
        for(let a of args) {
            if(a.type === 'SpreadElement')
                throw new Error('jsterp: spread element is not supported');
            evaluatedArgs.push(this.eval(s, a));
        }
        return evaluatedArgs;
    }

    evalProperty(s: Scope, key: Expression | PrivateIdentifier, computed: boolean): any {
        switch(true) {
            case key.type === 'PrivateIdentifier':
                return (key as PrivateIdentifier).name;
            case !computed:
                if(key.type !== 'Identifier')
                    throw new Error('jsterp: expected identifier');
                return (key as Identifier).name;
            default:
                return this.eval(s, key);
        }
    }
}

export function jsPlay() {
    //console.info(dumpJsExpr(`new Test().toString()`));
    expectString({}, "true ? 2+2 : 5", "4");
    expectString({Test}, `new Test().add(8,8)`, "16");
    expectString({Test}, `new Test().puppy`, "Rover");
    expectJSON({}, `{cat: '7', puppies: [1,2,3]}`, `{"cat":"7","puppies":[1,2,3]}`);
    expectJSON({}, `((a, b)=>a+b+2)(3,4)`, "9");
    expectString({Test}, `new Test().toString()`, "TEST Rover");
    expectJSON({}, `[99, 73, 4].filter(a=>a>7)`, "[99,73]");

    //dumpDeep(new Test());
}

function dumpDeep(o: any) {
    for(let k of Object.getOwnPropertyNames(o))
        console.info('PP', k);
    const oProto = Object.getPrototypeOf(o);
    if(oProto)
        dumpDeep(oProto);
}

export function expectString(s: Scope, jsExprStr: string, expectResultStr: any): any {
    const result = evalJsExprSrc(s, jsExprStr);
    const resultStr = String(result);
    if(resultStr !== expectResultStr)
        console.info(`FOR: ${jsExprStr} EXPECTED: ${expectResultStr} GOT: ${resultStr}`);
}

export function expectJSON(s: Scope, jsExprStr: string, expectResultStr: any): any {
    const result = evalJsExprSrc(s, jsExprStr);
    const resultStr = JSON.stringify(result);
    if(resultStr !== expectResultStr)
        console.info(`FOR: ${jsExprStr} EXPECTED: ${expectResultStr} GOT: ${resultStr}`);
}

class Test {
    puppy: string = 'Rover';

    add(a: number, b: number): number {
        return a+b;
    }
    
    toString() {
        return 'TEST '+this.puppy;
    }
    
    greet() {
        console.info('hello');
        return 7;
    }
}

if (import.meta.main)
    jsPlay();
    
