import { createApiObject, createRpcObject } from "./fetch.js";

export { RpcFetchError } from "./fetch.js";

export const api = createApiObject(fetch);
export const rpc = createRpcObject(fetch);
