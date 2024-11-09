import { writeFile } from "fs/promises";
import path from "path";
import ts from "typescript";
import type { Plugin } from "vite";
import { generateUrlType, getSchemaFromFunction, parseSchema } from "./helpers.js";

const methods = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";
type EndpointData = Partial<Record<Method, string>>;
type ProjectAPI = Record<Method, Record<string, string>>;

export function typesafeApi(): Plugin {
    let projectPath = "";
    let serverEndpointPathRegex = RegExp("");
    const projectAPI: ProjectAPI = {
        GET: {},
        POST: {},
        PATCH: {},
        PUT: {},
        DELETE: {},
        OPTIONS: {},
    };

    let config: ts.ParsedCommandLine;
    let host: ts.CompilerHost;
    let program: ts.Program;

    let hotUpdateFiles: string[] = [];
    let hotUpdateTimeout: NodeJS.Timeout;

    function parseProject(files?: string[]) {
        program = ts.createProgram({
            rootNames: config.fileNames,
            options: config.options,
            oldProgram: program,
            host: host,
        });

        const sourceFiles = program.getSourceFiles();
        const typeChecker = program.getTypeChecker();

        if (files) {
            for (const file of files) {
                const sourceFile = program.getSourceFile(file);
                if (!sourceFile) continue;

                parseFile(sourceFile, typeChecker);
            }
        } else {
            for (const sourceFile of sourceFiles) {
                if (serverEndpointPathRegex.test(sourceFile.fileName)) {
                    parseFile(sourceFile, typeChecker);
                }
            }
        }

        save();
    }

    function parseFile(file: ts.SourceFile, typeChecker: ts.TypeChecker) {
        const endpointsFound: Method[] = [];
        const allBodies: EndpointData = {};
        const allSearchParams: EndpointData = {};
        const allReturnTypes: EndpointData = {};

        ts.forEachChild(file, (node) => {
            if (
                !ts.canHaveModifiers(node) ||
                !node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)
            ) {
                return;
            }

            if (ts.isVariableStatement(node)) {
                node.declarationList.declarations.forEach((declaration) => {
                    if (!ts.isIdentifier(declaration.name)) return;

                    // Handle exported endpoint (ex. export const POST = ...)
                    const variableName = declaration.name.escapedText as string;
                    if (methods.includes(variableName)) {
                        endpointsFound.push(variableName as Method);

                        const schema = ts.forEachChild(declaration, (node) => {
                            if (ts.isSatisfiesExpression(node)) {
                                return ts.forEachChild(node.expression, (node) => {
                                    if (ts.isFunctionLike(node)) {
                                        return getSchemaFromFunction(typeChecker, node);
                                    }
                                });
                            } else if (ts.isFunctionLike(node)) {
                                return getSchemaFromFunction(typeChecker, node);
                            }
                        });

                        if (schema) {
                            const { body, searchParams, returnType } = parseSchema(
                                typeChecker,
                                schema,
                                variableName.toUpperCase() === "GET"
                            );
                            allBodies[variableName as Method] = body;
                            allSearchParams[variableName as Method] = searchParams;
                            allReturnTypes[variableName as Method] = returnType;
                        }
                    }
                });
            } else if (ts.isFunctionDeclaration(node)) {
                if (!node.name || !ts.isIdentifier(node.name)) return;

                // Handle exported endpoint (ex. export function POST() ...)
                const variableName = node.name.escapedText as string;
                if (methods.includes(variableName)) {
                    endpointsFound.push(variableName as Method);

                    const schema = getSchemaFromFunction(typeChecker, node);
                    if (schema) {
                        const { body, searchParams, returnType } = parseSchema(
                            typeChecker,
                            schema,
                            variableName.toUpperCase() === "GET"
                        );
                        allBodies[variableName as Method] = body;
                        allSearchParams[variableName as Method] = searchParams;
                        allReturnTypes[variableName as Method] = returnType;
                    }
                }
            }
        });

        if (endpointsFound.length === 0) return;

        const typesFile = program.getSourceFile(
            path.join(
                projectPath,
                ".svelte-kit/types",
                path.relative(projectPath, path.dirname(file.fileName)),
                "$types.d.ts"
            )
        );
        if (!typesFile) return;

        let url = "";
        let routeParams: string | undefined;
        ts.forEachChild(typesFile, (node) => {
            if (ts.isTypeAliasDeclaration(node)) {
                if (node.name.text === "RouteId") {
                    url = typeChecker.typeToString(typeChecker.getTypeAtLocation(node));
                } else if (node.name.text === "RouteParams") {
                    routeParams = node.type.getText();
                    if (routeParams === "{  }") routeParams = undefined;
                }
            }
        });

        for (const method of endpointsFound) {
            projectAPI[method][url] = generateUrlType({
                body: allBodies[method],
                routeParams: routeParams,
                searchParams: allSearchParams[method],
                returns: allReturnTypes[method],
            });
        }
    }

    async function save() {
        const projectMethods = methods.filter((m) => Object.keys(projectAPI[m as Method]).length);

        const filePath = path.join(projectPath, "src/api.d.ts");
        const fileContent = `${typeFileMessage}\ntype ProjectAPI = ${
            projectMethods.length === 0
                ? "object"
                : `{\n${projectMethods
                      .map(
                          (method) =>
                              `    ${method}: {\n${Object.entries(projectAPI[method as Method])
                                  .map(([url, type]) => `        ${url}: ${type}`)
                                  .join(";\n")};\n    }`
                      )
                      .join(";\n")};\n}`
        };\n`;

        await writeFile(filePath, fileContent);
    }

    return {
        name: "sveltekit-api-fetch",

        configureServer(s) {
            clearTimeout(hotUpdateTimeout);
            hotUpdateFiles = [];

            projectPath = s.config.root;
            serverEndpointPathRegex = RegExp(
                `^(?:${projectPath}/)?src/routes(/.*)?/\\+server\\.(ts|js)$`
            );

            const configPath = ts.findConfigFile(projectPath, ts.sys.fileExists, "tsconfig.json");
            if (!configPath) {
                throw new Error("Could not find a valid 'tsconfig.json'.");
            }

            config = ts.parseJsonConfigFileContent(
                ts.readConfigFile(configPath, ts.sys.readFile).config,
                ts.sys,
                projectPath,
                {
                    noEmit: true,
                    checkJs: false,
                    skipLibCheck: true,
                    incremental: true,
                    tsBuildInfoFile: path.join(projectPath, "tsbuildinfo"),
                },
                configPath
            );
            host = ts.createCompilerHost(config.options);

            parseProject();
        },

        handleHotUpdate(ctx) {
            if (serverEndpointPathRegex.test(ctx.file)) {
                hotUpdateFiles.push(ctx.file);

                clearTimeout(hotUpdateTimeout);
                hotUpdateTimeout = setTimeout(() => {
                    parseProject(hotUpdateFiles);
                    hotUpdateFiles = [];
                }, 300);
            }
        },
    };
}

const typeFileMessage = `/**
 * This file is generated by sveltekit-api-fetch.
 * Do not edit it, as it will be overwritten.
 * Learn more here: https://github.com/Guibi1/sveltekit-api-fetch
 */\n`;
