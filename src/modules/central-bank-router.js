const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const requireRoles = require('../middlewares/require-roles');
const centralBankService = require('./central-bank-service');
const { uuidLike } = require('../utils/schemas');

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

const syncAccountsQuerySchema = environmentSchema.extend({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const syncAccountParamsSchema = z.object({
  accountId: uuidLike,
});

const bankCodeParamsSchema = z.object({
  bankCode: z.coerce.number().int().positive(),
});

const syncAccountsBodySchema = environmentSchema.extend({
  accountIds: z.array(uuidLike).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
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

router.get(
  '/banks',
  internalOnly,
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.listBanks(req.query.environment);
    res.json(data);
  })
);

router.get(
  '/banks/:bankCode',
  internalOnly,
  validate(bankCodeParamsSchema, 'params'),
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.getBankByCode(
      req.params.bankCode,
      req.query.environment
    );
    res.json(data);
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
  internalOnly,
  validate(personSchema),
  asyncHandler(async (req, res) => {
    const { environment, ...payload } = req.body;
    const result = await centralBankService.registerPerson(payload, environment, {
      includeResponseMeta: true,
    });
    res.status(result.status).json(result.data);
  })
);

router.get(
  '/persons/alias/:alias',
  internalOnly,
  validate(aliasParamsSchema, 'params'),
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.findPersonByAlias(req.params.alias, req.query.environment);
    res.json(data);
  })
);

router.get(
  '/persons/:cbu',
  internalOnly,
  validate(cbuParamsSchema, 'params'),
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.findPersonByCbu(req.params.cbu, req.query.environment);
    res.json(data);
  })
);

router.put(
  '/persons/:cbu/alias',
  internalOnly,
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
  internalOnly,
  validate(environmentSchema, 'query'),
  asyncHandler(async (req, res) => {
    const data = await centralBankService.listTransactions(req.query.environment);
    res.json(data);
  })
);

router.post(
  '/transactions',
  internalOnly,
  validate(transactionSchema),
  asyncHandler(async (req, res) => {
    const { environment, ...payload } = req.body;
    const data = await centralBankService.createTransaction(payload, environment);
    res.status(201).json(data);
  })
);

router.get(
  '/sync/accounts',
  internalOnly,
  validate(syncAccountsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const accounts = await centralBankService.listSyncAccounts(req.query);
    res.json({ accounts });
  })
);

router.post(
  '/sync/accounts/bulk',
  internalOnly,
  validate(syncAccountsBodySchema),
  asyncHandler(async (req, res) => {
    const result = await centralBankService.syncAccounts(req.body);
    res.status(201).json(result);
  })
);

router.post(
  '/sync/accounts/:accountId',
  internalOnly,
  validate(syncAccountParamsSchema, 'params'),
  validate(environmentSchema),
  asyncHandler(async (req, res) => {
    const result = await centralBankService.syncAccount(
      req.params.accountId,
      req.body.environment
    );
    res.status(201).json(result);
  })
);

module.exports = router;
