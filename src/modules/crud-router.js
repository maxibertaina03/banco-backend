const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const crudService = require('./crud-service');
const { uuidLike } = require('../utils/schemas');

const paramsSchema = z.object({
  id: uuidLike,
});

function createCrudRouter(entityConfig) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const data = await crudService.list(entityConfig, req.query);
      res.json(data);
    })
  );

  router.get(
    '/:id',
    validate(paramsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const data = await crudService.getById(entityConfig, req.params.id);
      res.json(data);
    })
  );

  router.post(
    '/',
    validate(entityConfig.createSchema),
    asyncHandler(async (req, res) => {
      const created = await crudService.create(entityConfig, req.body);
      res.status(201).json(created);
    })
  );

  router.put(
    '/:id',
    validate(paramsSchema, 'params'),
    validate(entityConfig.updateSchema),
    asyncHandler(async (req, res) => {
      const updated = await crudService.update(entityConfig, req.params.id, req.body);
      res.json(updated);
    })
  );

  router.delete(
    '/:id',
    validate(paramsSchema, 'params'),
    asyncHandler(async (req, res) => {
      const deleted = await crudService.remove(entityConfig, req.params.id);
      res.json({
        message: 'Registro eliminado correctamente.',
        data: deleted,
      });
    })
  );

  return router;
}

module.exports = createCrudRouter;
