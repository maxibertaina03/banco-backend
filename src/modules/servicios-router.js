// Rutas de pago de servicios. Delgadas: validan, delegan y mapean al DTO.

const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { uuidLike } = require('../utils/schemas');
const createIdempotency = require('../middlewares/idempotency');
const serviciosService = require('./servicios-service');
const { aTransaccionPublica } = require('../dtos');

const router = express.Router();
const idempotency = createIdempotency(pool);

const RUBROS = ['luz', 'gas', 'agua', 'internet', 'telefonia', 'cable', 'otros'];

const empresasQuerySchema = z.object({ rubro: z.enum(RUBROS).optional() });
const deudaParamsSchema = z.object({ empresaId: z.string().trim().min(1).max(60) });
const deudaQuerySchema = z.object({ numero_cliente: z.string().trim().min(1).max(40) });

// Sin `monto`: el importe lo toma el banco de la factura. Si lo mandara el
// cliente, podría pagar una factura de 45.000 enviando 1.
const pagoSchema = z.object({
  cuenta_id: uuidLike,
  empresa_id: z.string().trim().min(1).max(60),
  numero_cliente: z.string().trim().min(1).max(40),
  factura_id: z.string().trim().min(1).max(80),
});

router.get(
  '/empresas',
  validate(empresasQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await serviciosService.listarEmpresas(req.query.rubro ?? null));
  })
);

router.get(
  '/empresas/:empresaId/deuda',
  validate(deudaParamsSchema, 'params'),
  validate(deudaQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(
      await serviciosService.consultarDeuda({
        empresaId: req.params.empresaId,
        numeroCliente: req.query.numero_cliente,
      })
    );
  })
);

router.post(
  '/pagos',
  idempotency,
  validate(pagoSchema),
  asyncHandler(async (req, res) => {
    const resultado = await serviciosService.pagarFactura({
      ...req.body,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
      idempotencyKey: req.get('Idempotency-Key') || null,
    });

    res.status(201).json({
      ...resultado,
      transaccion: aTransaccionPublica(resultado.transaccion),
    });
  })
);

module.exports = router;
