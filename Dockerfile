# Imagen de la prueba local en Docker — ver docker-compose.yml en la raíz
# del repo y el plan documentado ahí. NO se usa para desarrollo (seguimos
# usando "npm run dev" con nodemon fuera de Docker para eso).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Genera el cliente de Prisma contra el schema — no necesita una base de
# datos viva, solo lee prisma/schema.prisma.
RUN npx prisma generate

EXPOSE 3000

# La migración corre en cada arranque del contenedor (no en el build, porque
# acá SÍ hace falta una base de datos viva, que solo existe cuando ya está
# corriendo el servicio "db" de docker-compose) — es idempotente, no rompe
# nada si ya estaba migrada. Mismo comando que ya usa producción real
# (ver DESPLIEGUE.md), sin nodemon.
#
# El .p12 nunca viaja dentro de la imagen (ver .dockerignore) — en proveedores
# sin subida de binarios (ej. Render "Secret Files", que solo acepta texto) se
# sube codificado en base64 como "certificado.p12.b64"; si existe, se decodifica
# a certificado.p12 antes de arrancar. Si no existe (docker-compose local, donde
# el .p12 se monta directo), este paso simplemente se omite.
CMD ["sh", "-c", "if [ -f /etc/secrets/certificado.p12.b64 ]; then node -e \"require('fs').writeFileSync('certificado.p12', Buffer.from(require('fs').readFileSync('/etc/secrets/certificado.p12.b64','utf8'),'base64'))\"; fi && npx prisma migrate deploy && npx ts-node src/index.ts"]
