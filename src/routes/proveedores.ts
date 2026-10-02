// Catálogo de proveedores — es al módulo de Compras lo que Cliente es a
// Factura/NotaVenta. Mismo patrón de búsqueda/paginación/validación que
// clientes.ts, deliberadamente: son la misma clase de entidad (un tercero
// con identificación tributaria) vista desde el otro lado de la operación.
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { validarIdentificacion } from "../utils/validarIdentificacion";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerTextoBusqueda } from "../utils/busqueda";
import { registrarAuditoria } from "../utils/auditoria";
import { leerRangoFechas } from "../utils/rangoFechas";
import { emailValido } from "../utils/validarEmail";

export const proveedoresRouter = Router();

// GET /proveedores
// Sin "?page=" trae TODOS (lo necesita el buscador de proveedores en Compras).
// Con "?page=" pagina (lo usa la tabla de administración de Proveedores).
// "?q=" busca por identificación o razón social.
proveedoresRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const busqueda = leerTextoBusqueda(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.ProveedorWhereInput = {
      activo: true,
      ...(busqueda && {
        OR: [
          { razonSocial: { contains: busqueda, mode: "insensitive" } },
          { identificacion: { contains: busqueda, mode: "insensitive" } },
          { email: { contains: busqueda, mode: "insensitive" } },
          { telefono: { contains: busqueda, mode: "insensitive" } },
        ],
      }),
      ...(rango && { createdAt: rango }),
    };

    if (!paginacion.aplica) {
      const proveedores = await prisma.proveedor.findMany({ where, orderBy: { razonSocial: "asc" } });
      return res.json(proveedores);
    }

    const [proveedores, total] = await Promise.all([
      prisma.proveedor.findMany({
        where,
        orderBy: { razonSocial: "asc" },
        skip: paginacion.skip,
        take: paginacion.take,
      }),
      prisma.proveedor.count({ where }),
    ]);
    res.json(respuestaPaginada(proveedores, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar proveedores" });
  }
});

// GET /proveedores/:id/historial
// Qué productos le hemos comprado a este proveedor, cuánto y bajo qué
// número de factura — el reverso de GET /clientes/:id/historial.
proveedoresRouter.get("/:id/historial", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const compras = await prisma.compraDetalle.findMany({
      where: { compra: { proveedorId: id } },
      include: { compra: true, producto: true },
    });

    const historial = compras
      .map((d: (typeof compras)[number]) => ({
        fecha: d.compra.fechaEmision,
        documento: d.compra.numeroFactura,
        producto: d.producto.nombre,
        cantidad: d.cantidad,
        costoUnitario: d.costoUnitario,
        subtotal: d.subtotal,
        estado: d.compra.estado,
      }))
      .sort((a, b) => b.fecha.getTime() - a.fecha.getTime());

    res.json(historial);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el historial del proveedor" });
  }
});

// POST /proveedores
// Body: { tipoIdentificacion?, identificacion, razonSocial, direccion?, telefono?, email? }
proveedoresRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { tipoIdentificacion, identificacion, razonSocial, direccion, telefono, email } = req.body;

    if (!identificacion || !razonSocial) {
      return res.status(400).json({ error: "identificacion y razonSocial son obligatorios" });
    }

    const tipo = tipoIdentificacion ?? "RUC";
    const validacion = validarIdentificacion(tipo, identificacion);
    if (!validacion.valido) {
      return res.status(400).json({ error: validacion.mensaje });
    }

    if (email && !emailValido(email)) {
      return res.status(400).json({ error: "El correo electrónico no es válido" });
    }

    const proveedor = await prisma.proveedor.create({
      data: { tipoIdentificacion: tipo, identificacion, razonSocial, direccion, telefono, email },
    });

    res.status(201).json(proveedor);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un proveedor con esa identificación" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el proveedor" });
  }
});

// PUT /proveedores/:id
// No permite cambiar tipoIdentificacion/identificacion — es la clave de
// negocio, y ya puede estar referenciada en compras existentes.
proveedoresRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { razonSocial, direccion, telefono, email } = req.body;

    if (!razonSocial) {
      return res.status(400).json({ error: "razonSocial es obligatorio" });
    }
    if (email && !emailValido(email)) {
      return res.status(400).json({ error: "El correo electrónico no es válido" });
    }

    const proveedor = await prisma.proveedor.update({
      where: { id },
      data: { razonSocial, direccion, telefono, email },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_PROVEEDOR",
      entidad: "Proveedor",
      entidadId: proveedor.id,
      detalle: `${proveedor.razonSocial} (${proveedor.identificacion})`,
    });

    res.json(proveedor);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar el proveedor" });
  }
});

// DELETE /proveedores/:id
// Borrado suave, igual que Cliente/Producto: preserva el historial de compras.
proveedoresRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const proveedor = await prisma.proveedor.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_PROVEEDOR",
      entidad: "Proveedor",
      entidadId: proveedor.id,
      detalle: `${proveedor.razonSocial} (${proveedor.identificacion})`,
    });

    res.json({ mensaje: "Proveedor desactivado", proveedor });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el proveedor" });
  }
});
