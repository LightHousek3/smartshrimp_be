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
const aiBasePath = `${config.apiPrefix}/technician/seasons/{seasonId}/ai-diagnoses`;
const aiUpload = autoPaths[aiBasePath]?.post;
if (aiUpload) {
    aiUpload.requestBody = {
        required: true,
        content: { 'multipart/form-data': { schema: {
            type: 'object', required: ['images'], additionalProperties: false,
            properties: { images: { type: 'array', minItems: 1, maxItems: 5,
                items: { type: 'string', format: 'binary' }, description: 'JPEG, PNG or WEBP; at most 10 MiB per image.' } },
        } } },
    };
    aiUpload.description = 'Requires the current technician assignment and an ACTIVE season. Stores private originals and a final success/error log. Failed AI calls use the error envelope; find the stored error in history. Requests are not automatically retried.';
    aiUpload.responses = {
        201: { description: 'Saved result; same data as the detail endpoint' },
        400: { description: 'Invalid upload or image rejected by AI' },
        401: { description: 'Authentication required' },
        403: { description: 'Technician assignment, active account or ACTIVE season required' },
        404: { description: 'Season not found' },
        409: { description: 'Concurrent state change' },
        429: { description: 'Technician or AI rate limit exceeded' },
        502: { description: 'Invalid AI result; error stored in history' },
        503: { description: 'Storage or AI unavailable; AI busy' },
        504: { description: 'AI timed out; error stored in history' },
    };
}
if (autoPaths[aiBasePath]?.get) {
    autoPaths[aiBasePath].get.description = 'Own requests only, with a current assignment. Completed/cancelled seasons remain readable. Newest first, stable cursor pagination. data: [{id, createdAt, runStatus, imageCount, predictedLabel?, confidence?}]; meta: {totalResults, hasNextPage, nextCursor}.';
}
if (autoPaths[`${aiBasePath}/{diagnosisId}`]?.get) {
    autoPaths[`${aiBasePath}/{diagnosisId}`].get.description = 'Own result only, with a current assignment. data: {id, seasonId, createdAt, runStatus, imageUrls, imageUrlsExpireAt?, modelVersion, processingTimeMs, predictedLabel?, confidence?, predictions?, recommendation?, error?: {code, message}}. New image URLs expire after five minutes; reload detail to refresh. Internal input snapshots are never returned.';
}
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
