### 

### Entregable 1.1: Análisis de Requerimientos (Semana ………….)

Documenten sus respuestas a las preguntas de la sección 3 en un documento:

- ¿Qué datos necesitamos?
- ¿Cómo se relacionan?
- ¿Cómo aseguramos seguridad?
- ¿Cómo hablan entre sí?

**Formato:** Documento escrito (no diagramas aún, pensamiento puro).
**Evaluación:** ¿Demuestra comprensión del problema real?

### Entregable 1.2: Diagrama de Base de Datos (Semana ……………..)

Hagan un diagrama que muestre:

- Las tablas que necesitan.
- Qué campos tiene cada tabla.
- Cómo se conectan entre sí.

**Formato:** Diagrama (pueden ser cajas y líneas, o herramientas como Excalidraw/LucidChart/Draw.io)
**Evaluación:** ¿Responde las preguntas del negocio? ¿Es coherente?

### Entregable 1.3: Documento de Arquitectura (Semana ……………..)

Expliquen:

- Cómo van a estar separadas las tres capas.
- Qué tecnologías usa cada una.
- Cómo se comunican.

**Formato:** Documento + diagrama simple.
**Evaluación:** ¿Muestra que entendieron la separación de responsabilidades?

### FASE 2: DESARROLLO (Semanas ……………..)

### Entregable 2.1: API Backend (Semana ……………..)

Endpoints funcionales para:

- Autenticación.
- Consulta de saldo.
- Transferencias.
- Historial.

**Formato:** Código + documentación de endpoints
**Evaluación:** ¿Funciona? ¿Está seguro? ¿El código es legible?

### Entregable 2.2: Frontend (Semana ……………..)

Pantallas funcionales para:

- Login/Registro.
- Dashboard (saldo).
- Transferencias.
- Historial.

**Formato:** Código + evidencia que funciona.
**Evaluación:** ¿Se ve bien? ¿Se usa sin problemas? ¿Integra bien con el backend?

### Entregable 2.3: Base de Datos (Semana ……………..)

Sistema de BD funcional con:

- Todas las tablas del diagrama.
- Datos de prueba.
- Acceso desde el backend.

**Formato:** Script de creación + evidencia que funciona.
**Evaluación:** ¿Persisten los datos? ¿La integridad se mantiene?

### FASE 3: INTEGRACIÓN Y PRUEBAS (Semanas ……………..)

### Entregable 3.1: Sistema Integrado

Integración completa del sistema con todos sus componentes en funcionamiento:

- Frontend → Backend → BD operando de manera integrada.
- Los casos de uso exitosos se ejecutan correctamente.
- Los casos de error se detectan y gestionan adecuadamente.

**Formato:** Sistema vivo.
**Evaluación:** ¿Funciona? ¿Es usable?

### Entregable 3.2: Documentación Final

- Manual de instalación.
- Manual de usuario.
- Documentación técnica.
- Decisiones y por qué las tomaron.

**Formato:** Documento completo.
**Evaluación:** ¿Otro programador podría entender el sistema?

### Entregable 3.3: Presentación Final

Demostración viva del sistema + explicación del proceso.

**Formato:** Presentación + demostración.
**Evaluación:** ¿Explican con claridad? ¿Demuestran dominio?

---

## 10. Cómo se evalúa este proyecto?

### Análisis del problema

- ¿Demostraron que entienden qué necesita el banco?
- ¿Las preguntas fueron respondidas con pensamiento crítico?
- ¿Identificaron riesgos realistas?

### Diseño

- ¿La BD está bien organizada?
- ¿La arquitectura tiene sentido?
- ¿Se pueden responder las preguntas del negocio?

### Funcionalidad

- ¿El sistema hace lo que debe hacer?
- ¿Se pueden hacer transacciones?
- ¿Los saldos son correctos?

### Seguridad

- ¿Un usuario no puede ver datos de otro?
- ¿Las contraseñas están protegidas?
- ¿Se validan los datos?

### Calidad del código

- ¿Es legible?
- ¿Hay comentarios dónde es necesario?
- ¿Es fácil de cambiar?

### Documentación y comunicación

- ¿Se entiende cómo usar el sistema?
- ¿Se entiende cómo cambiar cosas?
- ¿Explican sus decisiones?

### Otros aspectos

- Logo, estética e imagen… nombre del Banco

---

## 11. Consejos finales

### Sobre el proceso

- **Empiecen por las preguntas, no por el código.** Hablen, discutan, piensen en equipo.
- **El análisis es el trabajo más importante.** Si no saben qué datos necesitan, el código va a ser un desastre.
- **Trabajen en equipo pero con roles claros:** alguien en BD, alguien en backend, alguien en frontend, alquien en dos partes a la vez. Pero **todos entienden todas las partes.**

### Sobre la ejecución

- **Prueben constantemente.** No dejen todo para el final.
- **Hagan commits regulares.** Si algo se rompe, vuelven atrás.
- **Documenten mientras avanzan, no al final.**

### Sobre las decisiones técnicas

- **Ante dudas técnicas, piensen en el problema del mundo real.** Un banco real ¿cómo lo haría?
- **No busquen la solución "perfecta".** Busquen la solución que funciona ahora.
- **Pueden cambiar de opinión.** Si descubren que algo no funciona, lo rediseñan.

### Sobre la coordinación

- **Reunión de sincronización:** 10 minutos, "¿qué hiciste? ¿qué hace falta? ¿hay algo que está bloqueando?"
- **Documentación de API clara:** Si cada uno conoce exactamente qué espera recibir del otro, no hay sorpresas.
- **Rama main siempre funcional:** no hacer *merge* de código que rompa el funcionamiento del sistema.

### Sobre la seguridad

- **No guardes contraseñas en texto plano.** Nunca.
- **Valida en el backend, no solo en el frontend.** El frontend es mentiroso.
- **No expongas IDs internos innecesariamente.** Alguien podría adivinar.

---

## 12. Preguntas finales y reflexiones

Antes de terminar este documento, háganse estas preguntas como equipo:

1. **¿Realmente entendemos qué necesita hacer el sistema o solo estamos haciendo un "ejercicio de sistema"?**
2. **¿Qué pasaría en una transferencia si el servidor se cae a mitad de la operación?**
3. **¿Cómo sabemos que Juan no puede ver los datos de María?**
4. **¿Quién es responsable de que un saldo nunca sea negativo?**
5. **¿Cómo probamos que el sistema es seguro?**
6. **¿Qué pasa cuando el sistema termina el proyecto y los estudiantes del próximo año lo tienen que mantener? ¿Entenderán el código?**

Si pueden responder estas preguntas con claridad, van por buen camino.