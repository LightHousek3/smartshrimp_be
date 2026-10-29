const express = require('express');
const { expertProtocolTemplateController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { expertProtocolTemplateValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();
router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});

/**
 * @route   GET /api/v1/expert/protocol-templates/creation-options
 * @desc    Read owned active farms available for template authoring.
 * @access  Private (Expert)
 */
router.get(
    '/creation-options',
    authenticate,
    authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertProtocolTemplateValidator.creationOptions),
    expertProtocolTemplateController.getCreationOptions
);

/**
 * @route   GET /api/v1/expert/protocol-templates/materials
 * @desc    Search the selected farm's catalog and current stock; never reserve inventory.
 * @access  Private (Expert)
 */
router.get(
    '/materials',
    authenticate,
    authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertProtocolTemplateValidator.getMaterials),
    expertProtocolTemplateController.getMaterials
);

/**
 * @route   POST /api/v1/expert/protocol-templates
 * @desc    Create a one-based production template with per-occurrence doses and proposal snapshots.
 * @access  Private (Expert)
 */
router.post(
    '/',
    authenticate,
    authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertProtocolTemplateValidator.createTemplate),
    expertProtocolTemplateController.createTemplate
);

/**
 * @route   GET /api/v1/expert/protocol-templates
 * @desc    List owned production templates with optional search, farm, species and status filters.
 * @access  Private (Expert)
 */
router.get(
    '/',
    authenticate,
    authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertProtocolTemplateValidator.getTemplates),
    expertProtocolTemplateController.getTemplates
);

/**
 * @route   GET /api/v1/expert/protocol-templates/:templateId
 * @desc    View template metadata and per-meal operation rules; no schedule generation.
 * @access  Private (Expert)
 */
router.get(
    '/:templateId',
    authenticate,
    authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertProtocolTemplateValidator.getTemplate),
    expertProtocolTemplateController.getTemplate
);

/**
 * @route   GET /api/v1/expert/protocol-templates/:templateId/editor
 * @desc    Read editable rules, material identities and safety warnings for an owned template.
 * @access  Private (Expert)
 */
router.get(
    '/:templateId/editor',
    authenticate,
    authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertProtocolTemplateValidator.getTemplate),
    expertProtocolTemplateController.getTemplateEditor
);
/**
 * @route   PUT /api/v1/expert/protocol-templates/:templateId
 * @desc    Atomically replace template rules and increment its version; never rewrite applied schedules.
 * @access  Private (Expert)
 */
router.put(
    '/:templateId',
    authenticate,
    authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertProtocolTemplateValidator.updateTemplate),
    expertProtocolTemplateController.updateTemplate
);

/**
 * @route   DELETE /api/v1/expert/protocol-templates/:templateId
 * @desc    Hard-delete an unreferenced template with version protection.
 * @access  Private (Expert)
 */
router.delete(
    '/:templateId',
    authenticate,
    authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertProtocolTemplateValidator.deleteTemplate),
    expertProtocolTemplateController.deleteTemplate
);

/**
 * @route   PATCH /api/v1/expert/protocol-templates/:templateId/status
 * @desc    Change availability with version protection; preserve all material rules.
 * @access  Private (Expert)
 */
router.patch(
    '/:templateId/status',
    authenticate,
    authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertProtocolTemplateValidator.updateStatus),
    expertProtocolTemplateController.updateStatus
);

module.exports = router;
