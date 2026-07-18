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
CMD ["sh", "-c", "npx prisma migrate deploy && npx ts-node src/index.ts"]
