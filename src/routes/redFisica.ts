// Red Física: cajas/NAP puntuales (CajaFibra) y los tramos de cable que las
// conectan (TendidoFibra) — el reemplazo de Google Earth para trazar por
// dónde va la fibra, ver el comentario "Módulo de RED FÍSICA" en
// schema.prisma. Ver/editar van con permisos separados (mismo criterio que
// contabilidad.ts), montado sin gate de router en index.ts.
import { Router, Request, Response } from "express";
import { Prisma, type CajaFibra as CajaFibraModelo, type TendidoFibra as TendidoFibraModelo } from "@prisma/client";
import multer from "multer";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { kmlWithFolders, type Folder as CarpetaKml, type Root as RaizKml, type F as FeatureKml } from "@tmcw/togeojson";
import { prisma } from "../db";
import { registrarAuditoria } from "../utils/auditoria";
import { requirePermiso } from "../middleware/auth";

export const redFisicaRouter = Router();

const puedeVer = requirePermiso("red_fisica");
const puedeEditar = requirePermiso("red_fisica_editar");

interface PuntoRuta {
  lat: number;
  lng: number;
}

function trazadoValido(valor: unknown): valor is PuntoRuta[] {
  return (
    Array.isArray(valor) &&
    valor.length >= 2 &&
    valor.every((p) => p && typeof p === "object" && Number.isFinite((p as any).lat) && Number.isFinite((p as any).lng))
  );
}

// GET /red-fisica/cajas
redFisicaRouter.get("/cajas", puedeVer, async (_req: Request, res: Response) => {
  try {
    const cajas = await prisma.cajaFibra.findMany({
      where: { activo: true },
      include: { nodo: { select: { id: true, nombre: true } } },
      orderBy: { codigo: "asc" },
    });
    res.json(cajas);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar las cajas de fibra" });
  }
});

// POST /red-fisica/cajas
// Body: { codigo, tipo, latitud, longitud, capacidadPuertos?, descripcion?, nodoId? }
redFisicaRouter.post("/cajas", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { codigo, tipo, latitud, longitud, capacidadPuertos, descripcion, nodoId } = req.body;
    if (!codigo || !tipo || latitud === undefined || longitud === undefined) {
      return res.status(400).json({ error: "codigo, tipo, latitud y longitud son obligatorios" });
    }

    const caja = await prisma.cajaFibra.create({
      data: {
        codigo,
        tipo,
        latitud: Number(latitud),
        longitud: Number(longitud),
        capacidadPuertos: capacidadPuertos ? Number(capacidadPuertos) : null,
        descripcion: descripcion || null,
        nodoId: nodoId ? Number(nodoId) : null,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_CAJA_FIBRA",
      entidad: "CajaFibra",
      entidadId: caja.id,
      detalle: `${caja.codigo} (${caja.tipo})`,
    });

    res.status(201).json(caja);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear la caja de fibra" });
  }
});

// PUT /red-fisica/cajas/:id
redFisicaRouter.put("/cajas/:id", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { codigo, tipo, latitud, longitud, capacidadPuertos, descripcion, nodoId } = req.body;
    if (!codigo || !tipo || latitud === undefined || longitud === undefined) {
      return res.status(400).json({ error: "codigo, tipo, latitud y longitud son obligatorios" });
    }

    const caja = await prisma.cajaFibra.update({
      where: { id },
      data: {
        codigo,
        tipo,
        latitud: Number(latitud),
        longitud: Number(longitud),
        capacidadPuertos: capacidadPuertos ? Number(capacidadPuertos) : null,
        descripcion: descripcion || null,
        nodoId: nodoId ? Number(nodoId) : null,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_CAJA_FIBRA",
      entidad: "CajaFibra",
      entidadId: caja.id,
      detalle: `${caja.codigo} (${caja.tipo})`,
    });

    res.json(caja);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Caja de fibra no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al editar la caja de fibra" });
  }
});

// DELETE /red-fisica/cajas/:id — borrado suave, mismo criterio que Olt/NodoRed.
// Un tendido que la tenga como origen/destino conserva la referencia.
redFisicaRouter.delete("/cajas/:id", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const caja = await prisma.cajaFibra.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_CAJA_FIBRA",
      entidad: "CajaFibra",
      entidadId: caja.id,
      detalle: caja.codigo,
    });

    res.json({ mensaje: "Caja de fibra desactivada", caja });
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Caja de fibra no encontrada" });
    console.error(error);
    res.status(500).json({ error: "Error al desactivar la caja de fibra" });
  }
});

// GET /red-fisica/tendidos
redFisicaRouter.get("/tendidos", puedeVer, async (_req: Request, res: Response) => {
  try {
    const tendidos = await prisma.tendidoFibra.findMany({
      where: { activo: true },
      include: {
        origenCaja: { select: { id: true, codigo: true } },
        destinoCaja: { select: { id: true, codigo: true } },
        nodo: { select: { id: true, nombre: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(tendidos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al listar los tendidos de fibra" });
  }
});

// POST /red-fisica/tendidos
// Body: { nombre?, tipo, trazado: [{lat,lng}, ...], origenCajaId?, destinoCajaId?, nodoId?, colorHex? }
redFisicaRouter.post("/tendidos", puedeEditar, async (req: Request, res: Response) => {
  try {
    const { nombre, tipo, trazado, origenCajaId, destinoCajaId, nodoId, colorHex } = req.body;
    if (!tipo || !trazadoValido(trazado)) {
      return res.status(400).json({ error: "tipo y trazado (al menos 2 puntos {lat,lng}) son obligatorios" });
    }

    const tendido = await prisma.tendidoFibra.create({
      data: {
        nombre: nombre || null,
        tipo,
        trazado: trazado as unknown as Prisma.InputJsonValue,
        origenCajaId: origenCajaId ? Number(origenCajaId) : null,
        destinoCajaId: destinoCajaId ? Number(destinoCajaId) : null,
        nodoId: nodoId ? Number(nodoId) : null,
        colorHex: colorHex || null,
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "CREAR_TENDIDO_FIBRA",
      entidad: "TendidoFibra",
      entidadId: tendido.id,
      detalle: `${tendido.nombre || "(sin nombre)"} (${tendido.tipo}, ${(trazado as PuntoRuta[]).length} puntos)`,
    });

    res.status(201).json(tendido);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear el tendido de fibra" });
  }
});

// PUT /red-fisica/tendidos/:id
// Body: { nombre?, tipo, origenCajaId?, destinoCajaId?, nodoId?, colorHex?,
// estado?, trazado? } — "trazado" es OPCIONAL: si no viene, el trazo
// guardado queda intacto (edición de solo metadatos, como antes); si viene,
// reemplaza el trazo completo — es lo que manda RedFisicaPage.tsx después
// de editar los vértices en el mapa (ver PanelEditarTrazado / MapaRedFisica
// "editing" de leaflet-draw).
redFisicaRouter.put("/tendidos/:id", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, tipo, origenCajaId, destinoCajaId, nodoId, colorHex, estado, trazado } = req.body;
    if (!tipo) return res.status(400).json({ error: "tipo es obligatorio" });
    if (trazado !== undefined && !trazadoValido(trazado)) {
      return res.status(400).json({ error: "El trazado debe tener al menos 2 puntos {lat,lng}" });
    }

    const tendido = await prisma.tendidoFibra.update({
      where: { id },
      data: {
        nombre: nombre || null,
        tipo,
        origenCajaId: origenCajaId ? Number(origenCajaId) : null,
        destinoCajaId: destinoCajaId ? Number(destinoCajaId) : null,
        nodoId: nodoId ? Number(nodoId) : null,
        colorHex: colorHex || null,
        ...(estado ? { estado } : {}),
        ...(trazado !== undefined ? { trazado: trazado as unknown as Prisma.InputJsonValue } : {}),
      },
    });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "EDITAR_TENDIDO_FIBRA",
      entidad: "TendidoFibra",
      entidadId: tendido.id,
      detalle: `${tendido.nombre || "(sin nombre)"} (${tendido.tipo})`,
    });

    res.json(tendido);
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Tendido de fibra no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al editar el tendido de fibra" });
  }
});

// DELETE /red-fisica/tendidos/:id — borrado suave, mismo criterio que las cajas.
redFisicaRouter.delete("/tendidos/:id", puedeEditar, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const tendido = await prisma.tendidoFibra.update({ where: { id }, data: { activo: false } });

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "DESACTIVAR_TENDIDO_FIBRA",
      entidad: "TendidoFibra",
      entidadId: tendido.id,
      detalle: tendido.nombre || `Tendido #${tendido.id}`,
    });

    res.json({ mensaje: "Tendido de fibra desactivado", tendido });
  } catch (error: any) {
    if (error.code === "P2025") return res.status(404).json({ error: "Tendido de fibra no encontrado" });
    console.error(error);
    res.status(500).json({ error: "Error al desactivar el tendido de fibra" });
  }
});

// --- Importar desde Google Earth (.kml / .kmz) ---
// El archivo se procesa SOLO en memoria (multer.memoryStorage — nunca toca
// disco ni la carpeta de uploads de la empresa) y esta primera ruta NO lee
// ni escribe nada en la base: es pura conversión de formato, así que no
// necesita el truco de "capturar la empresa antes de multer" que sí usan
// routes/visitas.ts y routes/facturasInternet.ts para sus subidas — ese
// truco existe para cuando el handler SÍ usa prisma/empresaActiva() después
// de multer, que acá no es el caso hasta /importar-kml/confirmar (esa ruta
// no tiene archivo adjunto, así que no le hace falta tampoco).
const TAMANO_MAXIMO_KML = 20 * 1024 * 1024; // 20MB — de sobra para un KML/KMZ real

const subirKml = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANO_MAXIMO_KML },
  fileFilter: (_req, file, cb) => {
    const nombre = file.originalname.toLowerCase();
    if (!nombre.endsWith(".kml") && !nombre.endsWith(".kmz")) {
      return cb(new Error("El archivo debe ser .kml o .kmz (el mismo formato que exporta Google Earth)"));
    }
    cb(null, true);
  },
});

// Un .kmz es un .kml comprimido en zip — se detecta por extensión o por los
// primeros bytes ("PK", firma de zip) por si el nombre no trae la extensión
// correcta.
async function extraerKmlDeArchivo(buffer: Buffer, nombreOriginal: string): Promise<string> {
  const pareceZip = buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!pareceZip && !nombreOriginal.toLowerCase().endsWith(".kmz")) {
    return buffer.toString("utf-8");
  }
  const zip = await JSZip.loadAsync(buffer);
  const archivoKml = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith(".kml"));
  if (!archivoKml) throw new Error("Ese .kmz no tiene ningún .kml adentro");
  return archivoKml.async("string");
}

// Namespaces que Google Earth SIEMPRE declara en sus propios KML — si el
// archivo viene de otra herramienta (o fue editado a mano) y usa un prefijo
// (ej. "gx:Tour", "xsi:schemaLocation") sin declararlo, el parser real de
// Google Earth lo tolera igual, pero @xmldom/xmldom es estricto de verdad
// con el estándar de namespaces XML y tira "NamespaceError: prefix is
// non-null and namespace is null" — no hay ninguna opción de DOMParser que
// lo evite (fatalError siempre relanza, ver lib/dom-parser.js). La solución
// es reparar el XML ANTES de parsearlo: se detecta cualquier prefijo
// "algo:" usado en una etiqueta o atributo que no tenga su "xmlns:algo="
// declarado en ningún lado del documento, y se le agrega la declaración
// (la real si es un prefijo conocido, una inventada si no) directo en la
// raíz <kml>.
const NAMESPACES_KML_CONOCIDOS: Record<string, string> = {
  gx: "http://www.google.com/kml/ext/2.2",
  kml: "http://www.opengis.net/kml/2.2",
  atom: "http://www.w3.org/2005/Atom",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
};

function repararNamespacesFaltantes(textoKml: string): string {
  const prefijosUsados = new Set<string>();
  for (const m of textoKml.matchAll(/<\/?([a-zA-Z_][\w.-]*):[a-zA-Z_]/g)) prefijosUsados.add(m[1]);
  for (const m of textoKml.matchAll(/[\s]([a-zA-Z_][\w.-]*):[a-zA-Z_][\w.-]*\s*=/g)) {
    if (m[1] !== "xmlns") prefijosUsados.add(m[1]);
  }
  prefijosUsados.delete("xml"); // prefijo reservado, siempre implícito — nunca hace falta declararlo

  const prefijosDeclarados = new Set<string>();
  for (const m of textoKml.matchAll(/xmlns:([a-zA-Z_][\w.-]*)\s*=/g)) prefijosDeclarados.add(m[1]);

  const faltantes = [...prefijosUsados].filter((p) => !prefijosDeclarados.has(p));
  if (faltantes.length === 0) return textoKml;

  const declaraciones = faltantes.map((p) => ` xmlns:${p}="${NAMESPACES_KML_CONOCIDOS[p] || `urn:red-fisica:ns:${p}`}"`).join("");
  return textoKml.replace(/<kml\b/, (etiqueta) => `${etiqueta}${declaraciones}`);
}

interface CajaCandidata {
  nombreSugerido: string;
  // Tipo COPIADO del archivo (ExtendedData o carpeta de Google Earth), nunca
  // inventado — ver tipoSugeridoDe. undefined = no se pudo detectar,
  // el usuario lo elige a mano como antes.
  tipoSugerido?: string;
  latitud: number;
  longitud: number;
  descripcion?: string;
}
interface TendidoCandidato {
  nombreSugerido: string;
  tipoSugerido?: string;
  trazado: PuntoRuta[];
  descripcion?: string;
}

// Campos de ExtendedData que se interpretan como "tipo" si el archivo ya
// trae esa clasificación propia (ej. exportado por una herramienta GIS que
// adjunta atributos por placemark) — comparación sin mayúsculas/acentos
// para tolerar variantes ("Tipo", "TIPO", "tipó").
const CLAVES_TIPO_EXTENDED_DATA = ["tipo", "type", "categoria", "category"];

function normalizarClave(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

// El tipo sugerido se COPIA de lo que el archivo YA trae — nunca se inventa
// ni se renombra — para evitar justo lo que pidió el usuario: errores de
// tipografía o de nombres inconsistentes al tener que volver a escribirlo a
// mano en cada elemento. Prioridad: 1) un campo de ExtendedData reconocible
// como "tipo"; 2) el nombre de la carpeta de Google Earth que contiene el
// placemark (patrón de organización muy común: una carpeta por categoría,
// ej. "Cámara", "NAP", "Troncal"). Si ninguna de las dos está, queda sin
// sugerencia y el usuario lo elige a mano, como antes.
function tipoSugeridoDe(feature: FeatureKml, carpetaActual: string | null): string | undefined {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  for (const [clave, valor] of Object.entries(props)) {
    if (CLAVES_TIPO_EXTENDED_DATA.includes(normalizarClave(clave)) && typeof valor === "string" && valor.trim()) {
      return valor.trim();
    }
  }
  return carpetaActual?.trim() || undefined;
}

function nombreDe(feature: FeatureKml, indice: number, prefijo: string): string {
  const nombre = (feature.properties as any)?.name;
  return typeof nombre === "string" && nombre.trim() ? nombre.trim() : `${prefijo}-${indice + 1}`;
}
function descripcionDe(feature: FeatureKml): string | undefined {
  const desc = (feature.properties as any)?.description;
  return typeof desc === "string" && desc.trim() ? desc.trim().slice(0, 2000) : undefined;
}

// Un Point de KML se sugiere como CajaFibra, un LineString/MultiLineString
// como TendidoFibra (cada línea de un MultiLineString se separa en un
// candidato propio) — el resto de geometrías (Polygon, etc.) se cuenta en
// "omitidos" pero no se sugiere nada, no tienen equivalente en este módulo.
// Recorre el ÁRBOL de carpetas (kmlWithFolders), no la lista plana, para
// poder arrastrar el nombre de la carpeta contenedora a cada placemark —
// ver tipoSugeridoDe.
function candidatosDesdeArbolKml(raiz: RaizKml): { cajas: CajaCandidata[]; tendidos: TendidoCandidato[]; omitidos: number } {
  const cajas: CajaCandidata[] = [];
  const tendidos: TendidoCandidato[] = [];
  let omitidos = 0;
  let contadorIndice = 0;

  function recorrer(nodos: Array<CarpetaKml | FeatureKml>, carpetaActual: string | null) {
    for (const nodo of nodos) {
      if (nodo.type === "folder") {
        const nombreCarpeta = typeof nodo.meta?.name === "string" && (nodo.meta.name as string).trim() ? (nodo.meta.name as string).trim() : carpetaActual;
        recorrer(nodo.children, nombreCarpeta);
        continue;
      }

      const feature = nodo;
      const indice = contadorIndice++;
      const geom = feature.geometry;
      if (!geom) {
        omitidos++;
        continue;
      }
      if (geom.type === "Point") {
        const [lng, lat] = geom.coordinates;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          omitidos++;
          continue;
        }
        cajas.push({
          nombreSugerido: nombreDe(feature, indice, "CAJA"),
          tipoSugerido: tipoSugeridoDe(feature, carpetaActual),
          latitud: lat,
          longitud: lng,
          descripcion: descripcionDe(feature),
        });
      } else if (geom.type === "LineString") {
        const trazado = geom.coordinates
          .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]))
          .map(([lng, lat]) => ({ lat, lng }));
        if (trazado.length < 2) {
          omitidos++;
          continue;
        }
        tendidos.push({
          nombreSugerido: nombreDe(feature, indice, "TENDIDO"),
          tipoSugerido: tipoSugeridoDe(feature, carpetaActual),
          trazado,
          descripcion: descripcionDe(feature),
        });
      } else if (geom.type === "MultiLineString") {
        geom.coordinates.forEach((linea, indiceLinea) => {
          const trazado = linea.filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1])).map(([lng, lat]) => ({ lat, lng }));
          if (trazado.length < 2) {
            omitidos++;
            return;
          }
          tendidos.push({
            nombreSugerido: `${nombreDe(feature, indice, "TENDIDO")} (parte ${indiceLinea + 1})`,
            tipoSugerido: tipoSugeridoDe(feature, carpetaActual),
            trazado,
            descripcion: descripcionDe(feature),
          });
        });
      } else {
        omitidos++;
      }
    }
  }

  recorrer(raiz.children, null);
  return { cajas, tendidos, omitidos };
}

// POST /red-fisica/importar-kml
// multipart/form-data: archivo (.kml o .kmz). Solo devuelve una VISTA PREVIA
// (candidatos a caja/tendido) — no guarda nada todavía, ver /confirmar.
redFisicaRouter.post(
  "/importar-kml",
  puedeEditar,
  (req: Request, res: Response, next) => {
    subirKml.single("archivo")(req, res, (error: any) => {
      if (error?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "El archivo no puede pesar más de 20MB" });
      if (error) return res.status(400).json({ error: error.message || "Error al subir el archivo" });
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Subí un archivo .kml o .kmz" });

      const textoKmlCrudo = await extraerKmlDeArchivo(req.file.buffer, req.file.originalname);
      const textoKml = repararNamespacesFaltantes(textoKmlCrudo);

      let dom;
      try {
        dom = new DOMParser().parseFromString(textoKml, "text/xml");
      } catch (error: any) {
        // Mensaje genérico y accionable para el usuario — el detalle técnico
        // (ej. "NamespaceError: prefix is non-null...") queda solo en el log
        // del servidor, no le sirve a quien está subiendo el archivo.
        console.error("Error de parseo KML:", error);
        return res.status(400).json({ error: "Ese archivo no es un KML/KMZ válido (XML mal formado) — probá reexportarlo desde Google Earth" });
      }

      const raiz = kmlWithFolders(dom as any);
      const { cajas, tendidos, omitidos } = candidatosDesdeArbolKml(raiz);

      if (cajas.length === 0 && tendidos.length === 0) {
        return res.status(400).json({ error: "No se encontró ningún punto o línea aprovechable en ese archivo" });
      }
      res.json({ cajas, tendidos, omitidos });
    } catch (error: any) {
      console.error(error);
      res.status(400).json({ error: error?.message || "No se pudo leer ese archivo KML/KMZ" });
    }
  }
);

const LIMITE_IMPORTACION = 2000;

// POST /red-fisica/importar-kml/confirmar
// Body: { cajas: [{codigo,tipo,latitud,longitud,capacidadPuertos?,descripcion?,nodoId?}, ...],
//          tendidos: [{nombre?,tipo,trazado,nodoId?,colorHex?}, ...] } — la lista ya
// REVISADA por el usuario en el frontend (con tipo/nodo elegidos a partir de
// la vista previa de /importar-kml). No intenta enlazar automáticamente los
// tendidos importados a las cajas importadas por cercanía — eso se deja para
// que el usuario lo haga a mano después, editando cada tendido.
redFisicaRouter.post("/importar-kml/confirmar", puedeEditar, async (req: Request, res: Response) => {
  try {
    const cajas: any[] = Array.isArray(req.body.cajas) ? req.body.cajas : [];
    const tendidos: any[] = Array.isArray(req.body.tendidos) ? req.body.tendidos : [];

    if (cajas.length === 0 && tendidos.length === 0) {
      return res.status(400).json({ error: "No hay nada para importar" });
    }
    if (cajas.length + tendidos.length > LIMITE_IMPORTACION) {
      return res.status(400).json({ error: `Como mucho ${LIMITE_IMPORTACION} elementos por importación — dividí el archivo en partes más chicas` });
    }
    for (const [i, c] of cajas.entries()) {
      if (!c.codigo || !c.tipo || !Number.isFinite(Number(c.latitud)) || !Number.isFinite(Number(c.longitud))) {
        return res.status(400).json({ error: `Caja #${i + 1}: código, tipo, latitud y longitud son obligatorios` });
      }
    }
    for (const [i, t] of tendidos.entries()) {
      if (!t.tipo || !trazadoValido(t.trazado)) {
        return res.status(400).json({ error: `Tendido #${i + 1}: tipo y trazado (al menos 2 puntos) son obligatorios` });
      }
    }

    // createMany en vez de un create() por elemento dentro de una
    // transacción interactiva: con importaciones grandes (cientos de
    // elementos, como una red completa) un create() por fila corría el
    // riesgo real de superar el timeout default de 5s de las transacciones
    // interactivas de Prisma. createMany arma un solo INSERT por tabla — muy
    // por debajo del límite de parámetros de Postgres incluso con miles de
    // filas — y la forma "array" de $transaction no tiene ese límite de 5s
    // (no hay código de usuario corriendo ENTRE las dos operaciones).
    const [resultadoCajas, resultadoTendidos] = await prisma.$transaction([
      prisma.cajaFibra.createMany({
        data: cajas.map((c) => ({
          codigo: c.codigo,
          tipo: c.tipo,
          latitud: Number(c.latitud),
          longitud: Number(c.longitud),
          capacidadPuertos: c.capacidadPuertos ? Number(c.capacidadPuertos) : null,
          descripcion: c.descripcion || null,
          nodoId: c.nodoId ? Number(c.nodoId) : null,
        })),
      }),
      prisma.tendidoFibra.createMany({
        data: tendidos.map((t) => ({
          nombre: t.nombre || null,
          tipo: t.tipo,
          trazado: t.trazado as unknown as Prisma.InputJsonValue,
          nodoId: t.nodoId ? Number(t.nodoId) : null,
          colorHex: t.colorHex || null,
        })),
      }),
    ]);
    const resultado = { cajasCreadas: resultadoCajas.count, tendidosCreados: resultadoTendidos.count };

    await registrarAuditoria(prisma, {
      usuarioId: req.usuario!.usuarioId,
      accion: "IMPORTAR_KML_RED_FISICA",
      entidad: "TendidoFibra",
      detalle: `${resultado.cajasCreadas} caja(s), ${resultado.tendidosCreados} tendido(s) importados desde KML/KMZ`,
    });

    res.status(201).json(resultado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al importar los datos" });
  }
});

function escaparXml(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// El equivalente inverso a candidatosDesdeArbolKml: arma el KML a mano (XML
// simple, sin librería — tokml traía una cadena de dependencias vieja y con
// vulnerabilidades críticas para algo tan chico).
function construirKml(cajas: CajaFibraModelo[], tendidos: TendidoFibraModelo[]): string {
  const placemarksCajas = cajas
    .map(
      (c) => `    <Placemark>
      <name>${escaparXml(c.codigo)}</name>
      <description>${escaparXml(`${c.tipo}${c.descripcion ? " - " + c.descripcion : ""}`)}</description>
      <Point><coordinates>${c.longitud},${c.latitud},0</coordinates></Point>
    </Placemark>`
    )
    .join("\n");

  const placemarksTendidos = tendidos
    .map((t) => {
      const puntos = (t.trazado as unknown as PuntoRuta[]).map((p) => `${p.lng},${p.lat},0`).join(" ");
      return `    <Placemark>
      <name>${escaparXml(t.nombre || t.tipo)}</name>
      <description>${escaparXml(t.tipo)}</description>
      <LineString><coordinates>${puntos}</coordinates></LineString>
    </Placemark>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Red Física</name>
${placemarksCajas}
${placemarksTendidos}
  </Document>
</kml>`;
}

async function obtenerCajasYTendidosActivos(): Promise<{ cajas: CajaFibraModelo[]; tendidos: TendidoFibraModelo[] }> {
  const [cajas, tendidos] = await Promise.all([
    prisma.cajaFibra.findMany({ where: { activo: true } }),
    prisma.tendidoFibra.findMany({ where: { activo: true } }),
  ]);
  return { cajas, tendidos };
}

// GET /red-fisica/exportar-kml
redFisicaRouter.get("/exportar-kml", puedeVer, async (_req: Request, res: Response) => {
  try {
    const { cajas, tendidos } = await obtenerCajasYTendidosActivos();
    const xml = construirKml(cajas, tendidos);
    res.setHeader("Content-Type", "application/vnd.google-earth.kml+xml");
    res.setHeader("Content-Disposition", 'attachment; filename="red-fisica.kml"');
    res.send(xml);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al exportar el KML" });
  }
});

// GET /red-fisica/exportar-kmz
// Mismo KML de arriba, comprimido como .kmz (un zip con "doc.kml" adentro,
// convención estándar que usa el propio Google Earth) — útil para volver a
// abrir en Google Earth después de haber hecho cambios acá (agregar/editar
// cajas y tendidos), sin que pese tanto como el .kml plano.
redFisicaRouter.get("/exportar-kmz", puedeVer, async (_req: Request, res: Response) => {
  try {
    const { cajas, tendidos } = await obtenerCajasYTendidosActivos();
    const xml = construirKml(cajas, tendidos);

    const zip = new JSZip();
    zip.file("doc.kml", xml);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    res.setHeader("Content-Type", "application/vnd.google-earth.kmz");
    res.setHeader("Content-Disposition", 'attachment; filename="red-fisica.kmz"');
    res.send(buffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al exportar el KMZ" });
  }
});
