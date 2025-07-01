const lazyValues = new WeakMap<object, Map<string | symbol, any>>();

export function lazy<T>(target: Function, context: ClassGetterDecoratorContext): any {
  const propertyKey = context.name;

    return function (this: any) {
        
        let objectCache = lazyValues.get(this);
        if (!objectCache) {
            objectCache = new Map();
            lazyValues.set(this, objectCache);
        }

        const existingProp = objectCache.get(propertyKey);
        if(existingProp !== undefined || objectCache.has(propertyKey))
            return existingProp;
      
        const prop = target.call(this);
        objectCache.set(propertyKey, prop);
        return prop;
    };
}

// Example usage:
class Calculator {
  @lazy
  get expensiveComputation() {
    console.log("Computing...");
    return Math.random() * 1000000;
  }

  @lazy
  get fibonacci() {
    console.log("Calculating fibonacci...");
    let a = 0, b = 1;
    for (let i = 0; i < 40; i++) {
      [a, b] = [b, a + b];
    }
    return b;
  }
}

function demo() {
    const calc = new Calculator();
    console.log(calc.expensiveComputation); // Logs "Computing..." then the value
    console.log(calc.expensiveComputation); // Returns cached value, no log
    console.log(calc.fibonacci); // Logs "Calculating fibonacci..." then the value
    console.log(calc.fibonacci); // Returns cached value, no log
}

if (import.meta.main)
    demo();
