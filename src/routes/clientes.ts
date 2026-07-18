import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { validarIdentificacion } from "../utils/validarIdentificacion";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerTextoBusqueda } from "../utils/busqueda";
import { registrarAuditoria } from "../utils/auditoria";
import { leerRangoFechas, fechaLocalDeString } from "../utils/rangoFechas";
import { emailValido } from "../utils/validarEmail";
import { sincronizarListaPlanCliente, quitarDeListaPlan, limpiarClienteDeNodo, reactivarClientePorIp } from "../utils/mikrotik";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";
import { requirePermiso } from "../middleware/auth";

export const clientesRouter = Router();

// Confirma que el id mandado exista y esté activo — mismo criterio que
// categoriaId en Producto: no se acepta "a ciegas", se valida contra la tabla.
async function tipoPrecioValido(tipoPrecioId: number): Promise<boolean> {
  const tipoPrecio = await prisma.tipoPrecio.findUnique({ where: { id: tipoPrecioId } });
  return !!tipoPrecio && tipoPrecio.activo;
}

// Mismo criterio que tipoPrecioValido — no se acepta un planInternetId "a ciegas".
async function planInternetValido(planInternetId: number) {
  const plan = await prisma.planInternet.findUnique({ where: { id: planInternetId } });
  return plan && plan.activo ? plan : null;
}

// Mismo criterio — no se acepta un nodoId "a ciegas".
async function nodoValido(nodoId: number) {
  const nodo = await prisma.nodoRed.findUnique({ where: { id: nodoId } });
  return nodo && nodo.activo ? nodo : null;
}

// Mismo criterio, más una condición extra: la VLAN tiene que pertenecer AL
// MISMO nodo que se está guardando — no tendría sentido (y sería un dato
// mal cargado) que un cliente del Nodo A quede vinculado a una VLAN del
// Nodo B.
async function vlanValida(vlanNodoId: number, nodoId: number | null) {
  const vlan = await prisma.vlanNodo.findUnique({ where: { id: vlanNodoId } });
  return vlan && vlan.activo && vlan.nodoId === nodoId ? vlan : null;
}

// Validación de forma nada más (4 octetos 0-255) — la IP la asigna a mano
// el técnico según el puerto/PON del cliente, este sistema no gestiona un
// pool ni verifica que esté realmente libre en la red.
function direccionIpValida(ip: string): boolean {
  const partes = ip.trim().split(".");
  if (partes.length !== 4) return false;
  return partes.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

// Rango válido de latitud/longitud nada más — el frontend ya extrajo los
// números del mensaje de ubicación de WhatsApp pegado (ver
// frontend/src/utils/parsearUbicacion.ts); esto es la última barrera antes
// de guardar, por si llega algo manual o corrupto directo al API.
function coordenadaValida(valor: number, min: number, max: number): boolean {
  return Number.isFinite(valor) && valor >= min && valor <= max;
}

// Auto-provisioning estilo ISPCube (ver utils/mikrotik.ts): deja la IP de
// este cliente en la address-list de SU plan (codigoMikrotik) EN EL
// MIKROTIK DE SU NODO, o la quita de cualquier lista de plan si se le
// desasignó uno. Best-effort a propósito (igual criterio que el envío de
// correo o el backup de comprobantes en otros módulos): si el router no
// responde, si falta el nodo, o si el plan todavía no tiene codigoMikrotik
// configurado, el cliente igual queda guardado en la base — nunca bloquea
// la operación de negocio. Devuelve un mensaje de advertencia (o null si
// todo salió bien).
async function sincronizarClienteMikrotik(
  nodoId: number | null | undefined,
  direccionIp: string | null | undefined,
  planInternet: { codigoMikrotik: string | null } | null,
  razonSocial: string
): Promise<string | null> {
  if (!direccionIp) return null;
  if (!nodoId) {
    return "Este cliente tiene IP pero no tiene un nodo de red asignado — no se sincronizó nada en el Mikrotik";
  }
  try {
    if (planInternet?.codigoMikrotik) {
      await sincronizarListaPlanCliente(nodoId, direccionIp, planInternet.codigoMikrotik, razonSocial);
    } else {
      await quitarDeListaPlan(nodoId, direccionIp);
      if (planInternet && !planInternet.codigoMikrotik) {
        return `El plan asignado todavía no tiene un código de Mikrotik configurado — la IP no se agregó a ninguna lista`;
      }
    }
    return null;
  } catch (error: any) {
    const mensaje = error?.message || "No se pudo sincronizar con el Mikrotik";
    console.error(`No se pudo sincronizar la IP "${direccionIp}" en el Mikrotik:`, error);
    return mensaje;
  }
}

// Si el cliente cambió de nodo, o le cambiaron la IP dentro del mismo nodo
// (ej. cambio de domicilio), la sincronización de arriba solo actúa sobre
// el nodo/IP NUEVOS — nunca se entera de que quedó una entrada huérfana en
// el router VIEJO con la IP VIEJA. Esto la limpia antes de sincronizar lo
// nuevo. Best-effort, igual criterio que sincronizarClienteMikrotik: si el
// router viejo no responde (o ya no existe/está inactivo), no bloquea el
// guardado — solo se pierde la limpieza automática de esta vez.
async function limpiarNodoAnteriorSiCambio(
  nodoIdAnterior: number | null,
  direccionIpAnterior: string | null,
  nodoIdNuevo: number | null,
  direccionIpNuevo: string | null
): Promise<string | null> {
  if (!nodoIdAnterior || !direccionIpAnterior) return null; // no tenía nada que limpiar
  const seMueveDeNodo = nodoIdAnterior !== nodoIdNuevo;
  const leCambioLaIp = direccionIpAnterior !== direccionIpNuevo;
  if (!seMueveDeNodo && !leCambioLaIp) return null; // nada cambió, la sincronización normal ya se encarga

  try {
    await limpiarClienteDeNodo(nodoIdAnterior, direccionIpAnterior);
    return null;
  } catch (error: any) {
    const mensaje = error?.message || "No se pudo limpiar con el Mikrotik";
    console.error(`No se pudo limpiar la IP anterior "${direccionIpAnterior}" del nodo #${nodoIdAnterior}:`, error);
    return `El cliente cambió de nodo/IP, pero no se pudo borrar su entrada anterior en el Mikrotik del nodo viejo: ${mensaje}. Revisa manualmente en Control Mikrotik.`;
  }
}

// GET /clientes
// Sin "?page=" trae TODOS (lo necesita, ej., el selector de cliente del
// Punto de Venta). Con "?page=" pagina (lo usa la tabla de Clientes).
// "?q=" busca por identificación o razón social, sin importar mayúsculas/minúsculas.
// "?nodoId=" / "?vlanNodoId=" filtran por nodo de red / VLAN específica dentro
// de ese nodo (para la vista de clientes agrupados por VLAN en Nodos de Red).
clientesRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const busqueda = leerTextoBusqueda(req);
    const rango = leerRangoFechas(req);
    const nodoId = req.query.nodoId ? Number(req.query.nodoId) : undefined;
    const vlanNodoId = req.query.vlanNodoId ? Number(req.query.vlanNodoId) : undefined;
    const where: Prisma.ClienteWhereInput = {
      ...(busqueda && {
        OR: [
          { razonSocial: { contains: busqueda, mode: "insensitive" } },
          { identificacion: { contains: busqueda, mode: "insensitive" } },
        ],
      }),
      ...(rango && { createdAt: rango }),
      ...(nodoId && { nodoId }),
      ...(vlanNodoId && { vlanNodoId }),
    };

    if (!paginacion.aplica) {
      const clientes = await prisma.cliente.findMany({ where, include: { tipoPrecio: true, planInternet: true, nodo: { select: { id: true, nombre: true, descripcion: true, mikrotikHost: true, rangoIpInicio: true, rangoIpFin: true, activo: true } }, vlanNodo: true }, orderBy: { razonSocial: "asc" } });
      return res.json(clientes);
    }

    const [clientes, total] = await Promise.all([
      prisma.cliente.findMany({
        where,
        include: { tipoPrecio: true, planInternet: true, nodo: { select: { id: true, nombre: true, descripcion: true, mikrotikHost: true, rangoIpInicio: true, rangoIpFin: true, activo: true } }, vlanNodo: true },
        orderBy: { razonSocial: "asc" },
        skip: paginacion.skip,
        take: paginacion.take,
      }),
      prisma.cliente.count({ where }),
    ]);
    res.json(respuestaPaginada(clientes, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar clientes" });
  }
});

// GET /clientes/:id/historial
// Qué productos se le han vendido a este cliente (facturas + notas de venta),
// cuánto y bajo qué número de documento — para poder responder "¿qué le
// hemos vendido a este cliente?" sin tener que revisar factura por factura.
clientesRouter.get("/:id/historial", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const [facturas, notasVenta] = await Promise.all([
      prisma.facturaDetalle.findMany({
        where: { factura: { clienteId: id } },
        include: { factura: true, producto: true },
      }),
      prisma.notaVentaDetalle.findMany({
        where: { notaVenta: { clienteId: id } },
        include: { notaVenta: true, producto: true },
      }),
    ]);

    const historial = [
      ...facturas.map((d: (typeof facturas)[number]) => ({
        fecha: d.factura.fechaEmision,
        tipo: "FACTURA" as const,
        documento: d.factura.secuencial,
        producto: d.producto.nombre,
        cantidad: d.cantidad,
        precioUnitario: d.precioUnitario,
        subtotal: d.subtotal,
        estado: d.factura.estado,
      })),
      ...notasVenta.map((d: (typeof notasVenta)[number]) => ({
        fecha: d.notaVenta.fechaEmision,
        tipo: "NOTA_VENTA" as const,
        documento: d.notaVenta.secuencial,
        producto: d.producto.nombre,
        cantidad: d.cantidad,
        precioUnitario: d.precioUnitario,
        subtotal: d.subtotal,
        estado: d.notaVenta.estado,
      })),
    ].sort((a, b) => b.fecha.getTime() - a.fecha.getTime());

    res.json(historial);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el historial del cliente" });
  }
});

// GET /clientes/:id/historial-visitas
// Todas las visitas técnicas hechas a este cliente (instalaciones, cambios de
// domicilio, cambios de equipo, etc.), con el acta de cada una: qué se hizo,
// qué equipos se dejaron y las fotos guardadas — para responder "¿qué le
// hemos instalado/cambiado a este cliente a lo largo del tiempo?" sin tener
// que ir ruta por ruta.
clientesRouter.get("/:id/historial-visitas", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const visitas = await prisma.visitaTecnica.findMany({
      where: { clienteId: id },
      include: {
        equiposDejados: true,
        rutaVisita: { include: { empleado: { select: SELECT_EMPLEADO_SEGURO } } },
      },
      orderBy: { rutaVisita: { fecha: "desc" } },
    });
    res.json(visitas);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el historial de visitas del cliente" });
  }
});

// POST /clientes
// A propósito SIN requirePermiso("clientes") acá: el buscador de clientes
// (BuscadorCliente/ModalNuevoCliente) permite registrar un cliente nuevo al
// vuelo desde Punto de Venta, Proformas y Visitas Técnicas — cualquier
// usuario con "ventas" o "visitas_editar" (pero sin "clientes") debe poder
// seguir haciendo eso. Editar un cliente YA existente (PUT más abajo) sí
// está gateado, porque esa acción solo existe en la pantalla de Clientes.
// Body: { tipoIdentificacion?, identificacion, razonSocial, direccion?, ciudad?, email?, telefono?, tipoPrecioId }
clientesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { tipoIdentificacion, identificacion, razonSocial, direccion, ciudad, email, telefono, tipoPrecioId, direccionIp, planInternetId, nodoId, vlanNodoId, latitud, longitud, fechaContrato } = req.body;

    if (!identificacion || !razonSocial || tipoPrecioId === undefined) {
      return res.status(400).json({ error: "identificacion, razonSocial y tipoPrecioId son obligatorios" });
    }

    const tipo = tipoIdentificacion ?? "CEDULA";
    const validacion = validarIdentificacion(tipo, identificacion);
    if (!validacion.valido) {
      return res.status(400).json({ error: validacion.mensaje });
    }

    // El email es opcional, pero si lo mandan, que tenga forma de email —
    // así evitamos guardar un typo que después haga fallar el envío
    // automático del RIDE/XML en silencio.
    if (email && !emailValido(email)) {
      return res.status(400).json({ error: "El correo electrónico no es válido" });
    }
    if (direccionIp && !direccionIpValida(direccionIp)) {
      return res.status(400).json({ error: "La dirección IP no tiene un formato válido" });
    }
    if (latitud !== undefined && latitud !== null && !coordenadaValida(Number(latitud), -90, 90)) {
      return res.status(400).json({ error: "La latitud no es válida" });
    }
    if (longitud !== undefined && longitud !== null && !coordenadaValida(Number(longitud), -180, 180)) {
      return res.status(400).json({ error: "La longitud no es válida" });
    }

    if (!(await tipoPrecioValido(Number(tipoPrecioId)))) {
      return res.status(400).json({ error: "tipoPrecioId no corresponde a una categoría de precio activa" });
    }

    let planInternet = null;
    if (planInternetId) {
      planInternet = await planInternetValido(Number(planInternetId));
      if (!planInternet) {
        return res.status(400).json({ error: "planInternetId no corresponde a un plan de internet activo" });
      }
    }

    if (nodoId && !(await nodoValido(Number(nodoId)))) {
      return res.status(400).json({ error: "nodoId no corresponde a un nodo de red activo" });
    }
    if (vlanNodoId && !(await vlanValida(Number(vlanNodoId), nodoId ? Number(nodoId) : null))) {
      return res.status(400).json({ error: "vlanNodoId no corresponde a una VLAN activa de ese mismo nodo" });
    }

    const cliente = await prisma.cliente.create({
      data: {
        tipoIdentificacion: tipo,
        identificacion,
        razonSocial,
        direccion,
        ciudad,
        email,
        telefono,
        tipoPrecioId: Number(tipoPrecioId),
        direccionIp: direccionIp || null,
        planInternetId: planInternetId ? Number(planInternetId) : null,
        nodoId: nodoId ? Number(nodoId) : null,
        vlanNodoId: vlanNodoId ? Number(vlanNodoId) : null,
        latitud: latitud !== undefined && latitud !== null ? Number(latitud) : null,
        longitud: longitud !== undefined && longitud !== null ? Number(longitud) : null,
        // fechaLocalDeString, NUNCA "new Date(fechaContrato)" a secas — un
        // string "YYYY-MM-DD" parseado directo cae en medianoche UTC, y en
        // un servidor con huso horario detrás de UTC (Ecuador, UTC-5) eso
        // corre el día al anterior (ver el comentario largo en
        // utils/rangoFechas.ts). El día del mes de este campo ES el dato —
        // correrse un día lo arruina.
        fechaContrato: fechaContrato ? fechaLocalDeString(fechaContrato, false) : null,
      },
      include: { tipoPrecio: true, planInternet: true, nodo: { select: { id: true, nombre: true, descripcion: true, mikrotikHost: true, rangoIpInicio: true, rangoIpFin: true, activo: true } }, vlanNodo: true },
    });

    const advertenciaMikrotik = await sincronizarClienteMikrotik(cliente.nodoId, cliente.direccionIp, planInternet, cliente.razonSocial);

    res.status(201).json({ ...cliente, advertenciaMikrotik });
  } catch (error: any) {
    if (error.code === "P2002") {
      const campo = error.meta?.target?.includes?.("direccionIp") ? "direccionIp" : "identificacion";
      return res.status(409).json({
        error: campo === "direccionIp" ? "Ya hay otro cliente con esa dirección IP" : "Ya existe un cliente con esa identificación",
      });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el cliente" });
  }
});

// PUT /clientes/:id
// Edita los datos de contacto de un cliente existente. NO permite cambiar
// "tipoIdentificacion" ni "identificacion" (cédula/RUC) — es la clave de
// negocio del cliente, y puede que ya haya quedado registrada tal cual en
// facturas ya autorizadas por el SRI; cambiarla after-the-fact rompería esa
// referencia histórica (igual que el "codigo" de Producto). "tipoPrecioId" SÍ
// se puede editar: un cliente puede cambiar de categoría de precio con el tiempo.
clientesRouter.put("/:id", requirePermiso("clientes"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { razonSocial, direccion, ciudad, email, telefono, tipoPrecioId, direccionIp, planInternetId, nodoId, vlanNodoId, latitud, longitud, fechaContrato } = req.body;

    if (!razonSocial || tipoPrecioId === undefined) {
      return res.status(400).json({ error: "razonSocial y tipoPrecioId son obligatorios" });
    }
    if (email && !emailValido(email)) {
      return res.status(400).json({ error: "El correo electrónico no es válido" });
    }
    if (direccionIp && !direccionIpValida(direccionIp)) {
      return res.status(400).json({ error: "La dirección IP no tiene un formato válido" });
    }
    if (latitud !== undefined && latitud !== null && !coordenadaValida(Number(latitud), -90, 90)) {
      return res.status(400).json({ error: "La latitud no es válida" });
    }
    if (longitud !== undefined && longitud !== null && !coordenadaValida(Number(longitud), -180, 180)) {
      return res.status(400).json({ error: "La longitud no es válida" });
    }
    if (!(await tipoPrecioValido(Number(tipoPrecioId)))) {
      return res.status(400).json({ error: "tipoPrecioId no corresponde a una categoría de precio activa" });
    }

    let planInternet = null;
    if (planInternetId) {
      planInternet = await planInternetValido(Number(planInternetId));
      if (!planInternet) {
        return res.status(400).json({ error: "planInternetId no corresponde a un plan de internet activo" });
      }
    }

    if (nodoId && !(await nodoValido(Number(nodoId)))) {
      return res.status(400).json({ error: "nodoId no corresponde a un nodo de red activo" });
    }
    if (vlanNodoId && !(await vlanValida(Number(vlanNodoId), nodoId ? Number(nodoId) : null))) {
      return res.status(400).json({ error: "vlanNodoId no corresponde a una VLAN activa de ese mismo nodo" });
    }

    // Se guarda ANTES del update — es la única oportunidad de saber a qué
    // nodo/IP pertenecía este cliente hasta ahora, para poder limpiar su
    // entrada vieja si se muda de nodo o le cambian la IP (ver
    // limpiarNodoAnteriorSiCambio más abajo).
    const clienteAntes = await prisma.cliente.findUnique({ where: { id }, select: { nodoId: true, direccionIp: true } });

    const cliente = await prisma.cliente.update({
      where: { id },
      data: {
        razonSocial,
        direccion,
        ciudad,
        email,
        telefono,
        tipoPrecioId: Number(tipoPrecioId),
        direccionIp: direccionIp || null,
        planInternetId: planInternetId ? Number(planInternetId) : null,
        nodoId: nodoId ? Number(nodoId) : null,
        vlanNodoId: vlanNodoId ? Number(vlanNodoId) : null,
        latitud: latitud !== undefined && latitud !== null ? Number(latitud) : null,
        longitud: longitud !== undefined && longitud !== null ? Number(longitud) : null,
        // fechaLocalDeString, NUNCA "new Date(fechaContrato)" a secas — un
        // string "YYYY-MM-DD" parseado directo cae en medianoche UTC, y en
        // un servidor con huso horario detrás de UTC (Ecuador, UTC-5) eso
        // corre el día al anterior (ver el comentario largo en
        // utils/rangoFechas.ts). El día del mes de este campo ES el dato —
        // correrse un día lo arruina.
        fechaContrato: fechaContrato ? fechaLocalDeString(fechaContrato, false) : null,
      },
      include: { tipoPrecio: true, planInternet: true, nodo: { select: { id: true, nombre: true, descripcion: true, mikrotikHost: true, rangoIpInicio: true, rangoIpFin: true, activo: true } }, vlanNodo: true },
    });

    const advertenciaLimpieza = await limpiarNodoAnteriorSiCambio(
      clienteAntes?.nodoId ?? null,
      clienteAntes?.direccionIp ?? null,
      cliente.nodoId,
      cliente.direccionIp
    );
    const advertenciaSincronizacion = await sincronizarClienteMikrotik(cliente.nodoId, cliente.direccionIp, planInternet, cliente.razonSocial);
    const advertenciaMikrotik = [advertenciaLimpieza, advertenciaSincronizacion].filter(Boolean).join(" ") || null;

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_CLIENTE",
      entidad: "Cliente",
      entidadId: cliente.id,
      detalle: `${cliente.razonSocial} (${cliente.identificacion})`,
    });

    res.json({ ...cliente, advertenciaMikrotik });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya hay otro cliente con esa dirección IP" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar el cliente" });
  }
});

// PATCH /clientes/:id/prorroga
// Body: { dias: number } — de 1 a 4, según la política del negocio ("uno o
// dos o tres o cuatro días máximo") cuando un cliente llama pidiendo plazo.
// Guarda Cliente.prorrogaHasta y reactiva el servicio de inmediato en el
// Mikrotik. Sin esto, una reactivación manual normal (ver
// PATCH /mikrotik/:nodoId/direcciones/:ip/reactivar) duraba menos de una
// hora: el job de suspensión automática (ver
// utils/gestionServicioInternet.ts) la deshacía sola en su próxima corrida,
// porque no tenía forma de distinguir "reactivado por error" de "reactivado
// a propósito, con plazo". Con prorrogaHasta guardado, el job sabe que no
// debe volver a cortarlo hasta que se cumpla, aunque siga sin pagar.
clientesRouter.patch("/:id/prorroga", requirePermiso("clientes"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const dias = Number(req.body?.dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 4) {
      return res.status(400).json({ error: "La prórroga debe ser de 1 a 4 días" });
    }

    const cliente = await prisma.cliente.findUnique({ where: { id } });
    if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });
    if (!cliente.nodoId || !cliente.direccionIp) {
      return res.status(400).json({ error: "Este cliente no tiene nodo/IP asignados — no hay a qué Mikrotik reactivarlo" });
    }

    // Vence al final de ese día (no a la misma hora exacta en que se dio),
    // para no cortarlo a media tarde del último día de plazo.
    const prorrogaHasta = new Date();
    prorrogaHasta.setDate(prorrogaHasta.getDate() + dias);
    prorrogaHasta.setHours(23, 59, 59, 999);

    const actualizado = await prisma.cliente.update({ where: { id }, data: { prorrogaHasta } });

    let advertenciaMikrotik: string | null = null;
    try {
      await reactivarClientePorIp(cliente.nodoId, cliente.direccionIp);
    } catch (error: any) {
      advertenciaMikrotik = `Se guardó la prórroga, pero no se pudo reactivar en el Mikrotik: ${error?.message || "error desconocido"}. Revisa manualmente.`;
    }

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DAR_PRORROGA_INTERNET",
      entidad: "Cliente",
      entidadId: cliente.id,
      detalle: `${cliente.razonSocial}: ${dias} día(s), hasta ${prorrogaHasta.toLocaleDateString("es-EC")}`,
    });

    res.json({ ...actualizado, advertenciaMikrotik });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al otorgar la prórroga" });
  }
});
