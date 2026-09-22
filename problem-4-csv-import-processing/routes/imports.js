const express = require('express');
const router = express.Router();

const controller = require('../controllers/importsController');
const uploadLimiter = require('../middleware/uploadLimiter');

router.post('/', uploadLimiter, controller.createImport);
router.get('/:id/status', controller.getStatus);
router.get('/:id/errors', controller.getErrorsFile);
router.get('/:id', controller.getImport);
router.delete('/:id', controller.deleteImport);

module.exports = router;
