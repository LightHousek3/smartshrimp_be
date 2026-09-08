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
