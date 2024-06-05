// deno-lint-ignore-file no-explicit-any

/**
 *
 * usually used with jsterp.
 */
export async function rpc(rpcExprSegments: ReadonlyArray<string>, ...args: any[]): Promise<any> {

    console.info('RPC', rpcExprSegments, args);

    const {rpcExpr, argsObj} = rpcUrl(rpcExprSegments, ...args);
    // // --- Replace ${} in this tagged template expr with arg
    // //     references, and hoist the args into an arg {}.
    // let rpcExpr = rpcExprSegments[0];
    // const argsObj: Record<string, any> = {};
    // args.forEach((argVal, i) => {
    //     const argName = `$arg${i}`;
    //     argsObj[argName] = argVal;
    //     rpcExpr += `(${argName})`;
    //     rpcExpr += rpcExprSegments[i+1];
    // });

    // --- Make the request with expr as the URL and the
    //     args json as the post body.
    const request = await new Request('/'+rpcExpr, {
        method: "POST",
        body: JSON.stringify(argsObj)});

    const response = await fetch(request);

    console.info('RPC response', response);

    if(!response.ok) {
        let errorJson = undefined;
        try {
            errorJson = await response.json();
        } catch (_e) {
            console.info('failed to read error json');
        }
        throw new Error(`RPC to ${rpcExpr} with args ${JSON.stringify(argsObj)} failed - ${JSON.stringify(errorJson)}`);
    }

    return await response.json();
}

export function rpcUrl(rpcExprSegments: ReadonlyArray<string>, ...args: any[]): { rpcExpr: string, argsObj: Record<string, any>} {

    console.info('RPC', rpcExprSegments, args);

    // --- Replace ${} in this tagged template expr with arg
    //     references, and hoist the args into an arg {}.
    let rpcExpr = rpcExprSegments[0];
    const argsObj: Record<string, any> = {};
    args.forEach((argVal, i) => {
        const argName = `$arg${i}`;
        argsObj[argName] = argVal;
        rpcExpr += `(${argName})`;
        rpcExpr += rpcExprSegments[i+1];
    });

    return {rpcExpr, argsObj};
}
