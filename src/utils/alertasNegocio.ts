// Cálculos de "cosas que necesitan atención" compartidos entre el Dashboard
// (en vivo, GET /dashboard/resumen) y el resumen diario por correo (una vez
// al día, ver jobs/resumenDiario.ts) — un solo lugar para no duplicar estas
// consultas ni arriesgarse a que ambos canales digan cosas distintas.
//
// Todas las funciones asumen que ya se está DENTRO de ejecutarConEmpresa
// (igual que el resto del código que usa "prisma"), excepto las que reciben
// la ruta del certificado como parámetro explícito.

import { prisma, empresaActiva } from "../db";
import { leerFechaExpiracionCertificado } from "./certificado";
import { rutaAbsoluta } from "./empresas";
import { estadoBackup, backupAtrasado, type EstadoBackupEmpresa } from "./backupBaseDatos";
import { calcularDiasParaVencer } from "./vencimientos";

const DIAS_ALERTA_CADUCIDAD_CERTIFICADO = 30;

export interface ProductoStockBajo {
  productoId: number;
  productoNombre: string;
  stockActual: number;
  stockMinimo: number;
  sucursalId: number | null;
  sucursalNombre: string | null;
}

// Mismo criterio ya usado en dashboard.ts: productos con lote tienen stock
// global (sin sucursal); productos sin lote se avisan por sucursal, porque
// un local puede quedarse sin stock aunque otro tenga de sobra.
export async function obtenerStockBajo(): Promise<ProductoStockBajo[]> {
  const [productosConLoteActivos, stockPorSucursal] = await Promise.all([
    prisma.producto.findMany({
      where: { activo: true, manejaLotes: true },
      select: { id: true, nombre: true, stockActual: true, stockMinimo: true },
    }),
    prisma.stockSucursal.findMany({
      where: { producto: { activo: true, manejaLotes: false } },
      include: { producto: { select: { nombre: true, stockMinimo: true } }, sucursal: { select: { id: true, nombre: true } } },
    }),
  ]);

  return [
    ...productosConLoteActivos
      .filter((p) => p.stockActual <= p.stockMinimo)
      .map((p) => ({
        productoId: p.id,
        productoNombre: p.nombre,
        stockActual: p.stockActual,
        stockMinimo: p.stockMinimo,
        sucursalId: null as number | null,
        sucursalNombre: null as string | null,
      })),
    ...stockPorSucursal
      .filter((s) => s.cantidad <= s.producto.stockMinimo)
      .map((s) => ({
        productoId: s.productoId,
        productoNombre: s.producto.nombre,
        stockActual: s.cantidad,
        stockMinimo: s.producto.stockMinimo,
        sucursalId: s.sucursal.id,
        sucursalNombre: s.sucursal.nombre,
      })),
  ].sort((a, b) => a.stockActual - a.stockMinimo - (b.stockActual - b.stockMinimo));
}

export interface CuentaPorCobrar {
  tipo: "FACTURA" | "NOTA_VENTA";
  id: number;
  secuencial: string;
  clienteNombre: string;
  total: string;
  montoPagado: string;
  saldo: string;
  fechaVencimiento: Date | null;
}

// "Pendientes", no "vencidas": aunque Factura/NotaVenta ya tienen
// fechaVencimiento (ver utils/vencimientos.ts, usado en
// /reportes/cuentas-por-cobrar), el resumen diario por correo se queda
// deliberadamente como una lista simple de saldo pendiente, sin desglose de
// mora — quien quiera ver atrasos por antigüedad va al reporte en pantalla.
export async function obtenerCuentasPorCobrarPendientes(): Promise<CuentaPorCobrar[]> {
  const [facturas, notasVenta] = await Promise.all([
    prisma.factura.findMany({
      where: { estadoPago: { in: ["PENDIENTE", "PARCIAL"] }, estado: { not: "ANULADA" } },
      include: { cliente: { select: { razonSocial: true } } },
      orderBy: { fechaEmision: "asc" },
    }),
    prisma.notaVenta.findMany({
      where: { estadoPago: { in: ["PENDIENTE", "PARCIAL"] }, estado: { not: "ANULADA" } },
      include: { cliente: { select: { razonSocial: true } } },
      orderBy: { fechaEmision: "asc" },
    }),
  ]);

  return [
    ...facturas.map((f) => ({
      tipo: "FACTURA" as const,
      id: f.id,
      secuencial: f.secuencial,
      clienteNombre: f.cliente.razonSocial,
      total: f.total.toFixed(2),
      montoPagado: f.montoPagado.toFixed(2),
      saldo: f.total.sub(f.montoPagado).toFixed(2),
      fechaVencimiento: f.fechaVencimiento,
    })),
    ...notasVenta.map((n) => ({
      tipo: "NOTA_VENTA" as const,
      id: n.id,
      secuencial: n.secuencial,
      clienteNombre: n.cliente.razonSocial,
      total: n.total.toFixed(2),
      montoPagado: n.montoPagado.toFixed(2),
      saldo: n.total.sub(n.montoPagado).toFixed(2),
      fechaVencimiento: n.fechaVencimiento,
    })),
  ];
}

// Subconjunto de obtenerCuentasPorCobrarPendientes que además está a N días
// o menos de vencer — pensado para un aviso propio y enfocado (ver
// jobs/alertaVencimientosProximos.ts), en vez de que esto se pierda como una
// línea más en el resumen diario general. Usa "<=" (no coincidencia exacta):
// un documento sigue apareciendo día a día mientras se acerca su
// vencimiento, hasta que se pague o venza — mismo criterio de "repetir
// hasta resolverse" que ya usa el resumen diario con las cuentas por cobrar
// en general, y evita que una caída del servidor justo el día exacto haga
// que un documento nunca se avise.
export async function obtenerCuentasProximasAVencer(diasAntes: number): Promise<CuentaPorCobrar[]> {
  const pendientes = await obtenerCuentasPorCobrarPendientes();
  return pendientes.filter((c) => {
    const dias = calcularDiasParaVencer(c.fechaVencimiento, new Date());
    return dias !== null && dias <= diasAntes;
  });
}

export interface DocumentoPendienteAutorizacion {
  tipo: "FACTURA" | "NOTA_CREDITO";
  id: number;
  secuencial: string;
  fechaEmision: Date;
}

// Facturas/notas de crédito atascadas en ENVIADA — el job de reintentos
// (jobs/reintentoAutorizacionSri.ts) ya las reintenta cada pocos minutos, así
// que si siguen así a la hora del resumen diario, sobrevivieron ~96
// reintentos sin resolverse: es la señal más alarmante de las que este
// archivo calcula.
export async function obtenerDocumentosPendientesAutorizacion(): Promise<DocumentoPendienteAutorizacion[]> {
  const [facturas, notasCredito] = await Promise.all([
    prisma.factura.findMany({
      where: { estado: "ENVIADA" },
      select: { id: true, secuencial: true, fechaEmision: true },
    }),
    prisma.notaCredito.findMany({
      where: { estado: "ENVIADA" },
      select: { id: true, secuencial: true, fechaEmision: true },
    }),
  ]);

  return [
    ...facturas.map((f) => ({ tipo: "FACTURA" as const, id: f.id, secuencial: f.secuencial, fechaEmision: f.fechaEmision })),
    ...notasCredito.map((n) => ({ tipo: "NOTA_CREDITO" as const, id: n.id, secuencial: n.secuencial, fechaEmision: n.fechaEmision })),
  ];
}

export interface DocumentoSriAtascado {
  tipo: "FACTURA" | "NOTA_CREDITO" | "RETENCION" | "GUIA_REMISION";
  id: number;
  secuencial: string;
  createdAt: Date;
  minutosAtascado: number;
}

// Igual que obtenerDocumentosPendientesAutorizacion pero con umbral de
// tiempo (no "está en ENVIADA ahora mismo", sino "lleva en ENVIADA más de X
// minutos") y cubriendo los 4 tipos de comprobante que reintentoAutorizacionSri.ts
// reintenta (esa función solo cubre factura/nota de crédito, pensada para el
// resumen diario donde retención/guía son menos frecuentes) — la usa
// jobs/alertaSriAtascado.ts para el aviso inmediato. No hay una columna
// "fechaEnviada" separada; createdAt es buena aproximación porque el envío
// al SRI es fire-and-forget casi inmediato tras crear el documento.
export async function obtenerDocumentosSriAtascados(minutosUmbral: number): Promise<DocumentoSriAtascado[]> {
  const limite = new Date(Date.now() - minutosUmbral * 60_000);
  const seleccion = { id: true, secuencial: true, createdAt: true } as const;

  const [facturas, notasCredito, retenciones, guiasRemision] = await Promise.all([
    prisma.factura.findMany({ where: { estado: "ENVIADA", createdAt: { lte: limite } }, select: seleccion }),
    prisma.notaCredito.findMany({ where: { estado: "ENVIADA", createdAt: { lte: limite } }, select: seleccion }),
    prisma.retencion.findMany({ where: { estado: "ENVIADA", createdAt: { lte: limite } }, select: seleccion }),
    prisma.guiaRemision.findMany({ where: { estado: "ENVIADA", createdAt: { lte: limite } }, select: seleccion }),
  ]);

  const ahora = Date.now();
  function mapear(tipo: DocumentoSriAtascado["tipo"], items: { id: number; secuencial: string; createdAt: Date }[]) {
    return items.map((d) => ({
      tipo,
      id: d.id,
      secuencial: d.secuencial,
      createdAt: d.createdAt,
      minutosAtascado: Math.round((ahora - d.createdAt.getTime()) / 60_000),
    }));
  }

  return [
    ...mapear("FACTURA", facturas),
    ...mapear("NOTA_CREDITO", notasCredito),
    ...mapear("RETENCION", retenciones),
    ...mapear("GUIA_REMISION", guiasRemision),
  ];
}

export interface EstadoCaducidadCertificado {
  fechaExpiracion: Date;
  diasRestantes: number;
  vencido: boolean;
  porCaducar: boolean; // dentro de la ventana de aviso, pero todavía no vencido
}

// Función pura (sin I/O) para que sea fácil de testear con fechas fijas —
// ver utils/alertasNegocio.test.ts.
export function calcularEstadoCaducidadCertificado(fechaExpiracion: Date, ahora: Date): EstadoCaducidadCertificado {
  const msPorDia = 24 * 60 * 60 * 1000;
  const diasRestantes = Math.ceil((fechaExpiracion.getTime() - ahora.getTime()) / msPorDia);
  const vencido = diasRestantes < 0;
  return {
    fechaExpiracion,
    diasRestantes,
    vencido,
    porCaducar: !vencido && diasRestantes <= DIAS_ALERTA_CADUCIDAD_CERTIFICADO,
  };
}

// Nunca lanza error: si el certificado no se puede leer (contraseña vieja,
// archivo ausente), el dashboard/resumen simplemente no muestra el aviso en
// vez de romperse por esto.
export function obtenerCertificadoPorCaducar(): EstadoCaducidadCertificado | null {
  try {
    const empresa = empresaActiva();
    const fechaExpiracion = leerFechaExpiracionCertificado(
      empresa.id,
      rutaAbsoluta(empresa.certificadoP12Path),
      empresa.certificadoP12Password
    );
    const estado = calcularEstadoCaducidadCertificado(fechaExpiracion, new Date());
    return estado.vencido || estado.porCaducar ? estado : null;
  } catch (error: any) {
    console.error(`[alertas-negocio] No se pudo leer la fecha de expiración del certificado:`, error.message);
    return null;
  }
}

export interface CertificadoInvalido {
  motivo: string;
}

// A diferencia de obtenerCertificadoPorCaducar (que solo avisa si el
// certificado YA CADUCÓ o está por caducar), esto avisa si el certificado
// simplemente NO SE PUEDE LEER del disco — archivo ausente/movido/corrupto,
// o contraseña que ya no coincide. Sin esto, cada intento de firmar (manual
// o automático) fallaba en silencio: solo quedaba en los logs del servidor,
// nadie se enteraba hasta que una venta real se quedaba sin poder enviarse.
// Reusa leerFechaExpiracionCertificado (con su misma caché de 6h) — no
// agrega ningún descifrado extra al Dashboard.
export function obtenerCertificadoInvalido(): CertificadoInvalido | null {
  const empresa = empresaActiva();
  if (!empresa.certificadoP12Password) return null; // nunca configurado: no es un error, es "todavía no"

  try {
    leerFechaExpiracionCertificado(empresa.id, rutaAbsoluta(empresa.certificadoP12Path), empresa.certificadoP12Password);
    return null;
  } catch (error: any) {
    const motivo =
      error.code === "ENOENT"
        ? `No se encuentra el archivo del certificado en el disco (${empresa.certificadoP12Path})`
        : `El certificado no se pudo abrir: ${error.message}`;
    return { motivo };
  }
}

export interface EstadoBackupBaseDatos extends EstadoBackupEmpresa {
  atrasado: boolean;
}

// Igual que obtenerCertificadoPorCaducar: nunca lanza error, para que el
// dashboard/resumen no se rompa si el archivo de estado local todavía no
// existe (ej. nunca se ha corrido un respaldo para esta empresa).
export function obtenerEstadoBackupBaseDatos(): EstadoBackupBaseDatos {
  const estado = estadoBackup(empresaActiva().id);
  return { ...estado, atrasado: backupAtrasado(estado) };
}
