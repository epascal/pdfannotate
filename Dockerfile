# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Installer unzip pour le script copy-pdfjs
RUN apk add --no-cache unzip

# Copier les fichiers de dépendances
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Copier le script postinstall avant npm install
COPY frontend/scripts frontend/scripts/

# Installer les dépendances
RUN npm ci

# Copier le reste du code source
COPY backend backend/
COPY frontend frontend/

# Build du frontend et du backend
RUN npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Créer un utilisateur non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copier uniquement les fichiers nécessaires pour la production
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/backend/package.json backend/
COPY --from=builder /app/backend/dist backend/dist/
COPY --from=builder /app/frontend/dist frontend/dist/

# Installer uniquement les dépendances de production du backend
WORKDIR /app/backend
RUN npm ci --omit=dev

WORKDIR /app

# Créer le répertoire de données
RUN mkdir -p /app/backend/data && chown -R nodejs:nodejs /app/backend/data

# Changer pour l'utilisateur non-root
USER nodejs

# Variables d'environnement
ENV NODE_ENV=production
ENV PORT=3001

# Exposer le port
EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Commande de démarrage
CMD ["node", "backend/dist/index.js"]
