const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const requireRoles = require('../middlewares/require-roles');
const centralBankService = require('./central-bank-service');

const router = express.Router();
const internalOnly = requireRoles(['admin', 'operador', 'tesoreria']);
const adminOnly = requireRoles(['admin']);

const environmentSchema = z.object({
  environment: z.enum(['test', 'prod']).optional(),
});

const registerBankSchema = environmentSchema.extend({
  name: z.string().trim().min(1).optional(),
});

const updateBankNameSchema = environmentSchema.extend({
  name: z.string().trim().min(1),
});

const configSchema = environmentSchema.extend({
  apiUrl: z.string().trim().url().optional(),
  registerToken: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  bankName: z.string().trim().min(1).optional(),
  activo: z.boolean().optional(),
});

const personSchema = environmentSchema.extend({
  nombre: z.string().trim().min(1),
  apellido: z.string().trim().min(1),
  dni: z.string().trim().min(1),
});

const cbuParamsSchema = z.object({
  cbu: z.string().trim().min(1),
});

const aliasParamsSchema = z.object({
  alias: z.string().trim().min(1),
});

const aliasBodySchema = environmentSchema.extend({
  alias: z.string().trim().regex(/^[A-Za-z0-9.-]+$/, 'Alias invalido.'),
});

const transactionSchema = environmentSchema.extend({
  cbuOrigen: z.string().trim().min(1),
  cbuDestino: z.string().trim().min(1),
  importe: z.coerce.number().positive(),
  saldoOrigen: z.coerce.number().nonnegative(),
});

router.get(
  '/config',
  adminOnly,
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const config = await centralBankService.getConfig(req.query.environment);
    res.json({ config });
  })
);

router.put(
  '/config',
  adminOnly,
  validate(configSchema),
  asyncHandler(async (req, res) => {
    const config = await centralBankService.saveConfig(req.body);
    res.json({ config });
  })
);

router.get(
  '/registration',
  internalOnly,
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const registration = await centralBankService.getLocalRegistration(req.query.environment);
    res.json({ registration });
  })
);

router.post(
  '/banks',
  internalOnly,
  validate(registerBankSchema),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.registerBank(req.body);
    res.status(201).json(data);
  })
);

router.put(
  '/banks/me',
  internalOnly,
  validate(updateBankNameSchema),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.updateBankName(req.body);
    res.json(data);
  })
);

router.post(
  '/persons',
  validate(personSchema),
  asyncHandler(async (req, res) => {
    const { environment, ...payload } = req.body;
    const data = await centralBankService.registerPerson(payload, environment);
    res.status(201).json(data);
  })
);

router.get(
  '/persons/alias/:alias',
  validate(aliasParamsSchema, 'params'),
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.findPersonByAlias(req.params.alias, req.query.environment);
    res.json(data);
  })
);

router.get(
  '/persons/:cbu',
  validate(cbuParamsSchema, 'params'),
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.findPersonByCbu(req.params.cbu, req.query.environment);
    res.json(data);
  })
);

router.put(
  '/persons/:cbu/alias',
  validate(cbuParamsSchema, 'params'),
  validate(aliasBodySchema),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.assignAlias(
      req.params.cbu,
      req.body.alias,
      req.body.environment
    );
    res.json(data);
  })
);

router.get(
  '/transactions',
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.listTransactions(req.query.environment);
    res.json(data);
  })
);

router.post(
  '/transactions',
  validate(transactionSchema),
  asyncHandler(async (req, res) => {
    const { environment, ...payload } = req.body;
    const data = await centralBankService.createTransaction(payload, environment);
    res.status(201).json(data);
  })
);

module.exports = router;
