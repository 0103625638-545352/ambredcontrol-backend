// Catálogo de bancos EXTERNOS (Pichincha, Guayaquil, Produbanco, etc.) — de
// dónde vino/salió el dinero de un Pago (ver Pago.bancoOrigenId en
// schema.prisma), NO las cuentas PROPIAS de la empresa (eso es
// CuentaBancaria/routes/cuentasBancarias.ts). Mirror de routes/tiposPrecio.ts
// (misma forma de CRUD con borrado suave). Solo ADMIN puede crear/editar/
// desactivar — cualquier usuario que registre un cobro puede elegir uno.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAdmin } from "../middleware/auth";
import { registrarAuditoria } from "../utils/auditoria";

export const bancosRouter = Router();

// GET /bancos
bancosRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const bancos = await prisma.banco.findMany({
      where: { activo: true },
      orderBy: { nombre: "asc" },
    });
    res.json(bancos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los bancos" });
  }
});

// POST /bancos
// Body: { nombre }
bancosRouter.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { nombre } = req.body;
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: "nombre es obligatorio" });
    }
    const banco = await prisma.banco.create({ data: { nombre: String(nombre).trim() } });
    res.status(201).json(banco);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un banco con ese nombre" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el banco" });
  }
});

// PUT /bancos/:id
bancosRouter.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre } = req.body;
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: "nombre es obligatorio" });
    }
    const banco = await prisma.banco.update({ where: { id }, data: { nombre: String(nombre).trim() } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_BANCO",
      entidad: "Banco",
      entidadId: banco.id,
      detalle: banco.nombre,
    });

    res.json(banco);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banco no encontrado" });
    }
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un banco con ese nombre" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar el banco" });
  }
});

// DELETE /bancos/:id
// Borrado suave: los pagos ya registrados con este banco lo conservan, solo
// deja de aparecer como opción nueva.
bancosRouter.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const banco = await prisma.banco.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_BANCO",
      entidad: "Banco",
      entidadId: banco.id,
      detalle: banco.nombre,
    });

    res.json({ mensaje: "Banco desactivado", banco });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banco no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el banco" });
  }
});
