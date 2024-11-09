const apiFetch = function <M extends AllowedMethod, U extends AllowedUrl<M>>(
    method: M,
    url: U,
    init: Init<M, U>,
    fetch: Fetch
): Promise<Response> {
    const body = init.body ? JSON.stringify((init as RequestInit).body) : undefined;
    const routeParams = init.routeParams ? Object.entries<string>(init.routeParams) : [];
    const searchParams = init.searchParams ? Object.entries<string>(init.searchParams) : [];

    const headers = {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(init ? init.headers : {}),
    };

    delete init.routeParams;
    delete init.searchParams;
    return fetch(generateUrl(url as string, routeParams, searchParams), {
        ...init,
        method,
        headers,
        body,
    });
};

export function createApiObject(fetch: Fetch) {
    function createRequest<M extends AllowedMethod>(method: M) {
        // MM is required to make sure that TypeScript doesn't replace the AllowedUrl with never
        return <MM extends M, U extends AllowedUrl<MM>>(url: U, init: PartialInit<MM, U>) =>
            apiFetch(method, url, init, fetch);
    }

    return {
        GET: createRequest("GET"),
        POST: createRequest("POST"),
        PATCH: createRequest("PATCH"),
        PUT: createRequest("PUT"),
        DELETE: createRequest("DELETE"),
        OPTIONS: createRequest("OPTIONS"),
    };
}

class RpcFetchError extends Error {
    response: Response;
    constructor(response: Response) {
        super(`rpcFetch failed: Received status ${response.status}. Data: '${response.text()}'`);
        this.response = response;
    }
}

const rpcFetch = async function <M extends AllowedMethod, U extends AllowedUrl<M>>(
    method: M,
    url: U,
    init: Init<M, U>,
    fetch: Fetch
): Promise<ApiReturnType<M, U>> {
    const body = init.body ? JSON.stringify((init as RequestInit).body) : undefined;
    const routeParams = init.routeParams ? Object.entries<string>(init.routeParams) : [];
    const searchParams = init.searchParams ? Object.entries<string>(init.searchParams) : [];

    const headers = {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(init ? init.headers : {}),
    };

    delete init.routeParams;
    delete init.searchParams;

    const result = await fetch(generateUrl(url as string, routeParams, searchParams), {
        ...init,
        method,
        headers,
        body,
    });

    if (result.status != 200) {
        throw new RpcFetchError(result);
    }

    return await result.json();
};

export function createRpcObject(fetch: Fetch) {
    function createRequest<M extends AllowedMethod>(method: M) {
        // MM is required to make sure that TypeScript doesn't replace the AllowedUrl with never
        return <MM extends M, U extends AllowedUrl<MM>>(
            url: U,
            init: PartialInit<MM, U>
        ): Promise<ApiReturnType<MM, U>> => rpcFetch<MM, U>(method as MM, url, init, fetch);
    }

    return {
        GET: createRequest("GET"),
        POST: createRequest("POST"),
        PATCH: createRequest("PATCH"),
        PUT: createRequest("PUT"),
        DELETE: createRequest("DELETE"),
        OPTIONS: createRequest("OPTIONS"),
    };
}

function generateUrl(
    route: string,
    routeParams: [string, string][],
    searchParams: [string, unknown][]
) {
    const url = routeParams
        .reduce((route, [param, value]) => {
            return route.replace(RegExp(`\/\\[(\\.\\.\\.)?${param}\\](\/|$)`), `\/${value}\/`);
        }, route)
        .replace(/\/$/, "");

    if (searchParams.length === 0) return url;

    const urlSearchParams = new URLSearchParams();
    for (const [name, value] of searchParams) {
        switch (typeof value) {
            case "undefined":
                break;
            case "string":
            case "boolean":
            case "number":
            case "bigint":
                urlSearchParams.set(name, value.toString());
                break;
            case "object":
                if (Array.isArray(value)) {
                    for (const v of value) {
                        urlSearchParams.append(name, v);
                    }
                    break;
                }
            default:
                throw "Objects and functions aren't supported. Serialize or destructure the object instead of passing it whole.";
        }
    }

    return `${url}?${urlSearchParams.toString()}`;
}

type Fetch = typeof fetch;

type AllowedMethod = keyof ProjectAPI;
type AllowedUrl<M extends AllowedMethod> = keyof ProjectAPI[M];

type Fields = "body" | "routeParams" | "searchParams";
type AllowedData<
    M extends AllowedMethod,
    U extends AllowedUrl<M>,
    Field extends string,
> = Field extends keyof ProjectAPI[M][U] ? ProjectAPI[M][U][Field] : never;

type ApiReturnType<
    M extends AllowedMethod,
    U extends AllowedUrl<M>,
> = "returns" extends keyof ProjectAPI[M][U] ? ProjectAPI[M][U]["returns"] : never;

type Init<M extends AllowedMethod, U extends AllowedUrl<M>> = Omit<
    RequestInit,
    "body" | "method"
> & { [Field in Fields]?: AllowedData<M, U, Field> };

type PartialInit<M extends AllowedMethod, U extends AllowedUrl<M>> = Omit<Init<M, U>, Fields> &
    Pick<
        { [Field in Fields]: AllowedData<M, U, Field> },
        { [Field in Fields]: AllowedData<M, U, Field> extends never ? never : Field }[Fields]
    >;
