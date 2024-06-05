// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types
import {block} from "../utils/strings.ts";
import {unwrap} from "../utils/utils.ts";

// NOTE: we are using a local checkout of deno-sqlite (master
//       from https://github.com/dyedgreen/deno-sqlite) because the last
//       release (3.8) was cut just before they enabled full text search.
//       Once another release happens we can go back to importing from deno.land.
import * as denoSqlite from "../../deno-sqlite/mod.ts";
//import * as denoSqlite from "./fake-deno-sqlite.ts";
//import * as denoSqlite from "https://deno.land/x/sqlite@v3.8/mod.ts";

export type Row = denoSqlite.Row;
//export type RowObject = denoSqlite.RowObject;
export type RowObject = Record<string, any>;
export type QueryParameter = denoSqlite.QueryParameter;
export type QueryParameterSet = denoSqlite.QueryParameterSet;

export type QueryParameters = Record<string, any>;
//export type QueryParameters2 = Record<string, any>;
type ToRecord<T> = {[Property in keyof T]: T[Property]};

/**
 * SQLite uses 'number' (0/1) to represent booleans.
 * (we call it a boolnum so users know what semantics
 * to expect, which true/false literals to use etc).
 */
export type boolnum = number;

const openDbs: Record<string,Db> = {};

export function dbByPath(path: string): Db {
    return openDbs[path] ??= Db.open(path);
}

export function closeAllDbs() {
    for(const db of Object.values(openDbs))
        db.close();
}

export const defaultDbPath = 'database/db.db';
export function db(): Db {
    return dbByPath(defaultDbPath);
}

/**
 * A wrapper around denoSqlite that adapts it for this applications
 * particular style of ORM-less usage.
 *
 * Also: We try not to let the underlying denoSqlite interface leak
 * out of here to make it easier if we ever want to port the application
 * to a different JS sqlite interface (for example 'better sqlite3' if we
 * want to run on node.js, or deno-sqlite3 (the ffi version) if we
 * have trouble with deno-sqlite (the wasm vesion we are using)).
 */
export class Db {
    memoizedPreparedQueries: Map<string, PreparedQuery> = new Map();

    static open(path: string): Db {
        console.info('opening ', path);
        return new Db(new denoSqlite.DB(path));
    }

    static deleteDb(path: string) {
        try {
            Deno.removeSync(path);
            return true;
        } catch(e) {
            if(!(e instanceof Deno.errors.NotFound))
                throw e;
            return false;
        }
    }

    constructor(public db: denoSqlite.DB) {
    }

    /**
     * prepare a query (and memoize)
     *
     * Queries prepared in this manner consume db resources until the db
     * is closed.
     */
    prepare<O extends RowObject={}, P extends QueryParameterSet={}>(sql: string): PreparedQuery<O,P> {
        const alreadyPreparedQuery = this.memoizedPreparedQueries.get(sql);
        if(alreadyPreparedQuery !== undefined)
            return alreadyPreparedQuery as PreparedQuery<O,P>;

        const preparedQuery = this.unmemoizedPrepare<O,P>(sql);
        this.memoizedPreparedQueries.set(sql, preparedQuery);

        return preparedQuery;
    }

    /**
     * prepare a query
     *
     * Call .finalize() on the returned query when you are done with it to
     * free sqlite resources.
     */
    unmemoizedPrepare<O extends RowObject, P extends QueryParameterSet>(sql: string): PreparedQuery<O,P> {
        //console.info('preparing ', sql);
        return new PreparedQuery<O,P>(this.db.prepareQuery<Row,O,P>(sql));
    }

    all<O extends RowObject={}, P extends QueryParameterSet={}>(sql: string, params?: P): Array<O> {
        return this.prepare<O,P>(sql).all(params);
    }

    first<O extends RowObject={}, P extends QueryParameterSet={}>(sql: string, params?: P): O|undefined {
        return this.prepare<O,P>(sql).first(params);
    }

    required<O extends RowObject={}, P extends QueryParameterSet={}>(sql: string, params?: P): O {
        return unwrap(this.prepare<O,P>(sql).first(params),
                      `expected result for query '${sql}' with parameters ${params}`);
    }

    exists<P extends QueryParameterSet={}>(sql: string, params?: P): boolean {
        return this.first<{},P>(sql) !== undefined;
    }

    execute<P extends QueryParameters={}>(sql: string, params?: P) {
        return this.prepare<{},P>(sql).execute(params);
    }

    insertWithAutoId<P extends QueryParameters={}>(sql: string, params?: P): number {
        return unwrap(this.prepare<{id:number},P>(sql).first(params)?.id,
                      `id not returned from insert stmt, did you forget RETURNING foo_id as id? sql is "${sql}"`);
    }

    insert<T extends QueryParameters, K extends keyof T, P extends QueryParameters = Omit<T,K>>(table_name: string, params: P, id_field_name: K): number {
        // EMERGENCY HACK
        // MDN says:
        // BUT: we use object.assign all over the place to copy objects, and it seems to
        // be sometimes introuding a {"undefined": ""} property.  I really should track this down more, but need to get this working now, thus
        // this hack:

        const paramsCopy: Record<string, any> = {};
        for(const k in params as Record<string, any>) {
            if(k != 'undefined')
                paramsCopy[k] = params[k];
        }
        params = paramsCopy as P;

        const fieldNames = Object.keys(paramsCopy);
        //console.info('fieldNames', fieldNames);
        const sql = `INSERT INTO ${table_name} (${fieldNames.join(',')}) VALUES (${fieldNames.map(f=>':'+f).join(',')}) RETURNING ${String(id_field_name)} AS id`;
        return this.insertWithAutoId<P>(sql, params);
    }

    update<T extends QueryParameters>(table_name: string, id_field_name: string, fieldNames: Array<keyof T>, id: number, fields: T) {
        const setTerms = fieldNames.map(name=>`${String(name)} = :${String(name)}`);
        const updateSql = `UPDATE ${table_name} SET ${setTerms.join(', ')} WHERE ${id_field_name} = :__id__`;
        this.execute<T & {__id__: number}>(updateSql, Object.assign({'__id__': id}, fields));
    }

    // updateSafe<T extends QueryParameters>(table_name: string, id_field_name: string, id: number, params: T) {
    //     const setTerms = Object.entries(params).map(([name, value])=>`${name} = :${name}`);
    //     const updateSql = `UPDATE ${table_name} SET ${setTerms.join(', ')} WHERE ${id_field_name} = :__id__`;
    //     this.execute<T & {__id__: number}>(updateSql, Object.assign({'__id__': id}, params));
    // }

    /**
     * Run multiple semicolon-separated statements from a single
     * string.
     *
     * This method cannot bind any query parameters, and any
     * result rows are discarded. It is only for running a chunk
     * of raw SQL; for example, to initialize a database.
     */
    executeStatements(sql: string) {
        return this.db.execute(sql);
    }

    transaction<V>(closure: () => V): V {
        return this.db.transaction(closure);
    }

    beginTransaction() {
        this.db.execute('BEGIN TRANSACTION;');
    }

    rollbackTransaction() {
        this.db.execute('ROLLBACK TRANSACTION;');
    }

    endTransaction() {
        this.db.execute('END TRANSACTION;');
    }

    rawQuery(sql: string, params: QueryParameterSet={}): Array<Row> {
        return this.db.query(sql, params);
    }

    close() {
        this.db.close(true);
    }
}

/**
 * Prepared query.
 */
export class PreparedQuery<O extends RowObject=RowObject, P extends QueryParameterSet=QueryParameterSet> {
    columnNames: string[];

    constructor(public preparedQuery: denoSqlite.PreparedQuery<Row,O,P>) {
        this.columnNames = this.preparedQuery.columns().map(c=>c.name);
    }

    all(params?: P): Array<O> {
        const allRows = this.preparedQuery.all(params);
        return allRows.map(row=>this.rowToObject(row));
    }

    first(params?: P): O|undefined {
        const firstRow = this.preparedQuery.first(params);
        return firstRow===undefined ? undefined : this.rowToObject(firstRow);
    }

    // TODO: query printing in this error message is borked.
    required(params?: P): O {
        const first = this.first(params);
        if(first == undefined) {
            throw new Error(`expected non-empty result for query ${this.preparedQuery.expandSql(params)}`);
        }
        return first;
    }

    execute(params?: P) {
        this.preparedQuery.execute(params);
    }

    rowToObject(row: Row): O {
        const columnNames = this.columnNames;
        if(row.length !== columnNames.length) {
            throw new Error(`expected ${columnNames.length} columns, got ${row.length} columns`);
        }
        const obj: RowObject = {};
        for(let i=0; i<columnNames.length; i++) {
            obj[columnNames[i]] = row[i];
        }
        return obj as O;
    }
}

export function assertDmlContainsAllFields(dml: string, fieldNames: string[]) {
    for(const fieldName of fieldNames) {
        if(!new RegExp("\\b"+fieldName+"\\b").test(dml))
            throw new Error(`DML '${dml}' is missing reference to required field name '${fieldName}'`);
    }
}

function example() {

    Db.deleteDb('test.db');
    const db = Db.open('test.db');

    console.info(db.rawQuery('select 1+1'));
    console.info(db.rawQuery('PRAGMA main.cache_size = -100000'));
    console.info(db.rawQuery('PRAGMA main.cache_size'));

    db.execute(block`
/**/   CREATE TABLE person(
/**/      person_id INTEGER PRIMARY KEY ASC,
/**/      name TEXT,
/**/      happy NUMBER);
/**/   `);

    const insertStmt = db.prepare<{}, {name: string, happy: number}>
        ('INSERT INTO person (name, happy) VALUES (:name, :happy)')
    insertStmt.execute({name: 'David', happy: 1});
    insertStmt.execute({name: 'Larry', happy: 0});
    insertStmt.execute({name: 'Henry', happy: 1});
    insertStmt.execute({name: 'Bart', happy: 0});

    const happyPeople = db.all<{person_id:number, name: string}, {happy: number}>(
        'SELECT person_id, name FROM person WHERE happy=:happy',
        {happy: 1});
    console.info(happyPeople);

    db.close();
}

if (import.meta.main)
    example();
