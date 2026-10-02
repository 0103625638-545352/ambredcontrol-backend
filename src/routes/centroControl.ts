// Centro de Control — una sola pantalla con todo lo que necesita atención
// del lado operativo: alertas de la red GPON (cortes masivos y señal
// degradada), control del personal técnico (visitas sospechosas, cuadre de
// material, equipos en comodato sin recuperar), anomalías de combustible,
// indicadores del negocio ISP y encuestas de satisfacción. Todo de solo
// lectura salvo cerrar una alerta de red. Gateado entero por el permiso
// "centro_control" en index.ts.
//
// Las reglas en sí (qué cuenta como sospechoso/anormal) viven en
// utils/controlInterno.ts y utils/monitoreoRed.ts — acá solo se consultan
// los datos y se les aplican.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { SELECT_EMPLEADO_SEGURO } from "../utils/empleados";
import { leerRangoFechas, aClaveDia } from "../utils/rangoFechas";
import { evaluarVisita, detectarAnomaliasCombustible, DISTANCIA_SOSPECHOSA_METROS } from "../utils/controlInterno";
import { ventanaCicloActual, enPrimerCiclo, fechaLimitePago } from "../utils/gestionServicioInternet";
import { registrarAuditoria } from "../utils/auditoria";

export const centroControlRouter = Router();

const DIA_MS = 24 * 3600_000;

function nombreEmpleado(e: { nombres: string; apellidos: string }): string {
  return `${e.nombres} ${e.apellidos}`;
}

// Rango "?desde=&hasta=" con un default de los últimos N días si no viene
// ninguno (a diferencia de leerRangoFechas, que sin parámetros no filtra).
function rangoConDefault(req: Request, diasPorDefecto: number): { gte: Date; lte: Date } {
  const rango = leerRangoFechas(req);
  return {
    gte: rango?.gte ?? new Date(Date.now() - diasPorDefecto * DIA_MS),
    lte: rango?.lte ?? new Date(),
  };
}

// ===========================================================================
// RED
// ===========================================================================

// GET /centro-control/red/alertas?estado=abiertas|todas
// Para un corte masivo incluye los clientes de ese puerto PON (para saber a
// quién avisar); para señal degradada, la ONU y su cliente.
centroControlRouter.get("/red/alertas", async (req: Request, res: Response) => {
  try {
    const soloAbiertas = req.query.estado !== "todas";
    const alertas = await prisma.alertaRed.findMany({
      where: soloAbiertas ? { fechaFin: null } : { fechaInicio: { gte: new Date(Date.now() - 30 * DIA_MS) } },
      include: { olt: { select: { id: true, nombre: true } }, _count: { select: { tickets: true } } },
      orderBy: [{ fechaFin: { sort: "desc", nulls: "first" } }, { fechaInicio: "desc" }],
      take: 300,
    });

    const onuIds = alertas.map((a) => a.oltOnuId).filter((id): id is number => id !== null);
    const onus = await prisma.oltOnu.findMany({
      where: { id: { in: onuIds } },
      select: { id: true, serial: true, onuIndex: true, rxPowerDbm: true, estado: true, cliente: { select: { id: true, razonSocial: true, telefono: true } } },
    });
    const onuPorId = new Map(onus.map((o) => [o.id, o]));

    const resultado = [];
    for (const a of alertas) {
      let clientesAfectados: { id: number; razonSocial: string; telefono: string | null; estadoOnu: string | null }[] = [];
      if (a.tipo === "CORTE_MASIVO") {
        const delPuerto = await prisma.oltOnu.findMany({
          where: { oltId: a.oltId, slot: a.slot, puerto: a.puerto, activo: true, clienteId: { not: null } },
          select: { estado: true, cliente: { select: { id: true, razonSocial: true, telefono: true } } },
        });
        clientesAfectados = delPuerto
          .filter((o) => o.cliente)
          .map((o) => ({ ...o.cliente!, estadoOnu: o.estado }))
          .sort((x, y) => (x.estadoOnu === "OFFLINE" ? -1 : 1) - (y.estadoOnu === "OFFLINE" ? -1 : 1));
      }
      const onu = a.oltOnuId ? onuPorId.get(a.oltOnuId) : undefined;
      resultado.push({
        id: a.id,
        tipo: a.tipo,
        olt: a.olt,
        slot: a.slot,
        puerto: a.puerto,
        cantidadAfectadas: a.cantidadAfectadas,
        mensaje: a.mensaje,
        fechaInicio: a.fechaInicio,
        fechaFin: a.fechaFin,
        cerradaManualmente: a.cerradaManualmente,
        cantidadTickets: a._count.tickets,
        onu: onu
          ? { id: onu.id, serial: onu.serial, onuIndex: onu.onuIndex, rxPowerDbm: onu.rxPowerDbm?.toFixed(2) ?? null, estado: onu.estado, cliente: onu.cliente }
          : null,
        clientesAfectados,
      });
    }
    res.json(resultado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener las alertas de red" });
  }
});

// PATCH /centro-control/red/alertas/:id/cerrar
// Cierre manual ("ya lo sé, ya está atendido") — una alerta de señal
// degradada cerrada así no se vuelve a abrir en una semana para esa ONU
// (ver evaluarSenalDegradada).
centroControlRouter.patch("/red/alertas/:id/cerrar", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const resultado = await prisma.alertaRed.updateMany({
      where: { id, fechaFin: null },
      data: { fechaFin: new Date(), cerradaManualmente: true },
    });
    if (resultado.count === 0) return res.status(404).json({ error: "La alerta no existe o ya estaba cerrada" });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CERRAR_ALERTA_RED",
      entidad: "AlertaRed",
      entidadId: id,
      detalle: "Cerrada manualmente desde el Centro de Control",
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al cerrar la alerta" });
  }
});

// GET /centro-control/red/onus/:id/historial?dias=30
centroControlRouter.get("/red/onus/:id/historial", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 90);
    const lecturas = await prisma.lecturaSenalOnu.findMany({
      where: { oltOnuId: id, fecha: { gte: new Date(Date.now() - dias * DIA_MS) } },
      orderBy: { fecha: "asc" },
      select: { fecha: true, rxPowerDbm: true },
    });
    res.json(lecturas.map((l) => ({ fecha: l.fecha, rxPowerDbm: l.rxPowerDbm.toFixed(2) })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el historial de señal" });
  }
});

// GET /centro-control/red/peores-senales — las 30 ONUs ONLINE con peor señal
// ahora mismo, tengan o no alerta abierta: sirve para planificar
// mantenimiento preventivo por zona.
centroControlRouter.get("/red/peores-senales", async (_req: Request, res: Response) => {
  try {
    const onus = await prisma.oltOnu.findMany({
      where: { activo: true, estado: "ONLINE", rxPowerDbm: { not: null } },
      orderBy: { rxPowerDbm: "asc" },
      take: 30,
      select: {
        id: true,
        slot: true,
        puerto: true,
        onuIndex: true,
        serial: true,
        rxPowerDbm: true,
        olt: { select: { nombre: true } },
        cliente: { select: { id: true, razonSocial: true } },
      },
    });
    res.json(onus.map((o) => ({ ...o, rxPowerDbm: o.rxPowerDbm!.toFixed(2) })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener las señales" });
  }
});

// ===========================================================================
// PERSONAL TÉCNICO
// ===========================================================================

// GET /centro-control/tecnicos/visitas-sospechosas?desde=&hasta= (default 7 días)
// Cruza cada visita completada con (a) la distancia registrada al marcar
// "Llegué" y (b) el rastreo GPS de fondo del técnico de ese día, si usa la
// app nativa (ver utils/controlInterno.ts → evaluarVisita).
centroControlRouter.get("/tecnicos/visitas-sospechosas", async (req: Request, res: Response) => {
  try {
    const rango = rangoConDefault(req, 7);
    const visitas = await prisma.visitaTecnica.findMany({
      where: { estado: "COMPLETADA", fechaLlegadaReal: rango },
      include: {
        cliente: { select: { id: true, razonSocial: true } },
        rutaVisita: { select: { fecha: true, empleado: { select: SELECT_EMPLEADO_SEGURO } } },
      },
      orderBy: { fechaLlegadaReal: "desc" },
    });

    const empleadoIds = [...new Set(visitas.map((v) => v.rutaVisita.empleado.id))];
    const rastro = await prisma.ubicacionTecnico.findMany({
      where: { empleadoId: { in: empleadoIds }, fecha: { gte: new Date(rango.gte.getTime() - DIA_MS), lte: new Date(rango.lte.getTime() + DIA_MS) } },
      select: { empleadoId: true, latitud: true, longitud: true, fecha: true },
    });
    const rastroPorEmpleadoDia = new Map<string, { latitud: number; longitud: number; fecha: Date }[]>();
    for (const p of rastro) {
      const clave = `${p.empleadoId}|${aClaveDia(p.fecha)}`;
      const lista = rastroPorEmpleadoDia.get(clave) ?? [];
      lista.push({ latitud: p.latitud.toNumber(), longitud: p.longitud.toNumber(), fecha: p.fecha });
      rastroPorEmpleadoDia.set(clave, lista);
    }

    const porTecnico = new Map<number, { empleadoId: number; nombre: string; visitas: number; sospechosas: number }>();
    const sospechosas = [];
    for (const v of visitas) {
      const empleado = v.rutaVisita.empleado;
      const evaluacion = evaluarVisita(
        {
          latitud: v.latitud.toNumber(),
          longitud: v.longitud.toNumber(),
          distanciaAlPunto: v.distanciaAlPunto ? v.distanciaAlPunto.toNumber() : null,
          fechaLlegadaReal: v.fechaLlegadaReal,
        },
        rastroPorEmpleadoDia.get(`${empleado.id}|${aClaveDia(v.fechaLlegadaReal!)}`) ?? []
      );

      const fila = porTecnico.get(empleado.id) ?? { empleadoId: empleado.id, nombre: nombreEmpleado(empleado), visitas: 0, sospechosas: 0 };
      fila.visitas++;
      if (evaluacion.sospechosa) fila.sospechosas++;
      porTecnico.set(empleado.id, fila);

      if (evaluacion.sospechosa) {
        sospechosas.push({
          visitaId: v.id,
          fechaLlegadaReal: v.fechaLlegadaReal,
          tecnico: nombreEmpleado(empleado),
          empleadoId: empleado.id,
          nombreContacto: v.nombreContacto,
          cliente: v.cliente,
          motivoVisita: v.motivoVisita,
          distanciaAlPunto: v.distanciaAlPunto ? Math.round(v.distanciaAlPunto.toNumber()) : null,
          distanciaRastroMetros: evaluacion.distanciaRastroMetros !== null ? Math.round(evaluacion.distanciaRastroMetros) : null,
          motivos: evaluacion.motivos,
        });
      }
    }

    res.json({
      umbralMetros: DISTANCIA_SOSPECHOSA_METROS,
      totalVisitas: visitas.length,
      porTecnico: [...porTecnico.values()].sort((a, b) => b.sospechosas - a.sospechosas),
      sospechosas,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al evaluar las visitas" });
  }
});

// GET /centro-control/tecnicos/cuadre
// Por técnico: equipos que todavía tiene en mano (despachados y sin
// instalar ni devolver) y hace cuántos días; rollos de cable activos; cable
// faltante en rollos ya cerrados con conteo físico; y metros promedio que
// gasta por instalación comparado con el promedio del equipo (un técnico
// que reporta el doble que el resto merece una pregunta).
centroControlRouter.get("/tecnicos/cuadre", async (_req: Request, res: Response) => {
  try {
    const hace90 = new Date(Date.now() - 90 * DIA_MS);

    const [enTransito, rollosActivos, rollosConFaltante, usoMetraje] = await Promise.all([
      prisma.egresoBodegaDetalle.findMany({
        where: { estado: "EN_TRANSITO" },
        select: {
          id: true,
          createdAt: true,
          egreso: { select: { empleado: { select: SELECT_EMPLEADO_SEGURO } } },
          numeroSerieProducto: { select: { id: true, numeroSerie: true, producto: { select: { nombre: true, costoPromedioActual: true } } } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.asignacionMetraje.findMany({
        where: { activo: true },
        select: { id: true, metrosIniciales: true, metrosRestantes: true, createdAt: true, empleadoId: true, producto: { select: { nombre: true } } },
      }),
      prisma.asignacionMetraje.findMany({
        where: { metrosFaltantes: { gt: 0 }, createdAt: { gte: hace90 } },
        select: { id: true, metrosIniciales: true, metrosFaltantes: true, createdAt: true, empleadoId: true, producto: { select: { nombre: true, costoPromedioActual: true } } },
      }),
      prisma.equipoDejadoVisita.findMany({
        where: { metrosUsados: { not: null }, visita: { tipoTrabajo: "INSTALACION_NUEVA", fechaLlegadaReal: { gte: hace90 } } },
        select: { metrosUsados: true, visitaId: true, visita: { select: { rutaVisita: { select: { empleadoId: true } } } } },
      }),
    ]);

    const empleados = await prisma.empleado.findMany({
      where: {
        id: {
          in: [
            ...new Set([
              ...enTransito.map((e) => e.egreso.empleado.id),
              ...rollosActivos.map((r) => r.empleadoId),
              ...rollosConFaltante.map((r) => r.empleadoId),
              ...usoMetraje.map((u) => u.visita.rutaVisita.empleadoId),
            ]),
          ],
        },
      },
      select: SELECT_EMPLEADO_SEGURO,
    });

    // Metros por instalación: se suman por visita primero (una instalación
    // puede usar dos rollos) y después se promedian por técnico.
    const metrosPorVisita = new Map<number, { empleadoId: number; metros: number }>();
    for (const u of usoMetraje) {
      const fila = metrosPorVisita.get(u.visitaId) ?? { empleadoId: u.visita.rutaVisita.empleadoId, metros: 0 };
      fila.metros += u.metrosUsados ?? 0;
      metrosPorVisita.set(u.visitaId, fila);
    }
    const instalaciones = [...metrosPorVisita.values()];
    const promedioGeneral = instalaciones.length > 0 ? instalaciones.reduce((s, i) => s + i.metros, 0) / instalaciones.length : null;

    const ahora = Date.now();
    const tecnicos = empleados.map((emp) => {
      const equipos = enTransito
        .filter((e) => e.egreso.empleado.id === emp.id)
        .map((e) => ({
          detalleId: e.id,
          numeroSerieProductoId: e.numeroSerieProducto.id,
          producto: e.numeroSerieProducto.producto.nombre,
          numeroSerie: e.numeroSerieProducto.numeroSerie,
          dias: Math.floor((ahora - e.createdAt.getTime()) / DIA_MS),
        }));
      const rollos = rollosActivos
        .filter((r) => r.empleadoId === emp.id)
        .map((r) => ({ id: r.id, producto: r.producto.nombre, metrosIniciales: r.metrosIniciales, metrosRestantes: r.metrosRestantes, dias: Math.floor((ahora - r.createdAt.getTime()) / DIA_MS) }));
      const faltantes = rollosConFaltante.filter((r) => r.empleadoId === emp.id);
      const metrosFaltantes = faltantes.reduce((s, r) => s + (r.metrosFaltantes ?? 0), 0);
      const valorFaltante = faltantes.reduce(
        (s, r) => s.add(r.producto.costoPromedioActual ? r.producto.costoPromedioActual.mul(r.metrosFaltantes ?? 0) : 0),
        new Prisma.Decimal(0)
      );
      const susInstalaciones = instalaciones.filter((i) => i.empleadoId === emp.id);
      const promedioMetros = susInstalaciones.length > 0 ? susInstalaciones.reduce((s, i) => s + i.metros, 0) / susInstalaciones.length : null;

      return {
        empleadoId: emp.id,
        nombre: nombreEmpleado(emp),
        equiposEnMano: equipos,
        equiposMasDe7Dias: equipos.filter((e) => e.dias > 7).length,
        rollosActivos: rollos,
        metrosFaltantes,
        valorFaltante: valorFaltante.toFixed(2),
        instalaciones90Dias: susInstalaciones.length,
        promedioMetrosPorInstalacion: promedioMetros !== null ? Math.round(promedioMetros) : null,
        // > 1.5 veces el promedio del equipo, con al menos 3 instalaciones
        // para que no lo dispare una sola instalación larga.
        consumoAlto: promedioMetros !== null && promedioGeneral !== null && susInstalaciones.length >= 3 && promedioMetros > promedioGeneral * 1.5,
      };
    });

    res.json({
      promedioGeneralMetrosPorInstalacion: promedioGeneral !== null ? Math.round(promedioGeneral) : null,
      tecnicos: tecnicos.sort((a, b) => b.metrosFaltantes - a.metrosFaltantes || b.equiposMasDe7Dias - a.equiposMasDe7Dias),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular el cuadre de material" });
  }
});

// GET /centro-control/equipos-no-recuperados
// Equipos que quedaron instalados en clientes que ya se dieron de baja
// (ONU, router, etc. en comodato). Los que tienen número de serie del
// catálogo se pueden marcar como recuperados desde la pantalla (reusa POST
// /productos/series/:id/regresar-a-bodega); los de texto libre del acta solo
// se listan.
centroControlRouter.get("/equipos-no-recuperados", async (_req: Request, res: Response) => {
  try {
    const [conSerie, textoLibre] = await Promise.all([
      prisma.numeroSerieProducto.findMany({
        where: { estado: "ENTREGADO", cliente: { activo: false } },
        select: {
          id: true,
          numeroSerie: true,
          fechaEntrega: true,
          producto: { select: { nombre: true, costoPromedioActual: true } },
          cliente: { select: { id: true, razonSocial: true, telefono: true, direccion: true, fechaBaja: true } },
        },
        orderBy: { cliente: { fechaBaja: "asc" } },
      }),
      prisma.equipoDejadoVisita.findMany({
        where: {
          numeroSerieProductoId: null,
          asignacionMetrajeId: null,
          serial: { not: null },
          visita: { cliente: { activo: false } },
        },
        select: {
          id: true,
          tipo: true,
          modelo: true,
          serial: true,
          createdAt: true,
          visita: { select: { cliente: { select: { id: true, razonSocial: true, telefono: true, direccion: true, fechaBaja: true } } } },
        },
      }),
    ]);

    const valorTotal = conSerie.reduce(
      (s, e) => s.add(e.producto.costoPromedioActual ?? 0),
      new Prisma.Decimal(0)
    );

    res.json({
      valorEstimado: valorTotal.toFixed(2),
      conSerie: conSerie.map((e) => ({
        numeroSerieProductoId: e.id,
        producto: e.producto.nombre,
        numeroSerie: e.numeroSerie,
        costo: e.producto.costoPromedioActual?.toFixed(2) ?? null,
        fechaEntrega: e.fechaEntrega,
        cliente: e.cliente,
      })),
      textoLibre: textoLibre.map((e) => ({
        id: e.id,
        tipo: e.tipo,
        modelo: e.modelo,
        serial: e.serial,
        fechaInstalacion: e.createdAt,
        cliente: e.visita.cliente,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los equipos no recuperados" });
  }
});

// ===========================================================================
// COMBUSTIBLE
// ===========================================================================

// GET /centro-control/combustible/anomalias?desde=&hasta= (default 60 días)
// Se cargan además 180 días ANTES del rango: la mediana de rendimiento de
// cada vehículo y la "carga anterior" de la primera carga del rango salen
// de ahí.
centroControlRouter.get("/combustible/anomalias", async (req: Request, res: Response) => {
  try {
    const rango = rangoConDefault(req, 60);
    const cargas = await prisma.cargaCombustible.findMany({
      where: { fecha: { gte: new Date(rango.gte.getTime() - 180 * DIA_MS), lte: rango.lte } },
      select: {
        id: true,
        vehiculoId: true,
        fecha: true,
        kilometraje: true,
        galones: true,
        costoTotal: true,
        gasolinera: true,
        vehiculo: { select: { placa: true } },
        usuario: { select: { nombre: true } },
      },
    });

    const anomalias = detectarAnomaliasCombustible(cargas.map((c) => ({ id: c.id, vehiculoId: c.vehiculoId, fecha: c.fecha, kilometraje: c.kilometraje, galones: c.galones.toNumber() })));
    const cargaPorId = new Map(cargas.map((c) => [c.id, c]));

    res.json(
      anomalias
        .map((a) => ({ ...a, carga: cargaPorId.get(a.cargaId)! }))
        .filter((a) => a.carga.fecha >= rango.gte)
        .map((a) => ({
          cargaId: a.cargaId,
          fecha: a.carga.fecha,
          placa: a.carga.vehiculo.placa,
          kilometraje: a.carga.kilometraje,
          galones: a.carga.galones.toFixed(2),
          costoTotal: a.carga.costoTotal.toFixed(2),
          gasolinera: a.carga.gasolinera,
          registradoPor: a.carga.usuario?.nombre ?? null,
          motivo: a.motivo,
          rendimiento: a.rendimiento !== null ? a.rendimiento.toFixed(1) : null,
          rendimientoMediano: a.rendimientoMediano !== null ? a.rendimientoMediano.toFixed(1) : null,
        }))
        .sort((x, y) => y.fecha.getTime() - x.fecha.getTime())
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al analizar el combustible" });
  }
});

// ===========================================================================
// INDICADORES DEL NEGOCIO ISP
// ===========================================================================

// GET /centro-control/indicadores-isp
// Clientes activos, ingreso mensual recurrente, ingreso promedio por
// cliente (ARPU), altas/bajas de los últimos 12 meses (churn), morosidad del
// ciclo en curso y clientes con suspensiones repetidas.
centroControlRouter.get("/indicadores-isp", async (_req: Request, res: Response) => {
  try {
    const clientes = await prisma.cliente.findMany({
      where: { planInternetId: { not: null } },
      select: {
        id: true,
        razonSocial: true,
        telefono: true,
        activo: true,
        createdAt: true,
        fechaInicioServicio: true,
        fechaContrato: true,
        fechaBaja: true,
        motivoBaja: true,
        prorrogaHasta: true,
        planInternet: { select: { id: true, nombre: true, precio: true, productoId: true } },
      },
    });
    const activos = clientes.filter((c) => c.activo);
    const hoy = new Date();

    // --- Ingreso recurrente ---
    const mrr = activos.reduce((s, c) => s.add(c.planInternet!.precio), new Prisma.Decimal(0));
    const arpu = activos.length > 0 ? mrr.div(activos.length) : new Prisma.Decimal(0);

    const porPlan = new Map<number, { plan: string; clientes: number; ingreso: Prisma.Decimal }>();
    for (const c of activos) {
      const fila = porPlan.get(c.planInternet!.id) ?? { plan: c.planInternet!.nombre, clientes: 0, ingreso: new Prisma.Decimal(0) };
      fila.clientes++;
      fila.ingreso = fila.ingreso.add(c.planInternet!.precio);
      porPlan.set(c.planInternet!.id, fila);
    }

    // --- Altas / bajas por mes (12 meses) ---
    const fechaAlta = (c: (typeof clientes)[number]) => c.fechaInicioServicio ?? c.createdAt;
    const meses = [];
    for (let i = 11; i >= 0; i--) {
      const inicio = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const fin = new Date(hoy.getFullYear(), hoy.getMonth() - i + 1, 1);
      const activosAlInicio = clientes.filter((c) => fechaAlta(c) < inicio && (!c.fechaBaja || c.fechaBaja >= inicio)).length;
      const altas = clientes.filter((c) => fechaAlta(c) >= inicio && fechaAlta(c) < fin).length;
      const bajas = clientes.filter((c) => c.fechaBaja && c.fechaBaja >= inicio && c.fechaBaja < fin).length;
      meses.push({
        mes: `${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, "0")}`,
        activosAlInicio,
        altas,
        bajas,
        churnPorcentaje: activosAlInicio > 0 ? Math.round((bajas / activosAlInicio) * 1000) / 10 : null,
      });
    }

    const motivosBaja = new Map<string, number>();
    for (const c of clientes) {
      if (c.fechaBaja && c.fechaBaja >= new Date(hoy.getFullYear(), hoy.getMonth() - 11, 1)) {
        const motivo = (c.motivoBaja || "Sin motivo registrado").trim();
        motivosBaja.set(motivo, (motivosBaja.get(motivo) ?? 0) + 1);
      }
    }

    // --- Morosidad del ciclo en curso ---
    // Mismo criterio que pagoDeEsteCiclo (utils/gestionServicioInternet.ts)
    // pero en lote: dos consultas para todos los clientes en vez de dos por
    // cliente. Los ciclos duran como máximo un mes, así que 62 días atrás
    // cubre cualquier ventana en curso.
    const desdeVentanas = new Date(hoy.getTime() - 62 * DIA_MS);
    const productoIds = [...new Set(activos.map((c) => c.planInternet!.productoId).filter((id): id is number => id !== null))];
    const [facturasPagadas, cobrosAdelantados] = await Promise.all([
      prisma.factura.findMany({
        where: { clienteId: { in: activos.map((c) => c.id) }, estadoPago: "PAGADA", fechaEmision: { gte: desdeVentanas }, detalles: { some: { productoId: { in: productoIds } } } },
        select: { clienteId: true, fechaEmision: true, detalles: { select: { productoId: true } } },
      }),
      prisma.pago.findMany({
        where: { clienteId: { in: activos.map((c) => c.id) }, facturaId: null, fecha: { gte: desdeVentanas } },
        select: { clienteId: true, fecha: true },
      }),
    ]);

    const morosos = [];
    let pendientesDentroDePlazo = 0;
    let alDia = 0;
    for (const c of activos) {
      const productoId = c.planInternet!.productoId;
      if (!productoId || enPrimerCiclo(c)) continue;
      const { inicio, fin } = ventanaCicloActual(c);
      const pagado =
        facturasPagadas.some((f) => f.clienteId === c.id && f.fechaEmision >= inicio && f.fechaEmision < fin && f.detalles.some((d) => d.productoId === productoId)) ||
        cobrosAdelantados.some((p) => p.clienteId === c.id && p.fecha >= inicio && p.fecha < fin);
      if (pagado) {
        alDia++;
        continue;
      }
      const limite = fechaLimitePago(c);
      limite.setHours(23, 59, 59, 999);
      if (limite >= hoy) {
        pendientesDentroDePlazo++;
        continue;
      }
      morosos.push({
        id: c.id,
        razonSocial: c.razonSocial,
        telefono: c.telefono,
        plan: c.planInternet!.nombre,
        monto: c.planInternet!.precio.toFixed(2),
        diasAtraso: Math.floor((hoy.getTime() - limite.getTime()) / DIA_MS) + 1,
        enProrroga: !!(c.prorrogaHasta && c.prorrogaHasta >= hoy),
      });
    }
    const evaluados = alDia + pendientesDentroDePlazo + morosos.length;
    const montoMoroso = morosos.reduce((s, m) => s.add(m.monto), new Prisma.Decimal(0));

    // --- Suspensiones repetidas (6 meses) ---
    const eventos = await prisma.eventoServicioInternet.groupBy({
      by: ["clienteId"],
      where: { tipo: "SUSPENDIDO", fecha: { gte: new Date(hoy.getTime() - 180 * DIA_MS) } },
      _count: { _all: true },
      having: { clienteId: { _count: { gte: 2 } } },
    });
    const clientePorId = new Map(clientes.map((c) => [c.id, c]));
    const suspensionesRepetidas = eventos
      .map((e) => ({ cliente: clientePorId.get(e.clienteId), suspensiones: e._count._all }))
      .filter((e) => e.cliente)
      .map((e) => ({ id: e.cliente!.id, razonSocial: e.cliente!.razonSocial, telefono: e.cliente!.telefono, activo: e.cliente!.activo, suspensiones: e.suspensiones }))
      .sort((a, b) => b.suspensiones - a.suspensiones);
    const primerEvento = await prisma.eventoServicioInternet.findFirst({ orderBy: { fecha: "asc" }, select: { fecha: true } });

    res.json({
      clientesActivos: activos.length,
      ingresoMensualRecurrente: mrr.toFixed(2),
      arpu: arpu.toFixed(2),
      porPlan: [...porPlan.values()]
        .map((p) => ({ plan: p.plan, clientes: p.clientes, ingreso: p.ingreso.toFixed(2) }))
        .sort((a, b) => b.clientes - a.clientes),
      meses,
      motivosBaja: [...motivosBaja.entries()].map(([motivo, cantidad]) => ({ motivo, cantidad })).sort((a, b) => b.cantidad - a.cantidad),
      morosidad: {
        evaluados,
        alDia,
        pendientesDentroDePlazo,
        morosos: morosos.length,
        porcentaje: evaluados > 0 ? Math.round((morosos.length / evaluados) * 1000) / 10 : 0,
        montoMoroso: montoMoroso.toFixed(2),
        detalle: morosos.sort((a, b) => b.diasAtraso - a.diasAtraso),
      },
      suspensionesRepetidas,
      historialSuspensionesDesde: primerEvento?.fecha ?? null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calcular los indicadores del negocio" });
  }
});

// ===========================================================================
// ENCUESTAS DE SATISFACCIÓN
// ===========================================================================

// GET /centro-control/encuestas?desde=&hasta= (default 30 días)
centroControlRouter.get("/encuestas", async (req: Request, res: Response) => {
  try {
    const rango = rangoConDefault(req, 30);
    const encuestas = await prisma.encuestaVisita.findMany({
      where: { enviadaEn: rango, telefono: { not: "" } }, // "" = no se pudo enviar, ver jobs/encuestaVisitas.ts
      include: {
        visita: {
          select: {
            id: true,
            nombreContacto: true,
            motivoVisita: true,
            fechaLlegadaReal: true,
            cliente: { select: { id: true, razonSocial: true } },
            rutaVisita: { select: { empleado: { select: SELECT_EMPLEADO_SEGURO } } },
          },
        },
      },
      orderBy: { enviadaEn: "desc" },
    });

    const porTecnico = new Map<number, { empleadoId: number; nombre: string; enviadas: number; respondidas: number; suma: number; bajas: number }>();
    for (const e of encuestas) {
      const emp = e.visita.rutaVisita.empleado;
      const fila = porTecnico.get(emp.id) ?? { empleadoId: emp.id, nombre: nombreEmpleado(emp), enviadas: 0, respondidas: 0, suma: 0, bajas: 0 };
      fila.enviadas++;
      if (e.calificacion !== null) {
        fila.respondidas++;
        fila.suma += e.calificacion;
        if (e.calificacion <= 2) fila.bajas++;
      }
      porTecnico.set(emp.id, fila);
    }
    const respondidas = encuestas.filter((e) => e.calificacion !== null);

    res.json({
      enviadas: encuestas.length,
      respondidas: respondidas.length,
      promedio: respondidas.length > 0 ? Math.round((respondidas.reduce((s, e) => s + e.calificacion!, 0) / respondidas.length) * 10) / 10 : null,
      porTecnico: [...porTecnico.values()]
        .map((t) => ({ empleadoId: t.empleadoId, nombre: t.nombre, enviadas: t.enviadas, respondidas: t.respondidas, calificacionesBajas: t.bajas, promedio: t.respondidas > 0 ? Math.round((t.suma / t.respondidas) * 10) / 10 : null }))
        .sort((a, b) => (a.promedio ?? 99) - (b.promedio ?? 99)),
      encuestas: encuestas.map((e) => ({
        id: e.id,
        enviadaEn: e.enviadaEn,
        calificacion: e.calificacion,
        comentario: e.comentario,
        respondidaEn: e.respondidaEn,
        visitaId: e.visita.id,
        cliente: e.visita.cliente?.razonSocial ?? e.visita.nombreContacto,
        motivoVisita: e.visita.motivoVisita,
        tecnico: nombreEmpleado(e.visita.rutaVisita.empleado),
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las encuestas" });
  }
});
