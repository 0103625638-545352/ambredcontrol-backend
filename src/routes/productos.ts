// Rutas relacionadas al catálogo de productos.
// Cada función maneja una combinación de método HTTP + URL.

import { Router, Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import multer from "multer";
import { prisma, empresaActiva, empresaActivaId } from "../db";
import { requirePermiso } from "../middleware/auth";
import { leerPaginacion, respuestaPaginada } from "../utils/paginacion";
import { leerTextoBusqueda } from "../utils/busqueda";
import { registrarAuditoria } from "../utils/auditoria";
import { generarEtiquetasProductoPdf, type TamanoEtiqueta } from "../utils/generarEtiquetaProducto";
import { rutaAbsoluta } from "../utils/empresas";
import { sucursalDelUsuarioActual } from "../utils/sucursales";
import { bodegaValidaEnSucursal } from "../utils/bodegas";
import { leerRangoFechas } from "../utils/rangoFechas";
import { validarCodigoBarras } from "../utils/codigoBarras";
import { generarCodigoProducto } from "../utils/codigoProducto";

export const productosRouter = Router();

// --- Subida de la foto del producto ---
// Se guarda en disco (no en la base de datos) — la base solo guarda la ruta
// relativa ("imagenUrl"). El backend sirve esta carpeta como archivos
// estáticos en /uploads/:empresaId (ver index.ts). Cada empresa tiene su
// propia carpeta de uploads (ver EmpresaConfig.carpetaUploads).
function carpetaImagenesActiva(): string {
  const carpeta = path.join(rutaAbsoluta(empresaActiva().carpetaUploads), "productos");
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
  }
  return carpeta;
}

const TIPOS_IMAGEN_PERMITIDOS = ["image/jpeg", "image/png", "image/webp"];
const TAMANO_MAXIMO_IMAGEN = 5 * 1024 * 1024; // 5MB

const almacenamientoImagen = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, carpetaImagenesActiva()),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `producto-${req.params.id}-${Date.now()}${extension}`);
  },
});

const subirImagen = multer({
  storage: almacenamientoImagen,
  limits: { fileSize: TAMANO_MAXIMO_IMAGEN },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_IMAGEN_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error("Solo se permiten imágenes JPG, PNG o WEBP"));
    }
    cb(null, true);
  },
});

// multer reporta sus propios errores (tipo/tamaño inválido) llamando a
// next(error) — sin este wrapper, Express los mostraría como una página de
// error genérica en vez de un JSON consistente con el resto de la API.
function subirImagenMiddleware(req: Request, res: Response, next: NextFunction) {
  subirImagen.single("imagen")(req, res, (error: any) => {
    if (error?.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "La imagen no puede pesar más de 5MB" });
    }
    if (error) {
      return res.status(400).json({ error: error.message || "Error al subir la imagen" });
    }
    next();
  });
}

// GET /productos
// Lista todos los productos activos, con su categoría incluida.
// Sin "?page=" trae TODOS (lo necesita, ej., la grilla del Punto de Venta).
// Con "?page=" pagina (lo usa la tabla de administración de Productos).
// "?q=" busca por nombre o código, sin importar mayúsculas/minúsculas.
productosRouter.get("/", async (req: Request, res: Response) => {
  try {
    const paginacion = leerPaginacion(req);
    const busqueda = leerTextoBusqueda(req);
    const rango = leerRangoFechas(req);
    const where: Prisma.ProductoWhereInput = {
      activo: true,
      ...(busqueda && {
        OR: [
          { nombre: { contains: busqueda, mode: "insensitive" } },
          { codigo: { contains: busqueda, mode: "insensitive" } },
          { codigoBarras: { contains: busqueda, mode: "insensitive" } },
          { modelo: { contains: busqueda, mode: "insensitive" } },
          { marca: { contains: busqueda, mode: "insensitive" } },
        ],
      }),
      ...(rango && { createdAt: rango }),
      // Filtros opcionales de la pantalla Productos (sin ellos, igual que antes).
      ...(req.query.categoriaId === "sin" && { categoriaId: null }),
      ...(typeof req.query.categoriaId === "string" && /^[0-9]+$/.test(req.query.categoriaId) && { categoriaId: Number(req.query.categoriaId) }),
      ...(req.query.tipo === "SERVICIO" && { esServicio: true }),
      ...(req.query.tipo === "BIEN" && { esServicio: false }),
    };

    if (!paginacion.aplica) {
      const productos = await prisma.producto.findMany({
        where,
        include: {
          categoria: true,
          stockPorSucursal: { include: { sucursal: { select: { id: true, nombre: true } } } },
          stockPorBodega: { include: { bodega: { select: { id: true, nombre: true, sucursalId: true } } } },
        },
        orderBy: { nombre: "asc" },
      });
      return res.json(productos);
    }

    const [productos, total] = await Promise.all([
      prisma.producto.findMany({
        where,
        include: {
          categoria: true,
          stockPorSucursal: { include: { sucursal: { select: { id: true, nombre: true } } } },
          stockPorBodega: { include: { bodega: { select: { id: true, nombre: true, sucursalId: true } } } },
        },
        orderBy: { nombre: "asc" },
        skip: paginacion.skip,
        take: paginacion.take,
      }),
      prisma.producto.count({ where }),
    ]);
    res.json(respuestaPaginada(productos, total, paginacion));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar productos" });
  }
});

// GET /productos/:id
// Trae un solo producto por su id.
productosRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const producto = await prisma.producto.findUnique({
      where: { id },
      include: {
        categoria: true,
        stockPorSucursal: { include: { sucursal: { select: { id: true, nombre: true } } } },
        stockPorBodega: { include: { bodega: { select: { id: true, nombre: true, sucursalId: true } } } },
      },
    });

    if (!producto) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    res.json(producto);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar el producto" });
  }
});

// GET /productos/:id/historial
// Historial combinado de este producto: compras (quién nos vendió), ventas
// por factura y por nota de venta (a quién le vendimos) y devoluciones por
// nota de crédito — cada fila con su documento y su contraparte. A diferencia
// de MovimientoInventario (que solo guarda un texto libre en "motivo"), acá
// sí se puede navegar de vuelta al documento y al cliente/proveedor exactos.
productosRouter.get("/:id/historial", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const [compras, facturas, notasVenta, notasCredito] = await Promise.all([
      prisma.compraDetalle.findMany({
        where: { productoId: id },
        include: { compra: { include: { proveedor: true } } },
      }),
      prisma.facturaDetalle.findMany({
        where: { productoId: id },
        include: { factura: { include: { cliente: true } } },
      }),
      prisma.notaVentaDetalle.findMany({
        where: { productoId: id },
        include: { notaVenta: { include: { cliente: true } } },
      }),
      prisma.notaCreditoDetalle.findMany({
        where: { productoId: id },
        include: { notaCredito: { include: { factura: { include: { cliente: true } } } } },
      }),
    ]);

    const historial = [
      ...compras.map((d: (typeof compras)[number]) => ({
        fecha: d.compra.fechaEmision,
        tipo: "COMPRA" as const,
        documento: d.compra.numeroFactura,
        contraparte: d.compra.proveedor.razonSocial,
        cantidad: d.cantidad, // entra al stock
        precioUnitario: d.costoUnitario,
        subtotal: d.subtotal,
        estado: d.compra.estado,
      })),
      ...facturas.map((d: (typeof facturas)[number]) => ({
        fecha: d.factura.fechaEmision,
        tipo: "VENTA_FACTURA" as const,
        documento: d.factura.secuencial,
        contraparte: d.factura.cliente.razonSocial,
        cantidad: -d.cantidad, // sale del stock
        precioUnitario: d.precioUnitario,
        subtotal: d.subtotal,
        estado: d.factura.estado,
      })),
      ...notasVenta.map((d: (typeof notasVenta)[number]) => ({
        fecha: d.notaVenta.fechaEmision,
        tipo: "VENTA_NOTA_VENTA" as const,
        documento: d.notaVenta.secuencial,
        contraparte: d.notaVenta.cliente.razonSocial,
        cantidad: -d.cantidad,
        precioUnitario: d.precioUnitario,
        subtotal: d.subtotal,
        estado: d.notaVenta.estado,
      })),
      ...notasCredito.map((d: (typeof notasCredito)[number]) => ({
        fecha: d.notaCredito.fechaEmision,
        tipo: "DEVOLUCION" as const,
        documento: d.notaCredito.secuencial,
        contraparte: d.notaCredito.factura.cliente.razonSocial,
        cantidad: d.cantidad, // vuelve a entrar al stock
        precioUnitario: d.precioUnitario,
        subtotal: d.subtotal,
        estado: d.notaCredito.estado,
      })),
    ].sort((a, b) => b.fecha.getTime() - a.fecha.getTime());

    res.json(historial);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener el historial del producto" });
  }
});

// --- Números de serie (ver Producto.controlaNumeroSerie / modelo
// NumeroSerieProducto) — bodega los captura contra la compra que los trajo
// (ver "pendientes de serializar" en routes/compras.ts); acá solo se
// consultan y se "entregan" (vinculan a un cliente, acción aparte y
// opcional, nunca requerida para completar una venta).

const SELECT_SERIE_COMPLETA = {
  id: true,
  numeroSerie: true,
  estado: true,
  fechaEntrega: true,
  referenciaDocumento: true,
  createdAt: true,
  producto: { select: { id: true, nombre: true, codigo: true } },
  cliente: { select: { id: true, razonSocial: true, identificacion: true } },
  compraDetalle: {
    select: {
      compra: { select: { id: true, numeroFactura: true, fechaEmision: true, proveedor: { select: { razonSocial: true } } } },
    },
  },
  // Quién lo tiene en mano ahora mismo (solo tiene sentido cuando estado =
  // EN_TRANSITO, ver EgresoBodega) — take:1 alcanza porque a lo sumo hay una
  // línea EN_TRANSITO por serial a la vez (el estado del serial es único).
  egresosDetalle: {
    where: { estado: "EN_TRANSITO" as const },
    take: 1,
    select: { id: true, egreso: { select: { id: true, empleado: { select: { id: true, nombres: true, apellidos: true } } } } },
  },
} as const;

// GET /productos/series/buscar?q=texto
// Busca por número de serie (coincidencia parcial, sin importar mayúsculas)
// en TODOS los productos — para responder "¿dónde está / a quién se le
// entregó el equipo con este serial?" sin tener que saber de antemano a
// qué producto pertenece.
productosRouter.get("/series/buscar", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json([]);
    const series = await prisma.numeroSerieProducto.findMany({
      where: { numeroSerie: { contains: q, mode: "insensitive" } },
      select: SELECT_SERIE_COMPLETA,
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(series);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar el número de serie" });
  }
});

// GET /productos/:id/series?estado=EN_BODEGA
productosRouter.get("/:id/series", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const productoId = Number(req.params.id);
    const estado = req.query.estado;
    const estadoValido = estado === "EN_BODEGA" || estado === "EN_TRANSITO" || estado === "ENTREGADO" ? estado : undefined;
    const series = await prisma.numeroSerieProducto.findMany({
      where: { productoId, ...(estadoValido ? { estado: estadoValido } : {}) },
      select: SELECT_SERIE_COMPLETA,
      orderBy: { createdAt: "asc" },
    });
    res.json(series);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los números de serie del producto" });
  }
});

// POST /productos/series/:serieId/entregar
// Body: { clienteId, referenciaDocumento? }
// Marca esta unidad como entregada a un cliente puntual — deliberadamente
// desacoplado de facturar/vender (ver comentario en el modelo): se puede
// hacer en el momento de la venta o mucho después, según le convenga a
// bodega. Funciona tanto desde EN_BODEGA (entrega directa, sin pasar por un
// EgresoBodega) como desde EN_TRANSITO (el técnico ya lo tenía despachado);
// en este último caso, de paso cierra la línea de egreso correspondiente
// (ver EgresoBodegaDetalle) para que no quede colgada como pendiente.
productosRouter.post("/series/:serieId/entregar", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const serieId = Number(req.params.serieId);
    const { clienteId, referenciaDocumento } = req.body;
    if (!clienteId) {
      return res.status(400).json({ error: "clienteId es obligatorio" });
    }

    const serie = await prisma.numeroSerieProducto.findUnique({ where: { id: serieId }, include: { producto: true } });
    if (!serie) return res.status(404).json({ error: "Número de serie no encontrado" });
    if (serie.estado === "ENTREGADO") {
      return res.status(409).json({ error: "Este número de serie ya fue entregado" });
    }

    const cliente = await prisma.cliente.findUnique({ where: { id: Number(clienteId) } });
    if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });

    const actualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // "Todo o nada" atómico: el chequeo de "serie.estado" de arriba se hizo
      // FUERA de la transacción, así que entre esa lectura y este punto otra
      // petición pudo haber entregado (o devuelto) esta misma serie primero.
      // updateMany con el estado en el WHERE hace el chequeo-y-escritura en
      // un solo paso atómico — si otra petición ganó la carrera, count da 0 y
      // se rechaza esta en vez de pisar en silencio la entrega ajena (mismo
      // criterio que POST /egresos-bodega y el acta de visitas).
      const resultado = await tx.numeroSerieProducto.updateMany({
        where: { id: serieId, estado: { in: ["EN_BODEGA", "EN_TRANSITO"] } },
        data: {
          estado: "ENTREGADO",
          clienteId: cliente.id,
          referenciaDocumento: referenciaDocumento?.trim() || null,
          fechaEntrega: new Date(),
        },
      });
      if (resultado.count === 0) throw new Error("SERIE_YA_NO_DISPONIBLE");

      await tx.egresoBodegaDetalle.updateMany({
        where: { numeroSerieProductoId: serieId, estado: "EN_TRANSITO" },
        data: { estado: "ENTREGADO" },
      });

      return tx.numeroSerieProducto.findUniqueOrThrow({ where: { id: serieId }, select: SELECT_SERIE_COMPLETA });
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "ENTREGAR_NUMERO_SERIE",
      entidad: "NumeroSerieProducto",
      entidadId: serieId,
      detalle: `${serie.producto.nombre}: serie ${serie.numeroSerie} → ${cliente.razonSocial}`,
    });

    res.json(actualizada);
  } catch (error: any) {
    if (error.message === "SERIE_YA_NO_DISPONIBLE") {
      return res.status(409).json({ error: "Este número de serie ya no está disponible (alguien más lo entregó o lo devolvió primero)" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al entregar el número de serie" });
  }
});

// POST /productos/series/:serieId/regresar-a-bodega
// Corrige una entrega mal asignada, o una que estaba EN_TRANSITO con un
// técnico y se decide devolverla sin usar — en ambos casos vuelve la unidad
// a EN_BODEGA, libre para despacharse/entregarse de nuevo, y cierra la
// línea de egreso correspondiente si venía de un EgresoBodega.
productosRouter.post("/series/:serieId/regresar-a-bodega", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const serieId = Number(req.params.serieId);
    const serie = await prisma.numeroSerieProducto.findUnique({ where: { id: serieId }, include: { producto: true } });
    if (!serie) return res.status(404).json({ error: "Número de serie no encontrado" });
    if (serie.estado === "EN_BODEGA") {
      return res.status(409).json({ error: "Este número de serie ya está en bodega" });
    }

    const actualizada = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Mismo motivo que en POST /series/:id/entregar: el chequeo de estado
      // de arriba quedó fuera de la transacción, así que el
      // chequeo-y-escritura real tiene que ser este updateMany atómico, no
      // un update incondicional — si el estado cambió mientras tanto, count
      // da 0 y se rechaza en vez de pisar en silencio lo que haya pasado.
      const resultado = await tx.numeroSerieProducto.updateMany({
        where: { id: serieId, estado: { in: ["EN_TRANSITO", "ENTREGADO"] } },
        data: { estado: "EN_BODEGA", clienteId: null, referenciaDocumento: null, fechaEntrega: null },
      });
      if (resultado.count === 0) throw new Error("SERIE_YA_NO_DISPONIBLE");

      await tx.egresoBodegaDetalle.updateMany({
        where: { numeroSerieProductoId: serieId, estado: "EN_TRANSITO" },
        data: { estado: "DEVUELTO" },
      });

      return tx.numeroSerieProducto.findUniqueOrThrow({ where: { id: serieId }, select: SELECT_SERIE_COMPLETA });
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "REGRESAR_NUMERO_SERIE_A_BODEGA",
      entidad: "NumeroSerieProducto",
      entidadId: serieId,
      detalle: `${serie.producto.nombre}: serie ${serie.numeroSerie}`,
    });

    res.json(actualizada);
  } catch (error: any) {
    if (error.message === "SERIE_YA_NO_DISPONIBLE") {
      return res.status(409).json({ error: "Este número de serie ya no está disponible (su estado cambió mientras tanto)" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al regresar el número de serie a bodega" });
  }
});

// GET /productos/:id/lotes
// Lotes activos de un producto perecible, del que caduca más pronto al que
// caduca más tarde — el mismo orden en que las ventas los van a consumir (FEFO).
productosRouter.get("/:id/lotes", async (req: Request, res: Response) => {
  try {
    const productoId = Number(req.params.id);
    const lotes = await prisma.loteProducto.findMany({
      where: { productoId },
      orderBy: { fechaCaducidad: "asc" },
    });
    res.json(lotes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener los lotes del producto" });
  }
});

// GET /productos/:id/etiqueta?cantidad=12&tamano=A4_4X9
// Genera un PDF con "cantidad" copias de la etiqueta (código de barras Code128
// + nombre) de este producto. "tamano" selecciona el preset de hoja/rollo (ver
// utils/generarEtiquetaProducto.ts); si falta o no es válido, usa "A4_4X9" —
// así los enlaces ya guardados/el hábito de uso actual no se rompen.
productosRouter.get("/:id/etiqueta", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const cantidad = Math.min(Math.max(Number(req.query.cantidad) || 1, 1), 200);
    const tamano = req.query.tamano as TamanoEtiqueta;

    const producto = await prisma.producto.findUnique({ where: { id } });
    if (!producto) return res.status(404).json({ error: "Producto no encontrado" });

    // El barcode real de fábrica (si existe) es lo que hay que poder escanear
    // en el estante — el código interno solo se usa como respaldo.
    const codigoParaEtiqueta = producto.codigoBarras || producto.codigo;
    const pdfBytes = await generarEtiquetasProductoPdf({ codigo: codigoParaEtiqueta, nombre: producto.nombre }, cantidad, tamano);

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="etiquetas-${codigoParaEtiqueta}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Error al generar las etiquetas: " + error.message });
  }
});

// POST /productos/:id/imagen
// Sube (o reemplaza) la foto de un producto. Va en su propia ruta, separada
// de POST/PUT /productos, porque esos dos reciben JSON y esta recibe
// multipart/form-data (el archivo).
productosRouter.post(
  "/:id/imagen",
  requirePermiso("productos"),
  subirImagenMiddleware,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!req.file) {
        return res.status(400).json({ error: "No se envió ninguna imagen" });
      }

      const producto = await prisma.producto.findUnique({ where: { id } });
      if (!producto) {
        fs.unlinkSync(req.file.path); // no dejamos el archivo huérfano en disco
        return res.status(404).json({ error: "Producto no encontrado" });
      }

      // Si ya tenía una imagen anterior, la borramos — si no, se van
      // acumulando archivos viejos en disco cada vez que alguien la cambia.
      if (producto.imagenUrl) {
        const rutaAnterior = path.join(process.cwd(), producto.imagenUrl);
        if (fs.existsSync(rutaAnterior)) {
          fs.unlinkSync(rutaAnterior);
        }
      }

      const imagenUrl = `/uploads/${empresaActivaId()}/productos/${req.file.filename}`;
      const actualizado = await prisma.producto.update({ where: { id }, data: { imagenUrl } });

      res.json(actualizado);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Error al subir la imagen: " + error.message });
    }
  }
);

// POST /productos
// Crea un producto nuevo. "codigo" NO viene en el body — se genera solo
// (ver utils/codigoProducto.ts), correlativo tipo "PROD-00001". Sin ningún
// campo de precio: el precio de venta se calcula al vuelo desde
// costoPromedioActual (ver utils/precios.ts) — un producto recién creado no
// tiene costo todavía, así que no tiene ningún precio calculable hasta su
// primera compra real.
// Body esperado (JSON): { nombre, marca?, modelo?, stockActual?, categoriaId?, manejaLotes?, fechaCaducidad? }
productosRouter.post("/", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const {
      codigoBarras,
      nombre,
      marca,
      modelo,
      descripcion,
      ivaPorcentaje,
      stockActual,
      stockMinimo,
      categoriaId,
      manejaLotes,
      fechaCaducidad,
      bodegaId,
      controlaNumeroSerie,
    } = req.body;

    // Validación básica: sin esto, un campo vacío podría romper la base de datos
    // o, peor, crear un producto inválido que arruina un reporte después.
    if (!nombre) {
      return res.status(400).json({ error: "nombre es obligatorio" });
    }

    const codigoBarrasLimpio: string | undefined = codigoBarras?.trim() || undefined;
    if (codigoBarrasLimpio && !validarCodigoBarras(codigoBarrasLimpio)) {
      return res.status(400).json({
        error: "El código de barras no es válido (dígito de control incorrecto) — revisa que esté bien escaneado o tipeado",
      });
    }

    const esPerecibleConLotes = manejaLotes === true;
    const stockInicial: number = esPerecibleConLotes ? 0 : stockActual ?? 0;

    // Si hay stock inicial en un producto sin lote, ese stock tiene que
    // quedar atribuido a ALGUNA sucursal (StockSucursal) y a ALGUNA bodega
    // (StockBodega) — si no, quedaría como un total global inalcanzable, sin
    // ninguna sucursal/bodega desde la que venderlo. La sucursal se atribuye
    // sola (igual criterio que /compras y /movimientos); la bodega, en
    // cambio, se elige explícitamente en el body, igual que en el resto del
    // sistema.
    const sucursal = stockInicial > 0 ? await sucursalDelUsuarioActual(req.usuario!.usuarioId) : null;
    if (sucursal) {
      await bodegaValidaEnSucursal(bodegaId, sucursal.id);
    }

    const producto = await prisma.$transaction(async (tx) => {
      const codigo = await generarCodigoProducto(tx);
      const nuevoProducto = await tx.producto.create({
        data: {
          codigo,
          codigoBarras: codigoBarrasLimpio,
          nombre,
          marca: marca?.trim() || null,
          modelo: modelo?.trim() || null,
          descripcion,
          ivaPorcentaje: ivaPorcentaje ?? 15.0,
          // Un producto que maneja lotes arranca SIEMPRE en 0: su stock se
          // ingresa después con "+ Stock", donde cada entrada crea su propio
          // lote con su propia caducidad — no tiene sentido un stock inicial
          // "suelto" sin lote asignado.
          stockActual: stockInicial,
          stockMinimo: stockMinimo ?? 0,
          categoriaId,
          manejaLotes: esPerecibleConLotes,
          fechaCaducidad: !esPerecibleConLotes && fechaCaducidad ? new Date(fechaCaducidad) : null,
          controlaNumeroSerie: controlaNumeroSerie === true,
        },
      });

      if (sucursal) {
        await tx.stockSucursal.create({
          data: { productoId: nuevoProducto.id, sucursalId: sucursal.id, cantidad: stockInicial },
        });
        await tx.stockBodega.create({
          data: { productoId: nuevoProducto.id, bodegaId, cantidad: stockInicial },
        });
        await tx.movimientoInventario.create({
          data: {
            productoId: nuevoProducto.id,
            tipo: "ENTRADA",
            cantidad: stockInicial,
            motivo: "Stock inicial al crear el producto",
            sucursalId: sucursal.id,
            bodegaId,
          },
        });
      }

      return nuevoProducto;
    });

    res.status(201).json(producto);
  } catch (error: any) {
    if (error.message === "SIN_SUCURSAL_ASIGNADA") {
      return res.status(400).json({ error: "Tu usuario no tiene una sucursal asignada — pídele a un administrador que te asigne una" });
    }
    if (error.message === "BODEGA_OBLIGATORIA") {
      return res.status(400).json({ error: "Debes elegir una bodega para el stock inicial" });
    }
    if (error.message === "BODEGA_NO_ENCONTRADA") {
      return res.status(400).json({ error: "La bodega indicada no existe o está inactiva" });
    }
    if (error.message === "BODEGA_NO_PERTENECE_A_SUCURSAL") {
      return res.status(400).json({ error: "Esa bodega no pertenece a tu sucursal" });
    }
    // Prisma lanza el código P2002 cuando se viola una restricción "unique"
    // (el campo "codigo" o, ahora también, "codigoBarras" no se pueden repetir).
    if (error.code === "P2002") {
      const esBarcode = Array.isArray(error.meta?.target) && error.meta.target.includes("codigoBarras");
      return res.status(409).json({ error: esBarcode ? "Ya existe un producto con ese código de barras" : "Ya existe un producto con ese código" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al crear el producto" });
  }
});

// PUT /productos/:id
// Edita un producto existente. NO permite cambiar "codigo" (es la clave de
// negocio, cambiarla podría romper referencias históricas) ni "stockActual"
// directamente (el stock SOLO se mueve a través de /movimientos, para que
// el kardex siempre refleje la verdad — si lo dejáramos editar aquí, alguien
// podría "arreglar" el stock sin dejar rastro de por qué cambió). Sin ningún
// campo de precio: el precio de venta se calcula al vuelo desde
// costoPromedioActual (ver utils/precios.ts), no hay nada que editar a mano.
productosRouter.put("/:id", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, codigoBarras, marca, modelo, descripcion, ivaPorcentaje, stockMinimo, categoriaId, manejaLotes, fechaCaducidad, controlaNumeroSerie } =
      req.body;

    if (!nombre) {
      return res.status(400).json({ error: "nombre es obligatorio" });
    }

    const codigoBarrasLimpio: string | null = codigoBarras?.trim() || null;
    if (codigoBarrasLimpio && !validarCodigoBarras(codigoBarrasLimpio)) {
      return res.status(400).json({
        error: "El código de barras no es válido (dígito de control incorrecto) — revisa que esté bien escaneado o tipeado",
      });
    }

    const esPerecibleConLotes = manejaLotes === true;

    const producto = await prisma.producto.update({
      where: { id },
      data: {
        nombre,
        codigoBarras: codigoBarrasLimpio,
        marca: marca?.trim() || null,
        modelo: modelo?.trim() || null,
        descripcion,
        ivaPorcentaje,
        stockMinimo,
        categoriaId,
        manejaLotes: esPerecibleConLotes,
        // Si pasa a manejar lotes, la fecha "suelta" ya no aplica — la
        // caducidad ahora vive en cada LoteProducto.
        fechaCaducidad: !esPerecibleConLotes && fechaCaducidad ? new Date(fechaCaducidad) : null,
        controlaNumeroSerie: controlaNumeroSerie === true,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_PRODUCTO",
      entidad: "Producto",
      entidadId: producto.id,
      detalle: `${producto.nombre} (${producto.codigo})`,
    });

    res.json(producto);
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un producto con ese código de barras" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al editar el producto" });
  }
});

// DELETE /productos/:id
// No borramos el producto de verdad (eso rompería el historial de facturas
// y movimientos que lo referencian). En vez de eso, lo marcamos "inactivo"
// — un borrado suave ("soft delete") — para que deje de aparecer en las
// listas pero sus datos históricos sigan intactos.
productosRouter.delete("/:id", requirePermiso("productos"), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const producto = await prisma.producto.update({
      where: { id },
      data: { activo: false },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_PRODUCTO",
      entidad: "Producto",
      entidadId: producto.id,
      detalle: `${producto.nombre} (${producto.codigo})`,
    });

    res.json({ mensaje: "Producto desactivado", producto });
  } catch (error: any) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el producto" });
  }
});
