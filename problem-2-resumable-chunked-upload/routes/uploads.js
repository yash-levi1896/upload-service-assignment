const express = require('express');
const router = express.Router();

const controller = require('../controllers/uploadsController');
const chunkUploadLimiter = require('../middleware/chunkUploadLimiter');

router.post('/initiate', controller.initiateUpload);
router.post('/:uploadId/chunk', chunkUploadLimiter, controller.uploadChunk);
router.get('/:uploadId/status', controller.getStatus);
router.post('/:uploadId/complete', controller.completeUpload);
router.delete('/:uploadId', controller.deleteUpload);

module.exports = router;
