import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";

import { productosRouter } from "./routes/productos";
import { movimientosRouter } from "./routes/movimientos";
import { facturasRouter } from "./routes/facturas";
import { facturasInternetRouter } from "./routes/facturasInternet";
import { clientesRouter } from "./routes/clientes";
import { reportesRouter } from "./routes/reportes";
import { sinonimosBusquedaRouter } from "./routes/sinonimosBusqueda";
import { authRouter } from "./routes/auth";
import { requireAuth, requireAdmin, requirePermiso } from "./middleware/auth";
import { notasCreditoRouter } from "./routes/notasCredito";
import { notasVentaRouter } from "./routes/notasVenta";
import { usuariosRouter } from "./routes/usuarios";
import { dashboardRouter } from "./routes/dashboard";
import { configuracionRouter } from "./routes/configuracion";
import { proveedoresRouter } from "./routes/proveedores";
import { comprasRouter } from "./routes/compras";
import { categoriasRouter } from "./routes/categorias";
import { tiposPrecioRouter } from "./routes/tiposPrecio";
import { cuentasBancariasRouter } from "./routes/cuentasBancarias";
import { pagosRouter } from "./routes/pagos";
import { proformasRouter } from "./routes/proformas";
import { auditoriaRouter } from "./routes/auditoria";
import { sucursalesRouter } from "./routes/sucursales";
import { bodegasRouter } from "./routes/bodegas";
import { puntosVentaRouter } from "./routes/puntosVenta";
import { trasladosRouter } from "./routes/traslados";
import { cajaRouter } from "./routes/caja";
import { retencionesRouter } from "./routes/retenciones";
import { guiasRemisionRouter } from "./routes/guiasRemision";
import { retencionesRecibidasRouter } from "./routes/retencionesRecibidas";
import { contabilidadRouter } from "./routes/contabilidad";
import { devolucionesCompraRouter } from "./routes/devolucionesCompra";
import { empleadosRouter } from "./routes/empleados";
import { rolDePagosRouter } from "./routes/rolDePagos";
import { decimosRouter } from "./routes/decimos";
import { vacacionesRouter } from "./routes/vacaciones";
import { utilidadesRouter } from "./routes/utilidades";
import { liquidacionesRouter } from "./routes/liquidaciones";
import { marcacionesRouter } from "./routes/marcaciones";
import { visitasRouter } from "./routes/visitas";
import { mikrotikRouter } from "./routes/mikrotik";
import { planesInternetRouter } from "./routes/planesInternet";
import { nodosRedRouter } from "./routes/nodosRed";
import { iniciarReintentoAutorizacionSri } from "./jobs/reintentoAutorizacionSri";
import { iniciarResumenDiario } from "./jobs/resumenDiario";
import { iniciarBackupDiario } from "./jobs/backupDiario";
import { iniciarAlertaVencimientosProximos } from "./jobs/alertaVencimientosProximos";
import { iniciarAlertaSriAtascado } from "./jobs/alertaSriAtascado";
import { iniciarSuspensionInternetPorFaltaPago } from "./jobs/suspensionInternetPorFaltaPago";
import { obtenerEmpresa, rutaAbsoluta, sembrarEmpresaPrincipalSiHaceFalta } from "./utils/empresas";

dotenv.config({ quiet: true });

// Multiempresa: si es la primera vez que corre esta versión del sistema,
// registra la empresa que ya existía (con los datos que ya estaban en el
// .env) como la primera empresa del registro — así no se pierde continuidad
// con los datos reales que ya se habían cargado antes de que existiera el
// concepto de "varias empresas".
sembrarEmpresaPrincipalSiHaceFalta();

const app = express();

app.use(cors()); // permite que tu frontend (en otro puerto) llame a esta API
app.use(express.json()); // permite leer JSON en el "body" de las peticiones

// Sirve las fotos de producto y el logo subidos (ver POST /productos/:id/imagen
// y POST /configuracion/logo) — cada empresa tiene su propia carpeta (nunca se
// mezclan), por eso el empresaId va en la URL. A propósito sin requireAuth:
// son <img src="..."> planas en el navegador, que no pueden mandar el token
// Bearer — y ni una foto de producto ni un logo son datos sensibles como para
// justificar la complejidad de servirlos autenticados.
app.use("/uploads/:empresaId", (req: Request, res: Response, next: NextFunction) => {
  const empresa = obtenerEmpresa(String(req.params.empresaId));
  if (!empresa) return res.status(404).end();
  express.static(rutaAbsoluta(empresa.carpetaUploads))(req, res, next);
});

// Ruta de prueba, para confirmar que el servidor responde
app.get("/", (req: Request, res: Response) => {
  res.json({ mensaje: "API de facturación e inventario funcionando" });
});

// La ruta de login es PÚBLICA (nadie tiene token todavía cuando intenta entrar).
// GET /auth/yo se protege internamente dentro de authRouter, no aquí.
app.use("/auth", authRouter);

app.use("/dashboard", requireAuth, dashboardRouter);
app.use("/configuracion", requireAuth, configuracionRouter);
app.use("/productos", requireAuth, productosRouter);
app.use("/categorias", requireAuth, categoriasRouter);
app.use("/tipos-precio", requireAuth, tiposPrecioRouter);
app.use("/cuentas-bancarias", requireAuth, cuentasBancariasRouter);
app.use("/movimientos", requireAuth, movimientosRouter);
app.use("/facturas", requireAuth, facturasRouter);
app.use("/facturas-internet", requireAuth, facturasInternetRouter);
app.use("/notas-venta", requireAuth, notasVentaRouter);
// A diferencia de clientes/facturas/notas-venta (que SÍ están abiertas a
// cualquier autenticado porque otras pantallas con su propio permiso — ej.
// Visitas Técnicas buscando un cliente, Notas de Crédito buscando una
// factura — dependen de leerlas), nada más consume /proformas, /proveedores
// o /compras, así que se pueden gatear enteras sin romper nada más.
app.use("/proformas", requireAuth, requirePermiso("ventas"), proformasRouter);
app.use("/clientes", requireAuth, clientesRouter);
app.use("/proveedores", requireAuth, requirePermiso("proveedores"), proveedoresRouter);
app.use("/compras", requireAuth, requirePermiso("compras"), comprasRouter);
app.use("/reportes", requireAuth, requirePermiso("reportes"), reportesRouter);
app.use("/sinonimos-busqueda", requireAuth, requirePermiso("reportes"), sinonimosBusquedaRouter);
app.use("/pagos", requireAuth, requirePermiso("reportes"), pagosRouter);
app.use("/notas-credito", requireAuth, requirePermiso("notas_credito"), notasCreditoRouter);
app.use("/usuarios", requireAuth, requireAdmin, usuariosRouter);
app.use("/auditoria", requireAuth, requirePermiso("auditoria"), auditoriaRouter);
app.use("/sucursales", requireAuth, sucursalesRouter);
app.use("/bodegas", requireAuth, bodegasRouter);
app.use("/puntos-venta", requireAuth, puntosVentaRouter);
app.use("/traslados", requireAuth, trasladosRouter);
app.use("/caja", requireAuth, requirePermiso("caja"), cajaRouter);
app.use("/retenciones", requireAuth, requirePermiso("retenciones"), retencionesRouter);
app.use("/retenciones-recibidas", requireAuth, requirePermiso("retenciones"), retencionesRecibidasRouter);
app.use("/guias-remision", requireAuth, requirePermiso("guias_remision"), guiasRemisionRouter);
// Nómina: sin permiso "blanket" a nivel de router (igual que Contabilidad)
// — cada ruta interna aplica su propio puedeVer("nomina")/puedeEditar("nomina_editar").
app.use("/empleados", requireAuth, empleadosRouter);
app.use("/nomina/rol-pagos", requireAuth, rolDePagosRouter);
app.use("/nomina/decimos", requireAuth, decimosRouter);
app.use("/nomina/vacaciones", requireAuth, vacacionesRouter);
app.use("/nomina/utilidades", requireAuth, utilidadesRouter);
app.use("/nomina/liquidaciones", requireAuth, liquidacionesRouter);
// Sin requirePermiso acá a propósito: el router ahora divide "ver" de
// "editar" ruta por ruta (ver contabilidad.ts) porque son permisos distintos.
app.use("/contabilidad", requireAuth, contabilidadRouter);
app.use("/devoluciones-compra", requireAuth, requirePermiso("devoluciones_compra"), devolucionesCompraRouter);
// Marcaciones: SIN requireAuth a nivel de router, igual que "/auth" — POST
// /marcaciones/marcar es público (un empleado no tiene necesariamente
// cuenta de Usuario/JWT), pero el resto de rutas dentro del router sí
// aplican requireAuth por su cuenta (ver routes/marcaciones.ts).
app.use("/marcaciones", marcacionesRouter);
// Visitas técnicas: requireAuth a nivel de router (todas sus rutas lo
// necesitan) — cada ruta interna aplica su propio puedeVer("visitas")/
// puedeEditar("visitas_editar") donde corresponde; GET /mi-ruta-hoy y los
// PATCH de llegada/omitir NO llevan ninguno de esos dos (cualquier usuario
// autenticado puede ver/actualizar SU PROPIA ruta, ver routes/visitas.ts).
app.use("/visitas", requireAuth, visitasRouter);
// La empresa tiene varios nodos de red, cada uno con su propio Mikrotik —
// por eso /mikrotik va SIEMPRE con el id del nodo en la URL (ver
// routes/mikrotik.ts); /nodos-red es el catálogo de esos nodos en sí.
app.use("/mikrotik/:nodoId", requireAuth, requirePermiso("mikrotik"), mikrotikRouter);
app.use("/nodos-red", requireAuth, requirePermiso("mikrotik"), nodosRedRouter);
app.use("/planes-internet", requireAuth, requirePermiso("mikrotik"), planesInternetRouter);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  iniciarReintentoAutorizacionSri();
  iniciarResumenDiario();
  iniciarBackupDiario();
  iniciarAlertaVencimientosProximos();
  iniciarAlertaSriAtascado();
  iniciarSuspensionInternetPorFaltaPago();
});
