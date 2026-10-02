import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";

import { resolverCertificadoHttpsLocal } from "./utils/httpsLocal";

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
import { bancosRouter } from "./routes/bancos";
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
import { vehiculosRouter } from "./routes/vehiculos";
import { ubicacionesTecnicosRouter } from "./routes/ubicacionesTecnicos";
import { rolDePagosRouter } from "./routes/rolDePagos";
import { decimosRouter } from "./routes/decimos";
import { vacacionesRouter } from "./routes/vacaciones";
import { utilidadesRouter } from "./routes/utilidades";
import { liquidacionesRouter } from "./routes/liquidaciones";
import { marcacionesRouter } from "./routes/marcaciones";
import { visitasRouter } from "./routes/visitas";
import { metrajeRouter } from "./routes/metraje";
import { egresosBodegaRouter } from "./routes/egresosBodega";
import { mikrotikRouter } from "./routes/mikrotik";
import { planesInternetRouter } from "./routes/planesInternet";
import { promocionesRouter } from "./routes/promociones";
import { switchesRouter } from "./routes/switches";
import { nodosRedRouter } from "./routes/nodosRed";
import { oltsRouter } from "./routes/olts";
import { mapaRedRouter } from "./routes/mapaRed";
import { redFisicaRouter } from "./routes/redFisica";
import { iniciarReintentoAutorizacionSri } from "./jobs/reintentoAutorizacionSri";
import { iniciarPollingOlt } from "./jobs/pollingOlt";
import { iniciarPingClientes } from "./jobs/pingClientes";
import { iniciarResumenDiario } from "./jobs/resumenDiario";
import { iniciarBackupDiario } from "./jobs/backupDiario";
import { iniciarAlertaVencimientosProximos } from "./jobs/alertaVencimientosProximos";
import { iniciarAlertaSriAtascado } from "./jobs/alertaSriAtascado";
import { iniciarSuspensionInternetPorFaltaPago } from "./jobs/suspensionInternetPorFaltaPago";
import { iniciarRecordatorioVencimientoInternet } from "./jobs/recordatorioVencimientoInternet";
import { whatsappWebhookRouter } from "./routes/whatsappWebhook";
import { centroControlRouter } from "./routes/centroControl";
import { ticketsRouter } from "./routes/tickets";
import { conciliacionBancariaRouter } from "./routes/conciliacionBancaria";
import { iniciarMonitoreoRed } from "./jobs/monitoreoRed";
import { iniciarEncuestaVisitas } from "./jobs/encuestaVisitas";
import { iniciarMonitoreoNodos } from "./jobs/monitoreoNodos";
import { obtenerEmpresa, rutaAbsoluta, sembrarEmpresaPrincipalSiHaceFalta, listarEmpresas } from "./utils/empresas";
import { cifrarCredencialesExistentes } from "./db";
import { cifradoActivo } from "./utils/cifrado";

dotenv.config({ quiet: true });

// Multiempresa: si es la primera vez que corre esta versión del sistema,
// registra la empresa que ya existía (con los datos que ya estaban en el
// .env) como la primera empresa del registro — así no se pierde continuidad
// con los datos reales que ya se habían cargado antes de que existiera el
// concepto de "varias empresas".
sembrarEmpresaPrincipalSiHaceFalta();

const app = express();

app.use(cors()); // permite que tu frontend (en otro puerto) llame a esta API
// El límite default de express.json() es 100KB — de sobra para casi todo el
// sistema, pero POST /red-fisica/importar-kml/confirmar puede mandar
// cientos de cajas/tendidos de una importación KML grande (cada tendido con
// su trazado completo, a veces con muchos puntos si viene de una medición
// de ruta) y lo supera fácil. Sin este límite más alto, Express corta la
// petición con un error que ni siquiera es JSON (rompe el manejo de errores
// normal de las rutas, que asume {error: "..."}).
// "verify" guarda el cuerpo CRUDO de la petición — lo necesita el webhook de
// WhatsApp para verificar la firma HMAC de Meta (ver routes/whatsappWebhook.ts).
app.use(
  express.json({
    limit: "15mb",
    verify: (req, _res, buf) => {
      if (req.url?.startsWith("/whatsapp-webhook")) (req as any).rawBody = buf;
    },
  })
);

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
app.use("/bancos", requireAuth, bancosRouter);
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
// Vehículos: sin requirePermiso a nivel de router — cada ruta interna
// aplica su propio puedeVer("vehiculos")/puedeEditar("vehiculos_editar"),
// mismo criterio que Nómina.
app.use("/vehiculos", requireAuth, vehiculosRouter);
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
// Webhook de WhatsApp Business: SIN requireAuth, igual que "/marcaciones" —
// lo llama Meta directamente, nunca el frontend. Se autentica con su propio
// mecanismo (verify_token en la verificación GET, ver routes/whatsappWebhook.ts).
app.use("/whatsapp-webhook", whatsappWebhookRouter);
// Visitas técnicas: requireAuth a nivel de router (todas sus rutas lo
// necesitan) — cada ruta interna aplica su propio puedeVer("visitas")/
// puedeEditar("visitas_editar") donde corresponde; GET /mi-ruta-hoy y los
// PATCH de llegada/omitir NO llevan ninguno de esos dos (cualquier usuario
// autenticado puede ver/actualizar SU PROPIA ruta, ver routes/visitas.ts).
app.use("/visitas", requireAuth, visitasRouter);
// Metraje de cable: sin requirePermiso a nivel de router — GET /mis-rollos
// es para cualquier autenticado (un técnico llenando su propia acta), el
// resto de rutas internas exige "inventario" por su cuenta, ver
// routes/metraje.ts.
app.use("/metraje", requireAuth, metrajeRouter);
// Egresos de bodega: sin requirePermiso a nivel de router — GET
// /mis-pendientes es self-service (un técnico viendo qué le despacharon a
// él), el resto exige "productos" por su cuenta, ver routes/egresosBodega.ts.
app.use("/egresos-bodega", requireAuth, egresosBodegaRouter);
// La empresa tiene varios nodos de red, cada uno con su propio Mikrotik —
// por eso /mikrotik va SIEMPRE con el id del nodo en la URL (ver
// routes/mikrotik.ts); /nodos-red es el catálogo de esos nodos en sí.
app.use("/mikrotik/:nodoId", requireAuth, requirePermiso("mikrotik"), mikrotikRouter);
app.use("/nodos-red", requireAuth, requirePermiso("mikrotik"), nodosRedRouter);
app.use("/planes-internet", requireAuth, requirePermiso("mikrotik"), planesInternetRouter);
app.use("/promociones", requireAuth, requirePermiso("mikrotik"), promocionesRouter);
app.use("/switches", requireAuth, requirePermiso("switches"), switchesRouter);
// Catálogo de OLT Huawei y sus ONUs — permiso propio "olt", separado de
// "mikrotik" (equipo y responsable suelen ser distintos, ver utils/permisos.ts).
app.use("/olts", requireAuth, requirePermiso("olt"), oltsRouter);
// Vista combinada de solo lectura para la sala de soporte técnico — permiso
// propio "mapa_red" para poder dárselo a un técnico sin darle acceso a
// configurar OLT/Mikrotik.
app.use("/mapa-red", requireAuth, requirePermiso("mapa_red"), mapaRedRouter);
// Red Física (trazado de fibra): sin requirePermiso a nivel de router —
// cada ruta interna aplica su propio puedeVer("red_fisica")/
// puedeEditar("red_fisica_editar"), mismo criterio que /contabilidad.
app.use("/red-fisica", requireAuth, redFisicaRouter);
// Localización de técnicos: sin requirePermiso a nivel de router — POST es
// self-service (cualquier Usuario con Empleado vinculado manda SU PROPIA
// posición, sin permiso especial), y las rutas de consulta para el mapa
// admin aplican su propio puedeVer("ubicacion_tecnicos") — mismo criterio
// que /vehiculos.
app.use("/ubicaciones-tecnicos", requireAuth, ubicacionesTecnicosRouter);
// Centro de Control (alertas de red, control de técnicos, combustible,
// indicadores ISP, encuestas) y Tickets de soporte — permisos propios, ver
// utils/permisos.ts.
app.use("/centro-control", requireAuth, requirePermiso("centro_control"), centroControlRouter);
app.use("/tickets", requireAuth, requirePermiso("tickets"), ticketsRouter);
// Conciliación del extracto bancario con los cobros de internet — mismo
// permiso que Facturación de Internet, que es donde se cobra a mano.
app.use("/conciliacion-bancaria", requireAuth, requirePermiso("mikrotik"), conciliacionBancariaRouter);

const PORT = process.env.PORT || 3000;

// HTTPS local opcional — solo para poder probar desde el celular en la
// misma red (navigator.geolocation, que usa "Llegué" en Visitas Técnicas,
// solo funciona en un "contexto seguro": HTTPS o localhost, nunca por IP LAN
// en HTTP plano). Con HTTPS_LOCAL_AUTO="true" en .env, resolverCertificadoHttpsLocal()
// detecta sola la IP LAN de esta PC y genera (con mkcert) el certificado en
// certs-local-dev/ si hace falta — ya no hay que regenerarlo ni editar rutas
// a mano cada vez que la PC cambia de IP (ver utils/httpsLocal.ts). Si no,
// sigue siendo HTTP plano como siempre. En producción ninguna variable de
// esto debe estar seteada: Nginx ya termina TLS ahí y le habla a este
// proceso por HTTP interno (ver DESPLIEGUE.md), no debe cambiar.
const { rutaCertHttps, rutaKeyHttps } = resolverCertificadoHttpsLocal();
const usaHttpsLocal = !!(rutaCertHttps && rutaKeyHttps);
const servidor = usaHttpsLocal
  ? https.createServer({ cert: fs.readFileSync(rutaCertHttps!), key: fs.readFileSync(rutaKeyHttps!) }, app)
  : http.createServer(app);

servidor.listen(Number(PORT), () => {
  console.log(`Servidor corriendo en ${usaHttpsLocal ? "https" : "http"}://localhost:${PORT}`);
  // Cifra las contraseñas de equipos que sigan en texto plano (ver
  // utils/cifrado.ts) — una sola vez por empresa, lo ya cifrado se salta.
  if (cifradoActivo()) {
    for (const empresa of listarEmpresas()) {
      cifrarCredencialesExistentes(empresa.id)
        .then((n) => n > 0 && console.log(`[cifrado] "${empresa.nombre}": ${n} equipo(s) con credenciales cifradas.`))
        .catch((error) => console.error(`[cifrado] No se pudieron cifrar las credenciales de "${empresa.nombre}":`, error.message));
    }
  } else {
    console.warn("[cifrado] CLAVE_CIFRADO_EQUIPOS no está en .env — las contraseñas de Mikrotik/OLT/switches se guardan sin cifrar.");
  }
  iniciarReintentoAutorizacionSri();
  iniciarResumenDiario();
  iniciarBackupDiario();
  iniciarAlertaVencimientosProximos();
  iniciarAlertaSriAtascado();
  iniciarSuspensionInternetPorFaltaPago();
  iniciarRecordatorioVencimientoInternet();
  iniciarPollingOlt();
  // iniciarPollingSwitches() queda deshabilitado: se decidió llevar el
  // control de los switches TP-Link de cliente de forma manual (demasiados
  // equipos para justificar el polling automático por ahora) — el módulo
  // completo (schema, rutas, job, página) sigue intacto para retomarlo más
  // adelante, ver jobs/pollingSwitches.ts.
  iniciarPingClientes();
  iniciarMonitoreoRed();
  iniciarEncuestaVisitas();
  iniciarMonitoreoNodos();
});
