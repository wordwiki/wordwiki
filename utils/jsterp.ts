import * as acorn from "npm:acorn@8.11.3";
import {Node, Expression, Identifier, Literal, ArrayExpression,
        ObjectExpression, UnaryExpression,
        BinaryExpression, LogicalExpression, MemberExpression, ConditionalExpression,
        CallExpression, NewExpression, SequenceExpression,
        ArrowFunctionExpression, TemplateLiteral,
        ParenthesizedExpression, Property, SpreadElement,
        PrivateIdentifier} from "npm:acorn@8.11.3";
import {Statement, ExpressionStatement, BlockStatement, EmptyStatement,
        ReturnStatement, BreakStatement, ContinueStatement, SwitchStatement,
        SwitchCase, WhileStatement, DoWhileStatement, ForInStatement,
        ForOfStatement} from "npm:acorn@8.11.3";
import * as strings from './strings.ts';
import * as utils from './utils.ts';
import {panic} from './utils.ts';

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

export function evalJsExprSrc(s: Scope, jsExprSrc: string, safeMode:boolean=false): any {
    return new Eval(safeMode).eval(s, parseJsExpr(jsExprSrc));
}

export const pubMarker = Symbol('pub');

// TODO: later make versions that check if have specified permissions etc.
export function pub(value: boolean=false) {
    return function (target: any, context: ClassMethodDecoratorContext) {
        // const fn = target[propertyKey];
        // if(!(fn instanceof Function))
        //     throw new Error(`attempt to mark non-function ${utils.className(target)}.${propertyKey} as public`);
        // fn[pubMarker] = true;
        return (a:number,b:number)=>a*b;
    };
}


function loggedMethod(originalMethod: any, context: ClassMethodDecoratorContext) {
    const methodName = String(context.name);

    function replacementMethod(this: any, ...args: any[]) {
        console.log(`LOG: Entering method '${methodName}'.`)
        const result = originalMethod.call(this, ...args);
        console.log(`LOG: Exiting method '${methodName}'.`)
        return result;
    }

    return replacementMethod;
}

class Foo {
    
}

/**
 * An partial interpreter for JS expressions represented as estree parse
 * trees as emitted by acornjs.
 *
 * For estree node documentation see: https://github.com/estree/estree
 *
 * - toString() is implicitly called by JS to do conversion to string.
 * - valueOf() is implicitly calles by JS to do numeric and primitive conversion.
 *
 * These cannot be banned by safeMode.  So you should not allow expressions
 * to access any values where calling toString() or valueOf() on that value
 * would leak secrets.
 *
 * If your security rules allow map/flatMap it is easy for users to
 * construct expressions that will consume all CPU, RAM or IO (if you
 * have methods that do IO).  But map is so useful in templates, that
 * we often do want to allow it.  We will probably introduce some invocation
 * limit feature to allow map to be used with less risk of resource exhaustion
 * attacks.
 * 
 * We will probably want to have a version of this that allows 'await' -
 * but that would require making all the methods 'async', which would
 * add a lot of overhead.  So we will probably have to maintain two
 * copies of this.
 */
export class Eval {
    constructor(readonly safeMode: boolean = false) {
    }
    
    eval(s: Scope, e: JsNode): any {
        switch(e.type) {
            case 'Identifier':
                return this.evalIdentifier(s, e as Identifier);
            case 'Literal':
                return this.evalLiteral(s, e as Literal);
            case 'ArrayExpression':
                return this.evalArrayExpression(s, e as ArrayExpression);
            case 'ObjectExpression':
                return this.evalObjectExpression(s, e as ObjectExpression);
            case 'UnaryExpression':
                return this.evalUnaryExpression(s, e as UnaryExpression);
            case 'BinaryExpression':
                return this.evalBinaryExpression(s, e as BinaryExpression);
            case 'LogicalExpression':
                return this.evalLogicalExpression(s, e as LogicalExpression);
            case 'MemberExpression':
                return this.evalMemberExpression(s, e as MemberExpression);
            case 'ConditionalExpression':
                return this.evalConditionalExpression(s, e as ConditionalExpression);
            case 'CallExpression':
                return this.evalCallExpression(s, e as CallExpression);
            case 'NewExpression':
                return this.evalNewExpression(s, e as NewExpression);
            case 'SequenceExpression':
                return this.evalSequenceExpression(s, e as SequenceExpression);
            case 'ArrowFunctionExpression':
                return this.evalArrowFunctionExpression(s, e as ArrowFunctionExpression);
            case 'TemplateLiteral':
                return this.evalTemplateLiteral(s, e as TemplateLiteral);
            case 'ParenthesizedExpression':
                return this.evalParenthesizedExpression(s, e as ParenthesizedExpression);
            default:
                throw new Error(`jsterp: unsupported node type ${e.type}`);
        }
    }
    
    evalIdentifier(s: Scope, e: Identifier): any {
        let v = s[e.name];
        // TODO: probably remove the boundnames from the error unless in
        //       dev mode - exceptions will be shown on client and having
        //       list of names ... hackers ... etc ... security by obscurity ???
        if(v === undefined && !(v in s))
            throw new Error(`jsterp: unbound identifier '${e.name}' - bound names are: ${utils.getAllPropertyNames(s).join()}`);
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

        // if(Object.hasOwn(obj, '__ref__'))
        //     return resolveObjectRef(scope, obj);
        // else
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

        // TODO this is a crappy version of safe mode.
        // probably switch to a decorator based scheme.
        // if(this.safeMode) {
        //     if(typeof propertyKey === 'string')
        //         propertyKey = propertyKey + '$';
        // }
        const obj = this.eval(s, e.object);
        let member = obj[propertyKey];

        if(this.safeMode && !member[pubMarker])
            throw new Error(`attempt to access non-public property ${String(propertyKey)}`);

        // TODO this is intended to whitelist some core builtin functions
        //      even when in safe mode. (like toString and filter).
        // if(!member && obj instanceof Array) {
        //     switch(propertyKey) {
        //         case 'filter': member = member['filter']; break;
        //             //Array.prototype.filter; break;
        //     }
        // }
        //console.info('got member', member, 'for name', propertyKey);

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
        const txts = e.quasis.map(q=>q.value.cooked ??
            panic('jsterp: missing cooked template value'));
        const values = e.expressions.map(x=>this.eval(s, x));
        if(txts.length != values.length+1)
            throw new Error('jsterp: malformed template literal');
        let result = txts[0];
        values.forEach((subst, i) => {
            result += String(subst);
            result += txts[i+1];
        });
        return result;
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

    resolveObjectRef(s: Scope, ref: Record<string,any>): any {
        const {resolver, ...args} = ref;
        const argValues = Object.values(args);
        return resolver(argValues);
    }
}

export function jsPlay() {
    expectString({}, "true ? 2+2 : 5", "4");
    expectString({Test}, `new Test().add(8,8)`, "16");
    expectString({Test}, `new Test().puppy`, "Rover");
    expectJSON({}, `{cat: '7', puppies: [1,2,3]}`, `{"cat":"7","puppies":[1,2,3]}`);
    expectJSON({}, `((a, b)=>a+b+2)(3,4)`, "9");
    expectString({Test}, `new Test().toString()`, "TEST Rover");
    expectJSON({}, `[99, 73, 4].filter(a=>a>7)`, "[99,73]");
    expectString({}, '`${7} seven ${8} cat ${9}`', "7 seven 8 cat 9");
    expectString({}, '`seven ${8*2} cat`', "seven 16 cat");
    expectString({}, '[0,1,2].flatMap(v1=>[0,1,2].flatMap(v2=>[0,1,2].flatMap(v3=>[v1,v2,v3]))).filter(v=>v!==0).map(v=>`v${v}`).join(":")',
                 'v1:v2:v1:v1:v1:v1:v2:v2:v2:v1:v2:v2:v1:v1:v1:v1:v2:v1:v1:v1:v1:v1:v1:v1:v2:v1:v2:v1:v2:v1:v1:v2:v2:v2:v2:v1:v2:v2:v2:v1:v2:v1:v1:v2:v1:v2:v2:v2:v2:v2:v1:v2:v2:v2');
    expectJSON({info: console.info}, 'info(`done tests`)', undefined);
    expectValue({Test}, 'Test.mul(2,2)', 4);

}

function dumpDeep(o: any) {
    for(let k of Object.getOwnPropertyNames(o))
        console.info('--', k);
    const oProto = Object.getPrototypeOf(o);
    if(oProto)
        dumpDeep(oProto);
}

export function expectValue(s: Scope, jsExprStr: string, expectResult: any, safeMode:boolean = false): any {
    const result = evalJsExprSrc(s, jsExprStr, safeMode);
    if(result !== expectResult)
        console.info(`FOR: ${jsExprStr} EXPECTED: ${expectResult} GOT: ${result}`);
}

export function expectString(s: Scope, jsExprStr: string, expectResultStr: any, safeMode:boolean = false): any {
    const result = evalJsExprSrc(s, jsExprStr, safeMode);
    const resultStr = String(result);
    if(resultStr !== expectResultStr)
        console.info(`FOR: ${jsExprStr} EXPECTED: ${expectResultStr} GOT: ${resultStr}`);
}

export function expectJSON(s: Scope, jsExprStr: string, expectResultStr: any, safeMode: boolean = false): any {
    const result = evalJsExprSrc(s, jsExprStr, safeMode);
    const resultStr = JSON.stringify(result);
    if(resultStr !== expectResultStr)
        console.info(`FOR: ${jsExprStr} EXPECTED: ${expectResultStr} GOT: ${resultStr}`);
}

class Test {
    puppy: string = 'Rover';
    
    static mul(a: number, b: number): number {
        return a*b;
    }
    
    add(a: number, b: number): number {
        return a+b;
    }

    @pub()
    safeAdd(a: number, b: number): number {
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

//console.info(new Test().safeAdd(3,3));


if (import.meta.main)
    jsPlay();



