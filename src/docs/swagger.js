const swaggerJSDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const config = require('../config');
const { buildAutoPaths } = require('./swaggerAutoPaths');

const baseUrl = config.app?.backendUrl || `http://localhost:${config.port}`;
const {
    paths: autoPaths,
    tags: autoTags,
    schemas: autoSchemas,
    endpointCount,
} = buildAutoPaths(config.apiPrefix);

const notificationDetailPath = `${config.apiPrefix}/notifications/{notificationId}`;
const { RAG_DOCUMENT_CATEGORIES } = require('../constants');
const documentUpload = autoPaths[`${config.apiPrefix}/admin/rag/documents`]?.post;
if (documentUpload) {
    documentUpload.requestBody = {
        required: true,
        content: {
            'multipart/form-data': {
                schema: {
                    type: 'object', required: ['file', 'title'], additionalProperties: false,
                    properties: {
                        file: { type: 'string', format: 'binary', description: 'PDF, DOCX, MD or TXT, up to 10 MiB' },
                        title: { type: 'string', maxLength: 255 }, category: { type: 'string', enum: RAG_DOCUMENT_CATEGORIES },
                        description: { type: 'string', maxLength: 1000 },
                    },
                },
            },
        },
    };
    documentUpload.responses = {
        202: { description: 'Original stored; indexing queued. Poll GET documents for status.' },
        400: { description: 'Invalid, empty or unreadable document' },
        401: { description: 'Authentication required' },
        403: { description: 'Admin role required' },
        413: { description: 'Document exceeds 10 MiB' },
        429: { description: 'Write rate limit exceeded' },
        503: { description: 'Cloudinary is unconfigured or original storage failed' },
    };
}
if (autoPaths[notificationDetailPath]?.get) {
    autoPaths[notificationDetailPath].get.description =
        'Returns an owned notification and records readAt on the first successful detail request. Repeated requests preserve the original readAt.';
}

const options = {
    definition: {
        openapi: '3.0.3',
        info: {
            title: 'Smart Shrimp API',
            version: '1.0.0',
            description: `Auto-generated API documentation for Smart Shrimp (${endpointCount} endpoints discovered from route files).`,
        },
        servers: [
            {
                url: baseUrl,
                description: `${config.env} server`,
            },
        ],
        tags: [{ name: 'Health' }, ...autoTags],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
            schemas: {
                ...autoSchemas,
            },
        },
        paths: {
            '/health': {
                get: {
                    tags: ['Health'],
                    summary: 'Health check',
                    operationId: 'health_check',
                    responses: {
                        200: {
                            description: 'Server health information',
                        },
                    },
                },
            },
            ...autoPaths,
        },
    },
    apis: [],
};

const swaggerSpec = swaggerJSDoc(options);

module.exports = {
    swaggerUi,
    swaggerSpec,
};
