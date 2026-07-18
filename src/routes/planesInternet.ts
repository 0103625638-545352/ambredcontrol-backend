// Catálogo de planes de internet que un Cliente del ISP puede contratar
// (nombre + velocidad + precio + codigoMikrotik) — mismo criterio de CRUD
// con borrado suave que routes/tiposPrecio.ts, pero gateado por el permiso
// "mikrotik" (ver utils/permisos.ts) en vez de requireAdmin: es parte del
// mismo dominio de red que el resto de /mikrotik, no de administración
// general.
//
// codigoMikrotik (ej. "PLAN550") es el nombre EXACTO de la address-list en
// el router; acá solo se guarda el código para poder agregar/quitar
// clientes de esa lista (ver routes/clientes.ts). El límite de velocidad
// NO se aplica en el Mikrotik — se aprovisiona en la OLT por ONU, fuera del
// alcance de este sistema (evita saturar el router con Queues de todos los
// clientes). No hace falta sincronizar nada con el router al crear/editar
// un plan — a diferencia del vínculo con Cliente, la lista se crea sola en
// RouterOS la primera vez que se le agrega una IP.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { registrarAuditoria } from "../utils/auditoria";
import { sincronizarProductoDePlan } from "../utils/planProducto";

export const planesInternetRouter = Router();


// GET /planes-internet
planesInternetRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const planes = await prisma.planInternet.findMany({
      where: { activo: true },
      orderBy: { precio: "asc" },
    });
    res.json(planes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los planes de internet" });
  }
});

// POST /planes-internet
// Body: { nombre, velocidadSubida, velocidadBajada, precio, codigoMikrotik? }
planesInternetRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { nombre, velocidadSubida, velocidadBajada, precio, codigoMikrotik } = req.body;
    if (!nombre || !velocidadSubida || !velocidadBajada || precio === undefined) {
      return res.status(400).json({ error: "nombre, velocidadSubida, velocidadBajada y precio son obligatorios" });
    }
    if (Number(precio) < 0) {
      return res.status(400).json({ error: "precio no puede ser negativo" });
    }

    const plan = await prisma.$transaction(async (tx) => {
      const creado = await tx.planInternet.create({
        data: { nombre, velocidadSubida, velocidadBajada, precio, codigoMikrotik: codigoMikrotik || null },
      });
      // Provisiona de una vez el Producto espejo (ver utils/planProducto.ts)
      // para que el plan ya se pueda facturar desde el minuto uno, sin
      // esperar a la primera factura para recién crearlo.
      await sincronizarProductoDePlan(tx, creado);
      return creado;
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_PLAN_INTERNET",
      entidad: "PlanInternet",
      entidadId: plan.id,
      detalle: `${plan.nombre} (${plan.velocidadSubida}/${plan.velocidadBajada})`,
    });

    res.status(201).json(plan);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya hay otro plan con ese código de Mikrotik" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el plan de internet" });
  }
});

// PUT /planes-internet/:id
planesInternetRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, velocidadSubida, velocidadBajada, precio, codigoMikrotik } = req.body;
    if (!nombre || !velocidadSubida || !velocidadBajada || precio === undefined) {
      return res.status(400).json({ error: "nombre, velocidadSubida, velocidadBajada y precio son obligatorios" });
    }
    if (Number(precio) < 0) {
      return res.status(400).json({ error: "precio no puede ser negativo" });
    }

    const plan = await prisma.$transaction(async (tx) => {
      const editado = await tx.planInternet.update({
        where: { id },
        data: { nombre, velocidadSubida, velocidadBajada, precio, codigoMikrotik: codigoMikrotik || null },
      });
      // Si cambió el precio o el nombre, el Producto espejo (o las facturas
      // de internet YA emitidas, que copian su propio precioUnitario en el
      // momento de facturar y no se ven afectadas retroactivamente) refleja
      // el nuevo precio desde la próxima factura.
      await sincronizarProductoDePlan(tx, editado);
      return editado;
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_PLAN_INTERNET",
      entidad: "PlanInternet",
      entidadId: plan.id,
      detalle: `${plan.nombre} (${plan.velocidadSubida}/${plan.velocidadBajada})`,
    });

    res.json(plan);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Plan de internet no encontrado" });
    }
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya hay otro plan con ese código de Mikrotik" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar el plan de internet" });
  }
});

// DELETE /planes-internet/:id
// Borrado suave: los clientes que ya lo tienen asignado lo conservan, solo
// deja de aparecer como opción para clientes nuevos.
planesInternetRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const plan = await prisma.planInternet.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_PLAN_INTERNET",
      entidad: "PlanInternet",
      entidadId: plan.id,
      detalle: plan.nombre,
    });

    res.json({ mensaje: "Plan de internet desactivado", plan });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Plan de internet no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el plan de internet" });
  }
});
