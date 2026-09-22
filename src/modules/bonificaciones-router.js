// Rutas de bonificaciones. Siempre sobre la persona autenticada: no se puede
// reclamar para otro.

const express = require('express');
const asyncHandler = require('../utils/async-handler');
const bonificacionesService = require('./bonificaciones-service');

const router = express.Router();

router.post(
  '/bienvenida',
  asyncHandler(async (req, res) => {
    const resultado = await bonificacionesService.otorgarBienvenida({
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
    });
    res.status(201).json(resultado);
  })
);

module.exports = router;
