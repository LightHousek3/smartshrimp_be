const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');
const ROUTES_INDEX_FILE = path.join(ROUTES_DIR, 'index.js');

function normalizePath(rawPath) {
    const compact = rawPath.replace(/\/+/g, '/');
    if (compact.length > 1 && compact.endsWith('/')) {
        return compact.slice(0, -1);
    }
    return compact;
}

function toOasPath(expressPath) {
    return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function toTag(basePath) {
    const cleaned = basePath.replace(/^\//, '').replace(/-/g, ' ').trim();
    if (!cleaned) {
        return 'General';
    }

    return cleaned
        .split('/')
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' ');
}

function safeRequireFromRoute(routeFile, requirePath) {
    try {
        if (requirePath.startsWith('.')) {
            const routeDir = path.dirname(routeFile);
            const resolvedPath = path.resolve(routeDir, requirePath);
            return require(resolvedPath);
        }

        return require(requirePath);
    } catch (error) {
        return undefined;
    }
}

function parseRouteImports(routeSource, routeFile) {
    const imports = {};

    const fullImportRegex = /const\s+(\w+)\s*=\s*require\(['"](.+?)['"]\);/g;
    let fullImportMatch;
    while ((fullImportMatch = fullImportRegex.exec(routeSource)) !== null) {
        const variableName = fullImportMatch[1];
        const requirePath = fullImportMatch[2];
        imports[variableName] = safeRequireFromRoute(routeFile, requirePath);
    }

    const namedImportRegex = /const\s+\{\s*([^}]+?)\s*\}\s*=\s*require\(['"](.+?)['"]\);/g;
    let namedImportMatch;
    while ((namedImportMatch = namedImportRegex.exec(routeSource)) !== null) {
        const requirePath = namedImportMatch[2];
        const moduleValue = safeRequireFromRoute(routeFile, requirePath);
        if (!moduleValue || typeof moduleValue !== 'object') {
            continue;
        }

        const namedImports = namedImportMatch[1]
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        namedImports.forEach((entry) => {
            const [importedName, aliasName] = entry.split(':').map((item) => item.trim());
            const localName = aliasName || importedName;
            imports[localName] = moduleValue[importedName];
        });
    }

    return imports;
}

function resolveReferencePath(referencePath, imports) {
    const chain = referencePath.split('.');
    const rootName = chain.shift();
    let value = imports[rootName];

    if (typeof value === 'undefined') {
        return undefined;
    }

    for (const key of chain) {
        if (!value || typeof value !== 'object' || !(key in value)) {
            return undefined;
        }
        value = value[key];
    }

    return value;
}

function extractValidationSchema(middlewareBlock, imports) {
    const strippedMiddleware = middlewareBlock.replace(/\/\/.*$/gm, '');
    const validateMatch = strippedMiddleware.match(/validate\(\s*([A-Za-z0-9_$.]+)\s*\)/);

    if (!validateMatch) {
        return undefined;
    }

    const schema = resolveReferencePath(validateMatch[1], imports);
    if (!schema || typeof schema !== 'object') {
        return undefined;
    }

    return schema;
}

function hasPrecedingRouterAuth(routeSource, routeIndex) {
    const precedingSource = routeSource.slice(0, routeIndex);
    const routerUseRegex = /(?:^|\n)\s*router\.use\s*\(([\s\S]*?)\)\s*;/g;
    let match;

    while ((match = routerUseRegex.exec(precedingSource)) !== null) {
        const middlewareBlock = match[1].replace(/\/\/.*$/gm, '');
        if (/\bauthenticate\b/.test(middlewareBlock)) {
            return true;
        }
    }

    return false;
}

function getRule(description, name) {
    if (!description || !Array.isArray(description.rules)) {
        return undefined;
    }

    return description.rules.find((rule) => rule.name === name);
}

function joiDescriptionToSchema(description) {
    if (!description || typeof description !== 'object') {
        return { type: 'object', additionalProperties: true };
    }

    if (description.type === 'object') {
        const properties = {};
        const required = [];
        const keys = description.keys || {};

        Object.keys(keys).forEach((key) => {
            const child = keys[key];
            properties[key] = joiDescriptionToSchema(child);
            if (child?.flags?.presence === 'required') {
                required.push(key);
            }
        });

        const objectSchema = {
            type: 'object',
            properties,
            additionalProperties: false,
        };

        if (required.length > 0) {
            objectSchema.required = required;
        }

        return objectSchema;
    }

    if (description.type === 'array') {
        return {
            type: 'array',
            items: joiDescriptionToSchema(description.items?.[0]),
        };
    }

    if (description.type === 'date') {
        return { type: 'string', format: 'date-time' };
    }

    if (description.type === 'number') {
        const schema = { type: 'number' };
        if (getRule(description, 'integer')) {
            schema.type = 'integer';
        }
        const minRule = getRule(description, 'min');
        const maxRule = getRule(description, 'max');
        if (minRule?.args?.limit !== undefined) {
            schema.minimum = minRule.args.limit;
        }
        if (maxRule?.args?.limit !== undefined) {
            schema.maximum = maxRule.args.limit;
        }
        return schema;
    }

    if (description.type === 'boolean') {
        return { type: 'boolean' };
    }

    if (description.type === 'string') {
        const schema = { type: 'string' };
        const lengthRule = getRule(description, 'length');
        const minRule = getRule(description, 'min');
        const maxRule = getRule(description, 'max');
        const patternRule = getRule(description, 'pattern');
        const emailRule = getRule(description, 'email');
        const uriRule = getRule(description, 'uri');
        const hexRule = getRule(description, 'hex');

        if (lengthRule?.args?.limit !== undefined) {
            schema.minLength = lengthRule.args.limit;
            schema.maxLength = lengthRule.args.limit;
        }
        if (minRule?.args?.limit !== undefined) {
            schema.minLength = minRule.args.limit;
        }
        if (maxRule?.args?.limit !== undefined) {
            schema.maxLength = maxRule.args.limit;
        }
        if (patternRule?.args?.regex) {
            schema.pattern = patternRule.args.regex
                .toString()
                .replace(/^\//, '')
                .replace(/\/[a-z]*$/, '');
        }
        if (emailRule) {
            schema.format = 'email';
        }
        if (uriRule) {
            schema.format = 'uri';
        }
        if (hexRule && lengthRule?.args?.limit === 24) {
            schema.pattern = '^[a-fA-F0-9]{24}$';
        }

        return schema;
    }

    return { type: 'object', additionalProperties: true };
}

function joiToParameters(schema, paramIn) {
    if (!schema || typeof schema.describe !== 'function') {
        return [];
    }

    const description = schema.describe();
    const keys = description?.keys || {};

    return Object.keys(keys).map((key) => ({
        name: key,
        in: paramIn,
        required: paramIn === 'path' ? true : keys[key]?.flags?.presence === 'required',
        schema: joiDescriptionToSchema(keys[key]),
    }));
}

function toSchemaName(input) {
    return String(input)
        .replace(/\{(.*?)\}/g, '$1')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_')
        .replace(/^[0-9]/, 'Schema_$&');
}

function inferStringExample(schemaNode, keyName = '') {
    const key = String(keyName).toLowerCase();
    if (Array.isArray(schemaNode?.enum) && schemaNode.enum.length > 0) {
        return String(schemaNode.enum[0]);
    }

    if (schemaNode?.format === 'email' || key.includes('email')) {
        return 'smartshrimp@gmail.com';
    }

    if (schemaNode?.format === 'uri' || key.includes('avatar') || key.includes('image')) {
        return 'https://example.com/image.jpg';
    }

    if (schemaNode?.format === 'date-time') {
        return '2026-03-24T00:00:00.000Z';
    }

    if (key.includes('date')) {
        return '2026-03-24';
    }

    if (key.includes('firstname')) return 'Dang';
    if (key.includes('lastname')) return 'Customer';
    if (key.includes('name')) return 'Demo Name';
    if (key.includes('gender')) return 'FEMALE';
    if (key.includes('address')) return 'Ấp 8, Thới Bình, Cà Mau';
    if (key.includes('age')) return 18;
    if (key.includes('title')) return 'Demo Title';
    if (key.includes('description')) return 'Demo description';
    if (key.includes('password')) return '123456';
    if (key.includes('phone')) return '0912345678';
    if (key.endsWith('id') || key === 'id') return '65f1b8f0a8c9b1d2e3f4a5b6';

    if (schemaNode?.pattern && /\^[0-9]{10,11}\$/.test(schemaNode.pattern)) {
        return '0912345678';
    }

    return 'demo';
}

function buildExampleFromSchema(schemaNode, keyName = '') {
    if (!schemaNode || typeof schemaNode !== 'object') {
        return null;
    }

    if (schemaNode.type === 'object') {
        const out = {};
        const properties = schemaNode.properties || {};
        Object.keys(properties).forEach((key) => {
            out[key] = buildExampleFromSchema(properties[key], key);
        });

        if (Object.keys(out).length === 0) {
            return { sample: 'demo' };
        }

        return out;
    }

    if (schemaNode.type === 'array') {
        return [buildExampleFromSchema(schemaNode.items || { type: 'string' }, keyName)];
    }

    if (schemaNode.type === 'integer') {
        if (schemaNode.minimum !== undefined) return schemaNode.minimum;
        return 1;
    }

    if (schemaNode.type === 'number') {
        if (schemaNode.minimum !== undefined) return schemaNode.minimum;
        return 1.5;
    }

    if (schemaNode.type === 'boolean') {
        return true;
    }

    return inferStringExample(schemaNode, keyName);
}

function setRequestBodyWithComponentSchema(operation, method, operationId, schema, schemaRegistry) {
    const normalizedSchema = schema || { type: 'object', additionalProperties: true };
    const schemaKey = JSON.stringify(normalizedSchema);
    let schemaName = schemaRegistry.byFingerprint.get(schemaKey);

    if (!schemaName) {
        schemaName = toSchemaName(`${operationId}_request`);
        schemaRegistry.schemas[schemaName] = normalizedSchema;
        schemaRegistry.byFingerprint.set(schemaKey, schemaName);
    }

    operation.requestBody = {
        required: ['post', 'put', 'patch'].includes(method),
        content: {
            'application/json': {
                schema: {
                    $ref: `#/components/schemas/${schemaName}`,
                },
                example: buildExampleFromSchema(normalizedSchema),
            },
        },
    };
}

function parseRouteRegistry(indexSource) {
    const imports = {};
    const importRegex = /const\s+(\w+)\s*=\s*require\(['"](.+?)['"]\);/g;
    let importMatch;

    while ((importMatch = importRegex.exec(indexSource)) !== null) {
        imports[importMatch[1]] = importMatch[2];
    }

    const registry = [];
    const routeEntryRegex = /\{\s*path:\s*['"](.+?)['"]\s*,\s*route:\s*(\w+)\s*\}/g;
    let routeMatch;

    while ((routeMatch = routeEntryRegex.exec(indexSource)) !== null) {
        const basePath = routeMatch[1];
        const routeVarName = routeMatch[2];
        const requirePath = imports[routeVarName];

        if (!requirePath) {
            continue;
        }

        const absoluteRouteFile = path.resolve(ROUTES_DIR, `${requirePath}.js`);
        registry.push({
            basePath,
            routeFile: absoluteRouteFile,
            routeVarName,
        });
    }

    return registry;
}

function buildOperation({
    method,
    fullExpressPath,
    sourceFile,
    middlewareBlock,
    tag,
    validationSchema,
    schemaRegistry,
    routerRequiresAuth,
}) {
    const oasPath = toOasPath(fullExpressPath);
    const operationId = `${method}_${oasPath.replace(/[{}/:-]/g, '_').replace(/_+/g, '_')}`;

    const strippedMiddleware = middlewareBlock.replace(/\/\/.*$/gm, '');
    const requiresAuth = routerRequiresAuth || /\bauthenticate\b/.test(strippedMiddleware);

    const params = [];
    const parameterIndex = new Map();
    const addParameter = (parameter) => {
        const key = `${parameter.in}:${parameter.name}`;
        if (parameterIndex.has(key)) {
            const idx = parameterIndex.get(key);
            params[idx] = parameter;
            return;
        }
        parameterIndex.set(key, params.length);
        params.push(parameter);
    };

    const paramRegex = /:([A-Za-z0-9_]+)/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(fullExpressPath)) !== null) {
        addParameter({
            name: paramMatch[1],
            in: 'path',
            required: true,
            schema: { type: 'string' },
        });
    }

    if (validationSchema?.params) {
        joiToParameters(validationSchema.params, 'path').forEach(addParameter);
    }

    if (validationSchema?.query) {
        joiToParameters(validationSchema.query, 'query').forEach(addParameter);
    }

    const operation = {
        tags: [tag],
        summary: `${method.toUpperCase()} ${oasPath}`,
        operationId,
        responses: {
            default: {
                description: 'Request processed',
            },
        },
        'x-source-file': sourceFile,
    };

    if (params.length > 0) {
        operation.parameters = params;
    }

    if (requiresAuth) {
        operation.security = [{ bearerAuth: [] }];
    }

    if (validationSchema?.body && typeof validationSchema.body.describe === 'function') {
        setRequestBodyWithComponentSchema(
            operation,
            method,
            operationId,
            joiDescriptionToSchema(validationSchema.body.describe()),
            schemaRegistry,
        );
    }

    return { oasPath, operation };
}

function parseRouteFile(routeSource, routeFile, basePath, apiPrefix, schemaRegistry) {
    const tag = toTag(basePath);
    const operations = [];
    const imports = parseRouteImports(routeSource, routeFile);

    const routeRegex =
        /(?:^|\n)\s*router\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2\s*,([\s\S]*?)\)\s*;/g;
    let match;

    while ((match = routeRegex.exec(routeSource)) !== null) {
        const method = match[1].toLowerCase();
        const childPath = match[3];
        const middlewareBlock = match[4] || '';
        const validationSchema = extractValidationSchema(middlewareBlock, imports);
        const routerRequiresAuth = hasPrecedingRouterAuth(routeSource, match.index);

        const fullExpressPath = normalizePath(
            `${apiPrefix}${basePath}/${childPath}`.replace(/\/+/g, '/'),
        );

        const sourceFile = path.relative(path.join(__dirname, '..'), routeFile).replace(/\\/g, '/');
        const { oasPath, operation } = buildOperation({
            method,
            fullExpressPath,
            sourceFile,
            middlewareBlock,
            tag,
            validationSchema,
            schemaRegistry,
            routerRequiresAuth,
        });

        operations.push({ method, oasPath, operation, tag });
    }

    return operations;
}

function buildAutoPaths(apiPrefix) {
    const paths = {};
    const tags = [];
    const schemas = {};
    const byFingerprint = new Map();
    const schemaRegistry = { schemas, byFingerprint };
    const seenTag = new Set();

    if (!fs.existsSync(ROUTES_INDEX_FILE)) {
        return { paths, tags, schemas, endpointCount: 0 };
    }

    const indexSource = fs.readFileSync(ROUTES_INDEX_FILE, 'utf8');
    const registry = parseRouteRegistry(indexSource);

    registry.forEach(({ basePath, routeFile }) => {
        if (!fs.existsSync(routeFile)) {
            return;
        }

        const routeSource = fs.readFileSync(routeFile, 'utf8');
        const operations = parseRouteFile(
            routeSource,
            routeFile,
            basePath,
            apiPrefix,
            schemaRegistry,
        );

        operations.forEach(({ method, oasPath, operation, tag }) => {
            if (!paths[oasPath]) {
                paths[oasPath] = {};
            }

            paths[oasPath][method] = operation;

            if (!seenTag.has(tag)) {
                seenTag.add(tag);
                tags.push({ name: tag });
            }
        });
    });

    return {
        paths,
        tags,
        schemas,
        endpointCount: Object.values(paths).reduce(
            (total, methods) => total + Object.keys(methods).length,
            0,
        ),
    };
}

module.exports = {
    buildAutoPaths,
};
