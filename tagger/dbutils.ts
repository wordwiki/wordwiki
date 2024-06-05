// // deno-lint-ignore-file require-await, no-unused-vars
// //import { DB, PreparedQuery } from "https://deno.land/x/sqlite/mod.ts";
// import { Db, PreparedQuery } from "./db.ts";
// import * as utils from "../utils/utils.ts";

// /**
//  * Prepared queries can be cached either by the literal prepared query text, or
//  * by a name.
//  *
//  * When caching by name, the query text is generated on demand (we
//  * have some situations where we are doing substantial metadata
//  * crawling to generate the query text).
//  */
// export class PreparedQueryCache {
//     preparedQueries: Map<Db, Map<string, Promise<PreparedQuery>>> = new Map();

//     async getPreparedQuery(db: Db, query: string): Promise<PreparedQuery> {
//         const queriesForDb = utils.getOrCreate(this.preparedQueries, db, ()=>new Map());
//         return utils.getOrCreate(queriesForDb, query, (name:string)=>db.prepareQuery(query));
//     }

//     async getNamedPreparedQuery(db: Db, name: string, query: ()=>string): Promise<PreparedQuery> {
//         const queriesForDb = utils.getOrCreate(this.preparedQueries, db, ()=>new Map());
//         return utils.getOrCreate(queriesForDb, '#'+name, (name:string)=>db.prepareQuery(query()));
//     }
// }
