const { expertProtocolTemplateService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /api/v1/expert/protocol-templates
 */
const getTemplates = asyncHandler(async (req, res) => {
    const { templates, meta } = await expertProtocolTemplateService.getTemplates(
        req.account,
        req.query,
    );
    ResponseHandler.paginated(res, {
        message: messages.EXPERT_PROTOCOL_TEMPLATE.LIST_FETCHED,
        data: templates,
        meta,
    });
});

/**
 * GET /api/v1/expert/protocol-templates/:templateId
 */
const getTemplate = asyncHandler(async (req, res) => {
    const template = await expertProtocolTemplateService.getTemplate(
        req.account,
        req.params.templateId,
    );
    ResponseHandler.success(res, {
        message: messages.EXPERT_PROTOCOL_TEMPLATE.FETCHED,
        data: template,
    });
});

/**
 * GET /api/v1/expert/protocol-templates/creation-options
 */
const getCreationOptions = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        data: await expertProtocolTemplateService.getCreationOptions(req.account),
    });
});

/**
 * GET /api/v1/expert/protocol-templates/materials
 */
const getMaterials = asyncHandler(async (req, res) => {
    const { materials, meta } = await expertProtocolTemplateService.getMaterials(
        req.account,
        req.query,
    );
    ResponseHandler.paginated(res, {
        data: materials,
        meta,
        message: messages.EXPERT_PROTOCOL_TEMPLATE.MATERIAL_LIST_FETCHED,
    });
});

/**
 * POST /api/v1/expert/protocol-templates
 */
const createTemplate = asyncHandler(async (req, res) => {
    const template = await expertProtocolTemplateService.createTemplate(req.account, req.body);
    ResponseHandler.created(res, {
        data: template,
        message: messages.EXPERT_PROTOCOL_TEMPLATE.CREATED,
    });
});

/**
 * GET /api/v1/expert/protocol-templates/:templateId/editor
 */
const getTemplateEditor = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        data: await expertProtocolTemplateService.getTemplateEditor(
            req.account,
            req.params.templateId,
        ),
    });
});

/**
 * PUT /api/v1/expert/protocol-templates/:templateId
 */
const updateTemplate = asyncHandler(async (req, res) => {
    const template = await expertProtocolTemplateService.updateTemplate(
        req.account,
        req.body,
        req.params.templateId,
    );
    ResponseHandler.success(res, {
        data: template,
        message: messages.EXPERT_PROTOCOL_TEMPLATE.UPDATED,
    });
});

/**
 * DELETE /api/v1/expert/protocol-templates/:templateId
 */
const deleteTemplate = asyncHandler(async (req, res) => {
    await expertProtocolTemplateService.deleteTemplate(
        req.account,
        req.params.templateId,
        req.body.expectedVersionNo,
    );
    ResponseHandler.noContent(res);
});

/**
 * PATCH /api/v1/expert/protocol-templates/:templateId/status
 */
const updateStatus = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        data: await expertProtocolTemplateService.updateStatus(
            req.account,
            req.params.templateId,
            req.body,
        ),
        message: messages.EXPERT_PROTOCOL_TEMPLATE.UPDATED,
    });
});

module.exports = {
    updateStatus,
    getTemplates,
    getTemplate,
    getCreationOptions,
    getMaterials,
    createTemplate,
    getTemplateEditor,
    updateTemplate,
    deleteTemplate,
};
