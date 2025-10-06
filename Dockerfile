# Stage 1: Build environment
# Here we install everything (including devDependencies) and build the TypeScript code.
FROM node:20-alpine AS build

WORKDIR /app

# Only copy the necessary files for installation to utilize cache
COPY package.json pnpm-lock.yaml ./

# Install ALL dependencies to be able to build the project
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy the remaining source code
COPY . .

# Execute the build script from your package.json
RUN pnpm build

# ---

# Stage 2: Production environment
# Here we create the final, lean image with only what is necessary for execution.
FROM node:20-alpine AS production

WORKDIR /app

# Copy the dependency definitions
COPY package.json pnpm-lock.yaml ./

# Install ONLY the production dependencies
RUN npm install -g pnpm && pnpm install --prod --frozen-lockfile

# Copy the built code from the build stage
COPY --from=build /app/dist ./dist

# Set the environment variable for Node to run in production mode
ENV NODE_ENV=production

# The command that is executed when starting the container (from your package.json)
# Note: We omit --env-file since environment variables are handled differently in Docker (e.g., via -e flags).
CMD ["node", "dist/server.js"]