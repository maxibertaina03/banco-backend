const express = require('express');
const createCrudRouter = require('../modules/crud-router');
const entities = require('../modules/entities');
const relationsRouter = require('../modules/relations-router');
const transaccionesRouter = require('../modules/transacciones-router');
const centralBankRouter = require('../modules/central-bank-router');
const tarjetasRouter = require('../modules/tarjetas-router');
const prestamosRouter = require('../modules/prestamos-router');
const plazosFijosRouter = require('../modules/plazos-fijos-router');

const router = express.Router();

router.use('/personas', createCrudRouter(entities.personas));
router.use('/roles', createCrudRouter(entities.roles));
router.use('/personas-roles', createCrudRouter(entities.personas_roles));
router.use('/usuarios', createCrudRouter(entities.usuarios));
router.use('/tipos-cuenta', createCrudRouter(entities.tipos_cuenta));
router.use('/cuentas', createCrudRouter(entities.cuentas));
router.use('/tipos-transaccion', createCrudRouter(entities.tipos_transaccion));
router.use('/transacciones', transaccionesRouter);
router.use('/central-bank', centralBankRouter);
router.use('/destinatarios', createCrudRouter(entities.destinatarios));
router.use('/auditoria', createCrudRouter(entities.auditoria));
router.use('/tarjetas', tarjetasRouter);
router.use('/prestamos', prestamosRouter);
router.use('/plazos-fijos', plazosFijosRouter);
router.use('/', relationsRouter);

module.exports = router;
