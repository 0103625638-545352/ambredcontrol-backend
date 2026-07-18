// Catálogo de cuentas bancarias de la empresa (global, no por sucursal — el
// banco al que llega una transferencia no depende de en qué local se cobró).
// Mirror de routes/tiposPrecio.ts (misma forma de CRUD con borrado suave),
// con requireAdmin: igual que TipoPrecio, esto fija datos estructurales que
// afectan la conciliación de dinero real de toda la empresa.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAdmin } from "../middleware/auth";
import { registrarAuditoria } from "../utils/auditoria";

export const cuentasBancariasRouter = Router();

const TIPOS_CUENTA_VALIDOS = ["AHORROS", "CORRIENTE"];

// GET /cuentas-bancarias
cuentasBancariasRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const cuentasBancarias = await prisma.cuentaBancaria.findMany({
      where: { activa: true },
      orderBy: { nombre: "asc" },
    });
    res.json(cuentasBancarias);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las cuentas bancarias" });
  }
});

// POST /cuentas-bancarias
// Body: { nombre, banco, numeroCuenta, tipoCuenta }
cuentasBancariasRouter.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { nombre, banco, numeroCuenta, tipoCuenta } = req.body;
    if (!nombre || !banco || !numeroCuenta || !tipoCuenta) {
      return res.status(400).json({ error: "nombre, banco, numeroCuenta y tipoCuenta son obligatorios" });
    }
    if (!TIPOS_CUENTA_VALIDOS.includes(tipoCuenta)) {
      return res.status(400).json({ error: 'tipoCuenta debe ser "AHORROS" o "CORRIENTE"' });
    }
    const cuentaBancaria = await prisma.cuentaBancaria.create({ data: { nombre, banco, numeroCuenta, tipoCuenta } });
    res.status(201).json(cuentaBancaria);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe una cuenta bancaria con ese banco y número de cuenta" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear la cuenta bancaria" });
  }
});

// PUT /cuentas-bancarias/:id
cuentasBancariasRouter.put("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, banco, numeroCuenta, tipoCuenta } = req.body;
    if (!nombre || !banco || !numeroCuenta || !tipoCuenta) {
      return res.status(400).json({ error: "nombre, banco, numeroCuenta y tipoCuenta son obligatorios" });
    }
    if (!TIPOS_CUENTA_VALIDOS.includes(tipoCuenta)) {
      return res.status(400).json({ error: 'tipoCuenta debe ser "AHORROS" o "CORRIENTE"' });
    }
    const cuentaBancaria = await prisma.cuentaBancaria.update({
      where: { id },
      data: { nombre, banco, numeroCuenta, tipoCuenta },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_CUENTA_BANCARIA",
      entidad: "CuentaBancaria",
      entidadId: cuentaBancaria.id,
      detalle: `${cuentaBancaria.nombre} (${cuentaBancaria.banco} — ${cuentaBancaria.numeroCuenta})`,
    });

    res.json(cuentaBancaria);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Cuenta bancaria no encontrada" });
    }
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe una cuenta bancaria con ese banco y número de cuenta" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar la cuenta bancaria" });
  }
});

// DELETE /cuentas-bancarias/:id
// Borrado suave: los pagos ya registrados con esta cuenta conservan la
// referencia aunque se desactive, solo deja de aparecer como opción nueva.
cuentasBancariasRouter.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const cuentaBancaria = await prisma.cuentaBancaria.update({ where: { id }, data: { activa: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_CUENTA_BANCARIA",
      entidad: "CuentaBancaria",
      entidadId: cuentaBancaria.id,
      detalle: `${cuentaBancaria.nombre} (${cuentaBancaria.banco} — ${cuentaBancaria.numeroCuenta})`,
    });

    res.json({ mensaje: "Cuenta bancaria desactivada", cuentaBancaria });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Cuenta bancaria no encontrada" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar la cuenta bancaria" });
  }
});
