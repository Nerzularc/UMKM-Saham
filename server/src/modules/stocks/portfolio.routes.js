import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import * as portfolioController from './portfolio.controller.js';

const router = express.Router();
router.use(requireAuth);

const CURRENCY = /^[A-Z]{3}$/;

router.get('/', portfolioController.list);
router.post('/',
  [
    body('name').trim().isLength({ min: 1, max: 255 }).withMessage('Portfolio name is required.'),
    body('baseCurrency').optional().customSanitizer((v) => String(v).toUpperCase()).matches(CURRENCY),
    body('costBasisMethod').optional().isIn(['WAC', 'FIFO']),
    body('portfolioType').optional().isIn(['tracking', 'simulation']),
    body('orgId').optional({ values: 'null' }).isUUID(),
  ],
  validate,
  portfolioController.create,
);
router.get('/:id', portfolioController.getOne);
router.get('/:id/holdings', portfolioController.holdings);
router.get('/:id/performance', portfolioController.performance);
router.put('/:id',
  [
    body('name').optional().trim().isLength({ min: 1, max: 255 }),
    body('costBasisMethod').optional().isIn(['WAC', 'FIFO']),
    body('baseCurrency').optional().customSanitizer((v) => String(v).toUpperCase()).matches(CURRENCY),
  ],
  validate,
  portfolioController.update,
);
router.delete('/:id', portfolioController.remove);

export default router;
