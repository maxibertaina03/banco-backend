const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const crudService = require('./crud-service');
const { uuidLike } = require('../utils/schemas');
const { armarContextoDeAuditoria } = require('../utils/audit');
const { paginationSchema } = require('../utils/pagination');

const paramsSchema = z.object({
  id: uuidLike,
});

function createCrudRouter(entityConfig) {
  const router = express.Router();
  const access = entityConfig.access || {};
  const listAccess = access.list || [];
  const getAccess = access.get || [];
  const createAccess = access.create || [];
  const updateAccess = access.update || [];
  const deleteAccess = access.delete || [];

  router.get(
    '/',
    ...listAccess,
    validate(paginationSchema, 'query'),
    asyncHandler(async (req, res) => {
      const data = await crudService.list(entityConfig, req.query);
      res.json(data);
    })
  );

  router.get(
    '/:id',
    ...getAccess,
    validate(paramsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const data = await crudService.getById(entityConfig, req.params.id);
      res.json(data);
    })
  );

  router.post(
    '/',
    ...createAccess,
    validate(entityConfig.createSchema),
    asyncHandler(async (req, res) => {
      const created = await crudService.create(entityConfig, req.body, armarContextoDeAuditoria(req));
      res.status(201).json(created);
    })
  );

  router.put(
    '/:id',
    ...updateAccess,
    validate(paramsSchema, 'params'),
    validate(entityConfig.updateSchema),
    asyncHandler(async (req, res) => {
      const updated = await crudService.update(entityConfig, req.params.id, req.body, armarContextoDeAuditoria(req));
      res.json(updated);
    })
  );

  router.delete(
    '/:id',
    ...deleteAccess,
    validate(paramsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const deleted = await crudService.remove(entityConfig, req.params.id, armarContextoDeAuditoria(req));
      res.json({
        message: 'Registro eliminado correctamente.',
        data: deleted,
      });
    })
  );

  return router;
}

module.exports = createCrudRouter;
