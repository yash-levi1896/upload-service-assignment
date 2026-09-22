const express = require('express');
const router = express.Router();

const controller = require('../controllers/filesController');
const uploadLimiter = require('../middleware/uploadLimiter');

router.post('/upload/init', controller.initUpload);
router.post('/upload', uploadLimiter, controller.uploadFile);
router.get('/:id/status', controller.getStatus);
router.get('/:id/download', controller.downloadFile);
router.get('/:id', controller.getFile);
router.delete('/:id', controller.deleteFile);

module.exports = router;
