const express = require('express');
const router = express.Router();

const controller = require('../controllers/uploadsController');

router.post('/initiate', controller.initiateUpload);
router.post('/:id/presigned-url', controller.getPresignedPartUrl);
router.post('/:id/complete', controller.completeUpload);
router.get('/:id/status', controller.getStatus);
router.get('/:id/download-url', controller.getDownloadUrl);
router.delete('/:id', controller.deleteUpload);

module.exports = router;
