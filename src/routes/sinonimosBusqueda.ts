// Diccionario editable del "Buscador dinámico" de Reportes — ver
// frontend/src/utils/interpretarBusqueda.ts. El admin agrega/borra palabras
// desde Ajustes; el buscador las combina con su vocabulario de fábrica cada
// vez que carga la pantalla, sin que un cambio de vocabulario requiera tocar
// código. Gateado con el mismo permiso "reportes" que ya protege la
// pantalla donde vive el buscador — no hace falta un permiso nuevo.
import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { registrarAuditoria } from "../utils/auditoria";

export const sinonimosBusquedaRouter = Router();

const CATEGORIAS_VALIDAS = ["ACTIVOS", "SUSPENDIDOS", "PAGARON", "NO_PAGARON", "VENTAS", "CLIENTES"];

// Mismo criterio de normalización que usa el parser en el frontend
// (interpretarBusqueda.ts): minúsculas y sin tildes, para comparar
// consistente sin importar cómo lo haya tipeado el admin.
function normalizarPalabra(valor: string): string {
  return valor
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// GET /sinonimos-busqueda
// Cualquiera con permiso "reportes" puede LEER el diccionario (lo necesita
// el buscador para funcionar) — solo agregar/borrar queda para quien además
// tenga rol ADMIN (ver abajo).
sinonimosBusquedaRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const sinonimos = await prisma.sinonimoBusqueda.findMany({ orderBy: [{ categoria: "asc" }, { palabra: "asc" }] });
    res.json(sinonimos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar el diccionario del buscador" });
  }
});

// POST /sinonimos-busqueda
// Body: { categoria, palabra }
sinonimosBusquedaRouter.post("/", async (req: Request, res: Response) => {
  try {
    if (req.usuario!.rol !== "ADMIN") {
      return res.status(403).json({ error: "Solo un administrador puede editar el diccionario del buscador" });
    }

    const { categoria, palabra } = req.body;
    if (!categoria || !CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ error: `categoria debe ser una de: ${CATEGORIAS_VALIDAS.join(", ")}` });
    }
    const palabraNormalizada = normalizarPalabra(String(palabra || ""));
    if (!palabraNormalizada) {
      return res.status(400).json({ error: "palabra es obligatoria" });
    }

    const creado = await prisma.sinonimoBusqueda.create({
      data: { categoria, palabra: palabraNormalizada },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "AGREGAR_SINONIMO_BUSQUEDA",
      entidad: "SinonimoBusqueda",
      entidadId: creado.id,
      detalle: `${categoria}: "${palabraNormalizada}"`,
    });

    res.status(201).json(creado);
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Esa palabra ya está agregada a esa categoría" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al agregar la palabra al diccionario del buscador" });
  }
});

// DELETE /sinonimos-busqueda/:id
sinonimosBusquedaRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    if (req.usuario!.rol !== "ADMIN") {
      return res.status(403).json({ error: "Solo un administrador puede editar el diccionario del buscador" });
    }

    const id = Number(req.params.id);
    const sinonimo = await prisma.sinonimoBusqueda.delete({ where: { id } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "ELIMINAR_SINONIMO_BUSQUEDA",
      entidad: "SinonimoBusqueda",
      entidadId: id,
      detalle: `${sinonimo.categoria}: "${sinonimo.palabra}"`,
    });

    res.json({ mensaje: "Palabra eliminada" });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "No se encontró esa palabra" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al eliminar la palabra del diccionario del buscador" });
  }
});
