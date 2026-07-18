import { Request } from "express";

// Convierte un "YYYY-MM-DD" (el formato que manda <input type="date">) a un
// Date en HORA LOCAL del servidor. A propósito NUNCA se hace "new
// Date(fechaStr)" a secas: el estándar ISO 8601 interpreta un string de solo
// fecha como MEDIANOCHE UTC, no medianoche local — y si después se le suma
// ".setHours(23,59,59,999)" (que sí opera en hora local), el resultado puede
// terminar cubriendo hasta la MADRUGADA del día pedido, no su fin real, en
// cualquier servidor con huso horario detrás de UTC (Ecuador/Colombia,
// UTC-5): "hasta=2026-07-19" terminaba cortando en 2026-07-19T04:59 UTC —
// cualquier factura/traslado/etc. creado el resto de ese día calendario
// (hora local) quedaba afuera del reporte sin ningún error visible, solo
// una tabla vacía.
export function fechaLocalDeString(fechaStr: string, finDelDia: boolean): Date {
  const [anio, mes, dia] = fechaStr.split("-").map(Number);
  return finDelDia
    ? new Date(anio, mes - 1, dia, 23, 59, 59, 999)
    : new Date(anio, mes - 1, dia, 0, 0, 0, 0);
}

// Primer y último día (hora local) de un mes calendario — usado por el
// módulo de Nómina (períodos siempre mensuales, ver routes/rolDePagos.ts)
// y reutilizable donde haga falta "el mes X del año Y" en vez de un rango
// libre. El truco de "day 0 del mes siguiente" da el último día del mes
// actual sin tener que calcular cuántos días tiene cada mes a mano.
export function rangoDelMes(anio: number, mes: number): { desde: Date; hasta: Date } {
  const desde = new Date(anio, mes - 1, 1, 0, 0, 0, 0);
  const hasta = new Date(anio, mes, 0, 23, 59, 59, 999);
  return { desde, hasta };
}

// "Clave" de día en hora LOCAL (YYYY-MM-DD) para agrupar series de tiempo
// (ventas por día, etc.) — nunca fecha.toISOString().slice(0,10), que
// trunca en UTC y puede correr un movimiento de hora local al día anterior
// o siguiente (mismo tipo de bug documentado arriba en fechaLocalDeString).
export function aClaveDia(fecha: Date): string {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${anio}-${mes}-${dia}`;
}

// Filtro opcional de "?desde=&hasta=" para rutas de LISTADO general. A
// diferencia de calcularRangoFechas en routes/reportes.ts, si no vienen los
// parámetros esto devuelve undefined (SIN filtro) — no "el mes actual". Poner
// ese default acá rompería en silencio pantallas existentes (FacturasPage,
// ProductosPage, el desplegable de "factura autorizada" al crear una nota de
// crédito, etc.) que llaman a estas mismas rutas esperando el historial
// completo cuando no piden nada en particular.
export function leerRangoFechas(req: Request): { gte?: Date; lte?: Date } | undefined {
  const { desde, hasta } = req.query;
  if (!desde && !hasta) return undefined;

  const rango: { gte?: Date; lte?: Date } = {};
  if (typeof desde === "string" && desde) rango.gte = fechaLocalDeString(desde, false);
  if (typeof hasta === "string" && hasta) rango.lte = fechaLocalDeString(hasta, true);
  return rango;
}
