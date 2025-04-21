/**
 * Our base exception classes.
 *
 * Eventually intended to be richer exception classes including things like
 * nested exceptions.
 *
 * We also define here exceptions for common internal error situations like
 * unimplemented abstract methods, assertion failures etc.
 */

/**
 * Base exception class.
 *
 * Note: Error.toString is not reliably called by JS runtimes to
 * format the error message, so all error text must be mixed into the
 * message (for example in subclass Error constructors).
 */
export class ErrorBase implements Error {
    public name = "Error";

    constructor (public message: string) {
    }
}

/**
 *
 */
export class InternalError extends ErrorBase {
  public name = 'InternalError';
  constructor (message: string) {
    super ('internal error: '+message);
  }
}

/**
 *
 */
export class AssertionError extends ErrorBase {
  public name = 'AssertionError';
  constructor (message_?: string) {
    super (message_ ? 'assertion failed: '+message_ : 'assertion failed');
  }
}

/**
 *
 */
export class AbstractMethodError extends ErrorBase {
  public name = 'AbstractMethodError';
  constructor (message_?: string) {
    super (message_ ? 'abstract method: '+message_ : 'abstract method');
  }
}

/**
 *
 */
export class NotImplementedYet extends ErrorBase {
  public name = 'NotImplementedYet';
  constructor (message_: string = 'Not implemented yet') {
    super ('not implemented: '+message_);
  }
}

/**
 *
 */
export class UnexpectedValue extends ErrorBase {
  public name = 'UnexpectedValue';
  constructor (message_: string) {
    super ('unexpected value: '+message_);
  }
}

/**
 *
 */
export class TypeError extends ErrorBase {
  public name = 'TypeError';
  constructor (public message_: string) {
    super ('type error: '+message_);
  }
}

// export var InternalError = Error;
// export var AssertionError = Error;
// export var AbstractMethodError = Error;
// export var ValidationError = Error;
// export var NotImplementedYet = Error;
// export var UnexpectedValueError = Error;
// export var TypeError = Error;
