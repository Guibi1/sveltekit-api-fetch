import ts from "typescript";

export function generateUrlType(fields: Record<string, string | undefined>) {
    const entries = Object.entries(fields).filter(([_, type]) => type !== undefined);
    if (entries.length === 0) return "never";

    return `{ ${entries.map(([name, type]) => `${name}: ${type}`).join("; ")} }`;
}

export function getSchemaFromFunction(typeChecker: ts.TypeChecker, func: ts.SignatureDeclaration) {
    return {
        schema: getSchema(func),
        returnType: getReturnType(typeChecker, func),
    };
}

function getSchema(func: ts.SignatureDeclaration) {
    return ts.forEachChild(func, (node) => {
        if (ts.isBlock(node)) {
            return ts.forEachChild(node, (node) => {
                if (ts.isVariableStatement(node)) {
                    return ts.forEachChild(node.declarationList, (declaration) => {
                        if (
                            ts.isVariableDeclaration(declaration) &&
                            declaration.initializer &&
                            ts.isAwaitExpression(declaration.initializer) &&
                            ts.isCallExpression(declaration.initializer.expression)
                        ) {
                            return declaration.initializer.expression.arguments[1];
                        }
                    });
                }
            });
        }
    });
}

function getReturnType(typeChecker: ts.TypeChecker, func: ts.SignatureDeclaration) {
    let returnType: ts.Type | undefined;

    ts.forEachChild(func, (node) => {
        if (ts.isBlock(node)) {
            ts.forEachChild(node, (child) => {
                if (ts.isReturnStatement(child) && child.expression) {
                    if (ts.isCallExpression(child.expression)) {
                        const calledFunction = child.expression.expression;
                        const calledFunctionText = calledFunction.getText();

                        if (calledFunctionText === "json") {
                            const jsonArgument = child.expression.arguments[0];
                            if (jsonArgument) {
                                returnType = typeChecker.getTypeAtLocation(jsonArgument);
                                // TODO: Apply 'as const' effect to returnType (don't know how to)
                                // Workaround is to just write "as const" in your code
                            }
                        }
                    }

                    // If not a 'json' call, use any (would use unknown but that is not available)
                    if (!returnType) {
                        returnType = typeChecker.getAnyType();
                    }
                }
            });
        }
    });

    return returnType ?? typeChecker.getVoidType();
}

/**
 * Turns a schema (obtained via `getSchemaFromFunction`) and parses it into strings `body` and `searchParams`.
 * @param data The schema from getSchemaFromFunction
 * @param skipBody Won't output body, set this to True on methods that don't support a body (like GET)
 * @returns Body and SearchParams, which are string representations of the types
 */
export function parseSchema(
    typeChecker: ts.TypeChecker,
    data: ReturnType<typeof getSchemaFromFunction>,
    skipBody = false
) {
    const zodInputType = data.schema ? typeChecker.getTypeAtLocation(data.schema) : undefined;

    const body =
        skipBody || !zodInputType
            ? undefined
            : `{ ${typeChecker
                  .getPropertiesOfType(zodInputType)
                  .map((property) => {
                      if (property.getName() === "searchParams") return null;
                      const outputType = getZodTypeToString(
                          typeChecker,
                          typeChecker.getTypeOfSymbol(property)
                      );
                      if (!outputType) return null;
                      return `${property.getName()}: ${outputType}`;
                  })
                  .filter((t) => t !== null)
                  .join("; ")} }`;

    let searchParams: string | undefined;
    const searchParamsSymbol = zodInputType?.getProperty("searchParams");
    if (searchParamsSymbol) {
        const searchParamsType = typeChecker.getTypeOfSymbol(searchParamsSymbol);

        // Check if the type is an object type
        if (searchParamsType.getFlags() & ts.TypeFlags.Object) {
            searchParams = getZodTypeToString(typeChecker, searchParamsType);
        }
    }

    let returnType: string | undefined;
    if (data.returnType) {
        returnType = typeChecker.typeToString(data.returnType);
    }

    return { body: body != "{  }" ? body : undefined, searchParams, returnType };
}

function getZodTypeToString(typeChecker: ts.TypeChecker, type: ts.Type): string {
    const zodType = type.getBaseTypes()?.[0];
    if (zodType) {
        return typeChecker.typeToString(
            typeChecker.getTypeArguments(zodType as ts.TypeReference)[2]
        );
    }

    const zodArguments = typeChecker.getTypeArguments(type as ts.TypeReference);
    if (zodArguments.length === 5) {
        // Fallback for zodObject
        return typeChecker.typeToString(zodArguments[4]);
    } else if (zodArguments.length === 2) {
        // Fallback for zodArray
        return getZodTypeToString(typeChecker, zodArguments[0]) + "[]";
    }

    return getZodTypeToString(typeChecker, zodArguments[0]);
}
