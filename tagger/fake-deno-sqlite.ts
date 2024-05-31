// ******************************************************************
// NOTE: This is a version of deno-sqlite with all the code replaced
// with a throw new Error(); The purpose is to allow the same program
// to be run in environments without deno-sqlite (obvously without
// using deno-sqlite calls)
// ******************************************************************

// import { StatementPtr, Wasm } from "../build/sqlite.js";
// import { getStr, setArr, setStr } from "./wasm.ts";
// import { Status, Types, Values } from "./constants.ts";
// import { SqliteError } from "./error.ts";

/**
 * The default type for returned rows.
 */
export type Row = Array<unknown>;

/**
 * The default type for row returned
 * as objects.
 */
export type RowObject = Record<string, unknown>;

/**
 * Possible parameter values to be bound to a query.
 *
 * When values are bound to a query, they are
 * converted between JavaScript and SQLite types
 * in the following way:
 *
 * | JS type in | SQL type        | JS type out      |
 * |------------|-----------------|------------------|
 * | number     | INTEGER or REAL | number           |
 * | bigint     | INTEGER         | number or bigint |
 * | boolean    | INTEGER         | number           |
 * | string     | TEXT            | string           |
 * | Date       | TEXT            | string           |
 * | Uint8Array | BLOB            | Uint8Array       |
 * | null       | NULL            | null             |
 * | undefined  | NULL            | null             |
 *
 * If no value is provided for a given parameter,
 * SQLite will default to NULL.
 *
 * If a `bigint` is bound, it is converted to a
 * signed 64 bit integer, which may overflow.
 *
 * If an integer value is read from the database, which
 * is too big to safely be contained in a `number`, it
 * is automatically returned as a `bigint`.
 *
 * If a `Date` is bound, it will be converted to
 * an ISO 8601 string: `YYYY-MM-DDTHH:MM:SS.SSSZ`.
 * This format is understood by built-in SQLite
 * date-time functions. Also see https://sqlite.org/lang_datefunc.html.
 */
export type QueryParameter =
  | boolean
  | number
  | bigint
  | string
  | null
  | undefined
  | Date
  | Uint8Array;

/**
 * A set of query parameters.
 *
 * When a query is constructed, it can contain
 * either positional or named parameters. For
 * more information see https://www.sqlite.org/lang_expr.html#parameters.
 *
 * A set of parameters can be passed to
 * a query method either as an array of
 * parameters (in positional order), or
 * as an object which maps parameter names
 * to their values:
 *
 * | SQL Parameter | QueryParameterSet       |
 * |---------------|-------------------------|
 * | `?NNN` or `?` | NNN-th value in array   |
 * | `:AAAA`       | value `AAAA` or `:AAAA` |
 * | `@AAAA`       | value `@AAAA`           |
 * | `$AAAA`       | value `$AAAA`           |
 *
 * See `QueryParameter` for documentation on
 * how values are converted between SQL
 * and JavaScript types.
 */
export type QueryParameterSet =
  | Record<string, QueryParameter>
  | Array<QueryParameter>;

/**
 * Name of a column returned from a database query.
 */
export interface ColumnName {
  /**
   * Name of the returned column.
   *
   * Corresponds to the `sqlite3_column_name`
   * function.
   */
  name: string;
  /**
   * Name of the database column that stores
   * the data returned from this query.
   *
   * This might be different from `name` if a
   * columns was renamed using e.g. as in
   * `SELECT foo AS bar FROM table`.
   *
   * Corresponds to the `sqlite3_column_origin_name`
   * function.
   */
  originName: string;
  /**
   * Name of the table that stores the data
   * returned from this query.
   *
   * Corresponds to the `sqlite3_column_table_name`
   * function.
   */
  tableName: string;
}

interface RowsIterator<R> {
  next: () => IteratorResult<R>;
  [Symbol.iterator]: () => RowsIterator<R>;
}

/**
 * A prepared query which can be executed many
 * times.
 */
export class PreparedQuery<
  R extends Row = Row,
  O extends RowObject = RowObject,
  P extends QueryParameterSet = QueryParameterSet,
> {
  // #wasm: Wasm;
  // #stmt: StatementPtr;
  // #openStatements: Set<StatementPtr>;

  // #status: number;
  // #iterKv: boolean;
  // #rowKeys?: Array<string>;
  // #finalized: boolean;

  /**
   * This constructor should never be used directly.
   * Instead a prepared query can be obtained by
   * calling `DB.prepareQuery`.
   */
  // constructor(
  //   wasm: Wasm,
  //   stmt: StatementPtr,
  //   openStatements: Set<StatementPtr>,
  // ) {
  //   // this.#wasm = wasm;
  //   // this.#stmt = stmt;
  //   // this.#openStatements = openStatements;

  //   // this.#status = Status.Unknown;
  //   // this.#iterKv = false;
  //   // this.#finalized = false;
  // }

  /**
   * Binds the given parameters to the query
   * and returns an array containing all resulting
   * rows.
   *
   * # Examples
   *
   * ```typescript
   * const query = db.prepareQuery<[number, string]>("SELECT id, name FROM people");
   * const rows = query.all();
   * // rows = [[1, "Peter"], ...]
   * ```
   *
   * To avoid SQL injection, user-provided values
   * should always be passed to the database through
   * a query parameter.
   *
   * ```typescript
   * const query = db.prepareQuery("SELECT id FROM people WHERE name = ?");
   * query.all([name]);
   * ```
   *
   * ```typescript
   * const query = db.prepareQuery("SELECT id FROM people WHERE name = :name");
   * query.all({ name });
   * ```
   *
   * See `QueryParameterSet` for documentation on
   * how values can be bound to SQL statements.
   *
   * See `QueryParameter` for documentation on how
   * values are returned from the database.
   */
    all(_params?: P): Array<R> {
        throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Like `all` except each row is returned
   * as an object containing key-value pairs.
   *
   * # Example
   *
   * ```typescript
   * const query = db.prepareQuery<[number, string], { id: number, name: string }>("SELECT id, name FROM people");
   * const rows = query.allEntries();
   * // rows = [{ id: 1, name: "Peter" }, ...]
   * ```
   */
    allEntries(_params?: P): Array<O> {
        throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Binds the given parameters to the query
   * and returns the first resulting row or
   * `undefined` when there are no rows returned
   * by the query.
   *
   * # Examples
   *
   * ```typescript
   * const query = db.prepareQuery<[number, string]>("SELECT id, name FROM people");
   * const person = query.first();
   * // person = [1, "Peter"]
   * ```
   *
   * ```typescript
   * const query = db.prepareQuery("SELECT id, name FROM people WHERE name = ?");
   * const person = query.first(["not a name"]);
   * // person = undefined
   * ```
   *
   * To avoid SQL injection, user-provided values
   * should always be passed to the database through
   * a query parameter.
   *
   * ```typescript
   * const query = db.prepareQuery("SELECT id FROM people WHERE name = ?");
   * query.first([name]);
   * ```
   *
   * ```typescript
   * const query = db.prepareQuery("SELECT id FROM people WHERE name = :name");
   * query.first({ name });
   * ```
   *
   * See `QueryParameterSet` for documentation on
   * how values can be bound to SQL statements.
   *
   * See `QueryParameter` for documentation on how
   * values are returned from the database.
   */
  first(_params?: P): R | undefined {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Like `first` except the row is returned
   * as an object containing key-value pairs.
   *
   * # Example
   *
   * ```typescript
   * const query = db.prepareQuery<[number, string], { id: number, name: string }>("SELECT id, name FROM people");
   * const person = query.firstEntry();
   * // person = { id: 1, name: "Peter" }
   * ```
   */
  firstEntry(_params?: P): O | undefined {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * **Deprecated:** prefer `first`.
   */
    one(_params?: P): R {
        throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * **Deprecated:** prefer `firstEntry`.
   */
    oneEntry(_params?: P): O {
        throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Binds the given parameters to the query and
   * executes the query, ignoring any rows which
   * might be returned.
   *
   * Using this method is more efficient when the
   * rows returned by a query are not needed or
   * the query does not return any rows.
   *
   * # Examples
   *
   * ```typescript
   * const query = db.prepareQuery<never, never, [string]>("INSERT INTO people (name) VALUES (?)");
   * query.execute(["Peter"]);
   * ```
   *
   * ```typescript
   * const query = db.prepareQuery<never, never, { name: string }>("INSERT INTO people (name) VALUES (:name)");
   * query.execute({ name: "Peter" });
   * ```
   *
   * See `QueryParameterSet` for documentation on
   * how values can be bound to SQL statements.
   *
   * See `QueryParameter` for documentation on how
   * values are returned from the database.
   */
  execute(_params?: P) {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Closes the prepared query. This must be
   * called once the query is no longer needed
   * to avoid leaking resources.
   *
   * After a prepared query has been finalized,
   * calls to `iter`, `all`, `first`, `execute`,
   * or `columns` will fail.
   *
   * Using iterators which were previously returned
   * from the finalized query will fail.
   *
   * `finalize` may safely be called multiple
   * times.
   */
  finalize() {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Returns the column names for this query.
   */
  columns(): Array<ColumnName> {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Returns the SQL string used to construct this
   * query, substituting placeholders (e.g. `?`) with
   * their values supplied in `params`.
   *
   * Calling this function invalidates any iterators
   * previously returned by calls to `iter`.
   *
   * See `QueryParameterSet` for documentation on
   * how values can be bound to SQL statements.
   */
  expandSql(_params?: P): string {
      throw new Error('sqlite not imported - using fake stub');
  }
}



/**
 * Options for opening a database.
 */
export interface SqliteOptions {
  /**
   * Mode in which to open the database.
   *
   * - `read`: read-only, throws an error if
   *   the database file does not exists
   *
   * - `write`: read-write, throws an error
   *   if the database file does not exists
   *
   * - `create`: read-write, create the database
   *   if the file does not exist (for an in-memory
   *   database this is the same as `write`)
   *
   * `create` is the default if no mode is
   * specified.
   */
  mode?: "read" | "write" | "create";
  /**
   * Force the database to be in-memory. When
   * this option is set, the database is opened
   * in memory, regardless of the specified
   * filename.
   */
  memory?: boolean;
  /**
   * Interpret the file name as a URI.
   * See https://sqlite.org/uri.html
   * for more information.
   */
  uri?: boolean;
}

/**
 * Options for opening a database from an in-memory
 * buffer.
 */
export interface SqliteDeserializeOptions {
  /**
   * Name of the schema to deserialize into.
   *
   * The default schema name is `main`, which
   * refers to the database opened originally.
   *
   * If a database schema with the given name
   * does not exist, this fails.
   */
  schema?: "main" | string;
  /**
   * Mode in which to open the deserialized
   * database.
   *
   * - `read`: opens a read-only database
   *
   * - `write`: opens a read-write database
   *   in memory
   *
   * `write` is the default if no mode is
   * specified.
   */
  mode?: "read" | "write";
}

/**
 * Options for defining a custom SQL function.
 */
export interface SqliteFunctionOptions {
  /**
   * Name of the custom function to be used on
   * the SQL side.
   *
   * If this argument is omitted, the function's
   * name is used. E.g.
   *
   * ```typescript
   * function foo(...) { ... }
   * const foo = (...) => ...;
   * const bar = function foo(...) { ... };
   * ```
   *
   * would all be called `foo` on the SQL side.
   */
  name?: string;
  /**
   * Enables additional query optimizations if
   * a function is pure (i.e. if it always returns
   * the same output given the same input).
   *
   * By default this is assumed `false`.
   */
  deterministic?: boolean;
  /**
   * If `directOnly` is `true`, the `SQLITE_DIRECTONLY`
   * flag is set when creating the user-defined function.
   *
   * Setting this flag means the function can only be
   * invoked from top-level SQL (e.g. it can't be used
   * inside VIEWs or TRIGGERs).
   *
   * This is a security feature that prevents functions
   * to be invoked by malicious inputs to the database /
   * malicious values set in bound parameters.
   *
   * By default this is assumed `true`.
   *
   * See https://www.sqlite.org/c3ref/c_deterministic.html#sqlitedirectonly
   * for more information.
   */
  directOnly?: boolean;
}

/**
 * A database handle that can be used to run
 * queries.
 */
export class DB {

  /**
   * Create a new database. The file at the
   * given path will be opened with the
   * mode specified in options. The default
   * mode is `create`.
   *
   * If no path is given, or if the `memory`
   * option is set, the database is opened in
   * memory.
   *
   * # Examples
   *
   * Create an in-memory database.
   * ```typescript
   * const db = new DB();
   * ```
   *
   * Open a database backed by a file on disk.
   * ```typescript
   * const db = new DB("path/to/database.sqlite");
   * ```
   *
   * Pass options to open a read-only database.
   * ```typescript
   * const db = new DB("path/to/database.sqlite", { mode: "read" });
   * ```
   */
    constructor(_path: string = ":memory:", _options: SqliteOptions = {}) {
        throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Query the database and return all matching
   * rows.
   *
   * This is equivalent to calling `all` on
   * a prepared query which is then immediately
   * finalized.
   *
   * The type parameter `R` may be supplied by
   * the user to indicated the type for the rows returned
   * by the query. Notice that the user is responsible
   * for ensuring the correctness of the supplied type.
   *
   * To avoid SQL injection, user-provided values
   * should always be passed to the database through
   * a query parameter.
   *
   * See `QueryParameterSet` for documentation on
   * how values can be bound to SQL statements.
   *
   * See `QueryParameter` for documentation on how
   * values are returned from the database.
   *
   * # Examples
   *
   * ```typescript
   * const rows = db.query<[string, number]>("SELECT name, age FROM people WHERE city = ?", [city]);
   * // rows = [["Peter Parker", 21], ...]
   * ```
   *
   * ```typescript
   * const rows = db.query<[string, number]>(
   *   "SELECT name, age FROM people WHERE city = :city",
   *   { city },
   *  );
   * // rows = [["Peter Parker", 21], ...]
   * ```
   */
  query<R extends Row = Row>(
    _sql: string,
    _params?: QueryParameterSet,
  ): Array<R> {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Like `query` except each row is returned
   * as an object containing key-value pairs.
   *
   * # Examples
   *
   * ```typescript
   * const rows = db.queryEntries<{ name: string, age: number }>("SELECT name, age FROM people");
   * // rows = [{ name: "Peter Parker", age: 21 }, ...]
   * ```
   *
   * ```typescript
   * const rows = db.queryEntries<{ name: string, age: number }>(
   *   "SELECT name, age FROM people WHERE age >= :minAge",
   *   { minAge },
   *  );
   * // rows = [{ name: "Peter Parker", age: 21 }, ...]
   * ```
   */
  queryEntries<O extends RowObject = RowObject>(
    _sql: string,
    _params?: QueryParameterSet,
  ): Array<O> {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Prepares the given SQL query, so that it
   * can be run multiple times and potentially
   * with different parameters.
   *
   * If a query will be issued a lot, this is more
   * efficient than using `query`. A prepared
   * query also provides more control over how
   * the query is run, as well as access to meta-data
   * about the issued query.
   *
   * The returned `PreparedQuery` object must be
   * finalized by calling its `finalize` method
   * once it is no longer needed.
   *
   * # Typing Queries
   *
   * Prepared query objects accept three type parameters
   * to specify precise types for returned data and
   * query parameters.
   *
   * - The first type parameter `R` indicates the tuple type
   *   for rows returned by the query.
   *
   * - The second type parameter `O` indicates the record type
   *   for rows returned as entries (mappings from column names
   *   to values).
   *
   * - The third type parameter `P` indicates the type this query
   *   accepts as parameters.
   *
   * Note, that the correctness of those types must
   * be guaranteed by the caller of this function.
   *
   * # Example
   *
   * ```typescript
   * const query = db.prepareQuery<
   *   [string, number],
   *   { name: string, age: number },
   *   { city: string },
   *  >("SELECT name, age FROM people WHERE city = :city");
   * // use query ...
   * query.finalize();
   * ```
   */
  prepareQuery<
    R extends Row = Row,
    O extends RowObject = RowObject,
    P extends QueryParameterSet = QueryParameterSet,
  >(
    _sql: string,
  ): PreparedQuery<R, O, P> {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Run multiple semicolon-separated statements from a single
   * string.
   *
   * This method cannot bind any query parameters, and any
   * result rows are discarded. It is only for running a chunk
   * of raw SQL; for example, to initialize a database.
   *
   * # Example
   *
   * ```typescript
   * db.execute(`
   *   CREATE TABLE people (
   *     id INTEGER PRIMARY KEY AUTOINCREMENT,
   *     name TEXT,
   *     age REAL,
   *     city TEXT
   *   );
   *   INSERT INTO people (name, age, city) VALUES ('Peter Parker', 21, 'nyc');
   * `);
   * ```
   */
  execute(_sql: string) {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Run a function within the context of a database
   * transaction. If the function throws an error,
   * the transaction is rolled back. Otherwise, the
   * transaction is committed when the function returns.
   *
   * Calls to `transaction` may be nested. Nested transactions
   * behave like SQLite save points.
   *
   * # Example
   *
   * ```typescript
   * db.transaction(() => {
   *   // call db.query ...
   *   db.transaction(() => {
   *     // nested transaction
   *   });
   *   // throw to roll back everything
   * });
   * ```
   */
  transaction<V>(_closure: () => V): V {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Serialize a database.
   *
   * The format is the same as would be written to disk
   * when modifying a database opened from a file. So for
   * an on-disk database file, this is just a copy of the
   * file contents on disk.
   *
   * If no `schema` name is specified the default
   * (`main`) schema is serialized.
   *
   * # Examples
   *
   * ```typescript
   * const data = db.serialize();
   * ```
   *
   * Serialize the in-memory temporary database
   *
   * ```typescript
   * const temp = db.serialize("temp");
   * ```
   */
  serialize(_schema: "main" | "temp" | string = "main"): Uint8Array {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Deserialize a database.
   *
   * The format is the same as would be read from disk
   * when opening a database from a file.
   *
   * When the database is deserialized, the contents of
   * the passed `data` buffer are copied.
   *
   * # Examples
   *
   * Replace the default (`main`) database schema
   * with the contents from `data`.
   *
   * ```typescript
   * db.deserialize(data);
   * ```
   *
   * Create an in-memory database from a buffer.
   *
   * ```typescript
   * const db = new DB();
   * db.deserialize(data);
   * ```
   *
   * Deserialize `data` as a read-only database.
   *
   * ```typescript
   * db.deserialize(data, { mode: "read" });
   * ```
   *
   * Specify a schema name different from `main`.
   * Note that it is not possible to deserialize into
   * the `temp` database.
   *
   * ```typescript
   * db.execute("ATTACH DATABASE ':memory:' AS other"); // create schema 'other'
   * db.deserialize(data, { schema: "other" });
   * ```
   *
   * For more details see https://www.sqlite.org/c3ref/deserialize.html
   * and https://www.sqlite.org/lang_attach.html.
   */
  deserialize(_data: Uint8Array, _options?: SqliteDeserializeOptions) {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Creates a custom (scalar) SQL function that can be
   * used in queries.
   *
   * # Examples
   *
   * ```typescript
   * const log = (value: unknown) => {
   *   console.log(value);
   *   return value;
   * };
   * db.createFunction(log);
   * db.query("SELECT name, log(updated_at) FROM users");
   * ```
   *
   * If a function is pure (i.e. always returns the same result
   * given the same input), it can be marked as `deterministic` to
   * enable additional optimizations.
   *
   * ```typescript
   * const discount = (price: number, salePercent: number) => num * (1 - salePercent / 100);
   * db.createFunction(discount, { deterministic: true });
   * db.query("SELECT name, discount(price, :sale) FROM products", { sale: 15 });
   * ```
   *
   * The function name can be set explicitly.
   *
   * ```typescript
   * db.createFunction(() => Math.random(), { name: "jsRandom" });
   * db.query("SELECT jsRandom()");
   * ```
   *
   * Functions can also take a variable number of arguments.
   *
   * ```typescript
   * const sum = (...nums: number[]) => nums.reduce((sum, num) => sum + num, 0);
   * db.createFunction(sum, { deterministic: true });
   * db.query("SELECT sum(1, 2), sum(1,2,3,4)");
   * ```
   */
  createFunction<
    A extends Array<SqlFunctionArgument> = Array<SqlFunctionArgument>,
    R extends SqlFunctionResult = SqlFunctionResult,
  >(_func: (...args: A) => R, _options?: SqliteFunctionOptions) {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Delete a user-defined SQL function previously
   * created with `createFunction`.
   *
   * After the function is deleted, it can no longer be
   * used in queries, and is free to be re-defined.
   *
   * # Example
   *
   * ```typescript
   * const double = (num: number) => num * 2;
   * db.createFunction(double);
   * // use the function ...
   * db.deleteFunction("double");
   * ```
   */
  deleteFunction(_name: string) {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Close the database. This must be called if
   * the database is no longer used to avoid leaking
   * open file descriptors.
   *
   * If called with `force = true`, any non-finalized
   * `PreparedQuery` objects will be finalized. Otherwise,
   * this throws if there are active queries.
   *
   * `close` may safely be called multiple
   * times.
   */
  close(_force = false) {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Get last inserted row id. This corresponds to
   * the SQLite function `sqlite3_last_insert_rowid`.
   *
   * Before a row is inserted for the first time (since
   * the database was opened), this returns `0`.
   */
  get lastInsertRowId(): number {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Return the number of rows modified, inserted or
   * deleted by the most recently completed query.
   * This corresponds to the SQLite function
   * `sqlite3_changes`.
   */
  get changes(): number {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Return the number of rows modified, inserted or
   * deleted since the database was opened.
   * This corresponds to the SQLite function
   * `sqlite3_total_changes`.
   */
  get totalChanges(): number {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Returns `true` when in auto commit mode and `false` otherwise.
   * This corresponds to the SQLite function
   * `sqlite3_get_autocommit`.
   */
  get autoCommit(): boolean {
      throw new Error('sqlite not imported - using fake stub');
  }

  /**
   * Returns `true` when the database handle is closed
   * and can no longer be used.
   */
  get isClosed(): boolean {
      throw new Error('sqlite not imported - using fake stub');
  }
}

/**
 * Possible arguments a user-defined SQL function might
 * receive.
 *
 * These correspond to the SQL types `INTEGER` (number,
 * bigint, or boolean), `REAL` (number), `TEXT` (string),
 * `BLOB` (Uint8Array), and `NULL` (null).
 *
 * See `QueryParameter` for more details on how JS values
 * are converted to and from SQL values.
 */
export type SqlFunctionArgument =
    | boolean
    | number
    | bigint
    | string
    | null
    | Uint8Array;

/**
 * Values a user-defined SQL function is allowed to
 * return.
 *
 * These correspond to how `QueryParameter`s are
 * converted when bound to queries. Additionally a
 * user-defined function may return `void` (e.g. as in
 * `return;`), in which case a `NULL` value is returned
 * on the SQL side.
 */
export type SqlFunctionResult =
    | void
    | boolean
    | number
    | bigint
    | string
    | null
    | undefined
    | Date
    | Uint8Array;

export type SqlFunction = (
    ...args: Array<SqlFunctionArgument>
) => SqlFunctionResult;
