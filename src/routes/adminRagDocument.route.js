const express = require('express');
const { authenticate, authorize, validate, writeLimiter } = require('../middlewares');
const { ragDocumentValidator: validator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');
const { ragDocumentController: controller } = require('../controllers');

const router = express.Router();
router.use(authenticate, authorize(ACCOUNT_ROLE.ADMIN));
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

/**
 * @route   GET /api/v1/admin/rag/documents
 * @desc    List knowledge documents with search, filters and pagination
 * @access  Admin
 */
router.get('/', validate(validator.list), controller.listDocuments);

/**
 * @route   POST /api/v1/admin/rag/documents/upload-intents
 * @desc    Reserve a document and sign a direct browser upload to Cloudinary
 * @access  Admin
 */
router.post('/upload-intents', writeLimiter, validate(validator.createUploadIntent), controller.createUploadIntent);

/**
 * @route   POST /api/v1/admin/rag/documents/:id/complete-upload
 * @desc    Confirm a signed Cloudinary upload and queue the document for AI processing
 * @access  Admin
 */
router.post('/:id/complete-upload', writeLimiter, validate(validator.completeUpload), controller.completeUpload);

/**
 * @route   POST /api/v1/admin/rag/documents/:id/reupload-intents
 * @desc    Sign a replacement upload for a failed document whose original file is missing
 * @access  Admin
 */
router.post('/:id/reupload-intents', writeLimiter, validate(validator.createReuploadIntent), controller.createReuploadIntent);

/**
 * @route   POST /api/v1/admin/rag/documents/:id/complete-reupload
 * @desc    Confirm the restored original file and queue the document for AI processing again
 * @access  Admin
 */
router.post('/:id/complete-reupload', writeLimiter, validate(validator.completeUpload), controller.completeReupload);

/**
 * @route   POST /api/v1/admin/rag/documents/:id/cancel-upload
 * @desc    Cancel an upload owned by the authenticated Admin and schedule cleanup
 * @access  Admin
 */
router.post('/:id/cancel-upload', writeLimiter, validate(validator.byId), controller.cancelUpload);

/**
 * @route   GET /api/v1/admin/rag/documents/:id
 * @desc    Get knowledge document details and processing status
 * @access  Admin
 */
router.get('/:id', validate(validator.byId), controller.getDocument);

/**
 * @route   GET /api/v1/admin/rag/documents/:id/file
 * @desc    Download the original knowledge document from Cloudinary
 * @access  Admin
 */
router.get('/:id/file', validate(validator.byId), controller.downloadDocument);

/**
 * @route   PATCH /api/v1/admin/rag/documents/:id
 * @desc    Update document metadata or enable and disable retrieval for a ready document
 * @access  Admin
 */
router.patch('/:id', writeLimiter, validate(validator.update), controller.updateDocument);

/**
 * @route   POST /api/v1/admin/rag/documents/:id/retry
 * @desc    Queue a failed document for AI processing again
 * @access  Admin
 */
router.post('/:id/retry', writeLimiter, validate(validator.byId), controller.retryDocument);

module.exports = router;
