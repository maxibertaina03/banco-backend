// Helpers puros para extraer datos de los payloads que devuelve el Banco
// Central (estructuras anidadas e inconsistentes según el endpoint). No tocan
// la BD ni la red: recorren un objeto buscando el primer valor útil.

/** Primer string no vacío encontrado en `payload` bajo cualquiera de `keys`. */
function findStringInPayload(payload, keys) {
  if (!payload || typeof payload !== 'object') return null;

  const queue = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;

    for (const key of keys) {
      const value = current[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

/** Primer "nombre apellido" armable recorriendo el payload anidado. */
function findFullNameInPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const queue = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;

    const name = [current.nombre, current.apellido]
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.trim())
      .join(' ');
    if (name) return name;

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

module.exports = {
  findStringInPayload,
  findFullNameInPayload,
};
