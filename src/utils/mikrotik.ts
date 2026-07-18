// Integración con los Mikrotik del ISP vía la API binaria de RouterOS
// (puerto 8728 por defecto). La empresa tiene VARIOS nodos de red (ver
// NodoRed en schema.prisma) — cada uno con su propio router a cargo de los
// clientes de su sector, con credenciales de API propias e independientes
// (si se compromete el router de un nodo, no compromete los demás). Por eso
// toda función de acá recibe "nodoId": no hay un único router global.
//
// La librería "node-routeros" mantiene un socket persistente por conexión:
// cacheamos una por nodo (nunca una por request) y la reconstruimos sola si
// se cae (evento "close"/"error") — mismo criterio que el cacheo de
// PrismaClient por empresa en db.ts. La clave del cache incluye la empresa
// activa (ver empresaActivaId() en db.ts) porque los ids de NodoRed son
// autoincrementales POR base de datos de empresa — sin esto, el nodo #1 de
// una empresa colisionaría con el nodo #1 de otra en este Map compartido
// por todo el proceso.
//
// Para "set"/"remove" la API de RouterOS exige el ".id" interno del
// registro, no el nombre — por eso primero buscamos el ".id" con un
// "print" filtrado (?campo=valor) y recién ahí mandamos el comando real.
import { RouterOSAPI } from "node-routeros";
import { prisma, empresaActivaId } from "../db";

const conexiones = new Map<string, RouterOSAPI>();

function claveConexion(nodoId: number): string {
  return `${empresaActivaId()}:${nodoId}`;
}

async function obtenerConexion(nodoId: number): Promise<RouterOSAPI> {
  const clave = claveConexion(nodoId);
  const existente = conexiones.get(clave);
  if (existente?.connected) return existente;

  const nodo = await prisma.nodoRed.findUnique({ where: { id: nodoId } });
  if (!nodo || !nodo.activo) {
    throw new Error(`El nodo de red #${nodoId} no existe o está desactivado`);
  }

  const nueva = new RouterOSAPI({
    host: nodo.mikrotikHost,
    user: nodo.mikrotikUsuario,
    password: nodo.mikrotikPassword,
    port: nodo.mikrotikPuerto,
    timeout: 10,
  });
  nueva.on("error", () => {
    if (conexiones.get(clave) === nueva) conexiones.delete(clave);
  });
  nueva.on("close", () => {
    if (conexiones.get(clave) === nueva) conexiones.delete(clave);
  });
  await nueva.connect();
  conexiones.set(clave, nueva);
  return nueva;
}

// Libera la conexión cacheada de un nodo (si existe) — hace falta ANTES de
// editar su host/puerto/credenciales, para que el próximo uso reconecte con
// los datos nuevos en vez de seguir usando la conexión vieja indefinidamente.
export async function cerrarConexionNodo(nodoId: number): Promise<void> {
  const clave = claveConexion(nodoId);
  const existente = conexiones.get(clave);
  if (!existente) return;
  conexiones.delete(clave);
  await existente.close().catch(() => {});
}

export interface EstadoMikrotik {
  identidad: string;
  version: string;
  // Tiempo que lleva ENCENDIDO el router (formato crudo de RouterOS, ej.
  // "1w6d23h59m59s") — no confundir con desde cuándo NOSOTROS logramos
  // conectarnos (ver NodoRed.ultimaConexionExitosa): esto es el uptime real
  // del equipo, tal cual lo reporta /system/resource/print.
  uptime: string;
}

// Prueba credenciales SUELTAS (host/puerto/usuario/password), sin que el
// nodo tenga que existir todavía en la base ni tocar el cache de conexiones
// — para el botón "Probar conexión" del formulario de Nodos, antes de
// guardar. Abre una conexión de un solo uso y la cierra enseguida.
export async function probarConexionAdHoc(config: { host: string; port: number; user: string; password: string }): Promise<EstadoMikrotik> {
  const conn = new RouterOSAPI({ ...config, timeout: 10 });
  try {
    await conn.connect();
    const [identidad] = await conn.write("/system/identity/print");
    const [recurso] = await conn.write("/system/resource/print");
    return {
      identidad: identidad?.name || "desconocida",
      version: recurso?.version || "desconocida",
      uptime: recurso?.uptime || "",
    };
  } finally {
    await conn.close().catch(() => {});
  }
}

// Prueba de conectividad simple — pensada para el botón "Probar conexión"
// de la pantalla de Nodos, para confirmar "sí llega a este router" sin
// tener que ir a buscar clientes/cuentas.
export async function probarConexion(nodoId: number): Promise<EstadoMikrotik> {
  const conn = await obtenerConexion(nodoId);
  const [identidad] = await conn.write("/system/identity/print");
  const [recurso] = await conn.write("/system/resource/print");
  return {
    identidad: identidad?.name || "desconocida",
    version: recurso?.version || "desconocida",
    uptime: recurso?.uptime || "",
  };
}

export interface VecinoRed {
  identidad: string;
  direccionIp: string;
  direccionMac: string;
  version: string;
  placa: string;
  interfaz: string;
}

// "Neighbors" al estilo WinBox: cada Mikrotik escucha su propio segmento de
// red por MNDP (Mikrotik Neighbor Discovery Protocol, broadcast en su LAN
// local) y guarda lo que va encontrando en /ip/neighbor — por eso esto se
// pide A TRAVÉS de la conexión API ya abierta con el router de ESTE nodo,
// en vez de escuchar MNDP nosotros mismos: nuestro backend no está en la
// misma LAN física que cada nodo (son sectores distintos), así que un
// broadcast propio no vería nada. address4 es el campo nuevo en versiones
// recientes de RouterOS; address es el viejo — algunos equipos todavía
// solo mandan uno de los dos.
export async function listarVecinos(nodoId: number): Promise<VecinoRed[]> {
  const conn = await obtenerConexion(nodoId);
  const datos = await conn.write("/ip/neighbor/print");
  return datos.map((d) => ({
    identidad: d.identity || "(sin identidad)",
    direccionIp: d.address4 || d.address || "",
    direccionMac: d["mac-address"] || "",
    version: d.version || "",
    placa: d.board || d.platform || "",
    interfaz: d.interface || "",
  }));
}

export interface VlanDetectada {
  nombre: string; // nombre de la interfaz VLAN en el router, ej. "vlan10"
  vlanId: number;
  interfaz: string; // interfaz física/bridge padre, ej. "ether2"
}

// Lee las VLANs configuradas AHORA MISMO en el router de este nodo — para
// el botón "Detectar VLANs" (ver routes/nodosRed.ts): un mismo Mikrotik
// puede atender varios sub-sectores/servicios en VLANs distintas, y esto
// evita tener que tipear el VLAN ID a mano mirando WinBox aparte.
export async function listarVlans(nodoId: number): Promise<VlanDetectada[]> {
  const conn = await obtenerConexion(nodoId);
  const datos = await conn.write("/interface/vlan/print");
  return datos.map((d) => ({
    nombre: d.name || "(sin nombre)",
    vlanId: Number(d["vlan-id"]) || 0,
    interfaz: d.interface || "",
  }));
}

// Crea la interfaz VLAN de verdad en el router (usado por "+ Agregar VLAN" —
// no por "Detectar VLANs"/Importar, que trae VLANs que YA existen ahí). Si
// ya hay una interfaz VLAN con ese vlan-id + interfaz padre, RouterOS
// rechaza el /add con "already have such vlan interface" — se deja
// propagar ese error tal cual, el caller lo traduce a un 502 legible.
export async function crearVlanEnRouter(nodoId: number, params: { nombre: string; vlanId: number; interfaz: string }): Promise<void> {
  const conn = await obtenerConexion(nodoId);
  await conn.write("/interface/vlan/add", [
    `=name=${params.nombre}`,
    `=vlan-id=${params.vlanId}`,
    `=interface=${params.interfaz}`,
  ]);
}

// La interfaz VLAN se busca en el router por su NOMBRE actual (el que tenía
// antes de este edit/borrado, no el nuevo) — es la única referencia estable
// que tenemos, porque vlan-id + interfaz padre pueden ser justo lo que se
// está por cambiar. Si no aparece con ese nombre (se renombró/borró a mano
// desde WinBox sin pasar por acá), no se considera un error fatal para
// eliminarVlanDelRouter — significa que ya no hay nada que borrar — pero SÍ
// lo es para editarVlanEnRouter, porque no hay forma segura de saber cuál
// interfaz "es" esta VLAN sin arriesgarse a tocar la equivocada.
export async function editarVlanEnRouter(
  nodoId: number,
  nombreActual: string,
  nuevo: { nombre: string; vlanId: number; interfaz: string }
): Promise<void> {
  const conn = await obtenerConexion(nodoId);
  const [existente] = await conn.write("/interface/vlan/print", [`?name=${nombreActual}`]);
  if (!existente) {
    throw new Error(`No se encontró la interfaz VLAN "${nombreActual}" en el Mikrotik — puede que ya no exista ahí`);
  }
  await conn.write("/interface/vlan/set", [
    `=.id=${existente[".id"]}`,
    `=name=${nuevo.nombre}`,
    `=vlan-id=${nuevo.vlanId}`,
    `=interface=${nuevo.interfaz}`,
  ]);
}

export async function eliminarVlanDelRouter(nodoId: number, nombre: string): Promise<void> {
  const conn = await obtenerConexion(nodoId);
  const [existente] = await conn.write("/interface/vlan/print", [`?name=${nombre}`]);
  if (!existente) return; // ya no está en el router — nada que borrar
  await conn.write("/interface/vlan/remove", [`=.id=${existente[".id"]}`]);
}

// --- Vínculo Cliente ↔ Mikrotik REAL (confirmado contra un router ISPCube
// en producción, no es una suposición): la red de H&A es IP FIJA por
// address-list, no PPPoE. Cada cliente tiene una IP asignada a mano por el
// técnico (según el puerto/PON al que se conecta, dentro del nodo de su
// sector — ver NodoRed), agregada a /ip/firewall/address-list con
// list=<código del plan, ej. "PLAN550">, EN EL ROUTER DE SU NODO.
//
// El límite de velocidad NO lo aplica el Mikrotik (a propósito: la empresa
// evita saturar el router con Queues de cientos de clientes) — se aplica en
// la OLT, al aprovisionar cada ONU con su perfil de velocidad. Este sistema
// nunca toca la OLT; solo administra la membresía IP↔lista en el Mikrotik
// del nodo, que sirve para identificar/bloquear al cliente (ver
// "Suspendido" abajo).
//
// Suspender NO mueve la IP de la lista de su plan: se AGREGA una entrada
// aparte en la lista "Suspendido" (así lo hace el router real) — el
// firewall corta primero por estar ahí (evaluada antes que la del plan),
// sin perder la asociación al plan. Reactivar solo quita esa entrada.
const LISTA_SUSPENDIDOS = "Suspendido";

export interface EntradaAddressList {
  id: string;
  lista: string;
  direccionIp: string;
  comentario?: string;
}

async function listarEntradasPorIp(conn: RouterOSAPI, direccionIp: string): Promise<EntradaAddressList[]> {
  const datos = await conn.write("/ip/firewall/address-list/print", [`?address=${direccionIp}`]);
  return datos.map((d) => ({ id: d[".id"], lista: d.list, direccionIp: d.address, comentario: d.comment || undefined }));
}

// Deja al cliente en la lista de SU plan actual — si estaba en la lista de
// otro plan (cambió de plan), la quita primero. Nunca toca "Suspendido".
export async function sincronizarListaPlanCliente(nodoId: number, direccionIp: string, codigoPlan: string, comentario: string): Promise<void> {
  const conn = await obtenerConexion(nodoId);
  const entradas = (await listarEntradasPorIp(conn, direccionIp)).filter((e) => e.lista !== LISTA_SUSPENDIDOS);

  const yaEnLaListaCorrecta = entradas.find((e) => e.lista === codigoPlan);
  for (const entrada of entradas) {
    if (entrada.id !== yaEnLaListaCorrecta?.id) {
      await conn.write("/ip/firewall/address-list/remove", [`=.id=${entrada.id}`]);
    }
  }

  if (yaEnLaListaCorrecta) {
    // Ya estaba en la lista correcta — solo refresca el comentario, por si
    // cambió el nombre del cliente desde la última sincronización.
    await conn.write("/ip/firewall/address-list/set", [`=.id=${yaEnLaListaCorrecta.id}`, `=comment=${comentario}`]);
    return;
  }
  await conn.write("/ip/firewall/address-list/add", [`=list=${codigoPlan}`, `=address=${direccionIp}`, `=comment=${comentario}`]);
}

// Quita al cliente de la lista de CUALQUIER plan (se le desasignó el plan
// sin asignarle uno nuevo) — deja "Suspendido" intacto si estaba ahí.
export async function quitarDeListaPlan(nodoId: number, direccionIp: string): Promise<void> {
  const conn = await obtenerConexion(nodoId);
  const entradas = (await listarEntradasPorIp(conn, direccionIp)).filter((e) => e.lista !== LISTA_SUSPENDIDOS);
  for (const entrada of entradas) {
    await conn.write("/ip/firewall/address-list/remove", [`=.id=${entrada.id}`]);
  }
}

// Borra TODAS las entradas de esta IP en ESTE nodo (la de su plan Y la de
// "Suspendido" si tenía) — a diferencia de quitarDeListaPlan (que deja
// "Suspendido" intacto a propósito para un cliente que SIGUE en este nodo),
// acá el cliente YA NO pertenece a esta combinación nodo/IP (cambió de
// nodo, o le cambiaron la IP dentro del mismo nodo — ver routes/clientes.ts),
// así que no debe quedar rastro suyo en este router bajo la IP vieja.
export async function limpiarClienteDeNodo(nodoId: number, direccionIp: string): Promise<void> {
  const conn = await obtenerConexion(nodoId);
  const entradas = await listarEntradasPorIp(conn, direccionIp);
  for (const entrada of entradas) {
    await conn.write("/ip/firewall/address-list/remove", [`=.id=${entrada.id}`]);
  }
}

export async function suspenderClientePorIp(nodoId: number, direccionIp: string, comentario: string): Promise<void> {
  const conn = await obtenerConexion(nodoId);
  const entradas = await listarEntradasPorIp(conn, direccionIp);
  if (entradas.some((e) => e.lista === LISTA_SUSPENDIDOS)) return; // ya estaba suspendido
  await conn.write("/ip/firewall/address-list/add", [`=list=${LISTA_SUSPENDIDOS}`, `=address=${direccionIp}`, `=comment=${comentario}`]);
}

export async function reactivarClientePorIp(nodoId: number, direccionIp: string): Promise<void> {
  const conn = await obtenerConexion(nodoId);
  const entradas = await listarEntradasPorIp(conn, direccionIp);
  for (const entrada of entradas.filter((e) => e.lista === LISTA_SUSPENDIDOS)) {
    await conn.write("/ip/firewall/address-list/remove", [`=.id=${entrada.id}`]);
  }
}

// Para la UI: qué IPs están suspendidas ahora mismo EN ESTE NODO — el
// frontend cruza esto contra Cliente.direccionIp (de los clientes de ese
// mismo nodo).
export async function listarIpsSuspendidas(nodoId: number): Promise<string[]> {
  const conn = await obtenerConexion(nodoId);
  const datos = await conn.write("/ip/firewall/address-list/print", [`?list=${LISTA_SUSPENDIDOS}`]);
  return datos.map((d) => d.address);
}

// --- Aprovisionamiento de un nodo nuevo: reglas de Filter Rules que hacen
// que la lista "Suspendido" efectivamente CORTE el tráfico (sin esto, un
// cliente suspendido sigue en la lista de address-list pero nada en el
// router lo bloquea de verdad). Mismo patrón usado en los routers reales
// del ISP: dos reglas en chain=forward, action=drop, src-address-list=
// Suspendido, una para TCP y otra para UDP — se llama sola al crear un
// nodo (ver routes/nodosRed.ts) y también se puede repetir a mano desde
// "Probar conexión" para los nodos que ya existían antes de esto.
// Idempotente: si una regla equivalente ya está creada (mismo chain/action/
// lista/protocolo), no la duplica.
export interface ResultadoConfigurarSuspension {
  creadas: string[];
  yaExistian: string[];
}

const REGLAS_SUSPENSION: { protocolo: string; etiqueta: string }[] = [
  { protocolo: "tcp", etiqueta: "TCP" },
  { protocolo: "udp", etiqueta: "UDP" },
];

async function reglaSuspensionExiste(conn: RouterOSAPI, protocolo: string): Promise<boolean> {
  const existentes = await conn.write("/ip/firewall/filter/print", [
    "?chain=forward",
    "?action=drop",
    `?src-address-list=${LISTA_SUSPENDIDOS}`,
    `?protocol=${protocolo}`,
  ]);
  return existentes.length > 0;
}

// Estado EN VIVO (nunca guardado en la base — mismo criterio que
// listarIpsSuspendidas arriba) de si las reglas ya están puestas en el
// router de este nodo — para que la UI pueda mostrar "Reglas configuradas"
// sin tener que confiar en si alguien las borró a mano después.
export async function estadoReglasSuspension(nodoId: number): Promise<{ tcp: boolean; udp: boolean }> {
  const conn = await obtenerConexion(nodoId);
  const [tcp, udp] = await Promise.all([reglaSuspensionExiste(conn, "tcp"), reglaSuspensionExiste(conn, "udp")]);
  return { tcp, udp };
}

export async function configurarReglasSuspension(nodoId: number): Promise<ResultadoConfigurarSuspension> {
  const conn = await obtenerConexion(nodoId);

  const creadas: string[] = [];
  const yaExistian: string[] = [];

  for (const regla of REGLAS_SUSPENSION) {
    if (await reglaSuspensionExiste(conn, regla.protocolo)) {
      yaExistian.push(regla.etiqueta);
      continue;
    }
    await conn.write("/ip/firewall/filter/add", [
      "=chain=forward",
      "=action=drop",
      `=src-address-list=${LISTA_SUSPENDIDOS}`,
      `=protocol=${regla.protocolo}`,
      `=comment=Bloqueo de clientes suspendidos (${regla.etiqueta}) - AmbrossISP`,
    ]);
    creadas.push(regla.etiqueta);
  }

  return { creadas, yaExistian };
}

// --- Visor genérico de address-lists (pantalla "Control Mikrotik") — para
// diagnóstico manual: ver TODAS las entradas de un nodo tal cual están en
// el router (no solo las que administra el vínculo con Cliente), y poder
// borrar una entrada suelta/huérfana (ej. de un cliente que ya no existe en
// el sistema, o un typo cargado a mano alguna vez directo en el router).
export async function listarTodasLasEntradasAddressList(nodoId: number): Promise<EntradaAddressList[]> {
  const conn = await obtenerConexion(nodoId);
  const datos = await conn.write("/ip/firewall/address-list/print");
  return datos.map((d) => ({ id: d[".id"], lista: d.list, direccionIp: d.address, comentario: d.comment || undefined }));
}

export async function eliminarEntradaAddressList(nodoId: number, id: string): Promise<void> {
  const conn = await obtenerConexion(nodoId);
  await conn.write("/ip/firewall/address-list/remove", [`=.id=${id}`]);
}

// --- Respaldo/restauración de configuración de un nodo — para el caso de
// "el Mikrotik se dañó, hay que reponer uno nuevo (de fábrica) y dejarlo
// como estaba": guarda listas de interfaces, sus miembros, reglas de
// firewall (filter y NAT) y address-lists tal cual están en el router en
// ese momento, y permite reaplicarlas después en un equipo de reemplazo.
// A propósito NO usa /export ni /system/backup (esos generan un archivo en
// el propio router, y esta librería no tiene forma de descargar archivos —
// solo la API binaria de comandos): en cambio, se lee cada tabla con
// "print" (el mismo mecanismo que ya usa el resto de este archivo) y se
// guarda como JSON estructurado, que se puede inspeccionar/descargar y
// reaplicar entrada por entrada con "add".
export interface RespaldoContenido {
  capturadoEn: string;
  interfaceLists: Record<string, string>[];
  interfaceListMembers: Record<string, string>[];
  firewallFilterRules: Record<string, string>[];
  firewallNatRules: Record<string, string>[];
  addressListEntries: Record<string, string>[];
}

export async function respaldarConfiguracionNodo(nodoId: number): Promise<RespaldoContenido> {
  const conn = await obtenerConexion(nodoId);
  const [interfaceLists, interfaceListMembers, firewallFilterRules, firewallNatRules, addressListEntries] = await Promise.all([
    conn.write("/interface/list/print"),
    conn.write("/interface/list/member/print"),
    conn.write("/ip/firewall/filter/print"),
    conn.write("/ip/firewall/nat/print"),
    conn.write("/ip/firewall/address-list/print"),
  ]);
  return {
    capturadoEn: new Date().toISOString(),
    interfaceLists,
    interfaceListMembers,
    firewallFilterRules,
    firewallNatRules,
    addressListEntries,
  };
}

// Campos que RouterOS devuelve en cada "print" pero que NO son parte de la
// configuración en sí (son metadatos/estadísticas/identificadores internos
// de ESE router) — mandarlos de vuelta en un "add" o rompe el comando, o no
// tiene sentido (ej. contadores de bytes/paquetes de la corrida anterior).
const CAMPOS_A_EXCLUIR_AL_RESTAURAR = new Set([
  ".id",
  ".nextid",
  "invalid",
  "bytes",
  "packets",
  "connection-bytes",
  "connection-rate",
  "packet-rate",
  "connection-mark",
  // Confirmados contra un router real (ver RespaldoMikrotik de NODO
  // MISICATA): "builtin" marca las 4 listas de interfaces de fábrica
  // (all/none/dynamic/static) — es informativo, "add" no lo acepta.
  // "creation-time" es la fecha en que ESE router creó la entrada —
  // tampoco es un parámetro de "add", el router pone la suya propia sola.
  "builtin",
  "creation-time",
]);

function limpiarParaRestaurar(entrada: Record<string, string>): string[] {
  const params: string[] = [];
  for (const [clave, valor] of Object.entries(entrada)) {
    if (CAMPOS_A_EXCLUIR_AL_RESTAURAR.has(clave)) continue;
    if (valor === undefined || valor === null || valor === "") continue;
    params.push(`=${clave}=${valor}`);
  }
  return params;
}

export interface ItemRestauracion {
  tabla: string;
  item: string;
  ok: boolean;
  error?: string;
}

export interface ResultadoRestauracion {
  total: number;
  exitosos: number;
  fallidos: number;
  detalle: ItemRestauracion[];
}

// Reaplica UNA tabla, entrada por entrada — cada una es best-effort: si una
// falla (ej. una lista de interfaces que RouterOS ya trae de fábrica, como
// "all"/"none"), se anota en el detalle y se sigue con las demás, nunca se
// aborta la restauración completa por un solo error.
async function restaurarTabla(
  conn: RouterOSAPI,
  rutaAdd: string,
  entradas: Record<string, string>[],
  etiquetaItem: (e: Record<string, string>) => string,
  nombreTabla: string,
  detalle: ItemRestauracion[]
): Promise<void> {
  for (const entrada of entradas) {
    // Las entradas "dynamic" las genera/gestiona el propio RouterOS solo
    // (ej. reglas creadas automáticamente por otro mecanismo) — no son
    // configuración puesta a mano, y RouterOS no deja crearlas por API.
    if (entrada.dynamic === "true") continue;

    try {
      await conn.write(rutaAdd, limpiarParaRestaurar(entrada));
      detalle.push({ tabla: nombreTabla, item: etiquetaItem(entrada), ok: true });
    } catch (error: any) {
      detalle.push({ tabla: nombreTabla, item: etiquetaItem(entrada), ok: false, error: error?.message || "Error desconocido" });
    }
  }
}

// Restaura un respaldo guardado en el nodo (se asume que su NodoRed.mikrotikHost
// ya apunta al equipo de reemplazo, de fábrica). Orden intencional: las
// listas de interfaces primero, porque sus miembros dependen de que la lista
// ya exista.
export async function restaurarConfiguracionNodo(nodoId: number, contenido: RespaldoContenido): Promise<ResultadoRestauracion> {
  const conn = await obtenerConexion(nodoId);
  const detalle: ItemRestauracion[] = [];

  await restaurarTabla(conn, "/interface/list/add", contenido.interfaceLists ?? [], (e) => e.name || "(sin nombre)", "Listas de interfaces", detalle);
  await restaurarTabla(
    conn,
    "/interface/list/member/add",
    contenido.interfaceListMembers ?? [],
    (e) => `${e.interface ?? "?"} → ${e.list ?? "?"}`,
    "Miembros de listas de interfaces",
    detalle
  );
  await restaurarTabla(
    conn,
    "/ip/firewall/filter/add",
    contenido.firewallFilterRules ?? [],
    (e) => e.comment || `${e.chain ?? "?"}/${e.action ?? "?"}`,
    "Reglas de firewall (filter)",
    detalle
  );
  await restaurarTabla(
    conn,
    "/ip/firewall/nat/add",
    contenido.firewallNatRules ?? [],
    (e) => e.comment || `${e.chain ?? "?"}/${e.action ?? "?"}`,
    "Reglas NAT",
    detalle
  );
  await restaurarTabla(
    conn,
    "/ip/firewall/address-list/add",
    contenido.addressListEntries ?? [],
    (e) => `${e.address ?? "?"} (${e.list ?? "?"})`,
    "Address-lists",
    detalle
  );

  const exitosos = detalle.filter((d) => d.ok).length;
  return { total: detalle.length, exitosos, fallidos: detalle.length - exitosos, detalle };
}
